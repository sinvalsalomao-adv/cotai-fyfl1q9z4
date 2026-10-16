import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { PriceIndexService } from '../src/lib/priceIndexService'
import type { AmostraPreco } from '../src/lib/connectors/types'
import { ComprasGovConnectorAdapter } from '../src/lib/connectors/comprasGovConnectorAdapter'
import { PncpConnectorAdapter } from '../src/lib/connectors/pncpConnectorAdapter'

vi.mock('../src/lib/pocketbase/client', () => ({ default: {
  baseUrl: 'https://offline-index.invalid', authStore: { token: 'SYNTHETIC-TOKEN' },
  collection() { throw new Error('Per-record SDK persistence is forbidden in this test') },
} }))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const path = fileURLToPath(new URL('../pocketbase/hooks/index_batch.js', import.meta.url))
const source = existsSync(path) ? readFileSync(path, 'utf8') : ''

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

function harness(options: { failSaveAt?: number } = {}) {
  let handler: (event: any) => any
  let middleware: any[] = []
  let database = new Map<string, any>()
  let transactions = 0, saves = 0
  class Record {
    id = ''
    data: any = {}
    constructor(_collection: any) {}
    set(key: string, value: any) { this.data[key] = clone(value) }
    get(key: string) { return this.data[key] }
    getString(key: string) { return String(this.data[key] ?? '') }
  }
  const app = {
    runInTransaction(callback: (tx: any) => void) {
      transactions++
      const draft = new Map([...database].map(([key, data]) => [key, clone(data)]))
      callback({
        findCollectionByNameOrId(name: string) { expect(name).toBe('price_samples_index'); return { name } },
        findRecordsByFilter(name: string, filter: string, _sort: string, limit: number, _offset: number, params: any) {
          expect(name).toBe('price_samples_index')
          expect(filter).toBe('sample_key = {:key}')
          expect(limit).toBe(1)
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
  })
  return {
    run(body: any, auth: any = { id: 'SYNTHETIC-USER' }) {
      expect(handler).toBeTypeOf('function')
      return handler!({ auth, requestInfo: () => ({ body }), json: (status: number, result: any) => ({ status, body: clone(result) }) })
    },
    get records() { return [...database.values()] },
    get middleware() { return middleware },
    get transactions() { return transactions },
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
    expect(h.records[0]).toMatchObject({ sample_key: first.sample_key, unidade: 'NÃO INFORMADO', quantidade: 0, data_referencia: '2026-01-01', raw_payload: first.raw_payload })
    expect(h.records[0].valor_total).toBeUndefined()
    expect(h.transactions).toBe(2)
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
    expect(h.records[0].raw_payload).toEqual(estimate.detalhesAdicionais)
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
    expect(h.records[2].raw_payload).toEqual(pncp.detalhesAdicionais)
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
    expect(h.records[0].raw_payload).toEqual(sample().detalhesAdicionais)
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
