import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { PriceIndexService } from '../src/lib/priceIndexService'
import type { AmostraPreco } from '../src/lib/connectors/types'
import { ComprasGovConnectorAdapter } from '../src/lib/connectors/comprasGovConnectorAdapter'
import { PncpConnectorAdapter } from '../src/lib/connectors/pncpConnectorAdapter'
import { mesclarIdentidadeCompras } from '../src/lib/comprasIdentity'
import { isEligibleComprasOfficialProof } from '../src/components/modalSearchPolicy'
import type { BudgetPriceResult } from '../src/services/budgetService'

vi.mock('../src/lib/pocketbase/client', () => ({ default: {
  baseUrl: 'https://offline-index.invalid', authStore: { token: 'SYNTHETIC-TOKEN' },
  collection() { throw new Error('Per-record SDK persistence is forbidden in this test') },
} }))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const path = fileURLToPath(new URL('../pocketbase/hooks/index_batch.js', import.meta.url))
const source = existsSync(path) ? readFileSync(path, 'utf8') : ''
const GROUPED_QUERY_URL =
  'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial' +
  '?tipo=codigoPdm&codigo=19385&pagina=2&tamanhoPagina=500&estado=CE' +
  '&dataCompraInicio=2024-01-01&dataCompraFim=2026-12-31'
const GROUPED_PURCHASE_URL = 'https://compras.gov.br/compra/offline-review'
const STRICT_VALIDATION_CONTRACT = 'cotai-official-price-v3'

function strictValidationSignature(row: {
  source: string
  sample_key: string
  source_record_id: string
}) {
  const parts = [
    STRICT_VALIDATION_CONTRACT,
    row.source,
    row.sample_key,
    row.source_record_id,
  ]
  const material = parts.map((part) => `${part.length}:${part}`).join('|')
  return createHash('sha256').update(material).digest('hex')
}

function expectServerValidationSeal(record: any) {
  const signature = strictValidationSignature(record)
  expect(record.payload_hash).toBe(signature)
  expect(record.raw_payload.proveniencia_preco.validacao_indice).toEqual({
    contrato: STRICT_VALIDATION_CONTRACT,
    fonte: record.source,
    sample_key: record.sample_key,
    source_record_id: record.source_record_id,
    assinatura: signature,
  })
}

function withoutServerValidationSeal(rawPayload: any) {
  const copy = clone(rawPayload)
  if (copy?.proveniencia_preco) delete copy.proveniencia_preco.validacao_indice
  return copy
}

// Invented offline values. No API, credentials, or application database access.
function sample(index = 1): AmostraPreco {
  const official = { idCompra: 'SYNTHETIC-COMPRA', idItemCompra: `SYNTHETIC-ITEM-${index}`,
    numeroItemCompra: index, niFornecedor: 'SYNTHETIC-SUPPLIER', precoUnitario: 2.5,
    dataResultado: '2026-01-01', codigoItemCatalogo: '991222' }
  const evidence = 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=991222&pagina=1&tamanhoPagina=500'
  return {
    id: `SYNTHETIC-${index}`, idExterno: `CATMAT#SYNTHETIC-COMPRA#SYNTHETIC-ITEM-${index}#2026-01-01#SYNTHETIC-SUPPLIER`,
    fonte: 'Compras.gov.br', fonteNomeExibicao: 'Compras.gov.br', urlOriginal: evidence,
    produto: 'SYNTHETIC ITEM', descricaoCompleta: 'SYNTHETIC ITEM', descricaoNormalizada: 'SYNTHETIC ITEM',
    orgaoComprador: 'SYNTHETIC ORGAO', orgaoCnpj: '', fornecedorNome: 'SYNTHETIC SUPPLIER',
    unidade: 'NÃO INFORMADO', quantidade: 0, valorUnitario: 2.5,
    dataPublicacaoOuContrato: '2026-01-01', natureza: 'contratado', isDemo: false,
    hashRastreabilidade: `SYNTHETIC-${index}`,
    detalhesAdicionais: { numeroItem: index, proveniencia_preco: {
      versao: 1, status: 'verificada', fonte: 'Compras.gov.br', campo_unitario: 'precoUnitario',
      valor_unitario: 2.5, natureza: 'contratado', url_evidencia: evidence,
      identidade: { tipo: 'material', codigoCatalogo: '991222', idCompra: official.idCompra,
        idItemCompra: official.idItemCompra, numeroItemCompra: index, fornecedor: official.niFornecedor },
      registro_oficial: official, data_oficial: '2026-01-01', campo_data: 'dataResultado',
      contexto_consulta: { tipo: 'material', codigo: '991222', pagina: 1, tamanhoPagina: 500 },
    } },
  }
}

function payload(index = 1) {
  const a = sample(index)
  return {
    sample_key: PriceIndexService.gerarSampleKey({ ...a, numeroItem: index }),
    source: a.fonte, source_record_id: a.idExterno, purchase_id: a.idExterno, item_id: String(index),
    descricao: a.descricaoCompleta, descricao_normalizada: a.descricaoNormalizada,
    orgao_cnpj: '', fornecedor_cnpj: '', unidade: a.unidade, quantidade: 0,
    valor_unitario: a.valorUnitario, data_referencia: a.dataPublicacaoOuContrato,
    url_original: a.urlOriginal, natureza_preco: 'homologado', raw_payload: a.detalhesAdicionais,
  }
}

function groupedSample(overrides: Record<string, unknown> = {}): AmostraPreco {
  const raw = {
    idCompra: '15836906900012025',
    idCompraItem: '1583690690001202500001',
    idItemCompra: '7670225',
    numeroItemCompra: 1,
    codigoItemCatalogo: '151063',
    codigoCatmat: '151063',
    codigoPdm: '19385',
    descricaoItem: 'PICOLÉ, NOME: PICOLÉ',
    precoUnitario: 4.4,
    dataResultado: '2025-03-13',
    cnpjFornecedor: '51340170000156',
    nomeFornecedor: 'SYNTHETIC SUPPLIER',
    estado: 'CE',
    siglaUnidadeFornecimento: 'UN',
    quantidade: 1,
    ...overrides,
  }
  const normalized = new ComprasGovConnectorAdapter().normalize(raw, 0, {
    tipo: 'material',
    codigo: '151063',
    consultaOficial: true,
    pagina: 2,
    tamanhoPagina: 500,
    estado: 'CE',
    seletor: 'codigoPdm',
    codigoPdm: '19385',
    urlConsultaOficial: GROUPED_QUERY_URL,
    dataCompraInicio: '2024-01-01',
    dataCompraFim: '2026-12-31',
  })
  if (!normalized) throw new Error('Grouped synthetic fixture must normalize.')
  return normalized
}

function materialItemSample(): AmostraPreco {
  const normalized = new ComprasGovConnectorAdapter().normalize(
    {
      idCompra: '15836906900012025',
      idCompraItem: '1583690690001202500001',
      idItemCompra: '7670225',
      numeroItemCompra: 1,
      codigoItemCatalogo: '151063',
      codigoCatmat: '151063',
      descricaoItem: 'SYNTHETIC MATERIAL',
      precoUnitario: 4.4,
      dataResultado: '2025-03-13',
      cnpjFornecedor: '51340170000156',
      nomeFornecedor: 'SYNTHETIC SUPPLIER',
      siglaUnidadeFornecimento: 'UN',
      quantidade: 1,
    },
    0,
    {
      tipo: 'material',
      codigo: '151063',
      consultaOficial: true,
      pagina: 1,
      tamanhoPagina: 500,
    },
  )
  if (!normalized) throw new Error('Item synthetic fixture must normalize.')
  return normalized
}

