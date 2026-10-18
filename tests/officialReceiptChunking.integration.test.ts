import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComprasGovConnectorAdapter } from '../src/lib/connectors/comprasGovConnectorAdapter'
import { PncpConnectorAdapter } from '../src/lib/connectors/pncpConnectorAdapter'
import { PriceIndexService } from '../src/lib/priceIndexService'

vi.mock('../src/lib/pocketbase/client', () => ({
  default: {
    baseUrl: 'https://offline-receipt-chunking.invalid',
    authStore: { token: 'AUTHENTICATED-OFFLINE-TOKEN' },
  },
}))

vi.mock('../src/lib/priceIndexService', () => ({
  PriceIndexService: {
    persistirAmostras: vi.fn(async (items: unknown[]) => ({
      inseridas: items.length,
      atualizadas: 0,
      ignoradas: 0,
    })),
  },
}))

const receipt = (source: 'PNCP' | 'Compras.gov.br', chunk: number, claimCount: number) => ({
  token: `R${String(chunk).padStart(2, '0')}${'a'.repeat(61)}`,
  query_hash: 'b'.repeat(64),
  expires_at: '2099-01-01T00:00:00.000Z',
  source,
  claim_count: claimCount,
})

const claim = (index: number) => index.toString(16).padStart(64, '0')

function pncpItems() {
  return Array.from({ length: 501 }, (_, zeroBased) => {
    const numeroItem = zeroBased + 1
    const valor = 1 + numeroItem / 1_000
    const item: any = {
      numeroItem,
      descricao: `ITEM PNCP OFICIAL ${numeroItem}`,
      unidadeMedida: 'UN',
      quantidade: 1,
      valorUnitarioHomologado: valor,
      fornecedor: {
        niFornecedor: '00000000000002',
        nomeRazaoSocialFornecedor: 'FORNECEDOR OFICIAL',
      },
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'PNCP',
        campo_unitario: 'valorUnitarioHomologado',
        valor_unitario: valor,
        natureza: 'homologado',
        url_evidencia:
          `https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/${numeroItem}/resultados`,
        identidade: {
          cnpj: '00000000000001',
          ano: 2026,
          sequencial: 9,
          numeroItem,
        },
        registro_oficial: {
          numeroItem,
          niFornecedor: '00000000000002',
          sequencialResultado: numeroItem,
          valorUnitarioHomologado: valor,
          dataResultado: '2026-01-01',
        },
        campo_data: 'dataResultado',
        data_oficial: '2026-01-01',
      },
    }
    item._cotai_ingestion_claim = claim(numeroItem)
    item._cotai_ingestion_receipt_index = Math.floor(zeroBased / 500)
    item._cotai_index_row = { sample_key: `PNCP-${numeroItem}` }
    return item
  })
}

function comprasItems() {
  return Array.from({ length: 501 }, (_, zeroBased) => {
    const numeroItem = zeroBased + 1
    const item: any = {
      idCompra: `158369069${String(numeroItem).padStart(6, '0')}2025`,
      idItemCompra: String(7_670_000 + numeroItem),
      numeroItemCompra: numeroItem,
      codigoItemCatalogo: '991222',
      codigoCatmat: '991222',
      tipoItem: 'MATERIAL',
      descricaoItem: `ITEM COMPRAS OFICIAL ${numeroItem}`,
      precoUnitario: 2 + numeroItem / 1_000,
      dataResultado: '2025-03-13',
      cnpjFornecedor: '51340170000156',
      nomeFornecedor: 'FORNECEDOR OFICIAL',
      siglaUnidadeFornecimento: 'UN',
    }
    item._cotai_ingestion_claim = claim(numeroItem)
    item._cotai_ingestion_receipt_index = Math.floor(zeroBased / 500)
    item._cotai_index_row = { sample_key: `COMPRAS-${numeroItem}` }
    return item
  })
}

beforeEach(() => {
  vi.mocked(PriceIndexService.persistirAmostras).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('official receipt completeness above the 500-claim boundary', () => {
  it('persists and acknowledges all 501 PNCP rows using two receipt chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          sucesso: true,
          ingestion_receipt: receipt('PNCP', 0, 500),
          ingestion_receipts: [receipt('PNCP', 0, 500), receipt('PNCP', 1, 1)],
          items: [
            {
              numeroControlePNCP: '00000000000001-1-000009/2026',
              orgaoEntidade: { cnpj: '00000000000001', razaoSocial: 'ÓRGÃO OFICIAL' },
              itensAta: pncpItems(),
            },
          ],
          totalRegistros: 2,
          totalPaginas: 2,
          paginaAtual: 1,
          tamPagina: 50,
          detalhamento_paralelo: { itens_fila_pendente: 0, cobertura_parcial: false },
        }),
      })),
    )

    const adapter = new PncpConnectorAdapter()
    ;(adapter as any).maxRetries = 0
    const page = await adapter.fetchPage({ termo: 'ITEM', tamanhoPagina: 50 }, 1)

    expect(page.sucesso).toBe(true)
    expect(page.amostras).toHaveLength(501)
    expect(page.amostras[500].ingestionReceipt?.token).toBe(receipt('PNCP', 1, 1).token)
    expect(PriceIndexService.persistirAmostras).toHaveBeenCalledTimes(1)
    expect(PriceIndexService.persistirAmostras).toHaveBeenCalledWith(page.amostras)
  })

  it('persists and acknowledges all 501 Compras rows using two receipt chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          sucesso: true,
          ingestion_receipt: receipt('Compras.gov.br', 0, 500),
          ingestion_receipts: [
            receipt('Compras.gov.br', 0, 500),
            receipt('Compras.gov.br', 1, 1),
          ],
          paginaAtual: 1,
          tamPagina: 500,
          dados: {
            resultado: comprasItems(),
            totalRegistros: 501,
            totalPaginas: 1,
          },
        }),
      })),
    )

    const result: any = await new ComprasGovConnectorAdapter().search({
      termo: 'ITEM',
      continuacoesCompras: [
        { etapa: 'precos', tipo: 'material', codigo: '991222', pagina: 1 },
      ],
    })

    expect(result.status).toBe('CONCLUIDA')
    expect(result.amostras).toHaveLength(501)
    expect(result.amostras[500].ingestionReceipt?.token).toBe(
      receipt('Compras.gov.br', 1, 1).token,
    )
    expect(PriceIndexService.persistirAmostras).toHaveBeenCalledTimes(1)
    expect(PriceIndexService.persistirAmostras).toHaveBeenCalledWith(result.amostras)
  })
})
