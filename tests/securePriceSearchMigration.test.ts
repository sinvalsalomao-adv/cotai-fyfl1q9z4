import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../pocketbase/migrations/1741634520_secure_fast_price_search.js',
  import.meta.url,
)

class FieldCollection {
  values = new Map<string, any>()
  getByName(name: string) {
    return this.values.get(name) || null
  }
  add(field: any) {
    this.values.set(field.name, field)
  }
}

function runMigration(db: DatabaseSync) {
  expect(existsSync(migrationUrl)).toBe(true)
  const collection = { fields: new FieldCollection() }
  let up: (app: any) => void = () => undefined
  vm.runInNewContext(readFileSync(migrationUrl, 'utf8'), {
    migrate(upHandler: typeof up) {
      up = upHandler
    },
    TextField: class TextField {
      constructor(options: any) {
        Object.assign(this, options)
      }
    },
    NumberField: class NumberField {
      constructor(options: any) {
        Object.assign(this, options)
      }
    },
  })
  const existingColumns = new Set(
    (db.prepare('PRAGMA table_info(price_samples_index)').all() as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  )
  up({
    findCollectionByNameOrId(name: string) {
      expect(name).toBe('price_samples_index')
      return collection
    },
    save() {
      for (const [name, field] of collection.fields.values) {
        if (existingColumns.has(name)) continue
        db.exec(
          `ALTER TABLE price_samples_index ADD COLUMN ${name} ${field && field.onlyInt ? 'INTEGER' : 'TEXT'}`,
        )
        existingColumns.add(name)
      }
    },
    db: () => ({
      newQuery(sql: string) {
        return { execute: () => db.exec(sql) }
      },
    }),
  })
}

function createLegacyTable() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE price_samples_index (
      id TEXT PRIMARY KEY, sample_key TEXT, source TEXT, source_record_id TEXT,
      descricao_normalizada TEXT, codigo_item TEXT, orgao TEXT, uf TEXT,
      data_referencia TEXT,
      valor_unitario REAL, qualidade_situacao TEXT, payload_hash TEXT,
      raw_payload TEXT, server_trust_version TEXT
    )
  `)
  return db
}

function insertLegacy(db: DatabaseSync, id: string, contract: string, trusted = true) {
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

const CONTRACT = 'cotai-official-price-v3'

describe('secure fast search migration', () => {
  it('backfills only fully sealed v3 rows and keeps v2/untrusted rows out of FTS', () => {
    const db = createLegacyTable()
    insertLegacy(db, 'v3', CONTRACT)
    insertLegacy(db, 'v2', 'cotai-official-price-v2')
    insertLegacy(db, 'untrusted', CONTRACT, false)

    runMigration(db)

    expect(
      db
        .prepare('SELECT id, search_eligible, search_contract FROM price_samples_index ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'untrusted', search_eligible: 0, search_contract: '' },
      { id: 'v2', search_eligible: 0, search_contract: '' },
      { id: 'v3', search_eligible: 1, search_contract: CONTRACT },
    ])
    expect(db.prepare('SELECT sample_id FROM price_samples_fts').all()).toEqual([
      { sample_id: 'v3' },
    ])
  })

  it('keeps FTS synchronized when an eligible row becomes rejected', () => {
    const db = createLegacyTable()
    insertLegacy(db, 'v3', CONTRACT)
    runMigration(db)

    db.prepare("UPDATE price_samples_index SET qualidade_situacao = 'rejeitada' WHERE id = 'v3'").run()

    expect(db.prepare('SELECT sample_id FROM price_samples_fts').all()).toEqual([])
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
