import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../pocketbase/hooks/prices_search.js', import.meta.url),
  'utf8',
)
const indexBatchSource = readFileSync(
  new URL('../pocketbase/hooks/index_batch.js', import.meta.url),
  'utf8',
)
const workerHookSource = readFileSync(
  new URL('../pocketbase/hooks/price_index_worker.js', import.meta.url),
  'utf8',
)

const STRICT_CONTRACT = 'cotai-official-price-v3'

function strictSeal(sourceName: string, sampleKey: string, recordId: string) {
  const parts = [STRICT_CONTRACT, sourceName, sampleKey, recordId]
  const material = parts.map((part) => `${part.length}:${part}`).join('|')
  return {
    contrato: STRICT_CONTRACT,
    fonte: sourceName,
    sample_key: sampleKey,
    source_record_id: recordId,
    assinatura: createHash('sha256').update(material).digest('hex'),
  }
}

function pncpRow(
  index: number,
  corrupt?: 'identity' | 'url' | 'unsealed' | 'seal_source' | 'seal_key' | 'seal_record' | 'seal_signature',
) {
  const sourceName = 'PNCP'
  const cnpj = corrupt === 'identity' ? '123' : '00000000000001'
  const item = index + 1
  const recordId = `${cnpj}/2026/9/itens/${item}`
  const sampleKey = `PNCP#${index}`
  const evidence =
    corrupt === 'url'
      ? 'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/999'
      : `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/2026/9/itens/${item}`
  const proof: any = {
    versao: 1,
    status: 'verificada',
    fonte: sourceName,
    campo_unitario: 'valorUnitarioHomologado',
    valor_unitario: 2.5,
    natureza: 'homologado',
    url_evidencia: evidence,
    identidade: { cnpj, ano: 2026, sequencial: 9, numeroItem: item },
    registro_oficial: { numeroItem: item, valorUnitarioHomologado: 2.5 },
  }
  const serverSeal = strictSeal(sourceName, sampleKey, recordId)
  if (corrupt !== 'unsealed') {
    proof.validacao_indice = { ...serverSeal }
    if (corrupt === 'seal_source') proof.validacao_indice.fonte = 'Compras.gov.br'
    if (corrupt === 'seal_key') proof.validacao_indice.sample_key = 'PNCP#FORGED'
    if (corrupt === 'seal_record') proof.validacao_indice.source_record_id = 'FORGED-RECORD'
    if (corrupt === 'seal_signature' || corrupt === 'identity' || corrupt === 'url') {
      proof.validacao_indice.assinatura = 'f'.repeat(64)
    }
  }
  return {
    id: `pncp-${index}`,
    sample_key: sampleKey,
    source: sourceName,
    source_record_id: recordId,
    purchase_id: recordId,
    item_id: String(item),
    descricao: `FORNECIMENTO DE DIPIRONA ITEM ${item}`,
    descricao_normalizada: `FORNECIMENTO DE DIPIRONA ITEM ${item}`,
    orgao_cnpj: cnpj,
    uf: 'CE',
    valor_unitario: 2.5,
    natureza_preco: 'homologado',
    url_original: `https://pncp.gov.br/app/editais/${cnpj}/2026/9`,
    payload_hash: corrupt === 'unsealed' ? '' : serverSeal.assinatura,
    server_trust_version: 'server-v1',
    raw_payload: JSON.stringify({ numeroItem: item, proveniencia_preco: proof }),
    qualidade_situacao: 'aceita',
  }
}