function useGroupedEvidence(row: any, evidence: string, rawField?: string) {
  const proof = (row.raw_payload || row.raw_data).proveniencia_preco
  proof.url_evidencia = evidence
  if (rawField) proof.registro_oficial[rawField] = evidence
  if ('url_original' in row) row.url_original = evidence
  if ('source_url' in row) row.source_url = evidence
}

function useGroupedQuery(row: any, query: string) {
  const proof = (row.raw_payload || row.raw_data).proveniencia_preco
  proof.contexto_consulta.urlConsultaOficial = query
  if (proof.url_evidencia === GROUPED_QUERY_URL) useGroupedEvidence(row, query)
}

function payloadFor(a: AmostraPreco) {
  const numeroItem = Number(a.detalhesAdicionais?.numeroItem || 1)
  return {
    sample_key: PriceIndexService.gerarSampleKey({ ...a, numeroItem }),
    source: a.fonte,
    source_record_id: a.idExterno,
    purchase_id: a.idExterno,
    item_id: String(numeroItem),
    descricao: a.descricaoCompleta,
    descricao_normalizada: a.descricaoNormalizada,
    orgao_cnpj: a.orgaoCnpj || '',
    fornecedor_cnpj: a.fornecedorCnpjOuCpf || '',
    unidade: a.unidade,
    quantidade: a.quantidade,
    valor_unitario: a.valorUnitario,
    data_referencia: a.dataPublicacaoOuContrato,
    url_original: a.urlOriginal,
    natureza_preco: 'homologado',
    codigo_item: a.codigoCatalogo,
    raw_payload: a.detalhesAdicionais,
  }
}

function setGroupedQueryValue(row: any, field: string, value: string) {
  const proof = row.raw_payload.proveniencia_preco
  const url = new URL(proof.url_evidencia)
  url.searchParams.set(field, value)
  proof.url_evidencia = url.toString()
  proof.contexto_consulta.urlConsultaOficial = proof.url_evidencia
  row.url_original = proof.url_evidencia
}

function budgetRow(a: AmostraPreco, id = a.id): BudgetPriceResult {
  return {
    id,
    budget_item_id: 'SYNTHETIC-BUDGET-ITEM',
    source: a.fonte,
    source_record_id: a.idExterno,
    source_url: a.urlOriginal,
    source_date: a.dataPublicacaoOuContrato,
    supplier_document: a.fornecedorCnpjOuCpf,
    description_original: a.descricaoCompleta,
    unit: a.unidade,
    quantity: a.quantidade,
    unit_price: a.valorUnitario,
    status: 'encontrado',
    raw_data: { natureza: a.natureza, ...clone(a.detalhesAdicionais) },
    created: a.dataPublicacaoOuContrato,
    updated: a.dataPublicacaoOuContrato,
  }
}

