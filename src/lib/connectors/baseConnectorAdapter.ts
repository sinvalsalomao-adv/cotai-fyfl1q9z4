/**
 * Base Adapter para Conectores de Preços
 * Fornece implementação robusta de:
 * - Ciclo de vida de consulta
 * - Circuit Breaker integrado
 * - Rate Limiting controlado
 * - Retries com Exponential Backoff + Jitter para 429/502/503/504 e Timeout (limite máximo, nunca infinito)
 * - Observabilidade completa (tempos, páginas, descartes, duplicidades)
 * - Preservação de páginas anteriores em caso de falha em páginas intermediárias (RF-014)
 * - Diferenciação estrita de "SEM RESULTADOS" vs "FONTE INDISPONÍVEL"
 */

import {
  IPriceConnectorAdapter,
  SourceMetadata,
  FailureStatus,
  ConnectorSearchParams,
  ConnectorPageResult,
  ConnectorSearchResult,
  AmostraPreco,
  PaginationInfo,
  ObservabilidadeFonte,
} from './types'
import { CircuitBreaker } from './circuitBreaker'
import { ConnectorRateLimiter } from './rateLimiter'
import { PriceSearchCache } from './cacheManager'

export abstract class BasePriceConnectorAdapter implements IPriceConnectorAdapter {
  public abstract readonly id: string
  public abstract readonly nome: string

  protected circuitBreaker: CircuitBreaker
  protected rateLimiter: ConnectorRateLimiter
  protected cache = PriceSearchCache.getInstance()

  // Configurações padrão de resiliência (podem ser sobrescritas por conector)
  protected maxRetries = 2
  protected retryDelayBaseMs = 400
  protected timeoutPorPaginaMs = 12000
  protected versaoConector = '2.0.0'

  constructor() {
    this.circuitBreaker = new CircuitBreaker('price_connector', {
      falhasParaAbrir: 3,
      tempoCooldownMs: 25000,
      sucessosParaFechar: 2,
    })
    this.rateLimiter = new ConnectorRateLimiter({
      requisicoesPorSegundo: 5,
      concorrenciaMaxima: 3,
    })
  }

  public abstract getSourceMetadata(): SourceMetadata

  public async healthCheck(): Promise<boolean> {
    if (this.circuitBreaker.isOpen()) return false
    return true
  }

  public getFailureStatus(): FailureStatus {
    const isCircuitOpen = this.circuitBreaker.isOpen()
    const ultimoErro = this.circuitBreaker.getUltimoErro()
    return {
      indisponivel: isCircuitOpen,
      motivo: ultimoErro.mensagem || undefined,
      statusHttp: ultimoErro.statusHttp || undefined,
      tempoCooldownRestanteMs: this.circuitBreaker.getTempoCooldownRestanteMs(),
      circuitOpen: isCircuitOpen,
    }
  }

  public hasNextPage(info: PaginationInfo): boolean {
    if (!info.temMaisPaginas) return false
    if (info.totalPaginasInformadoApi > 0 && info.paginaAtual >= info.totalPaginasInformadoApi) {
      return false
    }
    return true
  }

  public abstract normalize(rawItem: any, index: number, metadata?: any): AmostraPreco | null

  public abstract fetchPage(
    params: ConnectorSearchParams,
    pagina: number,
  ): Promise<ConnectorPageResult>

  /**
   * Execução resiliente de requisição de página com retries controlados
   */
  protected async fetchPageWithRetry(
    params: ConnectorSearchParams,
    pagina: number,
    executar: () => Promise<ConnectorPageResult>,
  ): Promise<ConnectorPageResult> {
    if (this.circuitBreaker.isOpen()) {
      return {
        sucesso: false,
        amostras: [],
        pagination: {
          paginaAtual: pagina,
          tamanhoPagina: params.tamanhoPagina || 25,
          totalRegistrosInformadoApi: 0,
          totalPaginasInformadoApi: 0,
          temMaisPaginas: false,
        },
        tempoMs: 0,
        statusHttp: 503,
        isIndisponivel: true,
        erro: `Circuit Breaker ABERTO para a fonte ${this.nome}. Cooldown em andamento (${Math.round(
          this.circuitBreaker.getTempoCooldownRestanteMs() / 1000,
        )}s restantes).`,
      }
    }

    let tentativa = 0
    let ultimoErro = ''
    let ultimoStatusHttp = 500
    let tempoInicio = performance.now()

    while (tentativa <= this.maxRetries) {
      tentativa++
      try {
        const resultado = await this.rateLimiter.execute(async () => {
          return await executar()
        })

        if (resultado.sucesso) {
          this.circuitBreaker.registrarSucesso()
          resultado.tentativasRealizadas = tentativa
          return resultado
        }

        ultimoErro = resultado.erro || 'Falha na resposta da fonte'
        ultimoStatusHttp = resultado.statusHttp || 500

        // Se for erro permanente (ex: 400 Bad Request, 401 Credencial inválida), não tenta de novo
        if (ultimoStatusHttp === 400 || ultimoStatusHttp === 401 || ultimoStatusHttp === 403) {
          this.circuitBreaker.registrarFalha(ultimoErro, ultimoStatusHttp)
          return resultado
        }

        // Se for 429 ou 5xx ou timeout, aguarda backoff com jitter antes da próxima tentativa
        if (tentativa <= this.maxRetries) {
          const jitter = Math.random() * 200
          const delay = Math.pow(2, tentativa - 1) * this.retryDelayBaseMs + jitter
          await new Promise((res) => setTimeout(res, delay))
        }
      } catch (err: any) {
        ultimoErro = err?.message || String(err)
        ultimoStatusHttp = err?.status || (err?.name === 'AbortError' ? 408 : 500)

        if (tentativa <= this.maxRetries) {
          const jitter = Math.random() * 200
          const delay = Math.pow(2, tentativa - 1) * this.retryDelayBaseMs + jitter
          await new Promise((res) => setTimeout(res, delay))
        }
      }
    }

    // Se esgotou retries sem sucesso
    this.circuitBreaker.registrarFalha(ultimoErro, ultimoStatusHttp)

    return {
      sucesso: false,
      amostras: [],
      pagination: {
        paginaAtual: pagina,
        tamanhoPagina: params.tamanhoPagina || 25,
        totalRegistrosInformadoApi: 0,
        totalPaginasInformadoApi: 0,
        temMaisPaginas: false,
      },
      tempoMs: Math.round(performance.now() - tempoInicio),
      statusHttp: ultimoStatusHttp,
      isIndisponivel: true,
      erro: ultimoErro,
      tentativasRealizadas: tentativa,
    }
  }