function comprasRow(index: number, corrupt?: 'context' | 'identity') {
  const sourceName = 'Compras.gov.br'
  const code = '151063'
  const item = String(index + 1)
  const purchase = `COMPRA-${index + 1}`
  const supplier = '00000000000002'
  const date = '2026-01-01'
  const recordId = ['CATMAT', purchase, item, date, supplier].map(encodeURIComponent).join('#')
  const sampleKey = `COMPRAS#${index}`
  const evidence =
    'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial' +
    '?tipo=codigoItemCatalogo&codigo=151063&pagina=1&tamanhoPagina=500'
  const serverSeal = strictSeal(sourceName, sampleKey, recordId)
  const proof: any = {
    versao: 1,
    status: 'verificada',
    fonte: sourceName,
    campo_unitario: 'precoUnitarioHomologado',
    valor_unitario: 3.75,
    natureza: 'homologado',
    campo_data: 'dataResultado',
    data_oficial: date,
    url_evidencia: evidence,
    identidade: {
      tipo: 'material',
      codigoCatalogo: code,
      idCompra: corrupt === 'identity' ? 'OUTRA-COMPRA' : purchase,
      idItemCompra: item,
      numeroItemCompra: item,
      fornecedor: supplier,
    },
    contexto_consulta:
      corrupt === 'context'
        ? undefined
        : {
            seletor: 'codigoItemCatalogo',
            tipo: 'material',
            codigo: code,
            pagina: 1,
            tamanhoPagina: 500,
          },
    registro_oficial: {
      idCompra: purchase,
      idItemCompra: item,
      numeroItemCompra: item,
      cnpjFornecedor: supplier,
      codigoItemCatalogo: code,
      codigoCatmat: code,
      precoUnitarioHomologado: 3.75,
      dataResultado: date,
    },
    validacao_indice: { ...serverSeal },
  }
  if (corrupt) proof.validacao_indice.assinatura = 'e'.repeat(64)
  return {
    id: `compras-${index}`,
    sample_key: sampleKey,
    source: sourceName,
    source_record_id: recordId,
    purchase_id: recordId,
    item_id: item,
    descricao: `AQUISICAO DE DIPIRONA ITEM ${item}`,
    descricao_normalizada: `AQUISICAO DE DIPIRONA ITEM ${item}`,
    fornecedor_cnpj: supplier,
    uf: 'SP',
    valor_unitario: 3.75,
    natureza_preco: 'homologado',
    data_referencia: date,
    codigo_item: `CATMAT ${code}`,
    url_original: evidence,
    payload_hash: serverSeal.assinatura,
    server_trust_version: 'server-v1',
    raw_payload: JSON.stringify({ codigo_item: code, tipoCatalogo: 'CATMAT', proveniencia_preco: proof }),
    qualidade_situacao: 'aceita',
  }
}

type SearchRow = ReturnType<typeof pncpRow> | ReturnType<typeof comprasRow>

