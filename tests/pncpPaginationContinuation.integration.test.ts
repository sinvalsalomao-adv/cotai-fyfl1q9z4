import { describe, expect, it } from 'vitest'
import { PncpConnectorAdapter } from '../src/lib/connectors/pncpConnectorAdapter'
import type {
  AmostraPreco,
  ConnectorPageResult,
  ConnectorSearchParams,
  ConnectorSearchResult,
  PaginationInfo,
  PncpContinuation,
} from '../src/lib/connectors/types'

function sampleForPage(page: number): AmostraPreco {
  return {
    id: `PNCP-SYNTHETIC-${page}`,
    fonte: 'PNCP',
    fonteNomeExibicao: 'PNCP (Portal Nacional de Contratações Públicas)',
    idExterno: `00000000000001/2026/9/itens/${page}`,
    urlOriginal: 'https://pncp.gov.br/app/editais/00000000000001/2026/9',
    dataPublicacaoOuContrato: '2026-01-01',
    produto: `ITEM PNCP PÁGINA ${page}`,
    descricaoCompleta: `ITEM PNCP PÁGINA ${page}`,
    orgaoComprador: 'Órgão oficial de teste',
    fornecedorNome: 'Fornecedor oficial de teste',
    unidade: 'UNIDADE',
    quantidade: 1,
    valorUnitario: page,
    hashRastreabilidade: `pncp-page-${page}`,
    natureza: 'homologado',
    isDemo: false,
  }
}

class FortyFourPagePncpAdapter extends PncpConnectorAdapter {
  public readonly requestedPages: number[] = []
  private readonly waitAfterFirst?: Promise<void>

  constructor(waitAfterFirst?: Promise<void>) {
    super()
    this.waitAfterFirst = waitAfterFirst
  }

  public override async fetchPage(
    _params: ConnectorSearchParams,
    pagina: number,
  ): Promise<ConnectorPageResult> {
    this.requestedPages.push(pagina)
    if (pagina > 1 && this.waitAfterFirst) await this.waitAfterFirst

    return {
      sucesso: true,
      amostras: [sampleForPage(pagina)],
      pagination: {
        paginaAtual: pagina,
        tamanhoPagina: 1,
        totalRegistrosInformadoApi: 44,
        totalPaginasInformadoApi: 44,
        temMaisPaginas: pagina < 44,
        proximoCursor: pagina < 44 ? `pncp-page-${pagina + 1}` : undefined,
      },
      tempoMs: 1,
      statusHttp: 200,
    }
  }
}

function expectedPages(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

function continuationOf(result: ConnectorSearchResult): PncpContinuation | undefined {
  return result.continuacaoPncp
}

describe('PNCP pagination beyond the first 20 official pages', () => {
  it('streams page 1 quickly but returns page 20 of 44 as partial with the exact continuation', async () => {
    let releaseRemainingPages!: () => void
    const remainingPages = new Promise<void>((resolve) => {
      releaseRemainingPages = resolve
    })
    const adapter = new FortyFourPagePncpAdapter(remainingPages)
    const streamedPages: PaginationInfo[] = []
    let settled = false

    const search = adapter
      .search(
        {
          termo: 'produto inédito',
          pagina: 1,
          tamanhoPagina: 1,
          paginacaoTotal: true,
          limitePaginas: 20,
          forcarAtualizacaoCache: true,
        },
        (_samples, pagination) => streamedPages.push(pagination),
      )
      .finally(() => {
        settled = true
      })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(streamedPages.map((page) => page.paginaAtual)).toEqual([1])
    expect(settled).toBe(false)

    releaseRemainingPages()
    const result = await search

    expect(adapter.requestedPages).toEqual(expectedPages(1, 20))
    expect(result.status).toBe('CONCLUIDA_PARCIAL')
    expect(continuationOf(result)).toEqual({
      paginaAtual: 20,
      proximaPagina: 21,
      totalPaginas: 44,
      proximoCursor: 'pncp-page-21',
    })
  })

  it('resumes without resetting or dropping pages and certifies completion only after page 44', async () => {
    const adapter = new FortyFourPagePncpAdapter()
    const statuses: ConnectorSearchResult['status'][] = []
    let nextPage = 1

    for (let turn = 0; turn < 3; turn++) {
      const result = await adapter.search({
        termo: 'serviço inédito',
        pagina: nextPage,
        tamanhoPagina: 1,
        paginacaoTotal: true,
        limitePaginas: 20,
        forcarAtualizacaoCache: true,
      })
      statuses.push(result.status)

      if (turn < 2) {
        const continuation = continuationOf(result)
        expect(result.status).toBe('CONCLUIDA_PARCIAL')
        expect(continuation).toBeDefined()
        nextPage = continuation!.proximaPagina
      } else {
        expect(result.status).toBe('CONCLUIDA')
        expect(continuationOf(result)).toBeUndefined()
      }
    }

    expect(statuses).toEqual(['CONCLUIDA_PARCIAL', 'CONCLUIDA_PARCIAL', 'CONCLUIDA'])
    expect(adapter.requestedPages).toEqual(expectedPages(1, 44))
    expect(new Set(adapter.requestedPages).size).toBe(44)
  })

  it('does not cache the final resumed window as though it contained the whole official population', async () => {
    const adapter = new FortyFourPagePncpAdapter()
    const term = 'cache pncp resumed window 44'

    const finalWindow = await adapter.search({
      termo: term,
      pagina: 41,
      tamanhoPagina: 1,
      paginacaoTotal: true,
      limitePaginas: 20,
      forcarAtualizacaoCache: true,
    })
    expect(finalWindow.status).toBe('CONCLUIDA')
    expect(finalWindow.amostras.map((sample) => sample.valorUnitario)).toEqual([41, 42, 43, 44])

    const callsBeforeFreshSearch = adapter.requestedPages.length
    const freshFirstWindow = await adapter.search({
      termo: term,
      pagina: 1,
      tamanhoPagina: 1,
      paginacaoTotal: true,
      limitePaginas: 1,
    })

    expect(adapter.requestedPages.slice(callsBeforeFreshSearch)).toEqual([1])
    expect(freshFirstWindow.status).toBe('CONCLUIDA_PARCIAL')
    expect(freshFirstWindow.continuacaoPncp?.proximaPagina).toBe(2)
  })
})
