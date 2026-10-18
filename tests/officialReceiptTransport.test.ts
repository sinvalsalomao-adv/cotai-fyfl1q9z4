import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComprasGovConnectorAdapter } from '../src/lib/connectors/comprasGovConnectorAdapter'
import { PncpConnectorAdapter } from '../src/lib/connectors/pncpConnectorAdapter'
import { PriceIndexService } from '../src/lib/priceIndexService'

vi.mock('../src/lib/pocketbase/client', () => ({
  default: {
    baseUrl: 'https://offline-receipt.invalid',
    authStore: { token: 'AUTHENTICATED-OFFLINE-TOKEN' },
  },
}))

const receipt = {
  token: `R${'a'.repeat(63)}`,
  query_hash: 'b'.repeat(64),
  expires_at: '2099-01-01T00:00:00.000Z',
  source: 'Compras.gov.br' as const,
  claim_count: 1,
}
const claimKey = 'c'.repeat(64)
const comprasIndexRow = {
  sample_key: 'COMPRASGOV#OFFICIAL#1##4_4000',
  source: 'Compras.gov.br',
  source_record_id: 'OFFICIAL',
  purchase_id: 'OFFICIAL',
  item_id: '1',
  descricao: 'PICOLÉ, NOME: PICOLÉ',
  descricao_normalizada: 'PICOLE NOME PICOLE',
  valor_unitario: 4.4,
  url_original:
    'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=151063&pagina=1&tamanhoPagina=500',
  raw_payload: { proveniencia_preco: { registro_oficial: { idCompra: '15836906900012025' } } },
}

afterEach(() => vi.unstubAllGlobals())

describe('official receipt transport stays transient', () => {
  it('carries a Compras page receipt to ingestion without contaminating official raw evidence', () => {
    const raw: any = {
      _cotai_ingestion_claim: claimKey,
      _cotai_index_row: comprasIndexRow,
      idCompra: '15836906900012025',
      idItemCompra: '7670225',
      numeroItemCompra: 1,
      codigoItemCatalogo: '151063',
      descricaoItem: 'PICOLÉ, NOME: PICOLÉ',
      precoUnitario: 4.4,
      dataResultado: '2025-03-13',
      cnpjFornecedor: '51340170000156',
    }
    const sample = new ComprasGovConnectorAdapter().normalize(raw, 0, {
      tipo: 'material',
      codigo: '151063',
      consultaOficial: true,
      pagina: 1,
      tamanhoPagina: 500,
      ingestionReceipt: receipt,
    })!

    expect(sample.ingestionReceipt).toEqual({
      token: receipt.token,
      queryHash: receipt.query_hash,
      claimKey,
      source: 'Compras.gov.br',
      expiresAt: receipt.expires_at,
      indexRow: comprasIndexRow,
    })
    expect(sample.detalhesAdicionais?.proveniencia_preco.registro_oficial).not.toHaveProperty(
      '_cotai_ingestion_claim',
    )
  })

  it('carries a PNCP page receipt to ingestion while preserving the exact official result', () => {
    const pncpReceipt = { ...receipt, source: 'PNCP' as const }
    const raw: any = {
      _cotai_ingestion_claim: claimKey,
      _cotai_index_row: { ...comprasIndexRow, source: 'PNCP' },
      orgao_cnpj: '00000000000001',
      anoCompra: 2026,
      sequencialCompra: 9,
      numeroItem: 2,
      valorUnitarioHomologado: 2.5,
      descricao: 'SERVIÇO DE MANUTENÇÃO PREDIAL',
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
          numeroItem: 2,
          niFornecedor: '00000000000002',
          sequencialResultado: 3,
          valorUnitarioHomologado: 2.5,
          dataResultado: '2026-01-01',
        },
        campo_data: 'dataResultado',
        data_oficial: '2026-01-01',
      },
    }
    const sample = new PncpConnectorAdapter().normalize(raw, 0, {
      ingestionReceipt: pncpReceipt,
    })!

    expect(sample.ingestionReceipt).toMatchObject({
      token: pncpReceipt.token,
      queryHash: pncpReceipt.query_hash,
      claimKey,
      source: 'PNCP',
    })
    expect(sample.detalhesAdicionais?.proveniencia_preco.registro_oficial).toEqual(
      raw.proveniencia_preco.registro_oficial,
    )
  })

  it('sends receipt scope only in the ingestion envelope and never stores its token in raw_payload', async () => {
    const raw: any = {
      _cotai_ingestion_claim: claimKey,
      _cotai_index_row: comprasIndexRow,
      idCompra: '15836906900012025',
      idItemCompra: '7670225',
      numeroItemCompra: 1,
      codigoItemCatalogo: '151063',
      descricaoItem: 'PICOLÉ, NOME: PICOLÉ',
      precoUnitario: 4.4,
      dataResultado: '2025-03-13',
      cnpjFornecedor: '51340170000156',
    }
    const sample = new ComprasGovConnectorAdapter().normalize(raw, 0, {
      tipo: 'material',
      codigo: '151063',
      consultaOficial: true,
      pagina: 1,
      tamanhoPagina: 500,
      ingestionReceipt: receipt,
    })!
    let sent: any
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sucesso: true,
            recebidas: 1,
            inseridas: 1,
            atualizadas: 0,
            ignoradas: 0,
          }),
        }
      }),
    )

    await expect(PriceIndexService.persistirAmostras([sample])).resolves.toMatchObject({
      inseridas: 1,
      ignoradas: 0,
    })
    expect(sent.amostras[0]._ingestion_receipt).toEqual({
      token: receipt.token,
      query_hash: receipt.query_hash,
      claim_key: claimKey,
    })
    expect(JSON.stringify(sent.amostras[0].raw_payload)).not.toContain(receipt.token)
  })
})