function sealWorkerRowThroughActualIndexBatch(row: SearchRow) {
  let handler: (event: any) => any
  let stored: any = null
  let receiptData: any = null
  class FakeRecord {
    data: { [key: string]: unknown } = {}
    constructor(_collection: unknown) {}
    set(key: string, value: unknown) {
      this.data[key] = structuredClone(value)
    }
    get(key: string) {
      return this.data[key]
    }
    getString(key: string) {
      return String(this.data[key] ?? '')
    }
  }
  const app = {
    findFirstRecordByData() {
      if (!receiptData) throw new Error('not found')
      const record = new FakeRecord(null)
      record.data = structuredClone(receiptData)
      return record
    },
    runInTransaction(callback: (tx: any) => void) {
      callback({
        findCollectionByNameOrId: () => ({ name: 'price_samples_index' }),
        findRecordsByFilter: () => [],
        save(record: FakeRecord) {
          stored = structuredClone(record.data)
        },
      })
    },
  }
  vm.runInNewContext(indexBatchSource, {
    routerAdd(_method: string, _route: string, callback: typeof handler) {
      handler = callback
    },
    $apis: { requireAuth: () => ({}), bodyLimit: () => ({}) },
    $app: app,
    $security: {
      sha256(value: string) {
        return createHash('sha256').update(value).digest('hex')
      },
    },
    Record: FakeRecord,
  })
  const input = structuredClone(row) as any
  input.raw_payload = JSON.parse(String(input.raw_payload))
  delete input.raw_payload.proveniencia_preco.validacao_indice
  delete input.payload_hash
  const canonical = (value: any): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  const fields = [
    'sample_key', 'source', 'source_record_id', 'purchase_id', 'item_id', 'descricao',
    'descricao_normalizada', 'orgao', 'orgao_cnpj', 'fornecedor_nome', 'fornecedor_cnpj',
    'fornecedor_porte', 'uf', 'municipio', 'unidade', 'quantidade', 'valor_unitario',
    'valor_total', 'natureza_preco', 'data_referencia', 'numero_processo', 'numero_ata',
    'modalidade', 'marca', 'codigo_item', 'url_original', 'raw_payload',
  ]
  const contract = Object.fromEntries(fields.map((field) => [field, input[field] == null ? null : input[field]]))
  const token = `R${'a'.repeat(63)}`
  const queryHash = 'b'.repeat(64)
  const claimKey = 'c'.repeat(64)
  receiptData = {
    user_id: 'TEST',
    source: input.source,
    query_hash: queryHash,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    claims: [{
      key: claimKey,
      record_hash: createHash('sha256').update(canonical(input.raw_payload.proveniencia_preco.registro_oficial)).digest('hex'),
      row_hash: createHash('sha256').update(canonical(contract)).digest('hex'),
      source_record_id: input.source_record_id,
      item_id: input.item_id,
      description: input.descricao,
      unit_price: input.valor_unitario,
      url_original: input.url_original,
    }],
  }
  input._ingestion_receipt = { token, query_hash: queryHash, claim_key: claimKey }
  const response = handler!({
    auth: { id: 'TEST' },
    requestInfo: () => ({ body: { amostras: [input] } }),
    json: (status: number, body: any) => ({ status, body }),
  })
  return {
    response,
    row: stored
      ? ({
          ...row,
          sample_key: stored.sample_key,
          source: stored.source,
          source_record_id: stored.source_record_id,
          purchase_id: stored.purchase_id,
          item_id: stored.item_id,
          payload_hash: stored.payload_hash,
          server_trust_version: stored.server_trust_version,
          qualidade_situacao: 'aceita',
          raw_payload: JSON.stringify(stored.raw_payload),
        } as SearchRow)
      : null,
  }
}

function workerPncpRow(index: number) {
  const row = pncpRow(index) as any
  row.sample_key =
    'PNCP#' +
    row.source_record_id.replace(/[^A-Z0-9_-]/gi, '') +
    '#' +
    row.item_id +
    '#' +
    String(row.orgao_cnpj).replace(/\D/g, '') +
    '#' +
    Number(row.valor_unitario).toFixed(4).replace('.', '_')
  return row as SearchRow
}

function validateThroughActualWorker(row: SearchRow) {
  const start = workerHookSource.indexOf('function gerarSampleKeyUtil(amostra)')
  const end = workerHookSource.indexOf('// Persistência progressiva', start)
  if (start < 0 || end < 0) throw new Error('worker strict helper not found')
  const context: any = {
    candidate: structuredClone({
      ...row,
      raw_payload: JSON.parse(String(row.raw_payload)),
    }),
    $security: {
      sha256(value: string) {
        return createHash('sha256').update(value).digest('hex')
      },
    },
  }
  vm.runInNewContext(
    `${workerHookSource.slice(start, end)}\nresult = validarESelarAmostraPncpWorker(candidate)`,
    context,
  )
  return context.result as { raw_payload: any; payload_hash: string } | null
}

