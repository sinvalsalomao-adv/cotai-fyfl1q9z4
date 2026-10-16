import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { ComprasGovConnectorAdapter } from '../src/lib/connectors/comprasGovConnectorAdapter'
import { PriceIndexService } from '../src/lib/priceIndexService'

// All records are invented offline fixtures. No real credentials, APIs or DB.
vi.mock('../src/lib/pocketbase/client', () => ({ default: {
  baseUrl: 'https://offline-contract.invalid', authStore: { token: '' },
} }))
vi.mock('../src/lib/priceIndexService', () => ({ PriceIndexService: {
  persistirAmostras: vi.fn(async () => ({ inseridas: 0, atualizadas: 0, ignoradas: 0 })),
} }))
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const row = (code = '991222', page = 1, kind = 'MATERIAL') => ({
  idCompra: 'SYNTHETIC-COMPRA', idItemCompra: `SYNTHETIC-ITEM-${code}-${page}`,
  numeroItemCompra: page, codigoItemCatalogo: code, tipoItem: kind,
  descricaoItem: 'SYNTHETIC OFFLINE ITEM', precoUnitario: 7.25,
  dataResultado: '2026-02-03', cnpjFornecedor: 'SYNTHETIC-SUPPLIER',
  nomeFornecedor: 'SYNTHETIC SUPPLIER', estado: 'CE', siglaUnidadeFornecimento: 'H',
})
const priceBody = (items: unknown[], total = items.length, pages = total ? 1 : 0) => ({
  sucesso: true, dados: { resultado: items, totalRegistros: total, totalPaginas: pages },
})

function officialCatalog(query: Record<string, string>, calls: URL[]) {
  let handler: (e: unknown) => any
  const context = vm.createContext({
    routerAdd(_method: string, _path: string, callback: typeof handler) { handler = callback },
    $apis: { requireAuth: () => ({}) },
    $http: { send(request: { url: string }) {
      const url = new URL(request.url)
      calls.push(url)
      const result = url.pathname.endsWith('/material/v1/palavra')
        ? [{ codigoPdm: 991111, codigoPDM: 991111, nomePdm: 'SYNTHETIC PDM', statusPDM: true }]
        : url.pathname.endsWith('/servico/v1/palavra')
          ? [{ codigoServico: 995555, descricaoServicoAcentuado: 'SYNTHETIC SERVICE', statusServico: true }]
          : [{ codigoPdm: 991111, codigoItem: 991222, statusItem: true, itemSuspenso: false }]
      return { statusCode: 200, json: result }
    } },
  })
  const hookPath = fileURLToPath(new URL('../pocketbase/hooks/comprasgov_catalog.js', import.meta.url))
  new vm.Script(readFileSync(hookPath, 'utf8')).runInContext(context)
  return handler!({ auth: { id: 'SYNTHETIC-USER' }, requestInfo: () => ({ query }),
    json(status: number, body: any) { return { status, body: copy(body) } } })
}

