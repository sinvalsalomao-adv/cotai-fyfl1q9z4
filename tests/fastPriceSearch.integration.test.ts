import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { isEligibleComprasOfficialProof } from '../src/components/modalSearchPolicy'

const hookSource = readFileSync(
  new URL('../pocketbase/hooks/prices_search.js', import.meta.url),
  'utf8',
)

const CONTRACT = 'cotai-official-price-v3'

type PriceRow = {
  id: string
  sample_key: string
  source: 'PNCP' | 'Compras.gov.br'
  source_record_id: string
  descricao: string
  descricao_normalizada: string
  orgao_cnpj?: string
  fornecedor_cnpj?: string
  codigo_item?: string
  uf?: string
  fornecedor_porte?: string
  unidade?: string
  data_referencia?: string
  modalidade?: string
  natureza_preco?: string
  marca?: string
  quantidade?: number
  valor_unitario: number
  valor_total?: number
  matching_score?: number
  qualidade_situacao?: string
  search_eligible?: number
  search_contract?: string
  raw_payload?: unknown
}

function seal(source: string, key: string, recordId: string) {
  const material = [CONTRACT, source, key, recordId]
    .map((part) => `${part.length}:${part}`)
    .join('|')
  return createHash('sha256').update(material).digest('hex')
}

function row(id: string, overrides: Partial<PriceRow> = {}): PriceRow {
  return {
    id,
    sample_key: `KEY-${id}`,
    source: 'PNCP',
    source_record_id: `00000000000001/2026/1/itens/${id.replace(/\D/g, '') || '1'}`,
    descricao: 'FORNECIMENTO DE DIPIRONA SODICA 500MG',
    descricao_normalizada: 'FORNECIMENTO DE DIPIRONA SODICA 500MG',
    codigo_item: '',
    uf: 'CE',
    fornecedor_porte: 'DEMAIS',
    unidade: 'UNIDADE',
    data_referencia: '2026-01-15',
    modalidade: 'PREGAO ELETRONICO',
    natureza_preco: 'homologado',
    marca: 'NAO INFORMADO',
    quantidade: 1,
    valor_unitario: 10,
    valor_total: 10,
    matching_score: 100,
    qualidade_situacao: 'aceita',
    search_eligible: 1,
    search_contract: CONTRACT,
    ...overrides,
  }
}