function harness(options: { failSaveAt?: number } = {}) {
  let handler: (event: any) => any
  let middleware: any[] = []
  let database = new Map<string, any>()
  let receipts = new Map<string, any>()
  let transactions = 0, saves = 0, lastTransactionError: unknown
  class Record {
    id = ''
    data: any = {}
    constructor(_collection: any) {}
    set(key: string, value: any) { this.data[key] = clone(value) }
    get(key: string) { return this.data[key] }
    getString(key: string) { return String(this.data[key] ?? '') }
  }
  const app = {
    findFirstRecordByData(collection: string, field: string, value: string) {
      expect(collection).toBe('official_ingestion_receipts')
      expect(field).toBe('token_hash')
      const data = receipts.get(value)
      if (!data) throw new Error('receipt not found')
      const record = new Record({ name: collection })
      record.data = clone(data)
      return record
    },
    runInTransaction(callback: (tx: any) => void) {
      transactions++
      const draft = new Map([...database].map(([key, data]) => [key, clone(data)]))
      try {
        callback({
          findCollectionByNameOrId(name: string) { expect(name).toBe('price_samples_index'); return { name } },
          findRecordsByFilter(name: string, filter: string, _sort: string, limit: number, _offset: number, params: any) {
            expect(name).toBe('price_samples_index')
            expect(filter).toBe('sample_key = {:key}')
            expect([1, 2]).toContain(limit)
            const data = draft.get(params.key)
            if (!data) return []
            const record = new Record({ name }); record.id = params.key; record.data = clone(data)
            return [record]
          },
          save(record: Record) {
            saves++
            if (saves === options.failSaveAt) throw new Error('SYNTHETIC DB failure with private details')
            draft.set(record.data.sample_key, clone(record.data))
          },
        })
      } catch (error) {
        lastTransactionError = error
        throw error
      }
      database = draft
    },
  }
  vm.runInNewContext(source, {
    routerAdd(method: string, route: string, callback: typeof handler, ...middlewares: any[]) {
      expect(method).toBe('POST'); expect(route).toBe('/backend/v1/cotai/index-batch')
      handler = callback; middleware = middlewares
    },
    $apis: { requireAuth: () => ({ auth: true }), bodyLimit: (bytes: number) => ({ bodyLimit: bytes }) },
    $app: app, Record,
    $security: {
      sha256(value: string) {
        return createHash('sha256').update(value).digest('hex')
      },
    },
  })
  return {
    seed(record: any) {
      database.set(record.sample_key, clone(record))
    },
    run(body: any, auth: any = { id: 'SYNTHETIC-USER' }) {
      expect(handler).toBeTypeOf('function')
      if (body && Array.isArray(body.amostras) && auth?.id) {
        const queryHash = createHash('sha256').update('SYNTHETIC-QUERY').digest('hex')
        const groups = new Map<string, { token: string; claims: any[] }>()
        body.amostras.forEach((row: any, index: number) => {
          let group = groups.get(row.source)
          if (!group) {
            group = {
              token: `R${createHash('sha256').update(`${row.source}|${JSON.stringify(body.amostras)}`).digest('hex').slice(0, 63)}`,
              claims: [],
            }
            groups.set(row.source, group)
          }
          const claimKey = createHash('sha256')
            .update(`${row.source}|${row.source_record_id}|${index}`)
            .digest('hex')
          row._ingestion_receipt = { token: group.token, query_hash: queryHash, claim_key: claimKey }
          const canonical = (value: any): string => {
            if (value === null || typeof value !== 'object') return JSON.stringify(value)
            if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
            return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
          }
          const persistedFields = [
            'sample_key', 'source', 'source_record_id', 'purchase_id', 'item_id',
            'descricao', 'descricao_normalizada', 'orgao', 'orgao_cnpj', 'fornecedor_nome',
            'fornecedor_cnpj', 'fornecedor_porte', 'uf', 'municipio', 'unidade',
            'quantidade', 'valor_unitario', 'valor_total', 'natureza_preco',
            'data_referencia', 'numero_processo', 'numero_ata', 'modalidade', 'marca',
            'codigo_item', 'url_original', 'raw_payload',
          ].reduce<Record<string, any>>((result, field) => {
            result[field] = row[field] == null ? null : row[field]
            return result
          }, {})
          group.claims.push({
            key: claimKey,
            record_hash: createHash('sha256')
              .update(canonical(row.raw_payload?.proveniencia_preco?.registro_oficial))
              .digest('hex'),
            row_hash: createHash('sha256').update(canonical(persistedFields)).digest('hex'),
            source_record_id: row.source_record_id,
            item_id: row.item_id,
            description: row.descricao,
            unit_price: row.valor_unitario,
            url_original: row.url_original,
          })
        })
        groups.forEach((group, source) => {
          receipts.set(createHash('sha256').update(group.token).digest('hex'), {
            user_id: auth.id,
            source,
            query_hash: queryHash,
            claims: group.claims,
            expires_at: new Date(Date.now() + 300_000).toISOString(),
          })
        })
      }
      return handler!({ auth, requestInfo: () => ({ body }), json: (status: number, result: any) => ({ status, body: clone(result) }) })
    },
    get records() { return [...database.values()] },
    get middleware() { return middleware },
    get transactions() { return transactions },
    get lastTransactionError() { return lastTransactionError },
  }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('authenticated index batch hook', () => {
  it('requires authentication and a bounded batch before any database work', () => {
    const h = harness()
    expect(h.middleware.some((m) => m.auth)).toBe(true)
    expect(h.middleware.some((m) => m.bodyLimit > 0 && m.bodyLimit <= 2 * 1024 * 1024)).toBe(true)
    expect(h.run({ amostras: [payload()] }, null).status).toBe(401)
    expect(h.run({ amostras: [payload()] }, { id: '' }).status).toBe(401)
    expect(h.run({ amostras: Array.from({ length: 101 }, () => payload()) }).status).toBe(413)
    expect(h.run({ amostras: 'invalid' }).status).toBe(400)
    expect(h.transactions).toBe(0)
  })

  it('upserts by stable key atomically and counts duplicates without inventing missing facts', () => {
    const h = harness()
    const first = payload()
    expect(h.run({ amostras: [first, first] }).body).toMatchObject({ sucesso: true, recebidas: 2, inseridas: 1, atualizadas: 0, ignoradas: 1 })
    expect(h.run({ amostras: [first] }).body).toMatchObject({ sucesso: true, inseridas: 0, atualizadas: 1, ignoradas: 0 })
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({
      sample_key: first.sample_key,
      unidade: 'NÃO INFORMADO',
      quantidade: 0,
      data_referencia: '2026-01-01',
      raw_payload: first.raw_payload,
      search_contract: 'cotai-official-price-v3',
      search_eligible: 1,
    })
    expect(h.records[0].valor_total).toBeNull()
    expectServerValidationSeal(h.records[0])
    expect(h.transactions).toBe(2)
  })

  it('fully replaces an untrusted legacy row before marking its official revalidation trusted', () => {
    const h = harness()
    const official = payload()
    h.seed({
      ...clone(official),
      descricao: 'LEGACY POISON',
      descricao_normalizada: 'LEGACY POISON',
      modelo: 'FORGED MODEL',
      situacao_contratacao: 'FORGED STATUS',
      qualidade_situacao: 'rejeitada',
      motivos_rejeicao: ['FORGED REASON'],
      matching_score: 999,
      matching_tipo: 'FORGED MATCH',
      vigencia_fim: '2099-12-31',
      situacao_origem: 'FORGED ORIGIN',
      data_verificacao: '2099-12-31T23:59:59.000Z',
      server_trust_version: '',
    })

    expect(h.run({ amostras: [official] }).body).toMatchObject({
      inseridas: 0,
      atualizadas: 1,
      ignoradas: 0,
    })
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({
      descricao: official.descricao,
      descricao_normalizada: official.descricao_normalizada,
      modelo: '',
      situacao_contratacao: '',
      qualidade_situacao: 'aceita',
      motivos_rejeicao: [],
      matching_score: 0,
      matching_tipo: '',
      vigencia_fim: '',
      situacao_origem: '',
      server_trust_version: 'server-v1',
    })
    expect(h.records[0].data_verificacao).not.toBe('2099-12-31T23:59:59.000Z')
    expectServerValidationSeal(h.records[0])
  })

  it('ignores every caller-supplied validation seal and mints a server seal only after full validation', () => {
    const h = harness()
    const row: any = payload()
    row.raw_payload.proveniencia_preco.validacao_indice = {
      contrato: STRICT_VALIDATION_CONTRACT,
      fonte: 'PNCP',
      sample_key: 'FORGED-KEY',
      source_record_id: 'FORGED-RECORD',
      assinatura: 'f'.repeat(64),
    }
    row.payload_hash = 'f'.repeat(64)

    expect(h.run({ amostras: [row] }).body).toMatchObject({
      inseridas: 1,
      atualizadas: 0,
      ignoradas: 0,
    })
    expectServerValidationSeal(h.records[0])
    expect(h.records[0].raw_payload.proveniencia_preco.validacao_indice.assinatura).not.toBe(
      'f'.repeat(64),
    )
  })

  it.each(['source', 'identity', 'record_id', 'key', 'price', 'proof', 'url', 'date', 'evidence_code'])('ignores invalid %s with explicit counts and no write', (kind) => {
    const h = harness(), invalid: any = payload()
    if (kind === 'source') invalid.source = 'OTHER'
    if (kind === 'identity') invalid.raw_payload.proveniencia_preco.identidade.idCompra = 'MISMATCH'
    if (kind === 'record_id') invalid.source_record_id = 'MISMATCH'
    if (kind === 'key') invalid.sample_key = 'MISMATCH'
    if (kind === 'price') invalid.valor_unitario = 99
    if (kind === 'proof') invalid.raw_payload.proveniencia_preco.status = 'nao_verificada'
    if (kind === 'url') invalid.url_original = 'https://evil.invalid/price'
    if (kind === 'date') invalid.data_referencia = '2020-01-01'
    if (kind === 'evidence_code') invalid.raw_payload.proveniencia_preco.url_evidencia = invalid.url_original.replace('991222', '123')
    const result = h.run({ amostras: [invalid] })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ sucesso: true, recebidas: 1, inseridas: 0, atualizadas: 0, ignoradas: 1 })
    expect(result.body.motivos_ignoradas).toBeDefined()
    expect(h.records).toHaveLength(0)
  })

  it.each([
    ['an unknown query key', (row: any) => { row.raw_payload.proveniencia_preco.url_evidencia += '&unexpected=1' }],
    ['a duplicate catalog code', (row: any) => { row.raw_payload.proveniencia_preco.url_evidencia += '&codigo=991222' }],
    ['page zero', (row: any) => {
      row.raw_payload.proveniencia_preco.contexto_consulta.pagina = 0
      row.raw_payload.proveniencia_preco.url_evidencia = row.raw_payload.proveniencia_preco.url_evidencia.replace('pagina=1', 'pagina=0')
    }],
    ['an oversized page size', (row: any) => {
      row.raw_payload.proveniencia_preco.contexto_consulta.tamanhoPagina = 501
      row.raw_payload.proveniencia_preco.url_evidencia = row.raw_payload.proveniencia_preco.url_evidencia.replace('tamanhoPagina=500', 'tamanhoPagina=501')
    }],
  ])('rejects an item query with %s instead of persisting evidence the modal refuses', (_label, mutate) => {
    const h = harness()
    const invalid: any = payload()
    mutate(invalid)
    invalid.url_original = invalid.raw_payload.proveniencia_preco.url_evidencia

    expect(h.run({ amostras: [invalid] }).body).toMatchObject({
      inseridas: 0,
      atualizadas: 0,
      ignoradas: 1,
      motivos_ignoradas: { URL_INVALID: 1 },
    })
    expect(h.records).toHaveLength(0)
  })

  it('accepts a strict item record link on the data host when it is byte-exactly bound to the row', () => {
    const h = harness()
    const row: any = payload()
    const recordLink = 'https://dadosabertos.compras.gov.br/compra/123'
    row.raw_payload.proveniencia_preco.url_evidencia = recordLink
    row.raw_payload.proveniencia_preco.registro_oficial.linkEditalOuCompra = recordLink
    row.url_original = recordLink

    expect(h.run({ amostras: [row] }).body).toMatchObject({
      inseridas: 1,
      atualizadas: 0,
      ignoradas: 0,
    })
    expect(h.records).toHaveLength(1)
  })

  it('rejects oversized bodies before touching the database and does not accept collection overrides', () => {
    const h = harness()
    expect(h.run({ amostras: [payload()], padding: 'x'.repeat(2 * 1024 * 1024) }).status).toBe(413)
    const row: any = payload(); row.collection = 'users'; row.id = 'UNTRUSTED'; row.is_admin = true
    expect(h.run({ amostras: [row], collection: 'users' }).body.inseridas).toBe(1)
    expect(h.records[0].collection).toBeUndefined()
    expect(h.records[0].id).toBeUndefined()
    expect(h.records[0].is_admin).toBeUndefined()
  })

  it.each(['valorUnitarioEstimado', 'valor_unitario_estimado', 'valorUnitarioHomologado', 'valor_unitario_homologado'])
    ('rejects a nature that contradicts the explicit PNCP field %s', (field) => {
      const h = harness(), row: any = payload()
      const cnpj = '00000000000001'
      row.source = 'PNCP'; row.source_record_id = `${cnpj}/2026/9/itens/1`
      row.purchase_id = row.source_record_id; row.orgao_cnpj = cnpj
      row.sample_key = PriceIndexService.gerarSampleKey({ fonte: 'PNCP', idExterno: row.source_record_id,
        numeroItem: 1, orgaoCnpj: cnpj, valorUnitario: 2.5 })
      row.url_original = `https://pncp.gov.br/app/editais/${cnpj}/2026/9`
      row.natureza_preco = field.toLowerCase().includes('estimado') ? 'homologado' : 'estimado'
      row.raw_payload = { numeroItem: 1, proveniencia_preco: { versao: 1, status: 'verificada', fonte: 'PNCP',
        campo_unitario: field, valor_unitario: 2.5, natureza: row.natureza_preco,
        identidade: { cnpj, ano: 2026, sequencial: 9, numeroItem: 1 },
        url_evidencia: `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/2026/9/itens/1`,
        campo_data: 'dataResultado', data_oficial: '2026-01-01',
        registro_oficial: { [field]: 2.5, dataResultado: '2026-01-01' } } }
      expect(h.run({ amostras: [row] }).body).toMatchObject({ inseridas: 0, ignoradas: 1,
        motivos_ignoradas: { PROOF_INVALID: 1 } })
      expect(h.records).toHaveLength(0)
    })

  it('persists PNCP item/result provenance and refuses an identity from a different item', () => {
    const h = harness(), row: any = payload()
    const identity = { cnpj: '00000000000001', ano: 2026, sequencial: 9, numeroItem: 2 }
    const base = 'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/2'
    row.source = 'PNCP'; row.item_id = '2'; row.orgao_cnpj = identity.cnpj
    row.fornecedor_cnpj = '00000000000002'
    row.source_record_id = '00000000000001/2026/9/itens/2/resultados/3/fornecedor/00000000000002'
    row.purchase_id = row.source_record_id
    row.sample_key = PriceIndexService.gerarSampleKey({ fonte: row.source, idExterno: row.source_record_id,
      numeroItem: 2, orgaoCnpj: identity.cnpj, valorUnitario: 2.5 })
    row.url_original = 'https://pncp.gov.br/app/editais/00000000000001/2026/9'
    row.raw_payload = { numeroItem: 2, proveniencia_preco: { versao: 1, status: 'verificada', fonte: 'PNCP',
      campo_unitario: 'valorUnitarioHomologado', valor_unitario: 2.5, natureza: 'homologado',
      identidade: identity, url_evidencia: base + '/resultados', campo_data: 'dataResultado', data_oficial: '2026-01-01',
      registro_oficial: { numeroItem: 2, sequencialResultado: 3, niFornecedor: '00000000000002', valorUnitarioHomologado: 2.5, dataResultado: '2026-01-01' } } }
    expect(h.run({ amostras: [row] }).body).toMatchObject({ inseridas: 1, ignoradas: 0 })
    row.raw_payload.proveniencia_preco.identidade.numeroItem = 99
    expect(h.run({ amostras: [row] }).body).toMatchObject({ atualizadas: 0, ignoradas: 1 })
    expect(h.records[0].raw_payload.proveniencia_preco.identidade.numeroItem).toBe(2)
  })

  it('rolls the whole batch back on a database error and returns only a safe failure', () => {
    const h = harness({ failSaveAt: 2 })
    const result = h.run({ amostras: [payload(1), payload(2)] })
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ sucesso: false, inseridas: 0, atualizadas: 0 })
    expect(JSON.stringify(result)).not.toContain('private details')
    expect(h.records).toHaveLength(0)
  })

  it('accepts only a CATMAT-row proof tied to the exact grouped PDM query', () => {
    const h = harness()
    const valid = payloadFor(groupedSample())
    const result = h.run({ amostras: [valid] })
    expect(h.lastTransactionError).toBeUndefined()
    expect(result.body).toMatchObject({
      inseridas: 1,
      atualizadas: 0,
      ignoradas: 0,
    })
    expect(h.records[0].raw_payload.proveniencia_preco).toMatchObject({
      identidade: { tipo: 'material', codigoCatalogo: '151063' },
      contexto_consulta: {
        tipo: 'material',
        codigo: '151063',
        seletor: 'codigoPdm',
        codigoPdm: '19385',
      },
    })
  })

  it.each(['linkEditalOuCompra', 'link_resultado', 'url'])(
    'accepts a safe grouped-PDM evidence link bound to registro_oficial.%s',
    (field) => {
      const h = harness()
      const valid = payloadFor(groupedSample({ [field]: GROUPED_PURCHASE_URL }))
      const result = h.run({ amostras: [valid] })
      expect(result.body).toMatchObject({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
      expect(h.records[0]).toMatchObject({ url_original: GROUPED_PURCHASE_URL })
      expect(
        h.records[0].raw_payload.proveniencia_preco.contexto_consulta.urlConsultaOficial,
      ).toBe(GROUPED_QUERY_URL)
    },
  )

  it('accepts grouped PDM proof when the optional returned PDM aliases are absent', () => {
    const h = harness()
    const valid = payloadFor(groupedSample({ codigoPdm: undefined, codigoPDM: undefined }))
    expect(h.run({ amostras: [valid] }).body).toMatchObject({
      inseridas: 1,
      atualizadas: 0,
      ignoradas: 0,
    })
  })

  it.each([
    ['service selector', (row: any) => { row.raw_payload.proveniencia_preco.identidade.tipo = 'servico'; row.raw_payload.proveniencia_preco.contexto_consulta.tipo = 'servico' }],
    ['PDM mismatch', (row: any) => { row.raw_payload.proveniencia_preco.contexto_consulta.codigoPdm = '19386' }],
    ['CATMAT context mismatch', (row: any) => { row.raw_payload.proveniencia_preco.contexto_consulta.codigo = '151064' }],
    ['CATMAT record mismatch', (row: any) => { row.raw_payload.proveniencia_preco.registro_oficial.codigoCatmat = '151064' }],
    ['unsafe codigoPdm', (row: any) => { row.raw_payload.proveniencia_preco.registro_oficial.codigoPdm = 9007199254740992 }],
    ['unsafe codigoPDM', (row: any) => { row.raw_payload.proveniencia_preco.registro_oficial.codigoPDM = 9007199254740992 }],
    ['raw PDM mismatch', (row: any) => { row.raw_payload.proveniencia_preco.registro_oficial.codigoPdm = '19386' }],
    ['raw PDM alias mismatch', (row: any) => { row.raw_payload.proveniencia_preco.registro_oficial.codigoPDM = '19386' }],
    ['wrong page', (row: any) => { row.raw_payload.proveniencia_preco.contexto_consulta.pagina = 3 }],
    ['wrong size', (row: any) => { row.raw_payload.proveniencia_preco.contexto_consulta.tamanhoPagina = 10 }],
    ['wrong UF', (row: any) => { row.raw_payload.proveniencia_preco.contexto_consulta.estado = 'SP' }],
    ['wrong start date', (row: any) => { row.raw_payload.proveniencia_preco.contexto_consulta.dataCompraInicio = '2024-02-01' }],
    ['wrong end date', (row: any) => { row.raw_payload.proveniencia_preco.contexto_consulta.dataCompraFim = '2026-11-30' }],
    ['oversized official page', (row: any) => { const c = row.raw_payload.proveniencia_preco.contexto_consulta; c.tamanhoPagina = 501; setGroupedQueryValue(row, 'tamanhoPagina', '501') }],
    ['invalid official UF', (row: any) => { const c = row.raw_payload.proveniencia_preco.contexto_consulta; c.estado = 'CEX'; setGroupedQueryValue(row, 'estado', 'CEX') }],
    ['invalid official start date', (row: any) => { const c = row.raw_payload.proveniencia_preco.contexto_consulta; c.dataCompraInicio = '2024-02-30'; setGroupedQueryValue(row, 'dataCompraInicio', '2024-02-30') }],
    ['reversed official date range', (row: any) => { const c = row.raw_payload.proveniencia_preco.contexto_consulta; c.dataCompraInicio = '2026-12-31'; c.dataCompraFim = '2024-01-01'; setGroupedQueryValue(row, 'dataCompraInicio', '2026-12-31'); setGroupedQueryValue(row, 'dataCompraFim', '2024-01-01') }],
    ['missing official query', (row: any) => { delete row.raw_payload.proveniencia_preco.contexto_consulta.urlConsultaOficial }],
    ['credentialed official query', (row: any) => { useGroupedQuery(row, GROUPED_QUERY_URL.replace('https://', 'https://spoof@')) }],
    ['default-port official query', (row: any) => { useGroupedQuery(row, GROUPED_QUERY_URL.replace('dadosabertos.compras.gov.br', 'dadosabertos.compras.gov.br:443')) }],
    ['fragmented official query', (row: any) => { useGroupedQuery(row, GROUPED_QUERY_URL + '#spoof') }],
    ['alternate official query host', (row: any) => {
      const proof = row.raw_payload.proveniencia_preco
      proof.url_evidencia = proof.url_evidencia.replace(
        'https://dadosabertos.compras.gov.br',
        'https://compras.gov.br',
      )
      proof.contexto_consulta.urlConsultaOficial = proof.url_evidencia
      proof.registro_oficial.url = proof.url_evidencia
      row.url_original = proof.url_evidencia
    }],
    ['unbound official evidence link', (row: any) => { useGroupedEvidence(row, GROUPED_PURCHASE_URL) }],
    ['credentialed bound evidence link', (row: any) => { useGroupedEvidence(row, 'https://spoof@compras.gov.br/compra/offline-review', 'linkEditalOuCompra') }],
    ['malformed bound evidence host', (row: any) => { useGroupedEvidence(row, 'https://.gov.br/compra/offline-review', 'linkEditalOuCompra') }],
    ['explicit-port bound evidence link', (row: any) => { useGroupedEvidence(row, 'https://compras.gov.br:444/compra/offline-review', 'linkEditalOuCompra') }],
    ['default-port bound evidence link', (row: any) => { useGroupedEvidence(row, 'https://compras.gov.br:443/compra/offline-review', 'linkEditalOuCompra') }],
    ['fragmented bound evidence link', (row: any) => { useGroupedEvidence(row, GROUPED_PURCHASE_URL + '#spoof', 'linkEditalOuCompra') }],
    ['redirect-like unbound evidence link', (row: any) => { const proof = row.raw_payload.proveniencia_preco; proof.registro_oficial.linkEditalOuCompra = GROUPED_PURCHASE_URL; useGroupedEvidence(row, GROUPED_PURCHASE_URL + '?redirect=https%3A%2F%2Fevil.invalid') }],
    ['extra query spoof', (row: any) => { const p = row.raw_payload.proveniencia_preco; p.url_evidencia += '&codigo=151063'; row.url_original = p.url_evidencia }],
  ])('rejects grouped proof with %s', (_label, mutate) => {
    const h = harness()
    const row: any = payloadFor(groupedSample())
    mutate(row)
    const result = h.run({ amostras: [row] })
    expect(result.body).toMatchObject({ inseridas: 0, atualizadas: 0, ignoradas: 1 })
    expect(h.records).toHaveLength(0)
  })
})

