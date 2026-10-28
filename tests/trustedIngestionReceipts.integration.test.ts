import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PriceIndexService } from '../src/lib/priceIndexService'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const hookPath = fileURLToPath(new URL('../pocketbase/hooks/index_batch.js', import.meta.url))
const hookSource = readFileSync(hookPath, 'utf8')
const migrationPath = fileURLToPath(
  new URL(
    '../pocketbase/migrations/1741634526_consolidate_search_and_admission.js',
    import.meta.url,
  ),
)

function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function comprasPayload() {
  const official = {
    idCompra: '15836906900012025',
    idItemCompra: '7670225',
    numeroItemCompra: 1,
    codigoItemCatalogo: '151063',
    codigoCatmat: '151063',
    descricaoItem: 'PICOLÉ, NOME: PICOLÉ',
    precoUnitario: 4.4,
    dataResultado: '2025-03-13',
    cnpjFornecedor: '51340170000156',
    nomeFornecedor: 'FORNECEDOR OFICIAL',
  }
  const evidence =
    'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial' +
    '?tipo=codigoItemCatalogo&codigo=151063&pagina=1&tamanhoPagina=500'
  const sourceRecordId =
    'CATMAT#15836906900012025#7670225#2025-03-13#51340170000156'
  const row: any = {
    source: 'Compras.gov.br',
    source_record_id: sourceRecordId,
    purchase_id: sourceRecordId,
    item_id: '1',
    descricao: official.descricaoItem,
    descricao_normalizada: official.descricaoItem,
    orgao_cnpj: '',
    fornecedor_cnpj: official.cnpjFornecedor,
    unidade: 'UN',
    quantidade: 0,
    valor_unitario: official.precoUnitario,
    data_referencia: official.dataResultado,
    natureza_preco: 'homologado',
    codigo_item: 'CATMAT 151063',
    url_original: evidence,
    raw_payload: {
      numeroItem: 1,
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'Compras.gov.br',
        campo_unitario: 'precoUnitario',
        valor_unitario: 4.4,
        natureza: 'contratado',
        url_evidencia: evidence,
        identidade: {
          tipo: 'material',
          codigoCatalogo: '151063',
          idCompra: official.idCompra,
          idItemCompra: official.idItemCompra,
          numeroItemCompra: 1,
          fornecedor: official.cnpjFornecedor,
        },
        registro_oficial: official,
        data_oficial: official.dataResultado,
        campo_data: 'dataResultado',
        contexto_consulta: {
          tipo: 'material',
          codigo: '151063',
          pagina: 1,
          tamanhoPagina: 500,
        },
      },
    },
  }
  row.sample_key = PriceIndexService.gerarSampleKey({
    fonte: row.source,
    idExterno: row.source_record_id,
    orgaoCnpj: row.orgao_cnpj,
    fornecedorCnpjOuCpf: row.fornecedor_cnpj,
    numeroItem: 1,
    valorUnitario: row.valor_unitario,
  })
  return row
}

function pncpPayload() {
  const official = {
    numeroItem: 2,
    niFornecedor: '00000000000002',
    sequencialResultado: 3,
    valorUnitarioHomologado: 2.5,
    dataResultado: '2026-01-01',
  }
  const evidence =
    'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/2/resultados'
  const sourceRecordId =
    '00000000000001/2026/9/itens/2/resultados/3/fornecedor/00000000000002'
  const row: any = {
    source: 'PNCP',
    source_record_id: sourceRecordId,
    purchase_id: sourceRecordId,
    item_id: '2',
    descricao: 'SERVIÇO DE MANUTENÇÃO PREDIAL',
    descricao_normalizada: 'SERVICO DE MANUTENCAO PREDIAL',
    orgao_cnpj: '00000000000001',
    fornecedor_cnpj: '00000000000002',
    unidade: 'H',
    quantidade: 0,
    valor_unitario: 2.5,
    data_referencia: '2026-01-01',
    natureza_preco: 'homologado',
    codigo_item: 'CATSER 1234',
    url_original: 'https://pncp.gov.br/app/editais/00000000000001/2026/9',
    raw_payload: {
      numeroItem: 2,
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'PNCP',
        campo_unitario: 'valorUnitarioHomologado',
        valor_unitario: 2.5,
        natureza: 'homologado',
        url_evidencia: evidence,
        identidade: { cnpj: '00000000000001', ano: 2026, sequencial: 9, numeroItem: 2 },
        registro_oficial: official,
        data_oficial: '2026-01-01',
        campo_data: 'dataResultado',
      },
    },
  }
  row.sample_key = PriceIndexService.gerarSampleKey({
    fonte: row.source,
    idExterno: row.source_record_id,
    orgaoCnpj: row.orgao_cnpj,
    fornecedorCnpjOuCpf: row.fornecedor_cnpj,
    numeroItem: 2,
    valorUnitario: row.valor_unitario,
  })
  return row
}

