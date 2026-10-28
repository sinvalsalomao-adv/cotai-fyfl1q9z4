const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const copy = (value) => JSON.parse(JSON.stringify(value))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const userId = 'OFFLINE-RECEIPT-USER'

function fixture(overrides = {}) {
  return {
    idCompra: '123456789', idItemCompra: '98765', numeroItemCompra: '7',
    codigoItemCatalogo: '123456', descricaoItem: 'Cadeira escolar',
    cnpjFornecedor: '12345678000190', nomeFornecedor: 'Fornecedor de teste',
    cnpjOrgao: '98765432000110', orgaoComprador: 'Orgao de teste',
    precoUnitarioHomologado: 125.5, quantidade: 4, unidadeMedida: 'UN',
    dataResultado: '2026-10-20', estado: 'CE', ...overrides,
  }
}

// Both complete hook scripts execute unchanged. Only PocketBase storage and the
// external official-response boundary are replaced; this harness cannot use HTTP.
function harness(official, tipo = 'material') {
  const tables = { official_ingestion_receipts: [], price_samples_index: [] }
  class MemoryRecord {
    constructor(collection) { this.collection = collection; this.data = {} }
    set(key, value) { this.data[key] = copy(value) }
    get(key) { return this.data[key] }
    getString(key) { return this.data[key] == null ? '' : String(this.data[key]) }
  }
  const app = {
    findCollectionByNameOrId(name) {
      assert.ok(Object.hasOwn(tables, name), `Unexpected collection: ${name}`)
      return name
    },
    findRecordsByFilter(name, filter, _sort, _limit, _offset, params) {
      if (name === 'official_ingestion_receipts') {
        assert.equal(filter, 'expires_at <= {:now}')
        return tables[name].filter((record) => record.getString('expires_at') <= params.now)
      }
      assert.equal(name, 'price_samples_index')
      assert.equal(filter, 'sample_key = {:key}')
      return tables[name].filter((record) => record.getString('sample_key') === params.key)
    },
    findFirstRecordByData(name, field, value) {
      assert.equal(name, 'official_ingestion_receipts')
      assert.equal(field, 'token_hash')
      const record = tables[name].find((entry) => entry.get(field) === value)
      if (!record) throw new Error('Record not found')
      return record
    },
    save(record) {
      const records = tables[record.collection]
      if (!records.includes(record)) records.push(record)
    },
    delete(record) {
      const records = tables[record.collection]
      records.splice(records.indexOf(record), 1)
    },
    runInTransaction(callback) { callback(app) },
    db() {
      return { newQuery() {
        return { bind() { return this }, all(rows) { rows.push({ request_count: 1 }) } }
      } }
    },
  }
  const routes = new Map()
  const context = vm.createContext({
    routerAdd(method, route, callback) { routes.set(`${method} ${route}`, callback) },
    $apis: { requireAuth: () => ({}), bodyLimit: () => ({}) },
    $app: app, Record: MemoryRecord,
    $security: { sha256, randomString: (length) => 'R'.repeat(length) },
    DynamicModel: class { constructor(data) { Object.assign(this, data) } },
    arrayOf: () => [], console: { log() {} },
    $http: { send(request) {
      const expected = tipo === 'servico'
        ? 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?codigoItemCatalogo=123456&pagina=1&tamanhoPagina=50'
        : 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=123456&pagina=1&tamanhoPagina=50'
      assert.equal(request.url, expected)
      return { statusCode: 200, raw: JSON.stringify({
        resultado: [official], totalRegistros: 1, totalPaginas: 1,
      }) }
    } },
  })
  for (const hook of ['comprasgov_search.js', 'index_batch.js']) {
    const filename = path.join(__dirname, '../pocketbase/hooks', hook)
    new vm.Script(readFileSync(filename, 'utf8'), { filename }).runInContext(context)
  }
  const event = (data) => ({
    auth: { id: userId }, requestInfo: () => data,
    json: (status, body) => ({ status, body: copy(body) }),
  })
  const query = tipo === 'servico'
    ? { catser: '123456', tipo_catalogo: 'servico' }
    : { catmat: '123456', tipo_catalogo: 'material' }
  const emitted = routes.get('GET /backend/v1/cotai/comprasgov-search')(event({ query }))
  assert.equal(emitted.status, 200, JSON.stringify(emitted.body))
  assert.equal(emitted.body.sucesso, true)
  const item = emitted.body.dados.resultado[0]
  const row = item._cotai_index_row
  if (row) {
    const receipt = emitted.body.ingestion_receipts[item._cotai_ingestion_receipt_index]
    row._ingestion_receipt = {
      token: receipt.token, query_hash: receipt.query_hash,
      claim_key: item._cotai_ingestion_claim,
    }
  }
  return {
    emitted, row, tables,
    ingest(value = row) {
      // Serialize the request again, as the client must do before index-batch.
      return routes.get('POST /backend/v1/cotai/index-batch')(
        event({ body: copy({ amostras: [value] }) }),
      )
    },
  }
}