describe('actual persistence client and hook', () => {
  it('keeps a valid PNCP estimate with no price date without relabeling publication as a price date', async () => {
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const reply = h.run(JSON.parse(String(init.body)))
      return { ok: true, status: reply.status, json: async () => reply.body }
    }))
    const estimate = new PncpConnectorAdapter().normalize({ orgao_cnpj: '00000000000001', anoCompra: 2026,
      sequencialCompra: 9, numeroItem: 2, valorUnitarioEstimado: 0.5, descricao: 'SYNTHETIC ESTIMATE',
      dataPublicacaoPncp: '2026-01-02', proveniencia_preco: { versao: 1, status: 'verificada', fonte: 'PNCP',
        campo_unitario: 'valorUnitarioEstimado', valor_unitario: 0.5, natureza: 'estimado',
        url_evidencia: 'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/2',
        identidade: { cnpj: '00000000000001', ano: 2026, sequencial: 9, numeroItem: 2 },
        registro_oficial: { numeroItem: 2, valorUnitarioEstimado: 0.5, dataPublicacaoPncp: '2026-01-02' },
        campo_data: '', data_oficial: '' } }, 0)!
    expect(estimate.dataPublicacaoOuContrato).toBe('2026-01-02')
    expect(await PriceIndexService.persistirAmostras([estimate])).toEqual({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    expect(h.records[0].data_referencia).toBe('')
    expect(h.records[0].raw_payload.proveniencia_preco.registro_oficial.dataPublicacaoPncp).toBe('2026-01-02')
    expect(withoutServerValidationSeal(h.records[0].raw_payload)).toEqual(
      clone(estimate.detalhesAdicionais!),
    )
    expectServerValidationSeal(h.records[0])
  })

  it('accepts real adapter output for service/material and PNCP without inventing quantity or units', async () => {
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const reply = h.run(JSON.parse(String(init.body)))
      return { ok: reply.status === 200, status: reply.status, json: async () => reply.body }
    }))
    const compras = new ComprasGovConnectorAdapter()
    const service = compras.normalize({ idCompra: 'SYNTHETIC-COMPRA', idItemCompra: 'SYNTHETIC-ITEM',
      numeroItemCompra: 9, niFornecedor: '00000000000002', precoUnitario: 0.1366,
      descricaoItem: 'SYNTHETIC SERVICE', dataResultado: '2023-11-24', siglaUnidadeMedida: 'M3', codigoItemCatalogo: 16527 }, 0,
      { tipo: 'servico', codigo: '16527', consultaOficial: true, pagina: 1, tamanhoPagina: 500 })!
    const material = compras.normalize({ idCompra: 'SYNTHETIC-COMPRA', idItemCompra: 'SYNTHETIC-ITEM-2',
      niFornecedor: '00000000000002', precoUnitario: 0.5, descricaoItem: 'SYNTHETIC MATERIAL',
      dataHomologacao: '2026-01-01', codigoItemCatalogo: 991222 }, 0,
      { tipo: 'material', codigo: '991222', consultaOficial: true, pagina: 1, tamanhoPagina: 500 })!
    const pncp = new PncpConnectorAdapter().normalize({ orgao_cnpj: '00000000000001', anoCompra: 2026,
      sequencialCompra: 9, numeroItem: 2, valorUnitarioHomologado: 2.5, descricao: 'SYNTHETIC PNCP',
      fornecedor: { niFornecedor: '00000000000002' }, proveniencia_preco: { versao: 1, status: 'verificada', fonte: 'PNCP',
        campo_unitario: 'valorUnitarioHomologado', valor_unitario: 2.5, natureza: 'homologado',
        url_evidencia: 'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/2/resultados',
        identidade: { cnpj: '00000000000001', ano: 2026, sequencial: 9, numeroItem: 2 },
        registro_oficial: { niFornecedor: '00000000000002', sequencialResultado: 3, valorUnitarioHomologado: 2.5, dataResultado: '2026-01-01' },
        campo_data: 'dataResultado', data_oficial: '2026-01-01' } }, 0)!
    expect(await PriceIndexService.persistirAmostras([service, material, pncp])).toEqual({ inseridas: 3, atualizadas: 0, ignoradas: 0 })
    expect(h.records[0]).toMatchObject({ unidade: 'M3', quantidade: 0, valor_unitario: 0.1366 })
    expect(h.records[1]).toMatchObject({ unidade: 'NÃO INFORMADO', quantidade: 0, data_referencia: '2026-01-01' })
    expect(h.records[1].raw_payload.proveniencia_preco.campo_data).toBe('dataHomologacao')
    expect(withoutServerValidationSeal(h.records[2].raw_payload)).toEqual(
      clone(pncp.detalhesAdicionais!),
    )
    expectServerValidationSeal(h.records[2])
  })

  it.each([
    ['query fallback', {}, GROUPED_QUERY_URL],
    ['bound official purchase link', { linkEditalOuCompra: GROUPED_PURCHASE_URL }, GROUPED_PURCHASE_URL],
    ['credentialed returned link', { linkEditalOuCompra: 'https://user:pass@compras.gov.br/compra/offline-review' }, GROUPED_QUERY_URL],
    ['explicit-port returned link', { linkEditalOuCompra: 'https://compras.gov.br:444/compra/offline-review' }, GROUPED_QUERY_URL],
    ['default-port returned link', { linkEditalOuCompra: 'https://compras.gov.br:443/compra/offline-review' }, GROUPED_QUERY_URL],
    ['fragmented returned link', { linkEditalOuCompra: GROUPED_PURCHASE_URL + '#spoof' }, GROUPED_QUERY_URL],
    ['non-government returned link', { linkEditalOuCompra: 'https://compras.invalid/compra/offline-review' }, GROUPED_QUERY_URL],
    ['catalogue returned link', { linkEditalOuCompra: 'https://catalogo.compras.gov.br/compra/offline-review' }, GROUPED_QUERY_URL],
    ['empty-fragment returned link', { linkEditalOuCompra: GROUPED_PURCHASE_URL + '#' }, GROUPED_QUERY_URL],
    ['raw-whitespace returned link', { linkEditalOuCompra: 'https://compras.gov.br/compra/offline review' }, GROUPED_QUERY_URL],
    ['raw-backslash returned link', { linkEditalOuCompra: 'https://compras.gov.br\\compra\\offline-review' }, GROUPED_QUERY_URL],
    ['host-query returned link', { linkEditalOuCompra: 'https://compras.gov.br?compra=offline-review' }, GROUPED_QUERY_URL],
  ])('round-trips grouped PDM proof with %s through persistence, reuse and modal validation', async (_label, raw, expectedEvidence) => {
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const reply = h.run(JSON.parse(String(init.body)))
      return { ok: reply.status === 200, status: reply.status, json: async () => reply.body }
    }))
    const grouped = groupedSample(raw)
    expect(grouped.urlOriginal).toBe(expectedEvidence)
    expect(grouped.detalhesAdicionais!.proveniencia_preco.url_evidencia).toBe(expectedEvidence)
    expect(
      isEligibleComprasOfficialProof(
        grouped.detalhesAdicionais!.proveniencia_preco,
        grouped.valorUnitario,
      ),
    ).toBe(true)
    await expect(PriceIndexService.persistirAmostras([grouped])).resolves.toEqual({
      inseridas: 1,
      atualizadas: 0,
      ignoradas: 0,
    })
    await expect(PriceIndexService.persistirAmostras([grouped])).resolves.toEqual({
      inseridas: 0,
      atualizadas: 1,
      ignoradas: 0,
    })
    expect(h.records).toHaveLength(1)
    expect(withoutServerValidationSeal(h.records[0].raw_payload)).toEqual(
      clone(grouped.detalhesAdicionais!),
    )
    expectServerValidationSeal(h.records[0])
  })

  it.each([
    ['query fallback', {}],
    ['bound official purchase link', { linkEditalOuCompra: GROUPED_PURCHASE_URL }],
    ['credentialed returned link fallback', { linkEditalOuCompra: 'https://user:pass@compras.gov.br/compra/offline-review' }],
    ['explicit-port returned link fallback', { linkEditalOuCompra: 'https://compras.gov.br:444/compra/offline-review' }],
    ['default-port returned link fallback', { linkEditalOuCompra: 'https://compras.gov.br:443/compra/offline-review' }],
    ['fragmented returned link fallback', { linkEditalOuCompra: GROUPED_PURCHASE_URL + '#spoof' }],
    ['non-government returned link fallback', { linkEditalOuCompra: 'https://compras.invalid/compra/offline-review' }],
    ['catalogue returned link fallback', { linkEditalOuCompra: 'https://catalogo.compras.gov.br/compra/offline-review' }],
    ['empty-fragment returned link fallback', { linkEditalOuCompra: GROUPED_PURCHASE_URL + '#' }],
    ['raw-whitespace returned link fallback', { linkEditalOuCompra: 'https://compras.gov.br/compra/offline review' }],
    ['raw-backslash returned link fallback', { linkEditalOuCompra: 'https://compras.gov.br\\compra\\offline-review' }],
    ['host-query returned link fallback', { linkEditalOuCompra: 'https://compras.gov.br?compra=offline-review' }],
  ])('reuses a rounded legacy slot when grouped PDM evidence arrives with %s', (_label, raw) => {
    const exact = budgetRow(groupedSample(raw), 'EXACT-ID')
    const legacy = clone(exact)
    legacy.id = 'SAVED-STABLE-ID'
    legacy.source_record_id = legacy.source_record_id!.replace(
      '15836906900012025',
      '15836906900012024',
    )
    legacy.raw_data!.proveniencia_preco.identidade.idCompra = 15836906900012024
    legacy.raw_data!.proveniencia_preco.registro_oficial.idCompra = 15836906900012024
    const keyFor = (row: BudgetPriceResult) =>
      `${row.source}_${row.source_record_id}_${row.unit_price}`
    const map = new Map<string, BudgetPriceResult>([[keyFor(legacy), legacy]])

    mesclarIdentidadeCompras(map, exact, keyFor)

    expect(map.size).toBe(1)
    expect([...map.values()][0]).toMatchObject({
      id: 'SAVED-STABLE-ID',
      source_record_id: exact.source_record_id,
    })
  })

  it.each([
    ['PDM context mismatch', (row: BudgetPriceResult) => { row.raw_data!.proveniencia_preco.contexto_consulta.codigoPdm = '19386' }],
    ['CATMAT record mismatch', (row: BudgetPriceResult) => { row.raw_data!.proveniencia_preco.registro_oficial.codigoCatmat = '151064' }],
    ['unsafe codigoPdm', (row: BudgetPriceResult) => { row.raw_data!.proveniencia_preco.registro_oficial.codigoPdm = 9007199254740992 }],
    ['missing official query', (row: BudgetPriceResult) => { delete row.raw_data!.proveniencia_preco.contexto_consulta.urlConsultaOficial }],
    ['credentialed official query', (row: BudgetPriceResult) => { useGroupedQuery(row, GROUPED_QUERY_URL.replace('https://', 'https://spoof@')) }],
    ['default-port official query', (row: BudgetPriceResult) => { useGroupedQuery(row, GROUPED_QUERY_URL.replace('dadosabertos.compras.gov.br', 'dadosabertos.compras.gov.br:443')) }],
    ['fragmented official query', (row: BudgetPriceResult) => { useGroupedQuery(row, GROUPED_QUERY_URL + '#spoof') }],
    ['alternate official query host', (row: BudgetPriceResult) => {
      const proof = row.raw_data!.proveniencia_preco
      proof.url_evidencia = proof.url_evidencia.replace(
        'https://dadosabertos.compras.gov.br',
        'https://compras.gov.br',
      )
      proof.contexto_consulta.urlConsultaOficial = proof.url_evidencia
      proof.registro_oficial.url = proof.url_evidencia
      row.source_url = proof.url_evidencia
    }],
    ['unbound official evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, GROUPED_PURCHASE_URL) }],
    ['credentialed bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, 'https://spoof@compras.gov.br/compra/offline-review', 'linkEditalOuCompra') }],
    ['explicit-port bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, 'https://compras.gov.br:444/compra/offline-review', 'linkEditalOuCompra') }],
    ['default-port bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, 'https://compras.gov.br:443/compra/offline-review', 'linkEditalOuCompra') }],
    ['fragmented bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, GROUPED_PURCHASE_URL + '#spoof', 'linkEditalOuCompra') }],
    ['empty-fragment bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, GROUPED_PURCHASE_URL + '#', 'linkEditalOuCompra') }],
    ['raw-whitespace bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, 'https://compras.gov.br/compra/offline review', 'linkEditalOuCompra') }],
    ['raw-backslash bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, 'https://compras.gov.br\\compra\\offline-review', 'linkEditalOuCompra') }],
    ['host-query bound evidence link', (row: BudgetPriceResult) => { useGroupedEvidence(row, 'https://compras.gov.br?compra=offline-review', 'linkEditalOuCompra') }],
    ['redirect-like unbound evidence link', (row: BudgetPriceResult) => { const proof = row.raw_data!.proveniencia_preco; proof.registro_oficial.linkEditalOuCompra = GROUPED_PURCHASE_URL; useGroupedEvidence(row, GROUPED_PURCHASE_URL + '?redirect=https%3A%2F%2Fevil.invalid') }],
    ['credentialed official URL', (row: BudgetPriceResult) => {
      const proof = row.raw_data!.proveniencia_preco
      proof.url_evidencia = proof.url_evidencia.replace('https://', 'https://spoof@')
      proof.contexto_consulta.urlConsultaOficial = proof.url_evidencia
      row.source_url = proof.url_evidencia
    }],
    ['official URL fragment', (row: BudgetPriceResult) => {
      const proof = row.raw_data!.proveniencia_preco
      proof.url_evidencia += '#spoof'
      proof.contexto_consulta.urlConsultaOficial = proof.url_evidencia
      row.source_url = proof.url_evidencia
    }],
    ['duplicate grouped query key', (row: BudgetPriceResult) => {
      const proof = row.raw_data!.proveniencia_preco
      proof.url_evidencia += '&codigo=151063'
      row.source_url = proof.url_evidencia
    }],
  ])('does not reuse a rounded legacy slot for grouped proof with %s', (_label, mutate) => {
    const exact = budgetRow(groupedSample(), 'EXACT-ID')
    const legacy = clone(exact)
    legacy.id = 'SAVED-STABLE-ID'
    legacy.source_record_id = legacy.source_record_id!.replace(
      '15836906900012025',
      '15836906900012024',
    )
    legacy.raw_data!.proveniencia_preco.identidade.idCompra = 15836906900012024
    legacy.raw_data!.proveniencia_preco.registro_oficial.idCompra = 15836906900012024
    mutate(exact)
    const keyFor = (row: BudgetPriceResult) =>
      `${row.source}_${row.source_record_id}_${row.unit_price}`
    const map = new Map<string, BudgetPriceResult>([[keyFor(legacy), legacy]])

    mesclarIdentidadeCompras(map, exact, keyFor)

    expect(map.size).toBe(2)
    expect([...map.values()].map((row) => row.id)).toEqual([
      'SAVED-STABLE-ID',
      'EXACT-ID',
    ])
  })

  it('does not reuse a rounded item slot whose official query has an extra key', () => {
    const exact = budgetRow(materialItemSample(), 'EXACT-ID')
    const legacy = clone(exact)
    legacy.id = 'SAVED-STABLE-ID'
    legacy.source_record_id = legacy.source_record_id!.replace(
      '15836906900012025',
      '15836906900012024',
    )
    legacy.raw_data!.proveniencia_preco.identidade.idCompra = 15836906900012024
    legacy.raw_data!.proveniencia_preco.registro_oficial.idCompra = 15836906900012024
    legacy.source_url += '&unexpected=1'
    legacy.raw_data!.proveniencia_preco.url_evidencia = legacy.source_url
    const keyFor = (row: BudgetPriceResult) =>
      `${row.source}_${row.source_record_id}_${row.unit_price}`
    const map = new Map<string, BudgetPriceResult>([[keyFor(legacy), legacy]])

    mesclarIdentidadeCompras(map, exact, keyFor)

    expect(map.size).toBe(2)
    expect([...map.values()].map((row) => row.id)).toEqual([
      'SAVED-STABLE-ID',
      'EXACT-ID',
    ])
  })

  it('reuses a rounded item slot whose strict returned record link is on the data host', () => {
    const exactSample = materialItemSample()
    const recordLink = 'https://dadosabertos.compras.gov.br/compra/123'
    exactSample.urlOriginal = recordLink
    exactSample.detalhesAdicionais!.proveniencia_preco.url_evidencia = recordLink
    exactSample.detalhesAdicionais!.proveniencia_preco.registro_oficial.linkEditalOuCompra = recordLink
    const exact = budgetRow(exactSample, 'EXACT-ID')
    const legacy = clone(exact)
    legacy.id = 'SAVED-STABLE-ID'
    legacy.source_record_id = legacy.source_record_id!.replace(
      '15836906900012025',
      '15836906900012024',
    )
    legacy.raw_data!.proveniencia_preco.identidade.idCompra = 15836906900012024
    legacy.raw_data!.proveniencia_preco.registro_oficial.idCompra = 15836906900012024
    const keyFor = (row: BudgetPriceResult) =>
      `${row.source}_${row.source_record_id}_${row.unit_price}`
    const map = new Map<string, BudgetPriceResult>([[keyFor(legacy), legacy]])

    mesclarIdentidadeCompras(map, exact, keyFor)

    expect(map.size).toBe(1)
    expect([...map.values()][0]).toMatchObject({
      id: 'SAVED-STABLE-ID',
      source_record_id: exact.source_record_id,
    })
  })

  it('persists 2992 samples in thirty authenticated requests of at most 100, preserving proof', async () => {
    const h = harness(), lengths: number[] = []
    let active = 0, peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://offline-index.invalid/backend/v1/cotai/index-batch')
      expect(init.method).toBe('POST')
      expect((init.headers as any).Authorization).toBe('SYNTHETIC-TOKEN')
      active++; peak = Math.max(active, peak)
      await Promise.resolve()
      const body = JSON.parse(String(init.body)); lengths.push(body.amostras.length)
      const reply = h.run(body); active--
      return { ok: reply.status === 200, status: reply.status, json: async () => reply.body }
    }))
    const result = await PriceIndexService.persistirAmostras(Array.from({ length: 2992 }, (_, i) => sample(i + 1)))
    expect(result).toEqual({ inseridas: 2992, atualizadas: 0, ignoradas: 0 })
    expect(lengths).toEqual([...Array(29).fill(100), 92])
    expect(peak).toBe(1)
    expect(h.records).toHaveLength(2992)
    expect(withoutServerValidationSeal(h.records[0].raw_payload)).toEqual(
      clone(sample().detalhesAdicionais!),
    )
    expectServerValidationSeal(h.records[0])
  })

  it('serializes concurrent persistence callers through one shared request queue', async () => {
    const h = harness()
    let active = 0, peak = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      const reply = h.run(JSON.parse(String(init.body))); active--
      return { ok: true, status: 200, json: async () => reply.body }
    }))
    await Promise.all([
      PriceIndexService.persistirAmostras([sample(1)]),
      PriceIndexService.persistirAmostras([sample(2)]),
      PriceIndexService.persistirAmostras([sample(3)]),
    ])
    expect(peak).toBe(1)
    expect(h.records).toHaveLength(3)
  })

  it('stops after HTTP failure without per-record fallback or fabricated success and lets later callers run', async () => {
    const h = harness(), calls: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls.push(body.amostras.length)
      if (calls.length === 2) return { ok: false, status: 503, json: async () => ({ message: 'SYNTHETIC PRIVATE RESPONSE' }) }
      const reply = h.run(body)
      return { ok: true, status: 200, json: async () => reply.body }
    }))
    await expect(PriceIndexService.persistirAmostras(Array.from({ length: 201 }, (_, i) => sample(i + 1))))
      .rejects.toMatchObject({ code: 'INDEX_BATCH_FAILED', status: 503, parcial: { inseridas: 100, atualizadas: 0, ignoradas: 0 } })
    expect(calls).toEqual([100, 100])
    expect(await PriceIndexService.persistirAmostras([sample(300)])).toEqual({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
  })

  it.each(['transport', 'counts', 'success'])('returns a sanitized explicit %s failure without retries', async (kind) => {
    const fetchMock = vi.fn(async () => {
      if (kind === 'transport') throw new Error('SYNTHETIC PRIVATE TRANSPORT')
      return { ok: true, status: 200, json: async () => ({ sucesso: kind !== 'success', recebidas: 1,
        inseridas: kind === 'counts' ? 999 : 1, atualizadas: 0, ignoradas: 0 }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(PriceIndexService.persistirAmostras([sample()])).rejects.toMatchObject({ code: 'INDEX_BATCH_FAILED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['response', 'body'])('times out the POST %s safely and releases the shared queue', async (stage) => {
    vi.useFakeTimers()
    const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('SYNTHETIC PRIVATE ABORT', 'AbortError')), { once: true })
    })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (stage === 'response') return waitForAbort(init.signal as AbortSignal)
      return { ok: true, status: 200, json: () => waitForAbort(init.signal as AbortSignal) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const work = PriceIndexService.persistirAmostras([sample()])
    await Promise.all([
      expect(work).rejects.toMatchObject({ code: 'INDEX_BATCH_FAILED', timed_out: true,
        message: 'Persistência do índice interrompida.', parcial: { inseridas: 0, atualizadas: 0, ignoradas: 0 } }),
      vi.advanceTimersByTimeAsync(10000),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ sucesso: true, recebidas: 1, inseridas: 1, atualizadas: 0, ignoradas: 0 }) })))
    await expect(PriceIndexService.persistirAmostras([sample(2)])).resolves.toMatchObject({ inseridas: 1 })
  })
})
