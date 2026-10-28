import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

// Cobre a migration consolidada (só estrutura) e o cron que faz o backfill em lotes.
const migrationUrl = new URL(
  '../pocketbase/migrations/1741634526_consolidate_search_and_admission.js',
  import.meta.url,
)
const backfillUrl = new URL('../pocketbase/hooks/search_eligibility_backfill.js', import.meta.url)

const CONTRACT = 'cotai-official-price-v3'

class FieldCollection {
  values = new Map<string, any>()
  getByName(name: string) {
    return this.values.get(name) || null
  }
  add(field: any) {
    this.values.set(field.name, field)
  }
}

class Field {
  constructor(options: any) {
    Object.assign(this, options)
  }
}
class TextField extends Field {
  kind = 'TEXT'
}
class DateField extends Field {
  kind = 'TEXT'
}
class NumberField extends Field {
  kind = 'NUMBER'
}

function makeCollection(name: string) {
  return {
    name,
    fields: new FieldCollection(),
    indexes: [] as string[],
    listRule: '' as string | null,
    viewRule: '' as string | null,
    createRule: '' as string | null,
    updateRule: '' as string | null,
    deleteRule: '' as string | null,
  }
}

function createDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE price_samples_index (
      id TEXT PRIMARY KEY, sample_key TEXT, source TEXT, source_record_id TEXT,
      descricao_normalizada TEXT, codigo_item TEXT, orgao TEXT, uf TEXT,
      data_referencia TEXT,
      valor_unitario REAL, qualidade_situacao TEXT, payload_hash TEXT,
      raw_payload TEXT, server_trust_version TEXT
    );
    CREATE TABLE price_index_tasks (
      id TEXT PRIMARY KEY, task_key TEXT UNIQUE, status TEXT, server_trust_version TEXT
    );
    CREATE TABLE pncp_item_cache (id TEXT PRIMARY KEY, server_trust_version TEXT);
  `)
  return db
}

// dbx usa {:nome}; node:sqlite aceita :nome com o objeto de binds sem prefixo.
function query(db: DatabaseSync, sql: string) {
  let binds: Record<string, any> = {}
  const text = sql.replace(/\{:(\w+)\}/g, ':$1')
  const q = {
    bind(values: Record<string, any>) {
      binds = values
      return q
    },
    execute() {
      if (Object.keys(binds).length) db.prepare(text).run(binds)
      else db.exec(text)
    },
    one(model: any) {
      const row = db.prepare(text).get(binds) as Record<string, any> | undefined
      if (!row) throw new Error('sql: no rows in result set')
      Object.assign(model, row)
    },
  }
  return q
}

function createApp(db: DatabaseSync) {
  const collections = new Map<string, ReturnType<typeof makeCollection>>()
  for (const name of [
    'official_ingestion_receipts',
    'pncp_item_cache',
    'price_samples_index',
    'price_index_tasks',
  ]) {
    collections.set(name, makeCollection(name))
  }
  const columns = (table: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    )
  const app = {
    collections,
    findCollectionByNameOrId(name: string) {
      const collection = collections.get(name)
      if (!collection) throw new Error(`missing collection ${name}`)
      return collection
    },
    save(collection: ReturnType<typeof makeCollection>) {
      const existing = columns(collection.name)
      if (existing.size === 0) return
      for (const [name, field] of collection.fields.values) {
        if (existing.has(name)) continue
        const type = field.kind === 'NUMBER' && field.onlyInt ? 'INTEGER' : field.kind
        db.exec(`ALTER TABLE ${collection.name} ADD COLUMN ${name} ${type}`)
      }
    },
    db: () => ({ newQuery: (sql: string) => query(db, sql) }),
    runInTransaction(fn: (tx: any) => void) {
      db.exec('BEGIN')
      try {
        fn(app)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return app
}

function runMigration(db: DatabaseSync) {
  expect(existsSync(migrationUrl)).toBe(true)
  let up: (app: any) => void = () => undefined
  vm.runInNewContext(readFileSync(migrationUrl, 'utf8'), {
    migrate(upHandler: typeof up) {
      up = upHandler
    },
    Collection: class Collection {},
    TextField,
    NumberField,
    DateField,
  })
  const app = createApp(db)
  up(app)
  return app
}

function loadBackfill(db: DatabaseSync) {
  expect(existsSync(backfillUrl)).toBe(true)
  let tick: () => void = () => undefined
  const logs: string[] = []
  vm.runInNewContext(readFileSync(backfillUrl, 'utf8'), {
    cronAdd(_id: string, _expr: string, handler: () => void) {
      tick = handler
    },
    DynamicModel: class DynamicModel {
      constructor(defaults: any) {
        Object.assign(this, defaults)
      }
    },
    $app: createApp(db),
    console: { log: (message: string) => logs.push(message) },
  })
  return { tick, logs }
}

function insertSample(db: DatabaseSync, id: string, contract: string, trusted = true) {
  const source = 'PNCP'
  const sampleKey = `KEY-${id}`
  const recordId = `RECORD-${id}`
  const material = [CONTRACT, source, sampleKey, recordId]
    .map((part) => `${part.length}:${part}`)
    .join('|')
  const signature = createHash('sha256').update(material).digest('hex')
  db.prepare(`
    INSERT INTO price_samples_index (
      id, sample_key, source, source_record_id, descricao_normalizada, codigo_item,
      orgao, uf, valor_unitario, qualidade_situacao, payload_hash, raw_payload,
      server_trust_version
    ) VALUES (?, ?, ?, ?, ?, '', '', 'CE', 2.5, 'aceita', ?, ?, ?)
  `).run(
    id,
    sampleKey,
    source,
    recordId,
    `FORNECIMENTO DE DIPIRONA ${id}`,
    signature,
    JSON.stringify({
      proveniencia_preco: {
        status: 'verificada',
        fonte: source,
        valor_unitario: 2.5,
        validacao_indice: {
          contrato: contract,
          fonte: source,
          sample_key: sampleKey,
          source_record_id: recordId,
          assinatura: signature,
        },
      },
    }),
    trusted ? 'server-v1' : '',
  )
}

const tableNames = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string
  }>).map(({ name }) => name)
const indexNames = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
    name: string
  }>).map(({ name }) => name)

describe('consolidated search and admission migration', () => {
  it('only adds structure: existing samples stay unmarked until the backfill runs', () => {
    const db = createDb()
    insertSample(db, 'v3', CONTRACT)

    runMigration(db)

    expect(db.prepare('SELECT search_eligible, search_contract FROM price_samples_index').all()).toEqual([
      { search_eligible: null, search_contract: null },
    ])
  })

  it('creates the private quota, snapshot and maintenance tables', () => {
    const db = createDb()
    runMigration(db)

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'cotai_price_search_rate_limits',
        'cotai_backend_rate_limits',
        'cotai_price_search_snapshots',
        'cotai_price_search_snapshot_items',
        'cotai_maintenance_state',
      ]),
    )
  })

  it('closes client writes, scopes tasks by owner and is idempotent', () => {
    const db = createDb()
    db.exec('ALTER TABLE price_index_tasks ADD COLUMN requested_by TEXT')
    db.prepare(
      "INSERT INTO price_index_tasks (id, task_key, status, server_trust_version, requested_by) VALUES ('t1', 'PNCP|dipirona|CE', 'done', 'server-v1', 'user1')",
    ).run()
    db.prepare(
      "INSERT INTO price_index_tasks (id, task_key, status, server_trust_version, requested_by) VALUES ('t2', 'PNCP|legado|CE', 'done', '', 'user1')",
    ).run()

    const app = runMigration(db)
    runMigration(db)

    expect(db.prepare('SELECT id, task_key FROM price_index_tasks ORDER BY id').all()).toEqual([
      { id: 't1', task_key: 'PNCP|dipirona|CE#OWNER#user1' },
      { id: 't2', task_key: 'PNCP|legado|CE' },
    ])

    const tasks = app.collections.get('price_index_tasks')!
    expect(tasks.listRule).toContain('requested_by = @request.auth.id')
    expect(tasks.viewRule).toContain('requested_by = @request.auth.id')
    expect(tasks.fields.getByName('admitted_at')).not.toBeNull()
    for (const collection of app.collections.values()) {
      expect(collection.createRule).toBeNull()
      expect(collection.updateRule).toBeNull()
      expect(collection.deleteRule).toBeNull()
    }
    expect(app.collections.get('official_ingestion_receipts')!.listRule).toBeNull()
  })

  it('exports the server-controlled fields and covering indexes in schema.json', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../src/lib/pocketbase/schema.json', import.meta.url), 'utf8'),
    )
    const collection = schema.collections.find((candidate: any) => candidate.name === 'price_samples_index')

    expect(collection.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'search_eligible', type: 'number' }),
        expect.objectContaining({ name: 'search_contract', type: 'text' }),
      ]),
    )
    expect(collection.indexes.join('\n')).toContain('idx_psi_searchable_source_value')
  })
})

describe('search eligibility backfill cron', () => {
  it('marks only fully sealed v3 rows, then creates the search indexes once', () => {
    const db = createDb()
    insertSample(db, 'v3', CONTRACT)
    insertSample(db, 'v2', 'cotai-official-price-v2')
    insertSample(db, 'untrusted', CONTRACT, false)
    runMigration(db)

    const { tick } = loadBackfill(db)
    tick()

    expect(
      db
        .prepare('SELECT id, search_eligible, search_contract FROM price_samples_index ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'untrusted', search_eligible: 0, search_contract: '' },
      { id: 'v2', search_eligible: 0, search_contract: '' },
      { id: 'v3', search_eligible: 1, search_contract: CONTRACT },
    ])
    expect(indexNames(db)).not.toContain('idx_psi_searchable_source_value')

    tick()
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'idx_psi_searchable_source_value',
        'idx_psi_searchable_uf_value',
        'idx_psi_searchable_date',
      ]),
    )
  })

  it('never overrides rows already marked by the ingestion hooks', () => {
    const db = createDb()
    insertSample(db, 'untrusted', CONTRACT, false)
    runMigration(db)
    db.exec(
      "UPDATE price_samples_index SET search_eligible = 1, search_contract = 'cotai-official-price-v3'",
    )

    loadBackfill(db).tick()

    expect(db.prepare('SELECT search_eligible FROM price_samples_index').all()).toEqual([
      { search_eligible: 1 },
    ])
  })

  it('processes the table in bounded batches using the stored cursor', () => {
    const db = createDb()
    for (let i = 0; i < 1005; i++) insertSample(db, `s${String(i).padStart(4, '0')}`, CONTRACT)
    runMigration(db)

    const { tick } = loadBackfill(db)
    tick()
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM price_samples_index WHERE search_eligible IS NULL').get() as any).n,
    ).toBe(5)
    tick()
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM price_samples_index WHERE search_eligible = 1').get() as any).n,
    ).toBe(1005)
  })
})
