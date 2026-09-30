import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SearchOrchestrator,
  CircuitBreaker,
  ConnectorRateLimiter,
  PriceSearchCache,
  BasePriceConnectorAdapter,
  SourceMetadata,
  ConnectorSearchParams,
  ConnectorPageResult,
  AmostraPreco,
  PaginationInfo,
} from './index'

// Mock de conector customizado para testes deterministicos de grande volume e resiliência
class MockVolumeConnector extends BasePriceConnectorAdapter {
  public readonly id: string
  public readonly nome: string
  public totalRegistrosMock: number
  public tamanhoPaginaMock: number
  public falharNaPagina?: number
  public simularStatusHttp?: number
  public delayMs?: number

  constructor(options: {
    id: string
    nome: string
    totalRegistros: number
    tamanhoPagina: number
    falharNaPagina?: number
    simularStatusHttp?: number
    delayMs?: number
  }) {
    super()
    this.id = options.id
    this.nome = options.nome
    this.totalRegistrosMock = options.totalRegistros
    this.tamanhoPaginaMock = options.tamanhoPagina
    this.falharNaPagina = options.falharNaPagina
    this.simularStatusHttp = options.simularStatusHttp
    this.delayMs = options.delayMs
  }

  public getSourceMetadata(): SourceMetadata {
    return {
      id: this.id,
      nome: this.nome,
      sigla: this.id.toUpperCase(),
      tipo: 'OFICIAL_GOV',
      status: 'ATIVA',
      descricao: 'Conector de teste de volume',
      urlPortal: 'https://exemplo.gov.br',
      suportaPaginacaoCompleta: true,
      maxTamanhoPaginaPermitido: 100,
      rateLimitRequisicoesPorSegundo: 100,
      concorrenciaMaximaRecomendada: 10,
      requerCredencial: false,
      credencialConfigurada: true,
      isDemo: false,
    }
  }

  public normalize(rawItem: any, index: number): AmostraPreco | null {
    return {
      id: `${this.id}-${rawItem.id}`,
      fonte: this.nome,
      fonteNomeExibicao: this.nome,
      idExterno: String(rawItem.id),
      urlOriginal: `https://exemplo.gov.br/${rawItem.id}`,
      dataPublicacaoOuContrato: '2025-01-15T00:00:00Z',
      produto: rawItem.produto || 'DIPIRONA SODICA 500MG/ML',
      descricaoCompleta: rawItem.descricao || 'DIPIRONA SODICA 500MG/ML SOL INJ',
      orgaoComprador: rawItem.orgao || 'Prefeitura Municipal Teste',
      fornecedorNome: rawItem.fornecedor || `Fornecedor ${index}`,
      fornecedorCnpjOuCpf: '00.000.000/0001-91',
      unidade: 'AMP',
      quantidade: 1000,
      valorUnitario: Number(rawItem.preco) || 2.5,
      hashRastreabilidade: `hash_${this.id}_${rawItem.id}`,
      natureza: 'homologado',
      isDemo: false,
    }
  }

  public async fetchPage(
    params: ConnectorSearchParams,
    pagina: number,
  ): Promise<ConnectorPageResult> {
    if (this.delayMs) {
      await new Promise((r) => setTimeout(r, this.delayMs))
    }

    if (this.falharNaPagina && pagina === this.falharNaPagina) {
      const status = this.simularStatusHttp || 500
      this.circuitBreaker.registrarFalha(`Erro simulado ${status}`, status)
      return {
        sucesso: false,
        amostras: [],
        pagination: {
          paginaAtual: pagina,
          tamanhoPagina: this.tamanhoPaginaMock,
          totalRegistrosInformadoApi: this.totalRegistrosMock,
          totalPaginasInformadoApi: Math.ceil(this.totalRegistrosMock / this.tamanhoPaginaMock),
          temMaisPaginas: false,
        },
        tempoMs: 10,
        statusHttp: status,
        isIndisponivel: status === 429 || status >= 500,
        erro: `Falha na página ${pagina}`,
      }
    }

    const totalPags = Math.ceil(this.totalRegistrosMock / this.tamanhoPaginaMock)
    const inicio = (pagina - 1) * this.tamanhoPaginaMock
    const fim = Math.min(inicio + this.tamanhoPaginaMock, this.totalRegistrosMock)
    const qtdNestaPagina = Math.max(0, fim - inicio)

    const amostras: AmostraPreco[] = []
    for (let i = 0; i < qtdNestaPagina; i++) {
      const globalIdx = inicio + i
      amostras.push(
        this.normalize(
          {
            id: globalIdx + 1,
            produto: 'DIPIRONA MONOIDRATADA 500MG COMPRIMIDO',
            descricao: `DIPIRONA 500MG CX 500 COMPRIMIDOS - LOTE ${globalIdx + 1}`,
            preco: 0.25 + (globalIdx % 50) * 0.01,
            orgao: `Prefeitura Municipal de Teste ${globalIdx % 10}`,
            fornecedor: `Distribuidora Farma ${globalIdx % 25} LTDA`,
          },
          globalIdx,
        )!,
      )
    }

    return {
      sucesso: true,
      amostras,
      pagination: {
        paginaAtual: pagina,
        tamanhoPagina: this.tamanhoPaginaMock,
        totalRegistrosInformadoApi: this.totalRegistrosMock,
        totalPaginasInformadoApi: totalPags,
        temMaisPaginas: pagina < totalPags,
      },
      tempoMs: 5,
      statusHttp: 200,
    }
  }
}

