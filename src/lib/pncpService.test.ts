import { describe, it, expect } from 'vitest'
import { PncpService } from './pncpService'

describe('PncpService - Homologação do Conector Real PNCP', () => {
  it('deve construir deep links reais e válidos para o PNCP', () => {
    const urlEdital = PncpService.construirDeepLinkPncp('08.241.747/0001-43', 2024, 12, 'editais')
    expect(urlEdital).toBe('https://pncp.gov.br/app/editais/08241747000143/2024/12')

    const urlAta = PncpService.construirDeepLinkPncp('17.888.082/0001-55', 2023, 1, 'atas')
    expect(urlAta).toBe('https://pncp.gov.br/app/atas/17888082000155/2023/1')
  })

  it('deve gerar hash determinístico de rastreabilidade (SHA-256 pattern)', () => {
    const hash = PncpService.gerarHashRastreabilidade({
      fonte: 'pncp',
      id_externo: '17888082000155-1-000001/2023',
      cnpj_orgao: '17888082000155',
      valor: 15.5,
      data: '2023-05-10',
      item: 'DIPIRONA SODICA 500MG/ML',
    })
    expect(hash).toContain('pncp_sha256_')
    expect(hash.length).toBeGreaterThan(15)
  })

  it('deve mapear corretamente campos da API do PNCP para modelo Referencia', async () => {
    // Simula uma resposta do endpoint /api/search/v1/atas
    const mockAta = {
      numeroControlePNCP: '08241747000143-1-000005/2024',
      numeroAtaRegistroPreco: '005/2024',
      anoAta: 2024,
      numeroSequencialAta: 5,
      dataPublicacaoPncp: '2024-03-15T10:00:00',
      orgaoEntidade: {
        cnpj: '08241747000143',
        razaoSocial: 'PREFEITURA MUNICIPAL DE NATAL - RN',
      },
      unidadeOrgao: {
        ufSigla: 'RN',
        municipioNome: 'Natal',
      },
      fornecedor: {
        nomeRazaoSocialFornecedor: 'DISTRIBUIDORA NORTE MEDICAMENTOS LTDA - ME',
        niFornecedor: '12345678000199',
        porteFornecedorNome: 'MICROEMPRESA',
      },
      itensAta: [
        {
          numeroItem: 1,
          descricao: 'DIPIRONA SODICA 500 MG/ML SOL INJ 2ML',
          materialOuServicoNome: 'DIPIRONA SODICA',
          valorUnitarioHomologado: 1.45,
          quantidade: 50000,
          unidadeMedida: 'AMP',
          marcaNome: 'TEUTO',
        },
      ],
    }

    // Executa método privado através da resposta mockada processada
    const res = await (PncpService as any).mapearItemParaReferencia(
      mockAta,
      mockAta.itensAta[0],
      0,
      0,
    )

    expect(res).not.toBeNull()
    expect(res.fonte).toBe('pncp')
    expect(res.orgao_comprador).toBe('PREFEITURA MUNICIPAL DE NATAL - RN')
    expect(res.municipio_uf).toBe('Natal - RN')
    expect(res.valor_normalizado).toBe(1.45)
    expect(res.unidade).toBe('AMP')
    expect(res.fornecedor).toBe('DISTRIBUIDORA NORTE MEDICAMENTOS LTDA - ME')
    expect(res.url).toBe('https://pncp.gov.br/app/atas/08241747000143/2024/5')
    expect(res.is_demo).toBe(false)
  })

  it('deve converter corretamente Referencias reais para BudgetPriceResult', () => {
    const mockRef = {
      id: 'PNCP-REAL-08241747000143-1',
      pesquisa_id: 'test',
      fonte: 'pncp' as const,
      id_externo: '08241747000143-1',
      item_externo: 'DIPIRONA 500MG GOTAS',
      natureza_preco: 'contratado' as const,
      valor_original: 2.1,
      valor_normalizado: 2.1,
      unidade: 'FRASCO',
      quantidade: 1000,
      data_contratacao: '2024-04-01T08:00:00Z',
      fornecedor: 'FARMACEUTICA POTIGUAR LTDA',
      cnpj_fornecedor: '08333444000155',
      orgao_comprador: 'SECRETARIA DE ESTADO DA SAUDE PUBLICA DO RN - SESAP',
      municipio_uf: 'Natal - RN',
      modalidade_licitacao: 'Pregão Eletrônico SRP',
      processo_origem: 'Ata 12/2024',
      marca_modelo: 'EMS',
      codigo_catalogo: 'CATMAT-4482',
      url: 'https://pncp.gov.br/app/atas/08333444000155/2024/12',
      hash: 'pncp_sha256_abcdef12_50',
      status_revisao: 'aceito' as const,
      source_identifier: '08241747000143-1',
      source_capture_date: new Date().toISOString(),
      confidence_score: 95,
      similarity_score: 96,
      is_demo: false,
      raw_data: {
        is_real_api: true,
        porte_empresa: 'DEMAIS',
      },
    }

    const converted = PncpService.converterParaBudgetPriceResults([mockRef], 'item-123')
    expect(converted.length).toBe(1)
    expect(converted[0].budget_item_id).toBe('item-123')
    expect(converted[0].source).toBe('PNCP')
    expect(converted[0].unit_price).toBe(2.1)
    expect(converted[0].raw_data.is_real_api).toBe(true)
    expect(converted[0].raw_data.is_demo).toBe(false)
    expect(converted[0].source_url).toBe('https://pncp.gov.br/app/atas/08333444000155/2024/12')
  })
})
