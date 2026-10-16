import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PriceIndexService } from './priceIndexService'
import { SearchOrchestrator } from './connectors/searchOrchestrator'
import { PncpConnectorAdapter } from './connectors/pncpConnectorAdapter'
import { ComprasGovConnectorAdapter } from './connectors/comprasGovConnectorAdapter'
import pb from './pocketbase/client'
import type { AmostraPreco, ConnectorSearchResult } from './connectors/types'

describe('Motor de Pesquisa Indexada - Testes Reais e Integrados (v0.0.92)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // CENÁRIO A: Índice Vazio -> Resposta Rápida e Tarefa Efetivamente Criada
  it('Cenário A: Índice vazio cria tarefa na fila e orquestrador responde imediatamente sem bloquear', async () => {
    vi.spyOn(PriceIndexService, 'searchIndex').mockResolvedValueOnce({
      took: 5,
      timed_out: false,
      hits: { total: 0, max_score: 0, hits: [] },
      aggregations: {
        preco_minimo: 0,
        preco_maximo: 0,
        preco_medio: 0,
        preco_mediana: 0,
        unidades: {},
        estados: {},
        municipios: {},
      },
      pagination: {
        paginaAtual: 1,
        tamanhoPagina: 10,
        totalPaginas: 1,
        totalRegistros: 0,
      },
    })

    const spyRegistrar = vi
      .spyOn(PriceIndexService, 'registrarTarefaAtualizacao')
      .mockResolvedValueOnce({ id: 'task_dipirona_123', termo: 'Dipirona', status: 'pending' })

    const mockPncp = new PncpConnectorAdapter()
    const mockSearchResult: ConnectorSearchResult = {
      sucesso: true,
      fonte: 'PNCP',
      fonteNomeExibicao: 'PNCP',
      totalAmostrasRecuperadas: 1,
      totalRegistrosInformadosApi: 1,
      paginasProcessadas: 1,
      tempoMs: 120,
      status: 'CONCLUIDA',
      amostras: [
        {
          id: 'PNCP#1',
          fonte: 'PNCP',
          fonteNomeExibicao: 'PNCP',
          idExterno: '12345/2026',
          urlOriginal: 'https://pncp.gov.br',
          dataPublicacaoOuContrato: '2026-03-01',
          produto: 'Dipirona 500mg',
          descricaoCompleta: 'Dipirona Sódica 500mg/ml',
          descricaoNormalizada: 'DIPIRONA SODICA 500MG ML',
          orgaoComprador: 'Prefeitura Municipal',
          orgaoCnpj: '00000000000191',
          fornecedorNome: 'Distribuidora Hospitalar',
          unidade: 'AMPOLA',
          quantidade: 1000,
          valorUnitario: 0.85,
          valorTotal: 850,
          scoreSimilaridade: 100,
          natureza: 'contratado',
          isDemo: false,
          hashRastreabilidade: 'PNCP#1',
        },
      ],
      observabilidade: {
        fonte: 'PNCP',
        tempoTotalMs: 120,
        quantidadeInformadaApi: 1,
        quantidadeRecebidaBruta: 1,
        quantidadeProcessadaValida: 1,
        quantidadeEntregue: 1,
        quantidadeDescartadaAntiContaminacao: 0,
        quantidadeDuplicidadesInternas: 0,
        paginasProcessadas: 1,
        totalPaginasApi: 1,
        retriesExecutados: 0,
        statusHttpFinal: 200,
        timeoutsCount: 0,
        errosEncontrados: [],
        circuitBreakerAcionado: false,
        cacheHit: false,
      },
    }

    vi.spyOn(mockPncp, 'search').mockResolvedValueOnce(mockSearchResult)

    const orchestrator = new SearchOrchestrator([mockPncp])
    const res = await orchestrator.search({ termo: 'Dipirona', tamanhoPagina: 10 })

    expect(spyRegistrar).toHaveBeenCalledWith('Dipirona', 'AMBAS', undefined)
    expect(res.amostras.length).toBeGreaterThan(0)
    expect(res.amostras[0].valorUnitario).toBe(0.85)
  })

  // CENÁRIO B: Coleta e Persistência Idempotente
  it('Cenário B: Persistência no price_samples_index é idempotente e rejeita itens sem preço unitário', async () => {
    const amostrasValidas: AmostraPreco[] = [
      {
        id: '1',
        fonte: 'PNCP',
        fonteNomeExibicao: 'PNCP',
        idExterno: '11222333000144/2026/1/itens/1',
        urlOriginal: 'https://pncp.gov.br/app/editais/11222333000144/2026/1',
        dataPublicacaoOuContrato: '2026-03-01',
        produto: 'Dipirona 500mg',
        descricaoCompleta: 'Dipirona 500mg Gotas',
        descricaoNormalizada: 'DIPIRONA 500MG GOTAS',
        orgaoComprador: 'Hospital Regional',
        orgaoCnpj: '11222333000144',
        fornecedorNome: 'Farma Distribuidora',
        unidade: 'FRASCO',
        quantidade: 50,
        valorUnitario: 2.35,
        valorTotal: 117.5,
        scoreSimilaridade: 100,
        natureza: 'contratado',
        isDemo: false,
        hashRastreabilidade: 'PNCP#1',
        detalhesAdicionais: { numeroItem: 1, proveniencia_preco: {
          versao: 1, status: 'verificada', fonte: 'PNCP', natureza: 'homologado',
          campo_unitario: 'valorUnitarioHomologado', valor_unitario: 2.35,
          identidade: { cnpj: '11222333000144', ano: 2026, sequencial: 1, numeroItem: 1 },
          url_evidencia: 'https://pncp.gov.br/api/pncp/v1/orgaos/11222333000144/compras/2026/1/itens/1/resultados',
          registro_oficial: { valorUnitarioHomologado: 2.35, dataResultado: '2026-03-01' },
          data_oficial: '2026-03-01', campo_data: 'dataResultado',
        } },
      },
      {
        id: '2',
        fonte: 'PNCP',
        fonteNomeExibicao: 'PNCP',
        idExterno: 'CONTROLE-PNCP-002',
        urlOriginal: 'https://pncp.gov.br',
        dataPublicacaoOuContrato: '2026-03-01',
        produto: 'Item Inválido Sem Preço',
        descricaoCompleta: 'Item Global',
        descricaoNormalizada: 'ITEM GLOBAL',
        orgaoComprador: 'Hospital Regional',
        orgaoCnpj: '11222333000144',
        fornecedorNome: 'NÃO INFORMADO',
        unidade: 'UN',
        quantidade: 1,
        valorUnitario: 0, // INVÁLIDO
        valorTotal: 0,
        scoreSimilaridade: 100,
        natureza: 'contratado',
        isDemo: false,
        hashRastreabilidade: 'PNCP#2',
      },
    ]

    const individualRequests = vi.spyOn(pb, 'collection').mockImplementation(() => {
      throw new Error('Persistência individual não deve ser usada')
    })
    // Only the HTTP boundary is mocked. Actual hook validation/transaction coverage is in
    // tests/indexBatch.integration.test.ts; this case preserves the service contract regression.
    const batch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        sucesso: true, recebidas: 1, inseridas: 1, atualizadas: 0, ignoradas: 0,
      }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        sucesso: true, recebidas: 1, inseridas: 0, atualizadas: 1, ignoradas: 0,
      }) } as Response)

    const resultado = await PriceIndexService.persistirAmostras(amostrasValidas)
    // O item com valorUnitario <= 0 DEVE ser ignorado
    expect(resultado.ignoradas).toBe(1)
    expect(resultado.inseridas).toBe(1)
    expect(resultado.atualizadas).toBe(0)
    const repetido = await PriceIndexService.persistirAmostras(amostrasValidas)
    expect(repetido).toEqual({ inseridas: 0, atualizadas: 1, ignoradas: 1 })
    expect(batch).toHaveBeenCalledTimes(2)
    expect(individualRequests).not.toHaveBeenCalled()
    const firstBody = JSON.parse(String(batch.mock.calls[0][1]?.body))
    const repeatedBody = JSON.parse(String(batch.mock.calls[1][1]?.body))
    expect(firstBody.amostras).toHaveLength(1)
    expect(firstBody.amostras[0].valor_unitario).toBe(2.35)
    expect(firstBody.amostras[0].raw_payload).toEqual(amostrasValidas[0].detalhesAdicionais)
    expect(firstBody.amostras[0].sample_key).toBe(repeatedBody.amostras[0].sample_key)
  })

  // CENÁRIO C e D: Segunda pesquisa usa o índice populado sem nova coleta pesada
  it('Cenário D: Segunda pesquisa com índice populado retorna imediatamente as amostras indexadas', async () => {
    vi.spyOn(PriceIndexService, 'searchIndex').mockResolvedValueOnce({
      took: 4,
      timed_out: false,
      hits: {
        total: 2,
        max_score: 1.0,
        hits: [
          {
            _index: 'price_samples_index',
            _id: 'rec_1',
            _score: 1.0,
            _source: {
              id: 'rec_1',
              sample_key: 'PNCP#123#1#0001#0_25',
              compra_id: '123/2026',
              item_id: '1',
              descricao: 'Dipirona 500mg Comprimido',
              descricao_texto: 'Dipirona 500mg Comprimido',
              descricao_normalizada: 'DIPIRONA 500MG COMPRIMIDO',
              fonte: 'PNCP',
              orgao: 'Secretaria de Saúde',
              orgao_cnpj: '00111222000133',
              for_nome: 'Distribuidora Farmacêutica Ltda',
              for_cnpj: '99888777000155',
              unidade: 'COMPRIMIDO',
              quantidade: 50000,
              valor_unitario: 0.25,
              valor_total: 12500,
              natureza_preco: 'homologado',
              data: '2026-02-15',
              link_oficial: 'https://pncp.gov.br/app/editais/123-2026',
            },
            sort: [0.25],
          },
          {
            _index: 'price_samples_index',
            _id: 'rec_2',
            _score: 1.0,
            _source: {
              id: 'rec_2',
              sample_key: 'COMPRAS#456#1#0001#0_18',
              compra_id: '456/2026',
              item_id: '1',
              descricao: 'Dipirona Sódica 500mg',
              descricao_texto: 'Dipirona Sódica 500mg',
              descricao_normalizada: 'DIPIRONA SODICA 500MG',
              fonte: 'Compras.gov.br',
              orgao: 'Ministério da Saúde',
              orgao_cnpj: '00394544000185',
              for_nome: 'Laboratório Farmacêutico Nacional',
              for_cnpj: '44555666000122',
              unidade: 'COMPRIMIDO',
              quantidade: 100000,
              valor_unitario: 0.18,
              valor_total: 18000,
              natureza_preco: 'homologado',
              data: '2026-02-20',
              link_oficial: 'https://catalogo.compras.gov.br',
            },
            sort: [0.18],
          },
        ],
      },
      aggregations: {
        preco_minimo: 0.18,
        preco_maximo: 0.25,
        preco_medio: 0.215,
        preco_mediana: 0.215,
        unidades: { COMPRIMIDO: 2 },
        estados: { DF: 1, SP: 1 },
        municipios: {},
      },
      pagination: {
        paginaAtual: 1,
        tamanhoPagina: 50,
        totalPaginas: 1,
        totalRegistros: 2,
      },
    })

    const orchestrator = new SearchOrchestrator()
    const res = await orchestrator.search({ termo: 'Dipirona', tamanhoPagina: 10 })

    expect(res.estado).toBe('CONCLUIDA')
    expect(res.amostras.length).toBe(2)
    // O mais barato (0.18) deve ser o primeiro
    expect(res.amostras[0].valorUnitario).toBe(0.18)
    expect(res.amostras[1].valorUnitario).toBe(0.25)
    expect(res.estatisticas.valorMinimo).toBe(0.18)
    expect(res.estatisticas.valorMaximo).toBe(0.25)
  })

  // CENÁRIO F: Preservação de preços unitários centavos < R$ 1,00 e proibição de valores globais
  it('Cenário F: Preços abaixo de R$ 1,00 são preservados integralmente com precisão decimal', () => {
    const orchestrator = new SearchOrchestrator()
    const amostras: AmostraPreco[] = [
      {
        id: '1',
        fonte: 'PNCP',
        fonteNomeExibicao: 'PNCP',
        idExterno: '1',
        urlOriginal: '',
        dataPublicacaoOuContrato: '2026-01-01',
        produto: 'Dipirona 500mg',
        descricaoCompleta: 'Dipirona 500mg',
        descricaoNormalizada: 'DIPIRONA 500MG',
        orgaoComprador: 'SMS',
        orgaoCnpj: '123',
        fornecedorNome: 'Distribuidora Alpha',
        unidade: 'COMP',
        quantidade: 1000,
        valorUnitario: 0.045, // < R$ 1,00
        valorTotal: 45,
        scoreSimilaridade: 100,
        natureza: 'contratado',
        isDemo: false,
        hashRastreabilidade: 'hash-1',
      },
      {
        id: '2',
        fonte: 'Compras.gov.br',
        fonteNomeExibicao: 'Compras.gov.br',
        idExterno: '2',
        urlOriginal: '',
        dataPublicacaoOuContrato: '2026-01-01',
        produto: 'Dipirona 500mg',
        descricaoCompleta: 'Dipirona 500mg',
        descricaoNormalizada: 'DIPIRONA 500MG',
        orgaoComprador: 'MS',
        orgaoCnpj: '456',
        fornecedorNome: 'Distribuidora Beta',
        unidade: 'COMP',
        quantidade: 1000,
        valorUnitario: 0.089, // < R$ 1,00
        valorTotal: 89,
        scoreSimilaridade: 100,
        natureza: 'contratado',
        isDemo: false,
        hashRastreabilidade: 'hash-2',
      },
    ]

    const stats = orchestrator.calcularEstatisticas(amostras)
    expect(stats.valorMinimo).toBe(0.045)
    expect(stats.valorMaximo).toBe(0.089)
    expect(stats.mediaGeral).toBeCloseTo(0.067, 3)
  })

  // CENÁRIO G: Resiliência — Falha do PNCP não afeta o Compras.gov.br
  it('Cenário G: Se o PNCP falha por timeout ou 502, Compras.gov.br continua entregando resultados', async () => {
    const pncp = new PncpConnectorAdapter()
    const comprasGov = new ComprasGovConnectorAdapter()

    // Mock do PNCP falhando com 502
    const mockPncpFalha: ConnectorSearchResult = {
      sucesso: false,
      fonte: 'PNCP',
      fonteNomeExibicao: 'PNCP',
      totalAmostrasRecuperadas: 0,
      totalRegistrosInformadosApi: 0,
      paginasProcessadas: 1,
      tempoMs: 2500,
      status: 'FALHA_TOTAL',
      amostras: [],
      erro: 'PNCP_UPSTREAM_UNAVAILABLE (502)',
      observabilidade: {
        fonte: 'PNCP',
        tempoTotalMs: 2500,
        quantidadeInformadaApi: 0,
        quantidadeRecebidaBruta: 0,
        quantidadeProcessadaValida: 0,
        quantidadeEntregue: 0,
        quantidadeDescartadaAntiContaminacao: 0,
        quantidadeDuplicidadesInternas: 0,
        paginasProcessadas: 1,
        totalPaginasApi: 0,
        retriesExecutados: 1,
        statusHttpFinal: 502,
        timeoutsCount: 0,
        errosEncontrados: ['PNCP_UPSTREAM_UNAVAILABLE'],
        circuitBreakerAcionado: false,
        cacheHit: false,
      },
    }
    vi.spyOn(pncp, 'search').mockResolvedValueOnce(mockPncpFalha)

    // Mock do Compras.gov.br retornando com sucesso
    const mockCgovSucesso: ConnectorSearchResult = {
      sucesso: true,
      fonte: 'Compras.gov.br',
      fonteNomeExibicao: 'Compras.gov.br',
      totalAmostrasRecuperadas: 1,
      totalRegistrosInformadosApi: 1,
      paginasProcessadas: 1,
      tempoMs: 300,
      status: 'CONCLUIDA',
      amostras: [
        {
          id: 'CGOV-1',
          fonte: 'Compras.gov.br',
          fonteNomeExibicao: 'Compras.gov.br',
          idExterno: 'COMP-100',
          urlOriginal: 'https://comprasnet.gov.br',
          dataPublicacaoOuContrato: '2026-03-01',
          produto: 'Dipirona 500mg',
          descricaoCompleta: 'Dipirona 500mg',
          descricaoNormalizada: 'DIPIRONA 500MG',
          orgaoComprador: 'Exército Brasileiro',
          orgaoCnpj: '00000000000191',
          fornecedorNome: 'Nacional Farma',
          unidade: 'COMPRIMIDO',
          quantidade: 5000,
          valorUnitario: 0.12,
          valorTotal: 600,
          scoreSimilaridade: 100,
          natureza: 'contratado',
          isDemo: false,
          hashRastreabilidade: 'CGOV-1',
        },
      ],
      observabilidade: {
        fonte: 'Compras.gov.br',
        tempoTotalMs: 300,
        quantidadeInformadaApi: 1,
        quantidadeRecebidaBruta: 1,
        quantidadeProcessadaValida: 1,
        quantidadeEntregue: 1,
        quantidadeDescartadaAntiContaminacao: 0,
        quantidadeDuplicidadesInternas: 0,
        paginasProcessadas: 1,
        totalPaginasApi: 1,
        retriesExecutados: 0,
        statusHttpFinal: 200,
        timeoutsCount: 0,
        errosEncontrados: [],
        circuitBreakerAcionado: false,
        cacheHit: false,
      },
    }
    vi.spyOn(comprasGov, 'search').mockResolvedValueOnce(mockCgovSucesso)

    // Índice vazio
    vi.spyOn(PriceIndexService, 'searchIndex').mockResolvedValueOnce({
      took: 2,
      timed_out: false,
      hits: { total: 0, max_score: 0, hits: [] },
      aggregations: {
        preco_minimo: 0,
        preco_maximo: 0,
        preco_medio: 0,
        preco_mediana: 0,
        unidades: {},
        estados: {},
        municipios: {},
      },
      pagination: {
        paginaAtual: 1,
        tamanhoPagina: 10,
        totalPaginas: 1,
        totalRegistros: 0,
      },
    })
    vi.spyOn(PriceIndexService, 'registrarTarefaAtualizacao').mockResolvedValueOnce({
      id: 'task_1',
      termo: 'Dipirona',
      status: 'pending',
    })

    const orchestrator = new SearchOrchestrator([pncp, comprasGov])
    const res = await orchestrator.search({ termo: 'Dipirona' })

    // Estado deve ser CONCLUIDA_PARCIALMENTE pois uma teve sucesso e a outra falha
    expect(res.estado).toBe('CONCLUIDA_PARCIALMENTE')
    expect(res.amostras.length).toBe(1)
    expect(res.amostras[0].valorUnitario).toBe(0.12)
    expect(res.fontesComSucesso).toContain('compras_gov')
    expect(res.fontesComFalha).toContain('pncp')
  })
})