function transport(options: {
  price?: (url: URL, signal?: AbortSignal) => any | Promise<any>
  catalog?: (query: Record<string, string>) => any
  priceUpstream?: (url: URL) => { statusCode: number; json: unknown }
} = {}) {
  const requests: URL[] = []
  const catalogCalls: URL[] = []
  const priceUpstreamCalls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input)
    requests.push(url)
    const params = Object.fromEntries(url.searchParams)
    if (url.pathname === '/backend/v1/comprasgov/catalogo') {
      const reply = options.catalog ? { status: 200, body: options.catalog(params) }
        : officialCatalog(params, catalogCalls)
      return { ok: reply.status === 200, status: reply.status, json: async () => copy(reply.body) }
    }
    expect(url.pathname).toBe('/backend/v1/cotai/comprasgov-search')
    if (options.priceUpstream) {
      // Execute the real price hook; stub only its external official HTTP boundary.
      let handler: (e: unknown) => any
      const context = vm.createContext({
        routerAdd(_method: string, _path: string, callback: typeof handler) { handler = callback },
        console: { log() {}, warn() {}, error() {} },
        $http: { send(request: { url: string }) {
          const officialUrl = new URL(request.url)
          priceUpstreamCalls.push(officialUrl)
          return copy(options.priceUpstream!(officialUrl))
        } },
      })
      const pricePath = fileURLToPath(new URL('../pocketbase/hooks/comprasgov_search.js', import.meta.url))
      new vm.Script(readFileSync(pricePath, 'utf8')).runInContext(context)
      const reply = handler!({ requestInfo: () => ({ query: params }),
        json(status: number, body: any) { return { status, body: copy(body) } } })
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status,
        json: async () => copy(reply.body) }
    }
    const code = params.codigo_item || params.catmat || params.catser
    const result = options.price ? await options.price(url, init.signal as AbortSignal)
      : priceBody([row(code, Number(params.pagina), params.catser ? 'SERVICO' : 'MATERIAL')])
    return { ok: true, status: 200, json: async () => copy(result) }
  }))
  return { requests, catalogCalls, priceUpstreamCalls }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('actual Compras adapter search and normalizer, offline HTTP only', () => {
  it('uses official identity independently of row index and price; keeps namespaces separate', () => {
    const adapter = new ComprasGovConnectorAdapter()
    const first = adapter.normalize(row(), 0)!
    const moved = adapter.normalize({ ...row(), precoUnitario: 9.75 }, 99)!
    expect(first.id).toBe(moved.id)
    expect(first.idExterno).toBe(moved.idExterno)
    expect(first.idExterno).toContain('SYNTHETIC-COMPRA')
    expect(adapter.normalize(row('991222', 1, 'SERVICO'), 0)!.id).not.toBe(first.id)
    expect(adapter.normalize({ ...row(), idItemCompra: 'SYNTHETIC-OTHER' }, 0)!.id).not.toBe(first.id)
  })

  it('keeps official unit and UF, leaves missing quantity unknown, and links to prices', () => {
    const result = new ComprasGovConnectorAdapter().normalize(row(), 0)!
    expect(result.unidade).toBe('H')
    expect(result.uf).toBe('CE')
    expect(result.quantidade).toBe(0)
    expect(result.valorTotal).toBeUndefined()
    expect(result.urlOriginal).toContain('dadosabertos.compras.gov.br/modulo-pesquisa-preco/')
    expect(result.urlOriginal).not.toContain('catalogo.compras')
    expect(result.detalhesAdicionais?.proveniencia_preco?.status).toBe('nao_verificada')
    expect(new ComprasGovConnectorAdapter().normalize({ ...row(), precoUnitario: Infinity }, 0)).toBeNull()
  })

  it('generic term discovers both namespaces through the actual CNBS hook and queue', async () => {
    const t = transport()
    const batches: string[] = []
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'DIPIRONA' }, (items) => {
      batches.push(...items.map((item) => item.codigoCatalogo!))
    })
    expect(t.catalogCalls.some((u) => u.pathname.endsWith('/material/v1/palavra'))).toBe(true)
    expect(t.catalogCalls.some((u) => u.pathname.endsWith('/servico/v1/palavra'))).toBe(true)
    expect(t.catalogCalls.some((u) => u.pathname.endsWith('/materialCaracteristcaValorporPDM'))).toBe(true)
    const prices = t.requests.filter((u) => u.pathname.endsWith('comprasgov-search'))
    expect(prices).toHaveLength(2)
    expect(prices.some((u) => (u.searchParams.get('codigo_item') || u.searchParams.get('catmat')) === '991222')).toBe(true)
    expect(prices.some((u) => u.searchParams.get('catser') === '995555')).toBe(true)
    expect(prices.every((u) => u.searchParams.get('tam_pagina') === '500')).toBe(true)
    expect(batches.sort()).toEqual(['CATMAT 991222', 'CATSER 995555'])
    expect(result.amostras).toHaveLength(2)
    expect(result.status).toBe('CONCLUIDA')
    const proof = result.amostras[0].detalhesAdicionais?.proveniencia_preco
    expect(proof).toMatchObject({ status: 'verificada' })
    expect(proof.fonte).toBe('Compras.gov.br')
    expect(proof.campo_unitario).toBe('precoUnitario')
    expect(proof.valor_unitario).toBe(7.25)
    expect(proof.url_evidencia).toContain('/modulo-pesquisa-preco/')
    expect(proof.registro_oficial.idCompra).toBe('SYNTHETIC-COMPRA')
  })

  it.each([
    [{ termo: 'CATMAT 991222' }, 'material', '991222'],
    [{ termo: 'CATSER: 995555' }, 'servico', '995555'],
    [{ termo: 'SYNTHETIC', catmatOuCodigo: '991222' }, 'material', '991222'],
    [{ termo: 'SYNTHETIC', catserOuCodigo: '995555' }, 'servico', '995555'],
  ])('explicit typed code bypasses discovery: %j', async (params, kind, code) => {
    const t = transport()
    const result = await new ComprasGovConnectorAdapter().search(params)
    expect(t.catalogCalls).toHaveLength(0)
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0].searchParams.get('tipo_catalogo')).toBe(kind)
    expect(t.requests[0].searchParams.get(kind === 'material' ? 'codigo_item' : 'catser') ||
      t.requests[0].searchParams.get('catmat')).toBe(code)
    expect(result.status).toBe('CONCLUIDA')
  })

  it('continues every official code page, preserves zero, and counts totals once per code', async () => {
    const t = transport({ price: (url) => {
      const page = Number(url.searchParams.get('pagina'))
      return priceBody(page === 7 ? [] : [row('991222', page)], 17, 7)
    } })
    const result: any = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(t.requests).toHaveLength(7)
    expect(result.totalRegistrosInformadosApi).toBe(17)
    expect(result.paginacaoCompras).toEqual([{ tipo: 'material', codigo: '991222', pagina: 7, tamanho: 500, total: 17, paginas: 7 }])
    expect(result.continuacoesCompras).toEqual([])
    expect(new URL(result.amostras[1].urlOriginal).searchParams.get('pagina')).toBe('2')
    expect(new URL(result.amostras[1].urlOriginal).searchParams.get('tamanhoPagina')).toBe('500')
  })

  it('does not fabricate a price sample or more pages from valid zero', async () => {
    const t = transport({ price: () => priceBody([], 0, 0) })
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(t.requests).toHaveLength(1)
    expect(result.amostras).toEqual([])
    expect(result.totalRegistrosInformadosApi).toBe(0)
    expect(result.status).toBe('CONCLUIDA')
  })

  it('rejects pre-aborted search before any HTTP or persistence', async () => {
    const t = transport()
    const controller = new AbortController()
    controller.abort()
    await expect(new ComprasGovConnectorAdapter().search({ termo: 'SYNTHETIC', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(t.requests).toHaveLength(0)
    expect(PriceIndexService.persistirAmostras).not.toHaveBeenCalled()
  })

  it('returns resumable typed work when an explicit deadline is already over', async () => {
    const t = transport()
    const result: any = await new ComprasGovConnectorAdapter().search({
      termo: 'CATSER 995555', deadlineAtMs: Date.now() - 1,
    } as any)
    expect(t.requests).toHaveLength(0)
    expect(result.status).toBe('CONCLUIDA_PARCIAL')
    expect(result.continuacoesCompras).toEqual([{ etapa: 'precos', tipo: 'servico', codigo: '995555', pagina: 1 }])
  })

  it('schema failure in catalog remains partial/failure with pending work, never valid zero', async () => {
    transport({ catalog: () => ({ sucesso: false, trabalhos: [], erro: { mensagem: 'SYNTHETIC ERROR' } }) })
    const result: any = await new ComprasGovConnectorAdapter().search({ termo: 'SYNTHETIC TERM' })
    expect(result.status).not.toBe('CONCLUIDA')
    expect(result.continuacoesCompras).toHaveLength(2)
  })

  it('real price hook preserves distinct purchases with identical supplier/item number/price', async () => {
    const first = { ...row(), idCompra: 'SYNTHETIC-A', idItemCompra: 'SYNTHETIC-IA' }
    const second = { ...row(), idCompra: 'SYNTHETIC-B', idItemCompra: 'SYNTHETIC-IB' }
    const t = transport({ priceUpstream: () => ({ statusCode: 200,
      json: { resultado: [first, second], totalRegistros: 2, totalPaginas: 1 } }) })
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(result.amostras).toHaveLength(2)
    expect(new Set(result.amostras.map((sample) => sample.id)).size).toBe(2)
    expect(t.priceUpstreamCalls).toHaveLength(1)
  })

  it('real price hook preserves empty page totals and adapter reaches the next official page', async () => {
    const t = transport({ priceUpstream: (url) => ({ statusCode: 200, json: {
      resultado: url.searchParams.get('pagina') === '1' ? [] : [row('991222', 2)],
      totalRegistros: 800, totalPaginas: 2,
    } }) })
    const result: any = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(t.priceUpstreamCalls.map((url) => url.searchParams.get('pagina'))).toEqual(['1', '2'])
    expect(result.totalRegistrosInformadosApi).toBe(800)
    expect(result.paginacaoCompras[0].paginas).toBe(2)
    expect(result.amostras).toHaveLength(1)
  })

  it('real price hook rejects unexpected HTTP200 schema instead of certifying empty success', async () => {
    const t = transport({ priceUpstream: () => ({ statusCode: 200, json: { unexpected: 'SYNTHETIC' } }) })
    const result: any = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(result.sucesso).toBe(false)
    expect(result.status).toBe('FALHA_TOTAL')
    expect(result.continuacoesCompras).toHaveLength(1)
    expect(t.priceUpstreamCalls.every((url) => url.pathname.endsWith('/1_consultarMaterial'))).toBe(true)
    expect(PriceIndexService.persistirAmostras).not.toHaveBeenCalled()
  })

  it('evidence reproduces official date filters forwarded by the actual price hook', async () => {
    const t = transport({ priceUpstream: () => ({ statusCode: 200,
      json: { resultado: [row()], totalRegistros: 1, totalPaginas: 1 } }) })
    const result = await new ComprasGovConnectorAdapter().search({
      termo: 'CATMAT 991222', dataInicio: '2026-01-01', dataFim: '2026-12-31', uf: 'CE',
    })
    const proof = result.amostras[0].detalhesAdicionais!.proveniencia_preco
    const evidence = new URL(proof.url_evidencia)
    expect(evidence.searchParams.get('dataInicial')).toBe(t.priceUpstreamCalls[0].searchParams.get('dataInicial'))
    expect(evidence.searchParams.get('dataFinal')).toBe(t.priceUpstreamCalls[0].searchParams.get('dataFinal'))
    expect(proof.contexto_consulta.dataInicial).toBe('20260101')
    expect(proof.contexto_consulta.dataFinal).toBe('20261231')
  })

  it('real price hook never infers an absent official unit from the description', async () => {
    transport({ priceUpstream: () => ({ statusCode: 200, json: {
      resultado: [{ ...row(), siglaUnidadeFornecimento: undefined,
        descricaoItem: 'SYNTHETIC CAIXA COM 100 AMPOLAS' }], totalRegistros: 1, totalPaginas: 1,
    } }) })
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(result.amostras).toHaveLength(1)
    expect(result.amostras[0].unidade).toBe('NÃO INFORMADO')
    const official = result.amostras[0].detalhesAdicionais!.proveniencia_preco.registro_oficial
    expect(official).not.toHaveProperty('unidadeMedida')
    expect(official).not.toHaveProperty('unidade')
  })

  it('real price hook preserves the original date kind when result date is absent', async () => {
    transport({ priceUpstream: () => ({ statusCode: 200, json: {
      resultado: [{ ...row(), dataResultado: undefined,
        dataCompra: '2025-04-01', dataAbertura: '2025-01-01' }], totalRegistros: 1, totalPaginas: 1,
    } }) })
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(result.amostras).toHaveLength(1)
    const proof = result.amostras[0].detalhesAdicionais!.proveniencia_preco
    expect(proof.registro_oficial).not.toHaveProperty('dataResultado')
    expect(proof.registro_oficial.dataCompra).toBe('2025-04-01')
    expect(proof.registro_oficial.dataAbertura).toBe('2025-01-01')
    expect(proof.campo_data).toBe('dataCompra')
    expect(proof.data_oficial).toBe('2025-04-01')
  })

  it('recognizes official homologation date without fabricating a result date', async () => {
      transport({ priceUpstream: () => ({ statusCode: 200, json: {
        resultado: [{ ...row(), dataResultado: undefined, dataHomologacao: '2025-03-04' }],
        totalRegistros: 1, totalPaginas: 1,
      } }) })
      const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
      expect(result.amostras).toHaveLength(1)
      const sample = result.amostras[0]
      const proof = sample.detalhesAdicionais!.proveniencia_preco
      expect(sample.dataPublicacaoOuContrato).toBe('2025-03-04')
      expect(proof.data_oficial).toBe('2025-03-04')
      expect(proof.campo_data).toBe('dataHomologacao')
      expect(proof.registro_oficial.dataHomologacao).toBe('2025-03-04')
      expect(proof.registro_oficial).not.toHaveProperty('dataResultado')
      expect(proof.status).toBe('verificada')
  })

  it('preserves opening date as metadata, not as verified price reference date', async () => {
    transport({ priceUpstream: () => ({ statusCode: 200, json: {
      resultado: [{ ...row(), dataResultado: undefined, dataAbertura: '2025-03-04' }],
      totalRegistros: 1, totalPaginas: 1,
    } }) })
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    const sample = result.amostras[0]
    const proof = sample.detalhesAdicionais!.proveniencia_preco
    expect(sample.dataPublicacaoOuContrato).toBe('')
    expect(proof.data_oficial).toBeNull()
    expect(proof.campo_data).toBeNull()
    expect(proof.registro_oficial.dataAbertura).toBe('2025-03-04')
    expect(proof.registro_oficial).not.toHaveProperty('dataResultado')
    expect(proof.status).toBe('nao_verificada')
  })
})