function createDatabase(rows: SearchRow[], tasks: any[] = []) {
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
      last_validated_at TEXT,
      server_trust_version TEXT, search_eligible INTEGER DEFAULT 0,
      search_contract TEXT DEFAULT ''
    );
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
      amostras_atualizadas INTEGER, tentativas INTEGER, pendentes TEXT, updated TEXT
      , server_trust_version TEXT
    );
    CREATE TABLE cotai_price_search_rate_limits (
      user_id TEXT PRIMARY KEY NOT NULL,
      window_started_at TEXT NOT NULL,
      request_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE cotai_price_search_snapshots (
      id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL, query_hash TEXT NOT NULL, cursor_secret TEXT NOT NULL,
      sort_name TEXT NOT NULL, page_size INTEGER NOT NULL, page_count INTEGER NOT NULL,
      captured_count INTEGER NOT NULL, total_count INTEGER NOT NULL,
      population_complete INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE cotai_price_search_snapshot_pages (
      snapshot_id TEXT NOT NULL, page_no INTEGER NOT NULL, hits_json TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, page_no)
    ) WITHOUT ROWID;
  `)
  const insert = db.prepare(`
    INSERT INTO price_samples_index (
      id, sample_key, source, source_record_id, purchase_id, item_id, descricao,
      descricao_normalizada, orgao_cnpj, fornecedor_cnpj, uf, valor_unitario,
      natureza_preco, data_referencia, codigo_item, url_original, payload_hash, raw_payload,
      qualidade_situacao, server_trust_version, search_eligible, search_contract
    ) VALUES (
      :id, :sample_key, :source, :source_record_id, :purchase_id, :item_id, :descricao,
      :descricao_normalizada, :orgao_cnpj, :fornecedor_cnpj, :uf, :valor_unitario,
      :natureza_preco, :data_referencia, :codigo_item, :url_original, :payload_hash, :raw_payload,
      :qualidade_situacao, :server_trust_version, :search_eligible, :search_contract
    )
  `)
  db.exec('BEGIN')
  for (const row of rows) {
    let eligible = 0
    try {
      const proof = JSON.parse(String(row.raw_payload)).proveniencia_preco
      eligible =
        row.server_trust_version === 'server-v1' &&
        (row.source === 'PNCP' || row.source === 'Compras.gov.br') &&
        Number(row.valor_unitario) > 0 &&
        row.qualidade_situacao !== 'rejeitada' &&
        proof?.status === 'verificada' &&
        proof?.fonte === row.source &&
        Number(proof?.valor_unitario) === Number(row.valor_unitario) &&
        proof?.validacao_indice?.contrato === STRICT_CONTRACT &&
        proof?.validacao_indice?.fonte === row.source &&
        proof?.validacao_indice?.sample_key === row.sample_key &&
        proof?.validacao_indice?.source_record_id === row.source_record_id &&
        proof?.validacao_indice?.assinatura === row.payload_hash &&
        /^[0-9a-f]{64}$/.test(String(row.payload_hash || ''))
          ? 1
          : 0
    } catch {}
    insert.run({
      orgao_cnpj: '',
      fornecedor_cnpj: '',
      data_referencia: '',
      codigo_item: '',
      search_eligible: eligible,
      search_contract: eligible ? STRICT_CONTRACT : '',
      ...row,
    })
  }
  const insertTask = db.prepare(`
    INSERT INTO price_index_tasks (
      id, task_key, source, termo, uf, status, paginas_consultadas, itens_processados,
      amostras_inseridas, amostras_atualizadas, tentativas, pendentes, updated,
      server_trust_version
    ) VALUES (
      :id, :task_key, :source, :termo, :uf, :status, :paginas_consultadas,
      :itens_processados, :amostras_inseridas, :amostras_atualizadas, :tentativas,
      :pendentes, :updated, :server_trust_version
    )
  `)
  for (const task of tasks) insertTask.run(task)
  db.exec('COMMIT')
  db.exec(`
    CREATE VIRTUAL TABLE price_samples_fts USING fts5(
      sample_id UNINDEXED,
      descricao_normalizada,
      codigo_item,
      tokenize='unicode61 remove_diacritics 2'
    );
    INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, codigo_item)
    SELECT rowid, id, COALESCE(descricao_normalizada, ''), COALESCE(codigo_item, '')
    FROM price_samples_index
    WHERE search_eligible = 1
      AND search_contract = '${STRICT_CONTRACT}'
      AND server_trust_version = 'server-v1'
      AND source IN ('PNCP', 'Compras.gov.br')
      AND valor_unitario > 0
      AND (qualidade_situacao IS NULL OR qualidade_situacao != 'rejeitada');
  `)
  return db
}

function searchHarness(rows: SearchRow[], tasks: any[] = []) {
  const db = createDatabase(rows, tasks)
  const handlers = new Map<string, (event: any) => any>()
  const pocketbaseSql = (sql: string) => sql.replace(/\{:([A-Za-z0-9_]+)\}/g, ':$1')
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
        all(target: any[]) {
          target.push(...db.prepare(pocketbaseSql(sql)).all(params))
        },
        one(target: Record<string, unknown>) {
          Object.assign(target, db.prepare(pocketbaseSql(sql)).get(params) || {})
        },
        execute() {
          return db.prepare(pocketbaseSql(sql)).run(params)
        },
      }
    },
  }
  const app = {
    db: () => dbAdapter,
    runInTransaction(callback: (txApp: any) => void) {
      db.exec('BEGIN IMMEDIATE')
      try {
        callback({ db: () => dbAdapter })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  vm.runInNewContext(source, {
    routerAdd(method: string, route: string, callback: (event: any) => any) {
      handlers.set(`${method} ${route}`, callback)
    },
    $app: app,
    $apis: { requireAuth: () => ({}), bodyLimit: () => ({}) },
    DynamicModel: class DynamicModel {
      constructor(initial: Record<string, unknown>) {
        Object.assign(this, initial)
      }
    },
    arrayOf: () => [],
    $security: {
      sha256(value: string) {
        return createHash('sha256').update(String(value)).digest('hex')
      },
      randomString(length: number) {
        return 'r'.repeat(length)
      },
    },
    console: { log() {}, error() {} },
    URL,
  })
  const response = (body: any = {}, query: Record<string, string> = {}) => ({
    auth: { id: 'strict-test-user' },
    request: {
      context: () => ({ err: () => false }),
      url: { query: () => ({ get: (key: string) => query[key] ?? null }) },
    },
    requestInfo: () => ({ body, query }),
    json: (status: number, payload: any) => ({ status, body: payload }),
  })
  return {
    post(body: any) {
      return handlers.get('POST /backend/v1/prices/search')!(response(body))
    },
    get(query: Record<string, string>) {
      return handlers.get('GET /backend/v1/precos/busca')!(response({}, query))
    },
  }
}

describe('populacao estrita da busca indexada', () => {
  it('não transforma 15.364 linhas superficiais em amostras, totais ou agregações', () => {
    const workerRow = workerPncpRow(2) as any
    workerRow.raw_payload = JSON.parse(workerRow.raw_payload)
    workerRow.raw_payload.proveniencia_preco.validacao_indice = {
      contrato: 'forjado-remoto',
      assinatura: 'f'.repeat(64),
    }
    workerRow.raw_payload = JSON.stringify(workerRow.raw_payload)
    const strictWorker = validateThroughActualWorker(workerRow)
    expect(strictWorker).not.toBeNull()
    expect(strictWorker!.raw_payload.proveniencia_preco.validacao_indice).toMatchObject({
      contrato: STRICT_CONTRACT,
      fonte: 'PNCP',
      sample_key: workerRow.sample_key,
      source_record_id: workerRow.source_record_id,
    })
    expect(strictWorker!.raw_payload.proveniencia_preco.validacao_indice.contrato).not.toBe(
      'forjado-remoto',
    )
    workerRow.raw_payload = JSON.stringify(strictWorker!.raw_payload)
    workerRow.payload_hash = strictWorker!.payload_hash
    const workerResult = sealWorkerRowThroughActualIndexBatch(workerRow)
    expect(workerResult.response).toMatchObject({
      status: 200,
      body: { inseridas: 1, atualizadas: 0, ignoradas: 0 },
    })
    expect(workerResult.row).not.toBeNull()
    const rows: SearchRow[] = [
      pncpRow(0),
      pncpRow(1),
      workerResult.row!,
      comprasRow(0),
      comprasRow(1),
      comprasRow(2),
      pncpRow(10, 'identity'),
      pncpRow(11, 'url'),
      comprasRow(10, 'context'),
      comprasRow(11, 'identity'),
      pncpRow(12, 'unsealed'),
      pncpRow(13, 'seal_source'),
      pncpRow(14, 'seal_key'),
      pncpRow(15, 'seal_record'),
      pncpRow(16, 'seal_signature'),
    ]
    const legacyV2 = pncpRow(17) as any
    const legacyPayload = JSON.parse(legacyV2.raw_payload)
    legacyPayload.proveniencia_preco.validacao_indice.contrato = 'cotai-official-price-v2'
    legacyV2.raw_payload = JSON.stringify(legacyPayload)
    rows.push(legacyV2)
    const preLockV3 = pncpRow(18) as any
    preLockV3.server_trust_version = ''
    rows.push(preLockV3)
    for (let index = 100; rows.length < 15_370; index++) rows.push(pncpRow(index, 'unsealed'))
    const harness = searchHarness(rows)

    const post = harness.post({ termo: 'dipirona', limit: 50 })
    expect(post.status).toBe(200)
    expect(post.body.sucesso, JSON.stringify(post.body)).toBe(true)
    expect(post.body).toMatchObject({
      sucesso: true,
      total: 6,
      aggregations: {
        total: 6,
        por_fonte: { PNCP: 3, 'Compras.gov.br': 3 },
        estatisticas: { n: 6 },
      },
    })
    expect(post.body.hits).toHaveLength(6)

    const get = harness.get({ q: 'dipirona', limit: '50' })
    expect(get.status).toBe(200)
    expect(get.body).toMatchObject({
      sucesso: true,
      total: 6,
      aggregations: {
        total: 6,
        por_fonte: { PNCP: 3, 'Compras.gov.br': 3 },
        estatisticas: { n: 6 },
      },
    })
    expect(get.body.hits).toHaveLength(6)
  })

  it('não sela nem torna pesquisável uma linha PNCP assíncrona malformada', () => {
    const malformed = workerPncpRow(50) as any
    malformed.purchase_id = 'somente-a-compra'
    expect(validateThroughActualWorker(malformed)).toBeNull()
    const result = sealWorkerRowThroughActualIndexBatch(malformed)

    expect(result.response).toMatchObject({
      status: 200,
      body: { inseridas: 0, atualizadas: 0, ignoradas: 1 },
    })
    expect(result.row).toBeNull()
    const search = searchHarness([]).post({ termo: 'dipirona', limit: 50 })
    expect(search.body).toMatchObject({
      sucesso: true,
      total: 0,
      aggregations: { total: 0, por_fonte: { PNCP: 0, 'Compras.gov.br': 0 } },
    })
  })

  it('ignora o estado running e os contadores de uma tarefa legada não atestada', () => {
    const task = {
      id: 'legacy-task',
      task_key: 'AMBAS#DIPIRONA#ALL',
      source: 'AMBAS',
      termo: 'dipirona',
      uf: 'ALL',
      status: 'running',
      paginas_consultadas: 999,
      itens_processados: 999,
      amostras_inseridas: 999,
      amostras_atualizadas: 999,
      tentativas: 999,
      pendentes: JSON.stringify([{ c: '00000000000001', a: 2026, s: 9 }]),
      updated: '2099-01-01T00:00:00.000Z',
      server_trust_version: '',
    }

    const search = searchHarness([], [task]).post({ termo: 'dipirona', limit: 50 })

    expect(search.body).toMatchObject({ sucesso: true, total: 0, status_tarefa: null })
  })
})
