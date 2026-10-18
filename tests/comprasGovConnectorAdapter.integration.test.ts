import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { ComprasGovConnectorAdapter } from '../src/lib/connectors/comprasGovConnectorAdapter'
import { PriceIndexService } from '../src/lib/priceIndexService'

// All records are invented offline fixtures. No real credentials, APIs or DB.
vi.mock('../src/lib/pocketbase/client', () => ({ default: {
  baseUrl: 'https://offline-contract.invalid', authStore: { token: '' },
} }))
vi.mock('../src/lib/priceIndexService', () => ({ PriceIndexService: {
  persistirAmostras: vi.fn(async (items: unknown[]) => ({
    inseridas: items.length, atualizadas: 0, ignoradas: 0,
  })),
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
      class FakeRecord {
        data: Record<string, unknown> = {}
        constructor(_collection: unknown) {}
        set(key: string, value: unknown) { this.data[key] = copy(value) }
      }
      class FakeDynamicModel {
        [key: string]: unknown
        constructor(data: Record<string, unknown>) { Object.assign(this, data) }
      }
      const context = vm.createContext({
        routerAdd(_method: string, _path: string, callback: typeof handler) { handler = callback },
        $apis: { requireAuth: () => ({}) },
        $security: {
          sha256(value: string) { return createHash('sha256').update(value).digest('hex') },
          randomString(length: number) { return 'R'.repeat(length) },
        },
        $app: {
          findRecordsByFilter() { return [] },
          findCollectionByNameOrId() { return { name: 'official_ingestion_receipts' } },
          db() {
            return {
              newQuery() {
                return {
                  bind() { return this },
                  all(rows: Array<Record<string, unknown>>) {
                    rows.splice(0, rows.length, { request_count: 1 })
                  },
                }
              },
            }
          },
          save() {},
          delete() {},
        },
        DynamicModel: FakeDynamicModel,
        arrayOf(value: unknown) { return [value] },
        Record: FakeRecord,
        console: { log() {}, warn() {}, error() {} },
        $http: { send(request: { url: string }) {
          const officialUrl = new URL(request.url)
          priceUpstreamCalls.push(officialUrl)
          return copy(options.priceUpstream!(officialUrl))
        } },
      })
      const pricePath = fileURLToPath(new URL('../pocketbase/hooks/comprasgov_search.js', import.meta.url))
      new vm.Script(readFileSync(pricePath, 'utf8')).runInContext(context)
      const reply = handler!({ auth: { id: 'SYNTHETIC-USER' }, requestInfo: () => ({ query: params }),
        json(status: number, body: any) { return { status, body: copy(body) } } })
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status,
        json: async () => copy(reply.body) }
    }
    const code = params.codigo_pdm || params.codigo_item || params.catmat || params.catser
    const result = options.price ? await options.price(url, init.signal as AbortSignal)
      : params.codigo_pdm
        ? (() => {
            const pagina = Number(params.pagina)
            const tamanhoPagina = Number(params.tam_pagina)
            const urlOficial = new URL('https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial')
            urlOficial.search = new URLSearchParams({
              tipo: 'codigoPdm', codigo: params.codigo_pdm, pagina: params.pagina,
              tamanhoPagina: params.tam_pagina,
            }).toString()
            return {
              sucesso: true,
              dados: { resultado: [{ ...row('991222', pagina), codigoPdm: params.codigo_pdm }],
                totalRegistros: 1, totalPaginas: 1 },
              paginaAtual: pagina, tamPagina: tamanhoPagina,
              consultaPreco: {
                tipo: 'material', seletor: 'codigoPdm', codigo: params.codigo_pdm,
                pagina, tamanhoPagina, urlOficial: urlOficial.toString(),
              },
            }
          })()
        : priceBody([row(code, Number(params.pagina), params.catser ? 'SERVICO' : 'MATERIAL')])
    const priced = result?.dados?.resultado
    if (Array.isArray(priced)) {
      for (let i = 0; i < priced.length; i++) {
        priced[i]._cotai_ingestion_claim = createHash('sha256').update(`claim-${i}`).digest('hex')
        priced[i]._cotai_index_row = {}
      }
      result.ingestion_receipt = {
        token: 'R'.repeat(64),
        query_hash: 'a'.repeat(64),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        source: 'Compras.gov.br',
        claim_count: priced.length,
      }
    }
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

  it('preserves a strict row-returned item link on the data host as verified evidence', () => {
    const recordLink = 'https://dadosabertos.compras.gov.br/compra/123'
    const result = new ComprasGovConnectorAdapter().normalize(
      { ...row(), linkEditalOuCompra: recordLink },
      0,
      {
        tipo: 'material',
        codigo: '991222',
        consultaOficial: true,
        pagina: 1,
        tamanhoPagina: 500,
      },
    )!

    expect(result.urlOriginal).toBe(recordLink)
    expect(result.detalhesAdicionais!.proveniencia_preco).toMatchObject({
      status: 'verificada',
      url_evidencia: recordLink,
      registro_oficial: { linkEditalOuCompra: recordLink },
    })
  })

  it('generic term discovers both namespaces through the actual CNBS hook and queue', async () => {
    const t = transport()
    const batches: string[] = []
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'DIPIRONA' }, (items) => {
      batches.push(...items.map((item) => item.codigoCatalogo!))
    })
    expect(t.catalogCalls.some((u) => u.pathname.endsWith('/material/v1/palavra'))).toBe(true)
    expect(t.catalogCalls.some((u) => u.pathname.endsWith('/servico/v1/palavra'))).toBe(true)
    expect(t.catalogCalls.some((u) => u.pathname.endsWith('/materialCaracteristcaValorporPDM'))).toBe(false)
    const prices = t.requests.filter((u) => u.pathname.endsWith('comprasgov-search'))
    expect(prices).toHaveLength(2)
    expect(prices.some((u) => u.searchParams.get('codigo_pdm') === '991111')).toBe(true)
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

  it('keeps a returned official purchase link separate from the exact grouped PDM query', async () => {
    const codigoPdm = '991111'
    const linkCompra = 'https://www.gov.br/compras/pt-br/acesso-a-informacao/consulta-detalhada'
    transport({ price: (url) => {
      const pagina = Number(url.searchParams.get('pagina'))
      const tamanhoPagina = Number(url.searchParams.get('tam_pagina'))
      const urlConsultaOficial = new URL(
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial',
      )
      urlConsultaOficial.search = new URLSearchParams({
        tipo: 'codigoPdm', codigo: codigoPdm, pagina: String(pagina),
        tamanhoPagina: String(tamanhoPagina),
      }).toString()
      return {
        sucesso: true,
        dados: {
          resultado: [{ ...row(), codigoPdm, linkEditalOuCompra: linkCompra }],
          totalRegistros: 1,
          totalPaginas: 1,
        },
        paginaAtual: pagina,
        tamPagina: tamanhoPagina,
        consultaPreco: {
          tipo: 'material', seletor: 'codigoPdm', codigo: codigoPdm,
          pagina, tamanhoPagina, urlOficial: urlConsultaOficial.toString(),
        },
      }
    } })

    const result = await new ComprasGovConnectorAdapter().search({
      termo: 'SYNTHETIC',
      continuacoesCompras: [{
        etapa: 'precos', tipo: 'material', seletor: 'codigoPdm',
        codigo: codigoPdm, pagina: 1,
      }],
    })

    expect(result.amostras).toHaveLength(1)
    const sample = result.amostras[0]
    const proof = sample.detalhesAdicionais!.proveniencia_preco
    expect(sample.urlOriginal).toBe(linkCompra)
    expect(proof.url_evidencia).toBe(linkCompra)
    expect(proof.registro_oficial.linkEditalOuCompra).toBe(linkCompra)
    expect(proof.contexto_consulta).toMatchObject({
      seletor: 'codigoPdm',
      codigoPdm,
      urlConsultaOficial:
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
        'tipo=codigoPdm&codigo=991111&pagina=1&tamanhoPagina=500',
    })
    expect(proof.contexto_consulta.urlConsultaOficial).not.toContain('codigoItemCatalogo')
  })

  it.each([
    ['credentials', 'https://user:pass@compras.gov.br/compra/offline-review'],
    ['explicit non-default port', 'https://compras.gov.br:444/compra/offline-review'],
    ['explicit default port', 'https://compras.gov.br:443/compra/offline-review'],
    ['fragment', 'https://compras.gov.br/compra/offline-review#spoof'],
    ['non-government host', 'https://compras.invalid/compra/offline-review'],
    ['catalogue host', 'https://catalogo.compras.gov.br/compra/offline-review'],
    ['empty government label', 'https://.gov.br/compra/offline-review'],
    ['empty middle host label', 'https://compras..gov.br/compra/offline-review'],
    ['leading host hyphen', 'https://-compras.gov.br/compra/offline-review'],
    ['trailing host hyphen', 'https://compras-.gov.br/compra/offline-review'],
    ['an empty fragment delimiter', 'https://compras.gov.br/compra/offline-review#'],
    ['raw whitespace', 'https://compras.gov.br/compra/offline review'],
    ['a raw backslash', 'https://compras.gov.br\\compra\\offline-review'],
    ['a query immediately after the host', 'https://compras.gov.br?compra=offline-review'],
  ])('falls back to the exact grouped PDM query when a returned link has %s', (_case, unsafeLink) => {
    const exactQuery =
      'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial' +
      '?tipo=codigoPdm&codigo=991111&pagina=1&tamanhoPagina=500'
    const sample = new ComprasGovConnectorAdapter().normalize(
      { ...row(), codigoPdm: '991111', linkEditalOuCompra: unsafeLink },
      0,
      {
        tipo: 'material', codigo: '991222', consultaOficial: true,
        pagina: 1, tamanhoPagina: 500, seletor: 'codigoPdm', codigoPdm: '991111',
        urlConsultaOficial: exactQuery,
      },
    )!

    expect(sample.urlOriginal).toBe(exactQuery)
    expect(sample.detalhesAdicionais!.evidencia_tipo).toBe('consulta_precos_por_codigo')
    expect(sample.detalhesAdicionais!.proveniencia_preco).toMatchObject({
      status: 'verificada',
      url_evidencia: exactQuery,
      contexto_consulta: { urlConsultaOficial: exactQuery },
    })
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

  it('does not deliver or advance a price page when index persistence rejects', async () => {
    transport()
    vi.mocked(PriceIndexService.persistirAmostras).mockRejectedValueOnce(Object.assign(
      new Error('Persistência do índice interrompida.'),
      {
        code: 'INDEX_BATCH_FAILED', status: 503, timed_out: false,
        parcial: { inseridas: 0, atualizadas: 0, ignoradas: 0 },
      },
    ))
    const progress = vi.fn()

    const result: any = await new ComprasGovConnectorAdapter().search(
      { termo: 'CATMAT 991222' }, progress,
    )

    expect(progress).not.toHaveBeenCalled()
    expect(result.amostras).toEqual([])
    expect(result.totalAmostrasRecuperadas).toBe(0)
    expect(result.observabilidade.quantidadeRecebidaBruta).toBe(1)
    expect(result.observabilidade.quantidadeProcessadaValida).toBe(0)
    expect(result.observabilidade.quantidadeEntregue).toBe(0)
    expect(result.status).toBe('FALHA_TOTAL')
    expect(result.sucesso).toBe(false)
    expect(result.erro).toContain('Persistência do índice interrompida.')
    expect(result.continuacoesCompras).toEqual([
      { etapa: 'precos', tipo: 'material', codigo: '991222', pagina: 1 },
    ])
    expect(result.paginacaoCompras).toEqual([])
  })

  it('keeps the whole page retryable when index acceptance is partial or ignored', async () => {
    transport({ price: () => priceBody([
      row('991222', 1),
      { ...row('991222', 1), idItemCompra: 'SYNTHETIC-SECOND' },
    ], 2, 1) })
    vi.mocked(PriceIndexService.persistirAmostras).mockResolvedValueOnce({
      inseridas: 1, atualizadas: 0, ignoradas: 1,
    })
    const progress = vi.fn()

    const result: any = await new ComprasGovConnectorAdapter().search(
      { termo: 'CATMAT 991222' }, progress,
    )

    expect(progress).not.toHaveBeenCalled()
    expect(result.amostras).toEqual([])
    expect(result.observabilidade.quantidadeProcessadaValida).toBe(0)
    expect(result.observabilidade.quantidadeEntregue).toBe(0)
    expect(result.status).toBe('FALHA_TOTAL')
    expect(result.erro).toContain('aceitação parcial')
    expect(result.continuacoesCompras).toEqual([
      { etapa: 'precos', tipo: 'material', codigo: '991222', pagina: 1 },
    ])
    expect(result.paginacaoCompras).toEqual([])
  })

  it('reports an index persistence timeout and preserves the exact page for retry', async () => {
    transport()
    vi.mocked(PriceIndexService.persistirAmostras).mockRejectedValueOnce(Object.assign(
      new Error('Persistência do índice interrompida.'),
      {
        code: 'INDEX_BATCH_FAILED', status: 0, timed_out: true,
        parcial: { inseridas: 0, atualizadas: 0, ignoradas: 0 },
      },
    ))

    const result: any = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })

    expect(result.amostras).toEqual([])
    expect(result.status).toBe('FALHA_TOTAL')
    expect(result.observabilidade.statusHttpFinal).toBe(408)
    expect(result.observabilidade.timeoutsCount).toBe(1)
    expect(result.continuacoesCompras).toEqual([
      { etapa: 'precos', tipo: 'material', codigo: '991222', pagina: 1 },
    ])
  })

  it('does not publish an accepted batch after the user aborts while persistence is pending', async () => {
    transport()
    let release!: (value: { inseridas: number; atualizadas: number; ignoradas: number }) => void
    vi.mocked(PriceIndexService.persistirAmostras).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve }),
    )
    const controller = new AbortController()
    const progress = vi.fn()
    const search = new ComprasGovConnectorAdapter().search(
      { termo: 'CATMAT 991222', signal: controller.signal }, progress,
    )
    await vi.waitFor(() => expect(PriceIndexService.persistirAmostras).toHaveBeenCalledTimes(1))

    controller.abort()
    await expect(search).rejects.toMatchObject({ name: 'AbortError' })
    release({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    await Promise.resolve()
    await Promise.resolve()
    expect(progress).not.toHaveBeenCalled()
  })

  it('awaits full contractual acceptance before publishing and counting a batch', async () => {
    transport()
    let release!: (value: { inseridas: number; atualizadas: number; ignoradas: number }) => void
    vi.mocked(PriceIndexService.persistirAmostras).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve }),
    )
    const progress = vi.fn()
    let settled = false
    const search = new ComprasGovConnectorAdapter().search(
      { termo: 'CATMAT 991222' }, progress,
    ).finally(() => { settled = true })
    await vi.waitFor(() => expect(PriceIndexService.persistirAmostras).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    expect(progress).not.toHaveBeenCalled()

    release({ inseridas: 0, atualizadas: 1, ignoradas: 0 })
    const result: any = await search

    expect(progress).toHaveBeenCalledTimes(1)
    expect(result.amostras).toHaveLength(1)
    expect(result.totalAmostrasRecuperadas).toBe(1)
    expect(result.observabilidade.quantidadeProcessadaValida).toBe(1)
    expect(result.observabilidade.quantidadeEntregue).toBe(1)
    expect(result.status).toBe('CONCLUIDA')
    expect(result.continuacoesCompras).toEqual([])
  })

  it('keeps concurrent resumed pages isolated while awaiting their persistence contracts', async () => {
    transport({ price: (url) => {
      const page = Number(url.searchParams.get('pagina'))
      return priceBody([row('991222', page)], 2, 2)
    } })
    const releases: Array<(
      value: { inseridas: number; atualizadas: number; ignoradas: number },
    ) => void> = []
    vi.mocked(PriceIndexService.persistirAmostras)
      .mockImplementationOnce(() => new Promise((resolve) => { releases.push(resolve) }))
      .mockImplementationOnce(() => new Promise((resolve) => { releases.push(resolve) }))
    const progress = vi.fn()
    const search = new ComprasGovConnectorAdapter().search({
      termo: 'SYNTHETIC',
      continuacoesCompras: [
        { etapa: 'precos', tipo: 'material', codigo: '991222', pagina: 1 },
        { etapa: 'precos', tipo: 'material', codigo: '991222', pagina: 2 },
      ],
    }, progress)
    await vi.waitFor(() => expect(releases).toHaveLength(2))

    releases[0]({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    releases[1]({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    const result: any = await search

    expect(result.amostras).toHaveLength(2)
    expect(progress).toHaveBeenCalledTimes(2)
    expect(result.paginacaoCompras).toEqual([
      { tipo: 'material', codigo: '991222', pagina: 2, tamanho: 500, total: 2, paginas: 2 },
    ])
  })

  it('publishes each concurrent PDM page with its own metadata when page 8 settles before page 2', async () => {
    const codigoPdm = '991111'
    transport({ price: (url) => {
      const pagina = Number(url.searchParams.get('pagina'))
      const tamanhoPagina = Number(url.searchParams.get('tam_pagina'))
      const totalRegistros = pagina === 8 ? 800 : 200
      const totalPaginas = pagina
      const urlOficial = new URL(
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial',
      )
      urlOficial.search = new URLSearchParams({
        tipo: 'codigoPdm', codigo: codigoPdm, pagina: String(pagina),
        tamanhoPagina: String(tamanhoPagina),
      }).toString()
      return {
        sucesso: true,
        dados: {
          resultado: [{ ...row('991222', pagina), codigoPdm }],
          totalRegistros,
          totalPaginas,
        },
        paginaAtual: pagina,
        tamPagina: tamanhoPagina,
        consultaPreco: {
          tipo: 'material', seletor: 'codigoPdm', codigo: codigoPdm,
          pagina, tamanhoPagina, urlOficial: urlOficial.toString(),
        },
      }
    } })
    const releases = new Map<number, (
      value: { inseridas: number; atualizadas: number; ignoradas: number },
    ) => void>()
    const holdPersistence = (items: any[]) => {
      const pagina = Number(new URL(items[0].urlOriginal).searchParams.get('pagina'))
      return new Promise((resolve) => { releases.set(pagina, resolve) })
    }
    vi.mocked(PriceIndexService.persistirAmostras)
      .mockImplementationOnce(holdPersistence)
      .mockImplementationOnce(holdPersistence)
    const progress = vi.fn()
    const search = new ComprasGovConnectorAdapter().search({
      termo: 'SYNTHETIC',
      continuacoesCompras: [
        { etapa: 'precos', tipo: 'material', seletor: 'codigoPdm', codigo: codigoPdm, pagina: 2 },
        { etapa: 'precos', tipo: 'material', seletor: 'codigoPdm', codigo: codigoPdm, pagina: 8 },
      ],
    }, progress)
    await vi.waitFor(() => expect([...releases.keys()].sort()).toEqual([2, 8]))

    releases.get(8)!({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1))
    releases.get(2)!({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    const result: any = await search

    expect(progress).toHaveBeenCalledTimes(2)
    const published = progress.mock.calls.map(([items, info]) => ({
      samplePage: Number(new URL(items[0].urlOriginal).searchParams.get('pagina')),
      paginaAtual: info.paginaAtual,
      tamanhoPagina: info.tamanhoPagina,
      totalRegistros: info.totalRegistrosInformadoApi,
      totalPaginas: info.totalPaginasInformadoApi,
      temMaisPaginas: info.temMaisPaginas,
      seletor: info.seletorCompras,
      codigoPdm: info.codigoPdmCompras,
      ledger: info.paginacaoCompras,
    }))
    expect(published).toEqual([
      {
        samplePage: 8,
        paginaAtual: 8,
        tamanhoPagina: 500,
        totalRegistros: 800,
        totalPaginas: 8,
        temMaisPaginas: false,
        seletor: 'codigoPdm',
        codigoPdm,
        ledger: [{
          tipo: 'material', seletor: 'codigoPdm', codigo: codigoPdm,
          pagina: 8, tamanho: 500, total: 800, paginas: 8,
        }],
      },
      {
        samplePage: 2,
        paginaAtual: 2,
        tamanhoPagina: 500,
        totalRegistros: 200,
        totalPaginas: 2,
        temMaisPaginas: false,
        seletor: 'codigoPdm',
        codigoPdm,
        ledger: [{
          tipo: 'material', seletor: 'codigoPdm', codigo: codigoPdm,
          pagina: 8, tamanho: 500, total: 800, paginas: 8,
        }],
      },
    ])
    expect(result.amostras).toHaveLength(2)
    expect(result.continuacoesCompras).toEqual([])
    expect(result.observabilidade.trabalhosConcluidosCompras).toBe(2)
    expect(result.paginacaoCompras).toEqual([{
      tipo: 'material', seletor: 'codigoPdm', codigo: codigoPdm,
      pagina: 8, tamanho: 500, total: 800, paginas: 8,
    }])
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

  it('chunks receipts without dropping the 501st legitimate official sample', async () => {
    const records = Array.from({ length: 501 }, (_, index) => ({
      ...row('991222', index + 1),
      idCompra: `SYNTHETIC-COMPRA-${index + 1}`,
      idItemCompra: `SYNTHETIC-ITEM-${index + 1}`,
    }))
    transport({
      priceUpstream: () => ({
        statusCode: 200,
        json: { resultado: records, totalRegistros: 501, totalPaginas: 1 },
      }),
    })

    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })

    expect(result.amostras).toHaveLength(501)
    expect(PriceIndexService.persistirAmostras).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ idExterno: expect.stringContaining('SYNTHETIC-COMPRA-501') }),
      ]),
    )
  })

  it('publishes a valid claimed row while skipping a positive unclaimed row without retrying', async () => {
    const unclaimed = {
      ...row('991222', 2),
      idCompra: 'SYNTHETIC-UNCLAIMED',
      idItemCompra: 'SYNTHETIC-UNCLAIMED-ITEM',
      dataResultado: undefined,
      cnpjFornecedor: undefined,
      nomeFornecedor: undefined,
    }
    transport({
      priceUpstream: () => ({
        statusCode: 200,
        json: { resultado: [row('991222', 1), unclaimed], totalRegistros: 2, totalPaginas: 1 },
      }),
    })

    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })

    expect(result.status).toBe('CONCLUIDA')
    expect(result.amostras).toHaveLength(1)
    expect(PriceIndexService.persistirAmostras).toHaveBeenCalledTimes(1)
    expect(vi.mocked(PriceIndexService.persistirAmostras).mock.calls[0][0]).toHaveLength(1)
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

  it('does not publish an opening date as an official price reference date', async () => {
    transport({ priceUpstream: () => ({ statusCode: 200, json: {
      resultado: [{ ...row(), dataResultado: undefined, dataAbertura: '2025-03-04' }],
      totalRegistros: 1, totalPaginas: 1,
    } }) })
    const result = await new ComprasGovConnectorAdapter().search({ termo: 'CATMAT 991222' })
    expect(result.status).toBe('CONCLUIDA')
    expect(result.amostras).toEqual([])
    expect(PriceIndexService.persistirAmostras).not.toHaveBeenCalled()
  })
})
