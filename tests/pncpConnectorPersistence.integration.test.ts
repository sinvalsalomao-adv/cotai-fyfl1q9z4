import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PncpConnectorAdapter } from '../src/lib/connectors/pncpConnectorAdapter'
import { PriceIndexService } from '../src/lib/priceIndexService'

vi.mock('../src/lib/pocketbase/client', () => ({
  default: {
    baseUrl: 'https://offline-contract.invalid',
    authStore: { token: 'SYNTHETIC-TOKEN' },
  },
}))
vi.mock('../src/lib/priceIndexService', () => ({
  PriceIndexService: {
    persistirAmostras: vi.fn(),
  },
}))

const receipt = {
  token: `R${'a'.repeat(63)}`,
  query_hash: 'b'.repeat(64),
  expires_at: '2099-01-01T00:00:00.000Z',
  source: 'PNCP',
  claim_count: 1,
}

const officialItem = {
  _cotai_ingestion_claim: 'c'.repeat(64),
  _cotai_ingestion_receipt_index: 0,
  _cotai_index_row: {
    sample_key:
      'PNCP#0000000000000120269itens2resultados3fornecedor00000000000002#2#00000000000001#2_5000',
    source: 'PNCP',
    source_record_id:
      '00000000000001/2026/9/itens/2/resultados/3/fornecedor/00000000000002',
    purchase_id:
      '00000000000001/2026/9/itens/2/resultados/3/fornecedor/00000000000002',
    item_id: '2',
    descricao: 'SYNTHETIC PNCP ITEM',
    descricao_normalizada: 'SYNTHETIC PNCP ITEM',
    orgao_cnpj: '00000000000001',
    fornecedor_cnpj: '00000000000002',
    valor_unitario: 2.5,
    url_original: 'https://pncp.gov.br/app/editais/00000000000001/2026/9',
    raw_payload: {},
  },
  orgao_cnpj: '00000000000001',
  anoCompra: 2026,
  sequencialCompra: 9,
  numeroItem: 2,
  valorUnitarioHomologado: 2.5,
  descricao: 'SYNTHETIC PNCP ITEM',
  fornecedor: { niFornecedor: '00000000000002' },
  proveniencia_preco: {
    versao: 1,
    status: 'verificada',
    fonte: 'PNCP',
    campo_unitario: 'valorUnitarioHomologado',
    valor_unitario: 2.5,
    natureza: 'homologado',
    url_evidencia:
      'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/2/resultados',
    identidade: { cnpj: '00000000000001', ano: 2026, sequencial: 9, numeroItem: 2 },
    registro_oficial: {
      niFornecedor: '00000000000002',
      sequencialResultado: 3,
      valorUnitarioHomologado: 2.5,
      dataResultado: '2026-01-01',
    },
    campo_data: 'dataResultado',
    data_oficial: '2026-01-01',
  },
}

function stubOfficialPage() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ingestion_receipt: receipt,
        ingestion_receipts: [receipt],
        items: [officialItem],
        totalRegistros: 2,
        totalPaginas: 2,
        detalhamento_paralelo: { itens_fila_pendente: 0, cobertura_parcial: false },
      }),
    })),
  )
}

beforeEach(() => {
  vi.mocked(PriceIndexService.persistirAmostras).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PNCP page persistence acknowledgement', () => {
  it('does not publish a successful page or its continuation before the index acknowledges every sample', async () => {
    stubOfficialPage()
    let acknowledge!: (counts: {
      inseridas: number
      atualizadas: number
      ignoradas: number
    }) => void
    vi.mocked(PriceIndexService.persistirAmostras).mockImplementationOnce(
      () => new Promise((resolve) => (acknowledge = resolve)),
    )
    const adapter = new PncpConnectorAdapter()
    ;(adapter as any).maxRetries = 0
    let settled = false

    const pagePromise = adapter
      .fetchPage({ termo: 'synthetic', tamanhoPagina: 50 }, 1)
      .finally(() => (settled = true))
    await vi.waitFor(() =>
      expect(PriceIndexService.persistirAmostras).toHaveBeenCalledTimes(1),
    )

    expect(settled).toBe(false)

    acknowledge({ inseridas: 1, atualizadas: 0, ignoradas: 0 })
    const page = await pagePromise

    expect(page).toMatchObject({
      sucesso: true,
      statusHttp: 200,
      pagination: { paginaAtual: 1, totalPaginasInformadoApi: 2, temMaisPaginas: true },
    })
    expect(page.amostras).toHaveLength(1)
  })

  it('keeps the PNCP page unpublished and retryable when index persistence fails', async () => {
    stubOfficialPage()
    vi.mocked(PriceIndexService.persistirAmostras).mockRejectedValueOnce(
      Object.assign(new Error('Persistência do índice interrompida.'), {
        code: 'INDEX_BATCH_FAILED',
        status: 503,
        timed_out: false,
        parcial: { inseridas: 0, atualizadas: 0, ignoradas: 0 },
      }),
    )
    const adapter = new PncpConnectorAdapter()
    ;(adapter as any).maxRetries = 0

    const page = await adapter.fetchPage({ termo: 'synthetic', tamanhoPagina: 50 }, 1)

    expect(page).toMatchObject({
      sucesso: false,
      statusHttp: 503,
      pagination: { paginaAtual: 1, temMaisPaginas: false },
    })
    expect(page.amostras).toEqual([])
    expect(page.erro).toContain('Persistência do índice interrompida.')
  })

  it('rejects partial acknowledgement instead of advancing the PNCP page', async () => {
    stubOfficialPage()
    vi.mocked(PriceIndexService.persistirAmostras).mockResolvedValueOnce({
      inseridas: 0,
      atualizadas: 0,
      ignoradas: 1,
    })
    const adapter = new PncpConnectorAdapter()
    ;(adapter as any).maxRetries = 0

    const page = await adapter.fetchPage({ termo: 'synthetic', tamanhoPagina: 50 }, 1)

    expect(page.sucesso).toBe(false)
    expect(page.statusHttp).toBe(502)
    expect(page.amostras).toEqual([])
    expect(page.erro).toContain('aceitação parcial')
  })
})