function claimFor(row: any, key: string) {
  const persisted = [
    'sample_key',
    'source',
    'source_record_id',
    'purchase_id',
    'item_id',
    'descricao',
    'descricao_normalizada',
    'orgao',
    'orgao_cnpj',
    'fornecedor_nome',
    'fornecedor_cnpj',
    'fornecedor_porte',
    'uf',
    'municipio',
    'unidade',
    'quantidade',
    'valor_unitario',
    'valor_total',
    'natureza_preco',
    'data_referencia',
    'numero_processo',
    'numero_ata',
    'modalidade',
    'marca',
    'codigo_item',
    'url_original',
    'raw_payload',
  ].reduce<Record<string, any>>((result, field) => {
    result[field] = row[field] == null ? null : row[field]
    return result
  }, {})
  return {
    key,
    record_hash: sha256(canonical(row.raw_payload.proveniencia_preco.registro_oficial)),
    row_hash: sha256(canonical(persisted)),
    source_record_id: row.source_record_id,
    item_id: row.item_id,
    description: row.descricao,
    unit_price: row.valor_unitario,
    url_original: row.url_original,
  }
}

function harness() {
  let handler: (event: any) => any
  const receipts = new Map<string, any>()
  const prices = new Map<string, any>()
  class Record {
    id = ''
    data: any = {}
    constructor(_collection: any) {}
    set(key: string, value: any) {
      this.data[key] = clone(value)
    }
    get(key: string) {
      return this.data[key]
    }
    getString(key: string) {
      return String(this.data[key] ?? '')
    }
  }
  const app = {
    findFirstRecordByData(collection: string, field: string, value: string) {
      expect(collection).toBe('official_ingestion_receipts')
      expect(field).toBe('token_hash')
      const data = receipts.get(value)
      if (!data) throw new Error('not found')
      const record = new Record({ name: collection })
      record.data = clone(data)
      return record
    },
    runInTransaction(callback: (tx: any) => void) {
      callback({
        findCollectionByNameOrId(name: string) {
          expect(name).toBe('price_samples_index')
          return { name }
        },
        findRecordsByFilter(_name: string, _filter: string, _sort: string, _limit: number, _offset: number, params: any) {
          const value = prices.get(params.key)
          if (!value) return []
          const record = new Record({ name: 'price_samples_index' })
          record.id = params.key
          record.data = clone(value)
          return [record]
        },
        save(record: Record) {
          prices.set(record.data.sample_key, clone(record.data))
        },
      })
    },
  }
  vm.runInNewContext(hookSource, {
    routerAdd(_method: string, _route: string, callback: typeof handler) {
      handler = callback
    },
    $apis: { requireAuth: () => ({}), bodyLimit: () => ({}) },
    $app: app,
    Record,
    $security: { sha256 },
  })
  return {
    issue(row: any, userId = 'USER-A', expired = false) {
      const token = `R${'a'.repeat(63)}`
      const queryHash = sha256(`${row.source}|query`)
      const claimKey = sha256(`${row.source}|${row.source_record_id}`)
      receipts.set(sha256(token), {
        user_id: userId,
        source: row.source,
        query_hash: queryHash,
        claims: [claimFor(row, claimKey)],
        expires_at: new Date(Date.now() + (expired ? -60_000 : 300_000)).toISOString(),
      })
      row._ingestion_receipt = { token, query_hash: queryHash, claim_key: claimKey }
      return row
    },
    run(rows: any[], userId = 'USER-A') {
      return handler!({
        auth: { id: userId },
        requestInfo: () => ({ body: { amostras: rows } }),
        json: (status: number, body: any) => ({ status, body: clone(body) }),
      })
    },
    get records() {
      return [...prices.values()]
    },
  }
}

