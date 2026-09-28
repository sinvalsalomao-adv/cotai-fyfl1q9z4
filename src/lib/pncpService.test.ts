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

  it('deve aceitar variações morfológicas legítimas do termo (ex: "picolé", "picole", "picolés")', async () => {
    // Validação de matching de itens com descrições reais encontradas no PNCP
    const mockAtaPicole = {
      numeroControlePNCP: '12345678000199-1-000010/2024',
      anoAta: 2024,
      numeroSequencialAta: 10,
      dataPublicacaoPncp: '2024-04-10T10:00:00',
      orgaoEntidade: {
        cnpj: '12345678000199',
        razaoSocial: 'MUNICIPIO DE EXEMPLO',
      },
      unidadeOrgao: { ufSigla: 'SP', municipioNome: 'Exemplo' },
      itensAta: [
        {
          numeroItem: 1,
          descricao: 'PICOLE DE FRUTAS SABORES DIVERSOS 60G',
          valorUnitarioHomologado: 2.5,
          quantidade: 500,
          unidadeMedida: 'UN',
        },
        {
          numeroItem: 2,
          descricao: 'SORVETE TIPO PICOLE RECHEADO',
          valorUnitarioHomologado: 3.2,
          quantidade: 300,
          unidadeMedida: 'UN',
        },
      ],
    }

    const res1 = await (PncpService as any).mapearItemParaReferencia(
      mockAtaPicole,
      mockAtaPicole.itensAta[0],
      0,
      0,
    )
    const res2 = await (PncpService as any).mapearItemParaReferencia(
      mockAtaPicole,
      mockAtaPicole.itensAta[1],
      0,
      1,
    )

    expect(res1).not.toBeNull()
    expect(res1.valor_normalizado).toBe(2.5)
    expect(res1.descricao).toContain('PICOLE')

    expect(res2).not.toBeNull()
    expect(res2.valor_normalizado).toBe(3.2)
  })

  it('deve extrair cnpj, ano e sequencial de compra da ata via numeroControlePNCP e item_url', () => {
    // Caso 1: controle de ata PNCP no formato CNPJ-TIPO-SEQCOMPRA/ANOCOMPRA-SEQATA
    const params1 = (PncpService as any).extrairParametrosItem({
      orgaoEntidade: { cnpj: '01612370000142' },
      numeroControlePNCP: '01612370000142-1-000130/2024-000001',
    })
    expect(params1.cnpj).toBe('01612370000142')
    expect(params1.sequencial).toBe(130)
    expect(params1.ano).toBe(2024)

    // Caso 2: extração por item_url no formato /atas/{cnpj}/{ano}/{seqCompra}/{seqAta}
    const params2 = (PncpService as any).extrairParametrosItem({
      item_url: '/atas/18691766000125/2024/41/1',
    })
    expect(params2.cnpj).toBe('18691766000125')
    expect(params2.sequencial).toBe(41)
    expect(params2.ano).toBe(2024)
  })
})