  /**
   * Orquestrador de coleta completa da fonte (loop de paginação completo no conector).
   * Sem limite arbitrário: se a fonte tem 44 páginas, processa as 44 páginas.
   * Preserva páginas anteriores se uma página intermediária falhar (RF-014).
   */
  public async search(
    params: ConnectorSearchParams,
    onProgress?: (novasAmostras: AmostraPreco[], info: PaginationInfo) => void,
  ): Promise<ConnectorSearchResult> {
    const t0 = performance.now()
    const observabilidade: ObservabilidadeFonte = {
      fonte: this.id,
      tempoTotalMs: 0,
      quantidadeInformadaApi: 0,
      quantidadeRecebidaBruta: 0,
      quantidadeProcessadaValida: 0,
      quantidadeEntregue: 0,
      quantidadeDescartadaAntiContaminacao: 0,
      quantidadeDuplicidadesInternas: 0,
      paginasProcessadas: 0,
      totalPaginasApi: 1,
      retriesExecutados: 0,
      statusHttpFinal: 200,
      timeoutsCount: 0,
      errosEncontrados: [],
      circuitBreakerAcionado: false,
      cacheHit: false,
    }

    // 1. Verificação de Cache (se não estiver forçando atualização)
    const tenantId = 'global'
    const chaveCache = this.cache.gerarChave(
      tenantId,
      this.id,
      params.termo,
      {
        uf: params.uf,
        periodoMeses: params.periodoMeses,
        precoMin: params.precoMin,
        precoMax: params.precoMax,
      },
      undefined,
      this.versaoConector,
    )

    if (!params.forcarAtualizacaoCache) {
      const entradaCache = this.cache.get<AmostraPreco[]>(chaveCache)
      if (entradaCache && entradaCache.dados && entradaCache.dados.length > 0) {
        observabilidade.cacheHit = true
        observabilidade.tempoTotalMs = Math.round(performance.now() - t0)
        observabilidade.quantidadeInformadaApi = entradaCache.quantidade
        observabilidade.quantidadeRecebidaBruta = entradaCache.quantidade
        observabilidade.quantidadeProcessadaValida = entradaCache.dados.length
        observabilidade.quantidadeEntregue = entradaCache.dados.length
        observabilidade.paginasProcessadas = 1

        if (onProgress) {
          onProgress(entradaCache.dados, {
            paginaAtual: 1,
            tamanhoPagina: entradaCache.dados.length,
            totalRegistrosInformadoApi: entradaCache.quantidade,
            totalPaginasInformadoApi: 1,
            temMaisPaginas: false,
          })
        }

        return {
          sucesso: true,
          fonte: this.id,
          fonteNomeExibicao: this.nome,
          amostras: entradaCache.dados,
          totalAmostrasRecuperadas: entradaCache.dados.length,
          totalRegistrosInformadosApi: entradaCache.quantidade,
          paginasProcessadas: 1,
          tempoMs: observabilidade.tempoTotalMs,
          status: 'CONCLUIDA',
          observabilidade,
        }
      }
    }

    // 2. Coleta completa página por página
    const todasAmostras: AmostraPreco[] = []
    const chavesDedup = new Set<string>()
    let paginaAtual = params.pagina || 1
    let temMais = true
    let totalPaginasApi = 1
    let totalRegistrosInformadoApi = 0
    let falhaIntermediaria: string | null = null
    let primeiraAmostraTempoRegistrado = false

    while (temMais && !params.signal?.aborted) {
      const pageResult = await this.fetchPage(params, paginaAtual)
      observabilidade.paginasProcessadas++
      if (pageResult.aviso && pageResult.aviso.startsWith('itens_fila_pendente:')) {
        const nFila = parseInt(pageResult.aviso.split(':')[1], 10) || 0
        if (nFila > 0) {
          observabilidade.itens_fila_pendente = (observabilidade.itens_fila_pendente || 0) + nFila
        }
      }
      observabilidade.statusHttpFinal = pageResult.statusHttp || 200
      if (pageResult.tentativasRealizadas && pageResult.tentativasRealizadas > 1) {
        observabilidade.retriesExecutados += pageResult.tentativasRealizadas - 1
      }

      if (!pageResult.sucesso) {
        observabilidade.errosEncontrados.push(
          `Página ${paginaAtual}: ${pageResult.erro || 'Falha de comunicação'}`,
        )
        if (pageResult.isIndisponivel) {
          observabilidade.circuitBreakerAcionado = this.circuitBreaker.isOpen()
        }
        falhaIntermediaria = pageResult.erro || 'Falha em página intermediária'
        // Resiliência (RF-014): Não aborta as páginas já coletadas anteriormente!
        break
      }

      totalPaginasApi = Math.max(
        totalPaginasApi,
        pageResult.pagination.totalPaginasInformadoApi || 1,
      )
      totalRegistrosInformadoApi = Math.max(
        totalRegistrosInformadoApi,
        pageResult.pagination.totalRegistrosInformadoApi || 0,
      )
      observabilidade.quantidadeRecebidaBruta += pageResult.amostras.length

      // Deduplicação estrita preservando fornecedores distintos e órgãos diferentes
      const novasAmostrasDestaPagina: AmostraPreco[] = []
      for (const amostra of pageResult.amostras) {
        const chaveCanonica = `${amostra.fonte}#${amostra.idExterno}#${amostra.orgaoComprador}#${amostra.fornecedorNome}#${amostra.valorUnitario.toFixed(4)}`
        if (!chavesDedup.has(chaveCanonica)) {
          chavesDedup.add(chaveCanonica)
          todasAmostras.push(amostra)
          novasAmostrasDestaPagina.push(amostra)
        } else {
          observabilidade.quantidadeDuplicidadesInternas++
        }
      }

      if (!primeiraAmostraTempoRegistrado && todasAmostras.length > 0) {
        observabilidade.tempoAtePrimeiroResultadoMs = Math.round(performance.now() - t0)
        primeiraAmostraTempoRegistrado = true
      }

      // Notifica progresso em tempo real para a camada superior (streaming progressivo)
      if (onProgress && novasAmostrasDestaPagina.length > 0) {
        onProgress(novasAmostrasDestaPagina, pageResult.pagination)
      }

      // Verifica condição de parada baseada na resposta da própria API
      temMais = this.hasNextPage(pageResult.pagination)
      if (temMais) {
        paginaAtual++
      }
    }

    observabilidade.tempoTotalMs = Math.round(performance.now() - t0)
    observabilidade.totalPaginasApi = totalPaginasApi
    observabilidade.quantidadeInformadaApi = Math.max(
      totalRegistrosInformadoApi,
      todasAmostras.length,
    )
    observabilidade.quantidadeProcessadaValida = todasAmostras.length
    observabilidade.quantidadeEntregue = todasAmostras.length

    // Salva no cache se obteve amostras com sucesso
    if (todasAmostras.length > 0) {
      this.cache.set(
        chaveCache,
        this.id,
        params.termo,
        tenantId,
        todasAmostras,
        observabilidade.quantidadeInformadaApi,
        undefined,
        10 * 60 * 1000,
        this.versaoConector,
      )
    }

    // Determina o estado final (RF-015)
    let statusFinal: 'CONCLUIDA' | 'CONCLUIDA_PARCIAL' | 'FALHA_TOTAL' | 'INDISPONIVEL' =
      'CONCLUIDA'
    if (todasAmostras.length > 0 && falhaIntermediaria) {
      statusFinal = 'CONCLUIDA_PARCIAL'
    } else if (todasAmostras.length === 0 && falhaIntermediaria) {
      statusFinal = this.circuitBreaker.isOpen() ? 'INDISPONIVEL' : 'FALHA_TOTAL'
    } else if (todasAmostras.length === 0 && observabilidade.errosEncontrados.length > 0) {
      statusFinal = 'FALHA_TOTAL'
    }

    return {
      sucesso: todasAmostras.length > 0 || (statusFinal === 'CONCLUIDA' && !falhaIntermediaria),
      fonte: this.id,
      fonteNomeExibicao: this.nome,
      amostras: todasAmostras,
      totalAmostrasRecuperadas: todasAmostras.length,
      totalRegistrosInformadosApi: observabilidade.quantidadeInformadaApi,
      paginasProcessadas: observabilidade.paginasProcessadas,
      tempoMs: observabilidade.tempoTotalMs,
      status: statusFinal,
      erro: falhaIntermediaria || undefined,
      observabilidade,
    }
  }
}