describe('trusted official ingestion receipts', () => {
  it('creates a server-only receipt store with bounded expiry indexing', () => {
    expect(existsSync(migrationPath)).toBe(true)
    const source = readFileSync(migrationPath, 'utf8')
    expect(source).toContain("name: 'official_ingestion_receipts'")
    expect(source).toContain('listRule: null')
    expect(source).toContain('viewRule: null')
    expect(source).toContain('createRule: null')
    expect(source).toContain('updateRule: null')
    expect(source).toContain('deleteRule: null')
    expect(source).toContain('expires_at')
  })

  it.each([
    ['Compras.gov.br', comprasPayload],
    ['PNCP', pncpPayload],
  ])('rejects an authenticated fabricated %s row without a server receipt', (_source, fixture) => {
    const h = harness()
    const result = h.run([fixture()])

    expect(result.body).toMatchObject({ inseridas: 0, atualizadas: 0, ignoradas: 1 })
    expect(result.body.motivos_ignoradas).toEqual({ RECEIPT_REQUIRED: 1 })
    expect(h.records).toHaveLength(0)
  })

  it.each([
    ['Compras.gov.br', comprasPayload],
    ['PNCP', pncpPayload],
  ])('accepts an exact %s row bound to a live receipt for the same user', (_source, fixture) => {
    const h = harness()
    const row = h.issue(fixture())
    const result = h.run([row])

    expect(result.body).toMatchObject({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    expect(h.records).toHaveLength(1)
    expect(JSON.stringify(h.records[0])).not.toContain(row._ingestion_receipt.token)
  })

  it.each([
    ['description', (row: any) => (row.descricao = 'ALTERADO PELO CLIENTE')],
    ['price', (row: any) => (row.valor_unitario += 1)],
    ['record id', (row: any) => (row.source_record_id += '-ALTERADO')],
    ['URL', (row: any) => (row.url_original += '?alterado=1')],
  ])('does not let a valid receipt authorize a different %s', (_label, mutate) => {
    const h = harness()
    const row = h.issue(comprasPayload())
    mutate(row)

    const result = h.run([row])

    expect(result.body).toMatchObject({ inseridas: 0, atualizadas: 0, ignoradas: 1 })
    expect(h.records).toHaveLength(0)
  })

  it.each([
    ['normalized description', (row: any) => (row.descricao_normalizada = 'VENENO INDEXADO')],
    ['buyer CNPJ', (row: any) => (row.orgao_cnpj = '99999999000199')],
    ['supplier CNPJ', (row: any) => (row.fornecedor_cnpj = '99999999000199')],
    ['state', (row: any) => (row.uf = 'ZZ')],
    ['unit', (row: any) => (row.unidade = 'CAIXA')],
    ['quantity', (row: any) => (row.quantidade = 999)],
    ['date', (row: any) => (row.data_referencia = '2025-03-14')],
    [
      'proof URL',
      (row: any) =>
        (row.raw_payload.proveniencia_preco.url_evidencia =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=151063&pagina=2&tamanhoPagina=500'),
    ],
    [
      'query context',
      (row: any) => (row.raw_payload.proveniencia_preco.contexto_consulta.pagina = 2),
    ],
  ])('binds the receipt to the complete persisted row: %s', (_label, mutate) => {
    const h = harness()
    const row = h.issue(comprasPayload())
    mutate(row)

    const result = h.run([row])

    expect(result.body).toMatchObject({ inseridas: 0, atualizadas: 0, ignoradas: 1 })
    expect(Object.values(result.body.motivos_ignoradas)).toEqual([1])
    expect(h.records).toHaveLength(0)
  })

  it('cannot reuse one claim with a recomputed sample key to inflate counts', () => {
    const h = harness()
    const first = h.issue(comprasPayload())
    const replay = clone(first)
    replay.orgao_cnpj = '99999999000199'
    replay.sample_key = PriceIndexService.gerarSampleKey({
      fonte: replay.source,
      idExterno: replay.source_record_id,
      orgaoCnpj: replay.orgao_cnpj,
      fornecedorCnpjOuCpf: replay.fornecedor_cnpj,
      numeroItem: replay.item_id,
      valorUnitario: replay.valor_unitario,
    })

    const result = h.run([first, replay])

    expect(result.body).toMatchObject({ inseridas: 1, atualizadas: 0, ignoradas: 1 })
    expect(result.body.motivos_ignoradas).toEqual({ RECEIPT_CLAIM_INVALID: 1 })
    expect(h.records).toHaveLength(1)
  })

  it('binds a receipt to the issuing user, source, query and expiry', () => {
    const cases: Array<(row: any, h: ReturnType<typeof harness>) => void> = [
      (row) => (row._ingestion_receipt.query_hash = 'f'.repeat(64)),
      (row) => (row.source = 'PNCP'),
    ]
    for (const mutate of cases) {
      const h = harness()
      const row = h.issue(comprasPayload())
      mutate(row, h)
      expect(h.run([row]).body).toMatchObject({ inseridas: 0, atualizadas: 0, ignoradas: 1 })
      expect(h.records).toHaveLength(0)
    }

    const wrongUser = harness()
    const bound = wrongUser.issue(comprasPayload(), 'USER-A')
    expect(wrongUser.run([bound], 'USER-B').body).toMatchObject({ ignoradas: 1 })

    const expired = harness()
    const stale = expired.issue(comprasPayload(), 'USER-A', true)
    expect(expired.run([stale]).body).toMatchObject({ ignoradas: 1 })
  })
})