function createDatabase(rows: PriceRow[], tasks: any[] = []) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE price_samples_index (
      id TEXT PRIMARY KEY, sample_key TEXT, source TEXT, source_record_id TEXT,
      purchase_id TEXT, item_id TEXT, descricao TEXT, descricao_normalizada TEXT,
      orgao TEXT, orgao_cnpj TEXT, fornecedor_nome TEXT, fornecedor_cnpj TEXT,
      fornecedor_porte TEXT, uf TEXT, municipio TEXT, unidade TEXT, quantidade REAL,
      valor_unitario REAL, valor_total REAL, natureza_preco TEXT, data_referencia TEXT,
      numero_processo TEXT, numero_ata TEXT, modalidade TEXT, situacao_contratacao TEXT,
      marca TEXT, modelo TEXT, codigo_item TEXT, url_original TEXT, payload_hash TEXT,
      raw_payload TEXT, qualidade_situacao TEXT, motivos_rejeicao TEXT,
      matching_score REAL, matching_tipo TEXT, indexed_at TEXT, source_updated_at TEXT,
      last_validated_at TEXT, server_trust_version TEXT, search_eligible INTEGER,
      search_contract TEXT
    );
    CREATE INDEX idx_test_searchable_price
      ON price_samples_index(search_eligible, search_contract, source, valor_unitario, id);
    CREATE INDEX idx_test_catalog_code ON price_samples_index(codigo_item);
    CREATE VIRTUAL TABLE price_samples_fts USING fts5(
      sample_id UNINDEXED,
      descricao_normalizada,
      codigo_item,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER trg_test_fts_ai AFTER INSERT ON price_samples_index
    WHEN new.search_eligible = 1
      AND new.search_contract = '${CONTRACT}'
      AND new.server_trust_version = 'server-v1'
      AND new.valor_unitario > 0
      AND new.source IN ('PNCP', 'Compras.gov.br')
      AND COALESCE(new.qualidade_situacao, '') != 'rejeitada'
    BEGIN
      INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, codigo_item)
      VALUES (new.rowid, new.id, COALESCE(new.descricao_normalizada, ''), COALESCE(new.codigo_item, ''));
    END;
    CREATE TABLE price_watermarks (
      fonte TEXT, last_watermark_date TEXT, status TEXT,
      amostras_coletadas_total INTEGER, updated TEXT
    );
    CREATE TABLE daily_sync_runs (
      ciclo_id TEXT, data_ciclo TEXT, status TEXT, finalizado_em TEXT, duracao_ms INTEGER,
      novas_amostras INTEGER, amostras_validadas INTEGER, amostras_invalidadas INTEGER,
      updated TEXT, created TEXT
    );
    CREATE TABLE price_index_tasks (
      id TEXT, task_key TEXT, source TEXT, termo TEXT, uf TEXT, status TEXT,
      paginas_consultadas INTEGER, itens_processados INTEGER, amostras_inseridas INTEGER,
      amostras_atualizadas INTEGER, tentativas INTEGER, pendentes TEXT, updated TEXT,
      server_trust_version TEXT, requested_by TEXT
    );
    CREATE TABLE cotai_price_search_rate_limits (
      user_id TEXT PRIMARY KEY NOT NULL,
      window_started_at TEXT NOT NULL,
      request_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE cotai_price_search_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      cursor_secret TEXT NOT NULL,
      sort_name TEXT NOT NULL,
      page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 100),
      page_count INTEGER NOT NULL,
      captured_count INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      population_complete INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX idx_cpss_owner_expiry
      ON cotai_price_search_snapshots(owner_user_id, expires_at);
    CREATE TABLE cotai_price_search_snapshot_items (
      snapshot_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 1),
      hit_json TEXT NOT NULL CHECK(
        json_valid(hit_json)
        AND json_type(hit_json) = 'object'
        AND length(CAST(hit_json AS BLOB)) <= 32768
      ),
      PRIMARY KEY(snapshot_id, position),
      FOREIGN KEY(snapshot_id) REFERENCES cotai_price_search_snapshots(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
  `)
  const insert = db.prepare(`
    INSERT INTO price_samples_index (
      id, sample_key, source, source_record_id, purchase_id, item_id, descricao,
      descricao_normalizada, codigo_item, orgao_cnpj, fornecedor_cnpj, uf, fornecedor_porte, unidade, data_referencia,
      modalidade, natureza_preco, marca, quantidade, valor_unitario, valor_total,
      matching_score, qualidade_situacao,
      payload_hash, raw_payload, server_trust_version, search_eligible, search_contract
    ) VALUES (
      :id, :sample_key, :source, :source_record_id, :purchase_id, :item_id, :descricao,
      :descricao_normalizada, :codigo_item, :orgao_cnpj, :fornecedor_cnpj, :uf, :fornecedor_porte, :unidade, :data_referencia,
      :modalidade, :natureza_preco, :marca, :quantidade, :valor_unitario, :valor_total,
      :matching_score, :qualidade_situacao,
      :payload_hash, :raw_payload, 'server-v1', :search_eligible, :search_contract
    )
  `)
  const insertOne = (candidate: PriceRow) => {
    const signature = seal(candidate.source, candidate.sample_key, candidate.source_record_id)
    insert.run({
      ...candidate,
      codigo_item: candidate.codigo_item || '',
      orgao_cnpj: candidate.orgao_cnpj || '',
      fornecedor_cnpj: candidate.fornecedor_cnpj || '',
      uf: candidate.uf || '',
      fornecedor_porte: candidate.fornecedor_porte || '',
      unidade: candidate.unidade || '',
      data_referencia: candidate.data_referencia || '',
      modalidade: candidate.modalidade || '',
      natureza_preco: candidate.natureza_preco || '',
      marca: candidate.marca || '',
      qualidade_situacao: candidate.qualidade_situacao || 'aceita',
      search_eligible: candidate.search_eligible ?? 1,
      search_contract: candidate.search_contract ?? CONTRACT,
      purchase_id: candidate.source_record_id,
      item_id: candidate.id,
      payload_hash: signature,
      raw_payload: JSON.stringify(
        candidate.raw_payload ?? {
          proveniencia_preco: {
            status: 'verificada',
            fonte: candidate.source,
            valor_unitario: candidate.valor_unitario,
            validacao_indice: {
              contrato: CONTRACT,
              fonte: candidate.source,
              sample_key: candidate.sample_key,
              source_record_id: candidate.source_record_id,
              assinatura: signature,
            },
          },
        },
      ),
    })
  }
  db.exec('BEGIN')
  rows.forEach(insertOne)
  const insertTask = db.prepare(`
    INSERT INTO price_index_tasks (
      id, task_key, source, termo, uf, status, paginas_consultadas, itens_processados,
      amostras_inseridas, amostras_atualizadas, tentativas, pendentes, updated,
      server_trust_version, requested_by
    ) VALUES (
      :id, :task_key, :source, :termo, :uf, :status, :paginas_consultadas,
      :itens_processados, :amostras_inseridas, :amostras_atualizadas, :tentativas,
      :pendentes, :updated, :server_trust_version
      , :requested_by
    )
  `)
  tasks.forEach((task) => insertTask.run({ ...task, requested_by: task.requested_by || 'user-1' }))
  db.exec('COMMIT')
  return { db, insertOne }
}

function searchHarness(
  rows: PriceRow[],
  options: {
    tasks?: any[]
    injectAfterPopulation?: PriceRow
    enforceJsVmNumberTypes?: boolean
    snapshotPersistenceMs?: number
  } = {},
) {
  const { db, insertOne } = createDatabase(rows, options.tasks || [])
  const handlers = new Map<
    string,
    { callback: (event: any) => any; middlewares: Array<{ kind: string; bytes?: number }> }
  >()
  const executed: Array<{
    sql: string
    params: Record<string, unknown>
    returned: number
    operation: 'all' | 'one' | 'execute'
  }> = []
  const pocketbaseSql = (sql: string) => sql.replace(/\{:([A-Za-z0-9_]+)\}/g, ':$1')
  let injected = false
  let randomCounter = 0
  let fakeNow = Date.parse('2026-02-01T00:00:00.000Z')
  let wroteSnapshotInTransaction = false
  let transactionOpen = false
  let deferredConcurrentInsert = false
  const injectConcurrentRow = (sql: string) => {
    if (
      !options.injectAfterPopulation ||
      injected ||
      !/price_samples_(?:index|fts)/.test(sql) ||
      /^\s*EXPLAIN/i.test(sql)
    )
      return
    injected = true
    // BEGIN IMMEDIATE keeps a real concurrent writer outside the read +
    // materialization transaction. Model that wait instead of inserting on
    // the same SQLite connection inside the transaction under test.
    if (transactionOpen) deferredConcurrentInsert = true
    else insertOne(options.injectAfterPopulation)
  }
  const dbAdapter = {
      newQuery(sql: string) {
        let params: Record<string, unknown> = {}
        return {
          withContext() {
            return this
          },
          bind(values: Record<string, unknown>) {
            params = values
            return this
          },
          all(target?: any[]) {
            const result = db.prepare(pocketbaseSql(sql)).all(params) as any[]
            executed.push({ sql, params: { ...params }, returned: result.length, operation: 'all' })
            if (options.enforceJsVmNumberTypes && target) {
              const model = (target as any).__dynamicModelTemplate as Record<string, unknown>
              for (const resultRow of result) {
                for (const [field, initial] of Object.entries(model || {})) {
                  const value = resultRow[field]
                  if (value === null || value === undefined) {
                    throw new Error(
                      `PocketBase JSVM cannot scan NULL ${field} into a non-null DynamicModel field`,
                    )
                  }
                  if (
                    typeof initial === 'number' &&
                    initial === 0 &&
                    !Object.is(initial, -0) &&
                    typeof value === 'number' &&
                    !Number.isInteger(value)
                  ) {
                    throw new Error(
                      `PocketBase JSVM cannot scan REAL ${field}=${value} into an integer DynamicModel field`,
                    )
                  }
                }
              }
            }
            if (target) target.push(...result)
            injectConcurrentRow(sql)
            return result
          },
          one(target: Record<string, unknown>) {
            const result = db.prepare(pocketbaseSql(sql)).get(params) as any
            executed.push({ sql, params: { ...params }, returned: result ? 1 : 0, operation: 'one' })
            if (result) Object.assign(target, result)
            injectConcurrentRow(sql)
            return result
          },
          execute() {
            const result = db.prepare(pocketbaseSql(sql)).run(params)
            executed.push({
              sql,
              params: { ...params },
              returned: Number(result.changes) || 0,
              operation: 'execute',
            })
            if (/INSERT INTO cotai_price_search_snapshots/i.test(sql)) {
              wroteSnapshotInTransaction = true
            }
            return result
          },
        }
      },
    }
  const app = {
    db: () => dbAdapter,
    runInTransaction(callback: (txApp: any) => void) {
      wroteSnapshotInTransaction = false
      db.exec('BEGIN IMMEDIATE')
      transactionOpen = true
      try {
        callback({ db: () => dbAdapter })
        db.exec('COMMIT')
        transactionOpen = false
        if (deferredConcurrentInsert && options.injectAfterPopulation) {
          deferredConcurrentInsert = false
          insertOne(options.injectAfterPopulation)
        }
        if (wroteSnapshotInTransaction) fakeNow += options.snapshotPersistenceMs || 0
      } catch (error) {
        db.exec('ROLLBACK')
        transactionOpen = false
        if (deferredConcurrentInsert && options.injectAfterPopulation) {
          deferredConcurrentInsert = false
          insertOne(options.injectAfterPopulation)
        }
        throw error
      }
    },
  }
  vm.runInNewContext(hookSource, {
    Date: class ControlledDate extends Date {
      constructor(value?: string | number | Date) {
        super(value === undefined ? fakeNow : value)
      }

      static now() {
        return fakeNow
      }
    },
    routerAdd(
      method: string,
      route: string,
      callback: (event: any) => any,
      ...middlewares: Array<{ kind: string; bytes?: number }>
    ) {
      handlers.set(`${method} ${route}`, { callback, middlewares })
    },
    $app: app,
    $apis: {
      requireAuth: () => ({ kind: 'auth' }),
      bodyLimit: (bytes: number) => ({ kind: 'bodyLimit', bytes }),
    },
    DynamicModel: class DynamicModel {
      constructor(initial: Record<string, unknown>) {
        Object.assign(this, initial)
      }
    },
    arrayOf: (model: Record<string, unknown>) => {
      const target: any[] = []
      Object.defineProperty(target, '__dynamicModelTemplate', { value: model })
      return target
    },
    $security: {
      sha256(value: string) {
        return createHash('sha256').update(String(value)).digest('hex')
      },
      randomString(length: number) {
        randomCounter += 1
        const seed = createHash('sha256').update(`snapshot-test-${randomCounter}`).digest('hex')
        return seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
      },
    },
    console: { log() {}, error() {} },
    URL,
  })
  const event = (
    body: any = {},
    query: Record<string, string> = {},
    authId: string | null = 'user-1',
  ) => ({
    auth: authId ? { id: authId } : null,
    request: {
      context: () => ({ err: () => false }),
      url: { query: () => ({ get: (key: string) => query[key] ?? null }) },
    },
    requestInfo: () => ({ body, query }),
    json: (status: number, payload: any) => ({ status, body: payload }),
  })
  const dispatch = (
    method: string,
    route: string,
    body: any,
    query: Record<string, string>,
    authId: string | null,
  ) => {
    const registered = handlers.get(`${method} ${route}`)!
    for (const middleware of registered.middlewares) {
      if (middleware.kind === 'auth' && !authId)
        return { status: 401, body: { code: 'AUTH_REQUIRED' } }
      if (
        middleware.kind === 'bodyLimit' &&
        Buffer.byteLength(JSON.stringify(body), 'utf8') > Number(middleware.bytes || 0)
      )
        return { status: 413, body: { code: 'BODY_TOO_LARGE' } }
    }
    return registered.callback(event(body, query, authId))
  }
  return {
    db,
    executed,
    post(body: any, authId: string | null = 'user-1') {
      return dispatch('POST', '/backend/v1/prices/search', body, {}, authId)
    },
    get(query: Record<string, string>, authId: string | null = 'user-1') {
      return dispatch('GET', '/backend/v1/precos/busca', {}, query, authId)
    },
    seedRate(userId: string, requestCount: number, windowStartedAt = new Date().toISOString()) {
      db.prepare(
        `INSERT OR REPLACE INTO cotai_price_search_rate_limits
         (user_id, window_started_at, request_count, updated_at) VALUES (?, ?, ?, ?)`,
      ).run(userId, windowStartedAt, requestCount, windowStartedAt)
    },
    seedFreshnessAndDailyRun() {
      db.prepare(
        `INSERT INTO price_watermarks
         (fonte, last_watermark_date, status, amostras_coletadas_total, updated)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('PNCP', '2026-01-31', 'ok', 321, '2026-02-01T00:00:00.000Z')
      db.prepare(
        `INSERT INTO daily_sync_runs
         (ciclo_id, data_ciclo, status, finalizado_em, duracao_ms, novas_amostras,
          amostras_validadas, amostras_invalidadas, updated, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'cycle-1',
        '2026-02-01',
        'completed',
        '2026-02-01T00:01:00.000Z',
        60000,
        20,
        19,
        1,
        '2026-02-01T00:01:00.000Z',
        '2026-02-01T00:00:00.000Z',
      )
    },
    dropFts() {
      db.exec('DROP TABLE price_samples_fts')
    },
    insertRow: insertOne,
    updateRow(id: string, changes: Partial<PriceRow>) {
      const assignments = Object.keys(changes)
        .map((field) => `${field} = :${field}`)
        .join(', ')
      db.prepare(`UPDATE price_samples_index SET ${assignments} WHERE id = :id`).run({
        ...changes,
        id,
      } as any)
    },
    deleteRow(id: string) {
      db.prepare('DELETE FROM price_samples_index WHERE id = ?').run(id)
    },
  }
}

describe('fast secure price search', () => {
  it('requires authentication on POST and legacy GET before executing the handler', () => {
    const harness = searchHarness([row('1')])

    const post = harness.post({ termo: 'dipirona' }, null)
    const get = harness.get({ q: 'dipirona' }, null)

    expect(post).toMatchObject({ status: 401 })
    expect(get).toMatchObject({ status: 401 })
    expect(harness.executed).toHaveLength(0)
  })

  it('enforces a small POST body boundary before executing the handler', () => {
    const harness = searchHarness([row('1')])

    const result = harness.post({ termo: `dipirona${'x'.repeat(40 * 1024)}` })

    expect(result).toMatchObject({ status: 413 })
    expect(harness.executed).toHaveLength(0)
  })

  it('rejects empty, stopword-only and over-broad searches without scanning the price index', () => {
    const harness = searchHarness([row('1')])
    const invalid = [
      harness.post({ termo: '' }),
      harness.get({ q: 'de para com' }),
      harness.post({ termo: 'x'.repeat(241) }),
      harness.post({ termo: Array.from({ length: 17 }, (_, index) => `token${index}`).join(' ') }),
      harness.post({ termo: 'dipirona', page: 1001 }),
      harness.post({ termo: 'dipirona', limit: 201 }),
      harness.post({ termo: 'dipirona', data_inicio: '2026-99-99' }),
      harness.post({ termo: 'dipirona', data_inicio: '2026-02-01', data_fim: '2026-01-01' }),
      harness.post({ termo: 'dipirona', preco_min: -1 }),
      harness.post({ termo: 'dipirona', preco_min: 20, preco_max: 10 }),
      harness.post({ termo: 'dipirona', sources: ['fonte inventada'] }),
      harness.get({ q: 'dipirona', desconhecido: 'x'.repeat(9 * 1024) }),
    ]

    for (const result of invalid) {
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ sucesso: false })
    }
    expect(
      harness.executed.filter(({ sql }) => /price_samples_(?:index|fts)/.test(sql)),
    ).toHaveLength(0)

    expect(harness.post({ termo: 'CATMAT 151063' }).status).toBe(200)
    expect(harness.get({ q: 'CATSER 151063' }).status).toBe(200)
    expect(harness.post({ termo: 'dipirona', fonte: 'ambas' }).status).toBe(200)
    expect(harness.post({ termo: 'dipirona', sources: ['todas'] }).status).toBe(200)
  })

  it('enforces one transactional search quota shared by POST and GET and scoped by user', () => {
    const harness = searchHarness([row('1')])
    harness.seedRate('limited-user', 120)

    const rejectedPost = harness.post({ termo: 'dipirona' }, 'limited-user')
    const rejectedGet = harness.get({ q: 'dipirona' }, 'limited-user')
    const otherUser = harness.post({ termo: 'dipirona' }, 'other-user')

    expect(rejectedPost).toMatchObject({
      status: 429,
      body: { sucesso: false, code: 'SEARCH_RATE_LIMITED' },
    })
    expect(rejectedGet).toMatchObject({
      status: 429,
      body: { sucesso: false, code: 'SEARCH_RATE_LIMITED' },
    })
    expect(otherUser.status).toBe(200)
    expect(
      harness.db
        .prepare(
          'SELECT request_count FROM cotai_price_search_rate_limits WHERE user_id = ?',
        )
        .get('limited-user'),
    ).toMatchObject({ request_count: 120 })
  })

  it('applies every advanced filter globally to hits, counters and statistics', () => {
    const rows = [
      row('old-small', {
        source: 'PNCP',
        valor_unitario: 1.5,
        valor_total: 1.5,
        data_referencia: '2025-01-10',
        unidade: 'FRASCO 100 ML',
        marca: 'UNIÃO QUÍMICA',
        fornecedor_porte: 'ME / EPP',
        modalidade: 'PREGÃO ELETRÔNICO',
        natureza_preco: 'homologado',
      }),
      row('mid-other', {
        source: 'Compras.gov.br',
        uf: 'SP',
        valor_unitario: 5,
        valor_total: 5,
        data_referencia: '2026-03-10',
        unidade: 'COMPRIMIDO',
        marca: 'EMS',
        fornecedor_porte: 'DEMAIS',
        modalidade: 'DISPENSA',
        natureza_preco: 'estimado',
      }),
      row('recent-target', {
        source: 'PNCP',
        valor_unitario: 10,
        valor_total: 10,
        data_referencia: '2026-06-20T12:00:00.000Z',
        unidade: 'CAIXA COM COMPRIMIDO REVESTIDO',
        marca: 'UNIÃO QUÍMICA',
        fornecedor_porte: 'EPP',
        modalidade: 'PREGÃO ELETRÔNICO',
        natureza_preco: 'homologado',
      }),
    ]
    const harness = searchHarness(rows)
    const cases: Array<[Record<string, any>, string[], number, Record<string, number>]> = [
      [{ data_inicio: '2026-01-01' }, ['mid-other', 'recent-target'], 2, { PNCP: 1, 'Compras.gov.br': 1 }],
      [{ data_fim: '2025-12-31' }, ['old-small'], 1, { PNCP: 1, 'Compras.gov.br': 0 }],
      [{ preco_min: 4, preco_max: 6 }, ['mid-other'], 1, { PNCP: 0, 'Compras.gov.br': 1 }],
      [{ unidade: 'frasco 100ml' }, ['old-small'], 1, { PNCP: 1, 'Compras.gov.br': 0 }],
      [{ marca: 'uniao quimica' }, ['old-small', 'recent-target'], 2, { PNCP: 2, 'Compras.gov.br': 0 }],
      [{ porte: 'ME_EPP' }, ['old-small', 'recent-target'], 2, { PNCP: 2, 'Compras.gov.br': 0 }],
      [{ apenas_me_epp: true }, ['old-small', 'recent-target'], 2, { PNCP: 2, 'Compras.gov.br': 0 }],
      [{ modalidade: 'dispensa' }, ['mid-other'], 1, { PNCP: 0, 'Compras.gov.br': 1 }],
      [{ natureza_preco: 'estimado' }, ['mid-other'], 1, { PNCP: 0, 'Compras.gov.br': 1 }],
    ]

    for (const [filters, expectedIds, expectedTotal, expectedSources] of cases) {
      const result = harness.post({ termo: 'dipirona', limit: 50, ...filters })
      expect(result.status).toBe(200)
      expect(result.body.hits.map((hit: any) => hit.id)).toEqual(expectedIds)
      expect(result.body.total).toBe(expectedTotal)
      expect(result.body.aggregations.total).toBe(expectedTotal)
      expect(result.body.aggregations.estatisticas.n).toBe(expectedTotal)
      expect(result.body.aggregations.por_fonte).toEqual(expectedSources)
    }

    const combined = harness.post({
      termo: 'dipirona',
      data_inicio: '2026-01-01',
      data_fim: '2026-12-31',
      preco_min: 6,
      preco_max: 12,
      unidade: 'comprimido',
      marca: 'uniao quimica',
      porte: 'ME_EPP',
      modalidade: 'pregao',
      natureza_preco: 'homologado',
    })
    expect(combined.body).toMatchObject({
      total: 1,
      aggregations: {
        total: 1,
        por_fonte: { PNCP: 1, 'Compras.gov.br': 0 },
        estatisticas: { n: 1, minimo: 10, maximo: 10, media: 10 },
      },
    })
    expect(combined.body.hits.map((hit: any) => hit.id)).toEqual(['recent-target'])
  })

  it('preserves task, freshness and daily-cycle fields on the authenticated legacy GET', () => {
    const harness = searchHarness([row('1')], {
      tasks: [
        {
          id: 'task-1',
          task_key: 'AMBAS#DIPIRONA#ALL#OWNER#user-1',
          source: 'AMBAS',
          termo: 'dipirona',
          uf: '',
          status: 'running',
          paginas_consultadas: 4,
          itens_processados: 20,
          amostras_inseridas: 10,
          amostras_atualizadas: 2,
          tentativas: 1,
          pendentes: '[{"source":"PNCP"}]',
          updated: '2026-02-01T00:00:00.000Z',
          server_trust_version: 'server-v1',
        },
      ],
    })
    harness.seedFreshnessAndDailyRun()

    const result = harness.get({ q: 'dipirona' })

    expect(result.status).toBe(200)
    expect(result.body.status_tarefa).toMatchObject({
      id: 'task-1',
      task_key: 'AMBAS#DIPIRONA#ALL#OWNER#user-1',
      pendentes_count: 1,
    })
    expect(result.body.frescor_sincronizacao).toMatchObject({
      PNCP: { ultima_data_sincronizada: '2026-01-31', total_coletadas_watermark: 321 },
    })
    expect(result.body.ciclo_diario).toMatchObject({
      ciclo_id: 'cycle-1',
      status: 'completed',
      novas_amostras: 20,
    })
  })

  it('scans decimal official prices and aggregates through PocketBase JSVM DynamicModel types', () => {
    const harness = searchHarness(
      [
        row('decimal-1', {
          quantidade: 0.125,
          valor_unitario: 0.019,
          valor_total: 0.002375,
          matching_score: 97.5,
        }),
        row('decimal-2', {
          quantidade: 2.75,
          valor_unitario: 2.3456,
          valor_total: 6.4504,
          matching_score: 88.25,
        }),
      ],
      { enforceJsVmNumberTypes: true },
    )

    const post = harness.post({ termo: 'dipirona', limit: 50 })
    const get = harness.get({ q: 'dipirona', limit: '50' })

    expect(post.status).toBe(200)
    expect(get.status).toBe(200)
    expect(post.body.hits.map((hit: any) => hit.valor_unitario)).toEqual([0.019, 2.3456])
    expect(post.body.hits.map((hit: any) => hit.quantidade)).toEqual([0.125, 2.75])
    expect(post.body.hits.map((hit: any) => hit.valor_total)).toEqual([0.002375, 6.4504])
    expect(post.body.hits.map((hit: any) => hit.matching_score)).toEqual([97.5, 88.25])
    expect(post.body.aggregations.estatisticas).toMatchObject({
      minimo: 0.019,
      maximo: 2.3456,
      media: 1.1823,
    })
    expect(get.body.aggregations).toEqual(post.body.aggregations)
  })

  it('returns an empty successful result without scanning NULL page details', () => {
    const harness = searchHarness([row('other', { descricao_normalizada: 'CAFE TORRADO' })], {
      enforceJsVmNumberTypes: true,
    })

    const post = harness.post({ termo: 'servico inexistente', limit: 50 })
    const get = harness.get({ q: 'servico inexistente', limit: '50' })

    for (const result of [post, get]) {
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({ sucesso: true, total: 0, hits: [] })
      expect(result.body.aggregations).toMatchObject({
        total: 0,
        por_fonte: { PNCP: 0, 'Compras.gov.br': 0 },
        estatisticas: { n: 0, minimo: 0, maximo: 0 },
      })
    }
  })

  it('rejects numeric POST continuation while the read-only legacy GET keeps its old contract', () => {
    const harness = searchHarness([row('only', { valor_unitario: 1.2345 })], {
      enforceJsVmNumberTypes: true,
    })

    const post = harness.post({ termo: 'dipirona', page: 99, limit: 50 })
    const get = harness.get({ q: 'dipirona', page: '99', limit: '50' })

    expect(post).toMatchObject({
      status: 400,
      body: { sucesso: false, code: 'SEARCH_CURSOR_REQUIRED' },
    })
    expect(get.status).toBe(200)
    expect(get.body).toMatchObject({ sucesso: true, total: 1, page: 99, hits: [] })
    expect(get.body.aggregations).toMatchObject({ total: 1 })
  })

  it('matches significant words anywhere with multi-token AND, not token substrings', () => {
    const rows = [
      row('1', { valor_unitario: 1, source: 'PNCP', uf: 'CE' }),
      row('2', {
        valor_unitario: 2,
        source: 'Compras.gov.br',
        uf: 'SP',
        descricao_normalizada: 'SOLUCAO ORAL COM DIPIRONA SODICA',
      }),
      row('3', { valor_unitario: 3, descricao_normalizada: 'DIPIRONA SODICA COMPRIMIDO' }),
      row('4', { valor_unitario: 4, descricao_normalizada: 'DIPIRONAX SODICA COMPRIMIDO' }),
      row('5', { valor_unitario: 5, descricao_normalizada: 'DIPIRONA COMPRIMIDO' }),
    ]
    const result = searchHarness(rows).post({ termo: 'dipirona sódica', limit: 50 })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      sucesso: true,
      total: 3,
      aggregations: {
        total: 3,
        por_fonte: { PNCP: 2, 'Compras.gov.br': 1 },
        por_uf: { CE: 2, SP: 1 },
        estatisticas: { n: 3, minimo: 1, maximo: 3, media: 2, mediana: 2, q1: 1.5, q3: 2.5 },
      },
    })
    expect(result.body.hits.map((hit: any) => hit.id)).toEqual(['1', '2', '3'])
  })

  it('makes palavra_exata require one contiguous normalized phrase anywhere in the description', () => {
    const harness = searchHarness([
      row('phrase', {
        descricao_normalizada: 'CONTRATACAO DE MANUTENCAO PREDIAL PREVENTIVA',
      }),
      row('separated', {
        descricao_normalizada: 'MANUTENCAO PREVENTIVA DE EDIFICIO PREDIAL',
      }),
    ])

    expect(
      harness
        .post({ termo: 'manutenção predial', palavra_exata: false })
        .body.hits.map((hit: any) => hit.id),
    ).toEqual(['phrase', 'separated'])
    const exactPost = harness.post({ termo: 'manutenção predial', palavra_exata: true })
    const exactGet = harness.get({ q: 'manutenção predial', palavra_exata: 'true' })

    expect(exactPost.body.hits.map((hit: any) => hit.id)).toEqual(['phrase'])
    expect(exactGet.body.hits.map((hit: any) => hit.id)).toEqual(['phrase'])
    expect(exactPost.body.filtros_aplicados.palavra_exata).toBe(true)
    expect(exactGet.body.filtros_aplicados.palavra_exata).toBe(true)
  })

  it('recalls a conservative singular/plural variant in word mode without weakening exact mode', () => {
    const harness = searchHarness([
      row('plural', { descricao_normalizada: 'FORNECIMENTO DE PICOLES ARTESANAIS' }),
    ])

    expect(harness.post({ termo: 'picolé' }).body.hits.map((hit: any) => hit.id)).toEqual([
      'plural',
    ])
    expect(
      harness.post({ termo: 'picolé', palavra_exata: true }).body.hits.map((hit: any) => hit.id),
    ).toEqual([])
  })

  it('validates CNPJ and applies it globally to either buyer or supplier on POST and GET', () => {
    const buyer = '12.345.678/0001-99'
    const supplier = '98.765.432/0001-10'
    const harness = searchHarness([
      row('buyer', { orgao_cnpj: buyer }),
      row('supplier', { fornecedor_cnpj: supplier }),
      row('other', { orgao_cnpj: '00.000.000/0001-91' }),
    ])

    const byBuyer = harness.post({ termo: 'dipirona', cnpj: buyer })
    const bySupplier = harness.get({ q: 'dipirona', cnpj: supplier })

    expect(byBuyer.body.hits.map((hit: any) => hit.id)).toEqual(['buyer'])
    expect(byBuyer.body.aggregations.total).toBe(1)
    expect(byBuyer.body.filtros_aplicados.cnpj).toBe('12345678000199')
    expect(bySupplier.body.hits.map((hit: any) => hit.id)).toEqual(['supplier'])
    expect(bySupplier.body.aggregations.total).toBe(1)
    expect(bySupplier.body.filtros_aplicados.cnpj).toBe('98765432000110')
    expect(harness.post({ termo: 'dipirona', cnpj: '123' })).toMatchObject({
      status: 400,
      body: { code: 'SEARCH_INPUT_INVALID' },
    })
    expect(harness.post({ termo: 'dipirona', cnpj: `abc${buyer}` })).toMatchObject({
      status: 400,
      body: { code: 'SEARCH_INPUT_INVALID' },
    })
  })

  it('distinguishes CATMAT and CATSER while allowing a bare catalog code', () => {
    const rows = [
      row('1', { codigo_item: 'CATMAT 151063', descricao_normalizada: 'MEDICAMENTO A' }),
      row('2', { codigo_item: 'CATSER 151063', descricao_normalizada: 'SERVICO B' }),
    ]
    const harness = searchHarness(rows)

    expect(harness.post({ termo: 'CATMAT 151063' }).body.hits.map((hit: any) => hit.id)).toEqual([
      '1',
    ])
    expect(harness.post({ termo: 'CATSER 151063' }).body.hits.map((hit: any) => hit.id)).toEqual([
      '2',
    ])
    expect(harness.post({ termo: '151063' }).body.total).toBe(2)
  })

  it('fails explicitly when the mandatory text index is unavailable', () => {
    const harness = searchHarness([row('1')])
    harness.dropFts()

    const result = harness.post({ termo: 'dipirona' })

    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({
      sucesso: false,
      code: 'SEARCH_INDEX_UNAVAILABLE',
      etapa: 'fts',
    })
  })

  it('returns page and counters from one population snapshot without materializing all rows in JS', () => {
    const rows = Array.from({ length: 5_000 }, (_, index) =>
      row(String(index + 1), { valor_unitario: index + 10 }),
    )
    const injected = row('injected', { valor_unitario: 1 })
    const harness = searchHarness(rows, { injectAfterPopulation: injected })

    const result = harness.post({ termo: 'dipirona', limit: 25 })

    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body.total).toBe(5_000)
    expect(result.body.hits).toHaveLength(25)
    expect(result.body.hits[0].id).not.toBe('injected')
    const populationQueries = harness.executed.filter(
      ({ sql }) =>
        /price_samples_(?:index|fts)/.test(sql) &&
        !/^\s*EXPLAIN/i.test(sql) &&
        !/price_index_tasks/.test(sql),
    )
    expect(populationQueries).toHaveLength(2)
    // Only the first page crosses the JSVM boundary. The second statement
    // materializes immutable rows directly inside SQLite and reports only
    // the number of inserted rows, never the 5,000 matching DTOs.
    expect(
      Math.max(
        ...populationQueries
          .filter(({ operation }) => operation === 'all')
          .map(({ returned }) => returned),
      ),
    ).toBeLessThanOrEqual(25)
    expect(populationQueries.find(({ operation }) => operation === 'execute')).toMatchObject({
      returned: 5_000,
    })
    expect(populationQueries[0].sql).toContain('price_samples_fts MATCH')
    expect(populationQueries[0].sql).not.toContain('json_extract')
    expect(populationQueries[0].sql).not.toMatch(/descricao_normalizada\s+LIKE/i)

    const plan = harness.db
      .prepare(
        `EXPLAIN QUERY PLAN ${populationQueries[0].sql.replace(/\{:([A-Za-z0-9_]+)\}/g, ':$1')}`,
      )
      .all(populationQueries[0].params) as Array<{ detail: string }>
    expect(plan.map(({ detail }) => detail).join('\n')).toMatch(/VIRTUAL TABLE INDEX/i)
  })

  it(
    'keeps a 15,370-match first response bounded while materializing stable rows inside SQLite',
    { timeout: 20_000 },
    () => {
      const harness = searchHarness(
        Array.from({ length: 15_370 }, (_, index) =>
          row(`national-${String(index + 1).padStart(5, '0')}`, {
            valor_unitario: index + 1,
          }),
        ),
      )

      const startedAt = performance.now()
      const result = harness.post({ termo: 'dipirona', limit: 100 })
      const elapsedMs = performance.now() - startedAt

      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({
        total: 15_370,
        snapshot_window_count: 15_370,
        snapshot_population_complete: true,
        has_more: true,
      })
      expect(result.body.hits).toHaveLength(100)
      expect(
        harness.db.prepare('SELECT COUNT(*) AS n FROM cotai_price_search_snapshot_items').get(),
      ).toEqual({ n: 15_370 })
      const boundaryRows = harness.executed
        .filter(({ operation }) => operation === 'all')
        .map(({ returned }) => returned)
      expect(Math.max(...boundaryRows)).toBeLessThanOrEqual(100)
      expect(elapsedMs).toBeLessThan(5_000)
    },
  )

  it('keeps GET and POST on the same indexed population contract', () => {
    const rows = [
      row('1', { valor_unitario: 4 }),
      row('2', { valor_unitario: 8, source: 'Compras.gov.br', uf: 'SP' }),
    ]
    const harness = searchHarness(rows)

    const post = harness.post({ termo: 'dipirona', limit: 50 })
    const get = harness.get({ q: 'dipirona', limit: '50' })

    expect(get.body.total).toBe(post.body.total)
    expect(get.body.hits.map((hit: any) => hit.id)).toEqual(
      post.body.hits.map((hit: any) => hit.id),
    )
    expect(get.body.aggregations).toEqual(post.body.aggregations)
  })

  it('does not expose a newer task belonging to another user, source or UF', () => {
    const baseTask = {
      status: 'running',
      paginas_consultadas: 1,
      itens_processados: 1,
      amostras_inseridas: 1,
      amostras_atualizadas: 0,
      tentativas: 0,
      pendentes: '[]',
      server_trust_version: 'server-v1',
    }
    const harness = searchHarness([], {
      tasks: [
        {
          ...baseTask,
          id: 'correct',
          task_key: 'AMBAS#DIPIRONA#CE#OWNER#user-1',
          source: 'AMBAS',
          termo: 'dipirona',
          uf: 'CE',
          updated: '2026-01-01T00:00:00.000Z',
        },
        {
          ...baseTask,
          id: 'wrong-newer',
          task_key: 'AMBAS#DIPIRONA#CE#OWNER#intruder',
          source: 'AMBAS',
          termo: 'dipirona',
          uf: 'CE',
          requested_by: 'intruder',
          updated: '2099-01-01T00:00:00.000Z',
        },
      ],
    })

    const result = harness.post({ termo: 'dipirona', uf: 'CE' })

    expect(result.body.status_tarefa).toMatchObject({
      id: 'correct',
      task_key: 'AMBAS#DIPIRONA#CE#OWNER#user-1',
    })
  })
})

describe('materialized price-search snapshots', () => {
  it.each([101, 200])('rejects a page size of %i instead of creating an incompatible snapshot', (limit) => {
    const harness = searchHarness([row('limit-1')])

    expect(harness.post({ termo: 'dipirona', limit })).toMatchObject({
      status: 400,
      body: { code: 'SEARCH_INPUT_INVALID' },
    })
  })

  it('requires every cursorless search to start on page one', () => {
    const harness = searchHarness(Array.from({ length: 120 }, (_, index) => row(`page-${index}`)))

    expect(
      harness.post({ termo: 'dipirona', page: 2, limit: 50, include_summary: false }),
    ).toMatchObject({
      status: 400,
      body: { code: 'SEARCH_CURSOR_REQUIRED' },
    })
  })

  it('includes snapshot serialization and persistence in the reported request duration', () => {
    const harness = searchHarness(
      Array.from({ length: 120 }, (_, index) =>
        row(`timed-${index}`, { valor_unitario: index + 1 }),
      ),
      { snapshotPersistenceMs: 275 },
    )

    const first = harness.post({ termo: 'dipirona', limit: 20 })

    expect(first.status).toBe(200)
    expect(first.body.duracao_ms).toBe(275)
    expect(first.body.metricas_consulta.took_ms).toBe(275)
  })

  it('keeps page 2 identical after concurrent insert, update and delete', () => {
    const rows = Array.from({ length: 250 }, (_, index) =>
      row(`r${String(index + 1).padStart(3, '0')}`, { valor_unitario: index + 1 }),
    )
    const harness = searchHarness(rows)

    const first = harness.post({ termo: 'dipirona', limit: 100 })

    expect(first.status).toBe(200)
    expect(first.body.snapshot).toMatch(/^ps1_/)
    expect(first.body.next_cursor).toMatch(/^pc1_/)
    expect(first.body.has_more).toBe(true)
    expect(first.body.hits).toHaveLength(100)

    harness.insertRow(row('new-low', { valor_unitario: 0.5 }))
    harness.updateRow('r150', { valor_unitario: 99_999, descricao: 'ALTERADA DEPOIS' })
    harness.deleteRow('r160')

    const storedSecondPageFirstHit = JSON.parse(
      (harness.db
        .prepare('SELECT hit_json FROM cotai_price_search_snapshot_items WHERE position = 101')
        .get() as { hit_json: string }).hit_json,
    )
    expect(storedSecondPageFirstHit).toMatchObject({
      id: 'r101',
      source: 'PNCP',
      valor_unitario: 101,
    })
    expect(typeof storedSecondPageFirstHit.raw_payload).toBe('string')

    const second = harness.post({
      termo: 'dipirona',
      limit: 100,
      include_summary: false,
      snapshot: first.body.snapshot,
      cursor: first.body.next_cursor,
    })

    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body).toMatchObject({
      sucesso: true,
      summary_included: false,
      page: 2,
      snapshot: first.body.snapshot,
      has_more: true,
    })
    expect(second.body.hits.map((hit: any) => hit.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `r${String(index + 101).padStart(3, '0')}`),
    )
    expect(second.body.hits.find((hit: any) => hit.id === 'r150')).toMatchObject({
      valor_unitario: 150,
      descricao: 'FORNECIMENTO DE DIPIRONA SODICA 500MG',
    })
    expect(
      harness.executed
        .slice(-3)
        .some(({ sql }) => /FROM\s+price_samples_index|JOIN\s+price_samples_index/i.test(sql)),
    ).toBe(false)
  })

  it('rejects malformed, foreign, expired and mismatched continuations with stable codes', () => {
    const harness = searchHarness(
      Array.from({ length: 140 }, (_, index) =>
        row(`auth-${String(index + 1).padStart(3, '0')}`, { valor_unitario: index + 1 }),
      ),
    )
    const first = harness.post({ termo: 'dipirona', limit: 50, uf: 'CE' }, 'owner')

    expect(
      harness.post({ termo: 'dipirona', limit: 50, cursor: 'bad', snapshot: 'bad' }, 'owner'),
    ).toMatchObject({ status: 400, body: { code: 'SEARCH_CURSOR_INVALID' } })
    expect(
      harness.post({ termo: 'dipirona', limit: 50, cursor: `pc1_${'0'.repeat(64)}` }, 'owner'),
    ).toMatchObject({ status: 400, body: { code: 'SEARCH_CURSOR_INVALID' } })
    expect(
      harness.post(
        {
          termo: 'dipirona',
          limit: 50,
          uf: 'CE',
          cursor: first.body.next_cursor,
          snapshot: first.body.snapshot,
        },
        'intruder',
      ),
    ).toMatchObject({ status: 404, body: { code: 'SEARCH_SNAPSHOT_NOT_FOUND' } })
    expect(
      harness.post(
        {
          termo: 'dipirona',
          limit: 50,
          uf: 'SP',
          cursor: first.body.next_cursor,
          snapshot: first.body.snapshot,
        },
        'owner',
      ),
    ).toMatchObject({ status: 409, body: { code: 'SEARCH_SNAPSHOT_MISMATCH' } })
    expect(
      harness.post(
        {
          termo: 'dipirona',
          limit: 50,
          uf: 'CE',
          cursor: `pc1_${'0'.repeat(64)}`,
          snapshot: first.body.snapshot,
        },
        'owner',
      ),
    ).toMatchObject({ status: 409, body: { code: 'SEARCH_SNAPSHOT_MISMATCH' } })

    harness.db
      .prepare('UPDATE cotai_price_search_snapshots SET expires_at = ?')
      .run('2000-01-01T00:00:00.000Z')
    expect(
      harness.post(
        {
          termo: 'dipirona',
          limit: 50,
          uf: 'CE',
          cursor: first.body.next_cursor,
          snapshot: first.body.snapshot,
        },
        'owner',
      ),
    ).toMatchObject({ status: 410, body: { code: 'SEARCH_SNAPSHOT_EXPIRED' } })
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM cotai_price_search_snapshots').get(),
    ).toEqual({ n: 0 })
  })

  it('binds every effective filter, ordering and page-size field into the snapshot identity', () => {
    const harness = searchHarness(
      Array.from({ length: 120 }, (_, index) => row(`filters-${index}`, { valor_unitario: index + 1 })),
    )
    const base = {
      termo: 'dipirona',
      limit: 20,
      sources: ['PNCP'],
      uf: 'CE',
      periodo_meses: 24,
      data_inicio: '2025-01-01',
      data_fim: '2026-12-31',
      preco_min: 1,
      preco_max: 1_000,
      modalidade: 'pregao',
      natureza_preco: 'homologado',
      unidade: 'unidade',
      marca: 'nao',
      porte: 'DEMAIS',
      apenas_me_epp: false,
      sort: 'valor_unitario:asc',
    }
    const first = harness.post(base)
    const continuation = {
      cursor: first.body.next_cursor,
      snapshot: first.body.snapshot,
      include_summary: false,
    }
    const variants = [
      { termo: 'ibuprofeno' },
      { limit: 19 },
      { sources: ['Compras.gov.br'] },
      { uf: 'SP' },
      { periodo_meses: 12 },
      { data_inicio: '2025-02-01' },
      { data_fim: '2026-11-30' },
      { preco_min: 2 },
      { preco_max: 999 },
      { modalidade: 'dispensa' },
      { natureza_preco: 'estimado' },
      { unidade: 'caixa' },
      { marca: 'marca' },
      { porte: 'ME_EPP' },
      { apenas_me_epp: true },
      { sort: 'valor_unitario:desc' },
    ]

    for (const variant of variants) {
      expect(harness.post({ ...base, ...continuation, ...variant })).toMatchObject({
        status: 409,
        body: { code: 'SEARCH_SNAPSHOT_MISMATCH' },
      })
    }
  })

  it('reuses a cursor idempotently and never stores the bearer snapshot token', () => {
    const harness = searchHarness(
      Array.from({ length: 180 }, (_, index) => row(`reuse-${index}`, { valor_unitario: index })),
    )
    const first = harness.post({ termo: 'dipirona', limit: 60 })
    const request = {
      termo: 'dipirona',
      limit: 60,
      include_summary: false,
      cursor: first.body.next_cursor,
      snapshot: first.body.snapshot,
    }

    const a = harness.post(request)
    const b = harness.post(request)

    expect({ ...a, body: { ...a.body, duracao_ms: 0 } }).toEqual({
      ...b,
      body: { ...b.body, duracao_ms: 0 },
    })
    expect(a.body.hits).toHaveLength(60)
    const stored = harness.db
      .prepare('SELECT token_hash FROM cotai_price_search_snapshots')
      .get() as { token_hash: string }
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.token_hash).not.toBe(first.body.snapshot)
  })

  it.each([
    'valor_unitario:asc',
    'valor_unitario:desc',
    'data_referencia:asc',
    'data_referencia:desc',
  ])('keeps deterministic ties across pages for %s', (sort) => {
    const candidates = Array.from({ length: 130 }, (_, index) =>
      row(`tie-${String(index).padStart(3, '0')}`, {
        valor_unitario: Math.floor(index / 5) + 1,
        data_referencia: `2026-01-${String(1 + Math.floor(index / 10)).padStart(2, '0')}`,
      }),
    )
    const expected = candidates.slice().sort((left, right) => {
      if (sort === 'valor_unitario:asc' || sort === 'valor_unitario:desc') {
        const value = left.valor_unitario - right.valor_unitario
        if (value) return sort.endsWith(':desc') ? -value : value
        return left.id.localeCompare(right.id)
      }
      const date = String(left.data_referencia).localeCompare(String(right.data_referencia))
      if (date) return sort.endsWith(':desc') ? -date : date
      return left.valor_unitario - right.valor_unitario || left.id.localeCompare(right.id)
    })
    const harness = searchHarness(candidates)
    const first = harness.post({ termo: 'dipirona', limit: 50, sort })
    const second = harness.post({
      termo: 'dipirona',
      limit: 50,
      sort,
      include_summary: false,
      cursor: first.body.next_cursor,
      snapshot: first.body.snapshot,
    })

    expect([...first.body.hits, ...second.body.hits].map((hit: any) => hit.id)).toEqual(
      expected.slice(0, 100).map(({ id }) => id),
    )
  })

  it('exposes every row beyond the former 600-hit cutoff through the stable cursor', () => {
    const complete = searchHarness(
      Array.from({ length: 550 }, (_, index) => row(`complete-${index}`, { valor_unitario: index + 1 })),
    ).post({ termo: 'dipirona', limit: 100 })
    expect(complete.body).toMatchObject({
      snapshot_window_count: 550,
      snapshot_population_complete: true,
      population_has_more: false,
    })

    const boundedHarness = searchHarness(
      Array.from({ length: 650 }, (_, index) => row(`bounded-${index}`, { valor_unitario: index + 1 })),
    )
    const bounded = boundedHarness.post({ termo: 'dipirona', limit: 100 })
    expect(bounded.body).toMatchObject({
      total: 650,
      snapshot_window_count: 650,
      snapshot_population_complete: true,
      population_has_more: false,
      has_more: true,
    })
    let page = bounded
    const ids = bounded.body.hits.map((hit: any) => hit.id)
    for (let index = 2; index <= 7; index++) {
      page = boundedHarness.post({
        termo: 'dipirona',
        limit: 100,
        include_summary: false,
        cursor: page.body.next_cursor,
        snapshot: bounded.body.snapshot,
      })
      ids.push(...page.body.hits.map((hit: any) => hit.id))
    }
    expect(page.body).toMatchObject({
      page: 7,
      has_more: false,
      next_cursor: null,
      population_has_more: false,
    })
    expect(page.body.hits).toHaveLength(50)
    expect(new Set(ids).size).toBe(650)
  })

  it('keeps at most three live snapshots per owner and cleans expired rows opportunistically', () => {
    const harness = searchHarness(
      Array.from({ length: 120 }, (_, index) => row(`quota-${index}`, { valor_unitario: index + 1 })),
    )
    for (let index = 0; index < 5; index++) {
      expect(harness.post({ termo: 'dipirona', limit: 20 }).status).toBe(200)
    }
    expect(
      harness.db
        .prepare(
          "SELECT COUNT(*) AS n FROM cotai_price_search_snapshots WHERE owner_user_id = 'user-1'",
        )
        .get(),
    ).toEqual({ n: 3 })

    harness.db
      .prepare(
        "UPDATE cotai_price_search_snapshots SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = (SELECT id FROM cotai_price_search_snapshots LIMIT 1)",
      )
      .run()
    expect(harness.post({ termo: 'dipirona', limit: 20 }).status).toBe(200)
    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM cotai_price_search_snapshots WHERE expires_at <= '2000-01-02'")
        .get(),
    ).toEqual({ n: 0 })
  })

  it('fails closed when a materialized page is missing instead of querying OFFSET', () => {
    const harness = searchHarness(
      Array.from({ length: 120 }, (_, index) => row(`missing-${index}`, { valor_unitario: index + 1 })),
    )
    const first = harness.post({ termo: 'dipirona', limit: 50 })
    harness.db
      .prepare('DELETE FROM cotai_price_search_snapshot_items WHERE position BETWEEN 51 AND 100')
      .run()
    const continuationStart = harness.executed.length

    const result = harness.post({
      termo: 'dipirona',
      limit: 50,
      include_summary: false,
      cursor: first.body.next_cursor,
      snapshot: first.body.snapshot,
    })

    expect(result).toMatchObject({
      status: 503,
      body: { code: 'SEARCH_SNAPSHOT_UNAVAILABLE' },
    })
    expect(
      harness.executed
        .slice(continuationStart)
        .some(({ sql }) => /FROM\s+price_samples_index|JOIN\s+price_samples_index/i.test(sql)),
    ).toBe(false)
  })

  it('stores only a compact official-evidence DTO and drops unrelated large raw fields', () => {
    const raw = {
      codigo_item: '151063',
      tipoCatalogo: 'CATMAT',
      debug_blob: 'x'.repeat(200_000),
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'PNCP',
        campo_unitario: 'valorUnitarioHomologado',
        valor_unitario: 10,
        url_evidencia:
          'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/1/itens/1',
        identidade: { cnpj: '00000000000001', ano: 2026, sequencial: 1, numeroItem: 1 },
        registro_oficial: { valorUnitarioHomologado: 10 },
        auditoria_extra: { lote: 'A-17' },
      },
    }
    const harness = searchHarness(
      Array.from({ length: 25 }, (_, index) =>
        row(`compact-${index}`, { valor_unitario: 10, raw_payload: raw }),
      ),
    )

    const result = harness.post({ termo: 'dipirona', limit: 10 })

    expect(result.status).toBe(200)
    const proof = JSON.parse(result.body.hits[0].raw_payload)
    expect(proof).toMatchObject({
      codigo_item: '151063',
      tipoCatalogo: 'CATMAT',
      proveniencia_preco: {
        status: 'verificada',
        campo_unitario: 'valorUnitarioHomologado',
        registro_oficial: { valorUnitarioHomologado: 10 },
        auditoria_extra: { lote: 'A-17' },
      },
    })
    expect(JSON.stringify(proof)).not.toContain('debug_blob')
    const storedBytes = harness.db
      .prepare('SELECT SUM(length(CAST(hit_json AS BLOB))) AS bytes FROM cotai_price_search_snapshot_items')
      .get() as { bytes: number }
    expect(storedBytes.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('fails closed when a required proof field makes one snapshot hit exceed its byte cap', () => {
    const hugeProof = {
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'PNCP',
        campo_unitario: 'valorUnitarioHomologado',
        valor_unitario: 10,
        url_evidencia: `https://pncp.gov.br/${'x'.repeat(40_000)}`,
        identidade: { cnpj: '00000000000001', ano: 2026, sequencial: 1, numeroItem: 1 },
        registro_oficial: { valorUnitarioHomologado: 10 },
      },
    }
    const harness = searchHarness([
      row('huge-proof-1', { raw_payload: hugeProof }),
      row('huge-proof-2'),
    ])

    expect(harness.post({ termo: 'dipirona', limit: 1 })).toMatchObject({
      status: 503,
      body: { code: 'SEARCH_SNAPSHOT_UNAVAILABLE' },
    })
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM cotai_price_search_snapshots').get(),
    ).toEqual({ count: 0 })
  })

  it('preserves a complete Compras proof and derives its bare catalog identity in the compact DTO', () => {
    const evidenceUrl =
      'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial' +
      '?tipo=codigoItemCatalogo&codigo=151063&pagina=1&tamanhoPagina=500'
    const proof = {
      versao: 1,
      status: 'verificada',
      fonte: 'Compras.gov.br',
      campo_unitario: 'precoUnitario',
      valor_unitario: 12.5,
      natureza: 'homologado',
      data_oficial: '2025-03-13',
      campo_data: 'dataResultado',
      url_evidencia: evidenceUrl,
      identidade: {
        tipo: 'material',
        codigoCatalogo: '151063',
        idCompra: '15836906900012025',
        idItemCompra: '7670225',
        numeroItemCompra: 1,
        fornecedor: '51340170000156',
      },
      contexto_consulta: {
        tipo: 'material',
        codigo: '151063',
        pagina: 1,
        tamanhoPagina: 500,
      },
      registro_oficial: {
        idCompra: '15836906900012025',
        idItemCompra: '7670225',
        idCompraItem: '15836906900012025-7670225',
        numeroItemCompra: 1,
        codigoItemCatalogo: '151063',
        codigoCatmat: '151063',
        cnpjFornecedor: '51340170000156',
        precoUnitario: 12.5,
        dataResultado: '2025-03-13',
        unidadeMedida: 'UNIDADE',
        quantidade: 1,
      },
      auditoria_extra: { lote: 'COMPRA-9' },
    }
    const harness = searchHarness(
      Array.from({ length: 12 }, (_, index) =>
        row(`compras-proof-${index}`, {
          source: 'Compras.gov.br',
          codigo_item: 'CATMAT 151063',
          valor_unitario: 12.5,
          raw_payload: { proveniencia_preco: proof },
        }),
      ),
    )

    const result = harness.post({ termo: 'dipirona', limit: 10 })
    const compact = JSON.parse(result.body.hits[0].raw_payload)

    expect(result.status).toBe(200)
    expect(compact.codigo_item).toBe('151063')
    expect(compact.codigoCatalogo).toBe('151063')
    expect(compact.tipoCatalogo).toBe('CATMAT')
    expect(compact.proveniencia_preco).toEqual(proof)
    expect(isEligibleComprasOfficialProof(compact.proveniencia_preco, 12.5)).toBe(true)
  })

  it('fails closed when the complete snapshot exceeds its 32 MiB storage budget', () => {
    const description = `DIPIRONA ${'X'.repeat(13_000)}`
    const harness = searchHarness(
      Array.from({ length: 1_300 }, (_, index) =>
        row(`total-bound-${index}`, {
          descricao: description,
          descricao_normalizada: description,
          valor_unitario: index + 1,
        }),
      ),
    )

    expect(harness.post({ termo: 'dipirona', limit: 100 })).toMatchObject({
      status: 503,
      body: { code: 'SEARCH_SNAPSHOT_UNAVAILABLE' },
    })
  })

  it('rejects a corrupt materialized hit without querying the live index', () => {
    const harness = searchHarness(
      Array.from({ length: 120 }, (_, index) => row(`corrupt-${index}`, { valor_unitario: index + 1 })),
    )
    const first = harness.post({ termo: 'dipirona', limit: 50 })
    harness.db
      .prepare('UPDATE cotai_price_search_snapshot_items SET hit_json = ? WHERE position = 51')
      .run('{}')
    const continuationStart = harness.executed.length

    expect(
      harness.post({
        termo: 'dipirona',
        limit: 50,
        cursor: first.body.next_cursor,
        snapshot: first.body.snapshot,
      }),
    ).toMatchObject({ status: 503, body: { code: 'SEARCH_SNAPSHOT_UNAVAILABLE' } })
    expect(
      harness.executed
        .slice(continuationStart)
        .some(({ sql }) => /FROM\s+price_samples_index|JOIN\s+price_samples_index/i.test(sql)),
    ).toBe(false)
  })
})