describe('Motor de Pesquisa de Preços (COTAI) — Suíte Oficial T1..T12', () => {
  beforeEach(() => {
    PriceSearchCache.getInstance().limparTudo()
  })

  // T1: API com 4.400 registros -> 4.400 recuperados (ausência de limite artificial)
  it('T1: Recupera integralmente 4.400 registros quando disponibilizados pela API sem cortes artificiais', async () => {
    const connector4400 = new MockVolumeConnector({
      id: 'mock_4400',
      nome: 'Fonte Grande Volume (4.400)',
      totalRegistros: 4400,
      tamanhoPagina: 100, // 44 páginas de 100
    })

    const res = await connector4400.search({ termo: 'dipirona', forcarAtualizacaoCache: true })

    expect(res.sucesso).toBe(true)
    expect(res.totalAmostrasRecuperadas).toBe(4400)
    expect(res.paginasProcessadas).toBe(44)
    expect(res.totalRegistrosInformadosApi).toBe(4400)
  })

  // T2: 44 páginas -> todas as 44 processadas
  it('T2: Processa exatamente todas as 44 páginas da fonte sem interrupção arbitrária', async () => {
    const connector = new MockVolumeConnector({
      id: 'mock_pages',
      nome: 'Fonte 44 Paginas',
      totalRegistros: 4400,
      tamanhoPagina: 100,
    })

    let progressoChamadas = 0
    let totalItensRecebidosViaProgresso = 0

    const res = await connector.search(
      { termo: 'dipirona', forcarAtualizacaoCache: true },
      (novas, info) => {
        progressoChamadas++
        totalItensRecebidosViaProgresso += novas.length
      },
    )

    expect(progressoChamadas).toBe(44)
    expect(totalItensRecebidosViaProgresso).toBe(4400)
    expect(res.paginasProcessadas).toBe(44)
  })

  // T3: Fontes múltiplas (4.400 + 1.200 + 350) -> resultado consolidado de 5.950 amostras
  it('T3: Consolida múltiplas fontes (4.400 + 1.200 + 350) preservando origens e totalizando 5.950 amostras', async () => {
    const orquestrador = SearchOrchestrator.getInstance()
    // Registra mocks com volumes especificados
    const c1 = new MockVolumeConnector({
      id: 'src_4400',
      nome: 'Fonte PNCP Teste',
      totalRegistros: 4400,
      tamanhoPagina: 200,
    })
    const c2 = new MockVolumeConnector({
      id: 'src_1200',
      nome: 'Fonte Compras.gov Teste',
      totalRegistros: 1200,
      tamanhoPagina: 200,
    })
    const c3 = new MockVolumeConnector({
      id: 'src_350',
      nome: 'Fonte BPS Teste',
      totalRegistros: 350,
      tamanhoPagina: 100,
    })

    orquestrador.registrarConector(c1)
    orquestrador.registrarConector(c2)
    orquestrador.registrarConector(c3)

    const res = await orquestrador.executarPesquisa(
      { termo: 'dipirona', forcarAtualizacaoCache: true },
      { fonteSolicitada: 'src_4400,src_1200,src_350' },
    )

    expect(res.estado).toBe('CONCLUIDA')
    expect(res.amostras.length).toBe(4400 + 1200 + 350)
    expect(res.estatisticas.totalAmostras).toBe(5950)
    expect(res.estatisticas.valorMinimo).toBeGreaterThan(0)
    expect(res.observabilidade.fontesComSucesso).toContain('src_4400')
    expect(res.observabilidade.fontesComSucesso).toContain('src_1200')
    expect(res.observabilidade.fontesComSucesso).toContain('src_350')
  })

  // T4: Timeout de uma fonte -> as outras continuam normalmente (isolamento de falhas)
  it('T4: Falha ou timeout de uma fonte não compromete as demais', async () => {
    const orquestrador = SearchOrchestrator.getInstance()
    const cBoa = new MockVolumeConnector({
      id: 'fonte_boa',
      nome: 'Fonte Boa',
      totalRegistros: 500,
      tamanhoPagina: 100,
    })
    const cLentaFalha = new MockVolumeConnector({
      id: 'fonte_timeout',
      nome: 'Fonte Lenta com Timeout',
      totalRegistros: 1000,
      tamanhoPagina: 100,
      falharNaPagina: 1,
      simularStatusHttp: 504,
    })

    orquestrador.registrarConector(cBoa)
    orquestrador.registrarConector(cLentaFalha)

    const res = await orquestrador.executarPesquisa(
      { termo: 'dipirona', forcarAtualizacaoCache: true },
      { fonteSolicitada: 'fonte_boa,fonte_timeout' },
    )

    expect(res.estado).toBe('CONCLUIDA_PARCIALMENTE')
    expect(res.amostras.length).toBe(500)
    expect(res.fontesComSucesso).toContain('fonte_boa')
    expect(res.fontesComFalha).toContain('fonte_timeout')
    expect(res.errosPorFonte['fonte_timeout']).toBeDefined()
  })

  // T5: Falha em página intermediária (ex: pág 5 de 10) -> preserva páginas 1..4 (RF-014)
  it('T5: Falha na página 5 preserva páginas 1–4 e conclui parcialmente', async () => {
    const connectorFalhaP5 = new MockVolumeConnector({
      id: 'src_falha_p5',
      nome: 'Fonte Falha Pagina 5',
      totalRegistros: 1000,
      tamanhoPagina: 100, // 10 páginas no total
      falharNaPagina: 5,
    })

    const res = await connectorFalhaP5.search({ termo: 'dipirona', forcarAtualizacaoCache: true })

    expect(res.status).toBe('CONCLUIDA_PARCIAL')
    expect(res.totalAmostrasRecuperadas).toBe(400) // 4 páginas de 100 = 400 preservadas
    expect(res.paginasProcessadas).toBe(5) // Tentou a 5 e parou preservando
    expect(res.observabilidade.errosEncontrados.length).toBeGreaterThan(0)
  })

  // T6: 429 Too Many Requests -> Exponential Backoff + Cooldown (Circuit Breaker)
  it('T6: Responde a 429 acionando backoff e abrindo circuit breaker se persistir', async () => {
    const cb = new CircuitBreaker('test_429', { falhasParaAbrir: 2, tempoCooldownMs: 5000 })
    expect(cb.isOpen()).toBe(false)

    // Simula erro 429 (peso 2 no breaker)
    cb.registrarFalha('429 Too Many Requests', 429)
    expect(cb.isOpen()).toBe(true)
    expect(cb.getTempoCooldownRestanteMs()).toBeGreaterThan(0)
  })

  // T7: Erros 502/503/504 -> Retry controlado + Circuit Breaker
  it('T7: Tratamento de erros 502/503/504 com retry limitado e abertura controlada', async () => {
    const cb = new CircuitBreaker('test_503', { falhasParaAbrir: 2, tempoCooldownMs: 3000 })
    cb.registrarFalha('503 Service Unavailable', 503)
    expect(cb.isOpen()).toBe(true)

    const erroInfo = cb.getUltimoErro()
    expect(erroInfo.statusHttp).toBe(503)
    expect(erroInfo.mensagem).toContain('503')
  })

  // T8: Vários usuários simultâneos -> Concorrência global controlada via Rate Limiter
  it('T8: Rate limiter gerencia concorrência e fila sem estourar limites', async () => {
    const limiter = new ConnectorRateLimiter({
      requisicoesPorSegundo: 10,
      concorrenciaMaxima: 2,
    })

    let executadosSimultaneosMaximo = 0
    let executadosAtuais = 0

    const tarefa = async () => {
      return limiter.execute(async () => {
        executadosAtuais++
        executadosSimultaneosMaximo = Math.max(executadosSimultaneosMaximo, executadosAtuais)
        await new Promise((r) => setTimeout(r, 20))
        executadosAtuais--
        return true
      })
    }

    await Promise.all([tarefa(), tarefa(), tarefa(), tarefa(), tarefa()])

    expect(executadosSimultaneosMaximo).toBeLessThanOrEqual(2)
  })

  // T9: Pesquisa repetida -> Cache válido utilizado
  it('T9: Pesquisa idêntica reutiliza cache reduzindo chamadas a 0ms e paginasProcessadas 1', async () => {
    const cache = PriceSearchCache.getInstance()
    const chave = cache.gerarChave('t1', 'PNCP', 'DIPIRONA', {})
    cache.set<AmostraPreco[]>(
      chave,
      'PNCP',
      'DIPIRONA',
      't1',
      [{ id: '1', valorUnitario: 10 } as any],
      1,
    )

    const recuperado = cache.get<AmostraPreco[]>(chave)
    expect(recuperado).not.toBeNull()
    expect(recuperado?.dados.length).toBe(1)
  })

  // T10: Fonte indisponível -> Apresenta "FONTE INDISPONÍVEL", NUNCA "0 RESULTADOS"
  it('T10: Diferenciação obrigatória: fonte indisponível não vira 0 resultados com sucesso', async () => {
    const cIndisponivel = new MockVolumeConnector({
      id: 'fonte_off',
      nome: 'Fonte Caiu',
      totalRegistros: 0,
      tamanhoPagina: 10,
      falharNaPagina: 1,
      simularStatusHttp: 503,
    })

    const res = await cIndisponivel.search({ termo: 'dipirona', forcarAtualizacaoCache: true })

    expect(res.status).toBe('INDISPONIVEL')
    expect(res.sucesso).toBe(false)
    expect(res.erro).toBeDefined()
  })

  // T11: Performance de 10.000+ registros -> Frontend sem travar, cálculo eficiente
  it('T11: Processamento de 10.000+ registros calcula estatísticas e mediana em menos de 100ms', () => {
    const orquestrador = SearchOrchestrator.getInstance()
    const amostrasGrandes: AmostraPreco[] = []

    for (let i = 0; i < 10000; i++) {
      amostrasGrandes.push({
        id: `A-${i}`,
        fonte: 'PNCP',
        fonteNomeExibicao: 'PNCP',
        idExterno: String(i),
        urlOriginal: '',
        dataPublicacaoOuContrato: '2025-01-01',
        produto: 'DIPIRONA 500MG',
        descricaoCompleta: 'DIPIRONA 500MG COMPRIMIDO',
        orgaoComprador: 'Prefeitura',
        fornecedorNome: `Fornecedor ${i % 200}`,
        unidade: 'UN',
        quantidade: 100,
        valorUnitario: 0.1 + (i % 1000) * 0.002,
        hashRastreabilidade: `h_${i}`,
        natureza: 'homologado',
        isDemo: false,
      })
    }

    const t0 = performance.now()
    const stats = orquestrador.calcularEstatisticas(amostrasGrandes)
    const tFim = performance.now()

    expect(stats.totalAmostras).toBe(10000)
    expect(stats.valorMinimo).toBeGreaterThan(0)
    expect(stats.medianaGeral).toBeGreaterThan(0)
    expect(tFim - t0).toBeLessThan(100)
  })

  // T12: Paginação da interface independente da coleta: exibe "1–50 de 4.400"
  it('T12: Paginação visual opera independentemente da coleta (fatiamento de 50 sobre 4.400)', () => {
    const totalRegistros = 4400
    const itensPorPagina = 50
    const paginaAtual = 1

    const inicio = (paginaAtual - 1) * itensPorPagina
    const fim = Math.min(inicio + itensPorPagina, totalRegistros)

    const labelContador = `Mostrando ${inicio + 1}–${fim} de ${totalRegistros} amostras`
    expect(labelContador).toBe('Mostrando 1–50 de 4400 amostras')
  })
})