function accepted(run) {
  const reply = run.ingest()
  assert.equal(reply.status, 200)
  assert.equal(reply.body.inseridas, 1, JSON.stringify(reply.body))
  assert.equal(reply.body.ignoradas, 0)
  assert.equal(run.tables.price_samples_index.length, 1)
  const stored = run.tables.price_samples_index[0]
  assert.equal(stored.getString('server_trust_version'), 'server-v1')
  assert.equal(stored.get('search_eligible'), 1)
  assert.equal(stored.get('raw_payload').proveniencia_preco.validacao_indice.contrato,
    'cotai-official-price-v3')
  return stored
}

for (const tipo of ['material', 'servico']) {
  test(`${tipo}: emitted receipt survives JSON and is accepted by real index-batch`, () => {
    const run = harness(fixture(), tipo)
    const stored = accepted(run)
    assert.equal(stored.getString('sample_key'),
      `COMPRASGOVBR#${tipo === 'servico' ? 'CATSER' : 'CATMAT'}123456789987652026-10-2012345678000190#7#98765432000110#125_5000`)
    assert.equal(stored.getString('source_record_id'),
      `${tipo === 'servico' ? 'CATSER' : 'CATMAT'}#123456789#98765#2026-10-20#12345678000190`)
  })
}

test('missing idItemCompra stays absent or null and receipt survives JSON', () => {
  const official = fixture()
  delete official.idItemCompra
  const run = harness(official)
  assert.equal(run.row.raw_payload.proveniencia_preco.identidade.idItemCompra == null, true)
  assert.equal(accepted(run).getString('source_record_id'),
    'CATMAT#123456789#7#2026-10-20#12345678000190')
})

test('missing numeroItemCompra stays absent or null and receipt survives JSON', () => {
  const official = fixture()
  delete official.numeroItemCompra
  const run = harness(official)
  assert.equal(run.row.raw_payload.proveniencia_preco.identidade.numeroItemCompra == null, true)
  const stored = accepted(run)
  assert.equal(stored.getString('item_id'), '1')
  assert.equal(stored.getString('source_record_id'),
    'CATMAT#123456789#98765#2026-10-20#12345678000190')
})

test('long idCompra remains the exact official string through emission and persistence', () => {
  const purchase = '123456789012345678901234567890'
  const run = harness(fixture({ idCompra: purchase }))
  const stored = accepted(run)
  assert.equal(stored.get('raw_payload').proveniencia_preco.identidade.idCompra, purchase)
  assert.equal(stored.get('raw_payload').proveniencia_preco.registro_oficial.idCompra, purchase)
  assert.equal(stored.getString('source_record_id'),
    'CATMAT#123456789012345678901234567890#98765#2026-10-20#12345678000190')
})

function rejected(run, reason) {
  const reply = run.ingest()
  assert.equal(reply.status, 200)
  assert.equal(reply.body.inseridas, 0)
  assert.equal(reply.body.ignoradas, 1)
  assert.deepEqual(reply.body.motivos_ignoradas, { [reason]: 1 })
  assert.equal(run.tables.price_samples_index.length, 0)
}

test('positive price tampering cannot reuse the issued receipt', () => {
  const run = harness(fixture())
  // Keep the proof internally consistent so only the original receipt can reject it.
  run.row.valor_unitario = 250
  run.row.valor_total = 1000
  run.row.sample_key = 'COMPRASGOVBR#CATMAT123456789987652026-10-2012345678000190#7#98765432000110#250_0000'
  run.row.raw_payload.proveniencia_preco.valor_unitario = 250
  run.row.raw_payload.proveniencia_preco.registro_oficial.precoUnitarioHomologado = 250
  rejected(run, 'RECEIPT_CLAIM_INVALID')
})

test('row without official proof is refused', () => {
  const run = harness(fixture())
  delete run.row.raw_payload.proveniencia_preco
  rejected(run, 'PROOF_INVALID')
})

test('row without a temporary ingestion receipt is refused', () => {
  const run = harness(fixture())
  delete run.row._ingestion_receipt
  rejected(run, 'RECEIPT_REQUIRED')
})

test('row without a positive unit price is refused', () => {
  const run = harness(fixture())
  run.row.valor_unitario = 0
  rejected(run, 'UNIT_PRICE_INVALID')
})

test('official row without a positive price does not receive a claim', () => {
  const run = harness(fixture({ precoUnitarioHomologado: 0 }))
  assert.equal(run.row, undefined)
  assert.equal(run.emitted.body.ingestion_receipt, null)
  assert.equal(run.tables.official_ingestion_receipts.length, 0)
})
