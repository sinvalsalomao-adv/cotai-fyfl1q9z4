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
  PncpContinuation,
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
  protected maxRetries = 1
  protected retryDelayBaseMs = 300
  protected timeoutPorPaginaMs = 8000
  protected versaoConector = '2.3.0'

  constructor() {
    this.circuitBreaker = new CircuitBreaker('price_connector', {
      falhasParaAbrir: 3,
      tempoCooldownMs: 20000,
      sucessosParaFechar: 2,
    })
    this.rateLimiter = new ConnectorRateLimiter({
      requisicoesPorSegundo: 10,
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
    const verificarCancelamento = () => {
      if (params.signal?.aborted)
        throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
    }
    const circuitoAberto = (): ConnectorPageResult => ({
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
      circuitOpen: true,
      retryAtMs: Date.now() + this.circuitBreaker.getTempoCooldownRestanteMs(),
      erro: `Circuit Breaker ABERTO para a fonte ${this.nome}. Cooldown em andamento (${Math.round(
        this.circuitBreaker.getTempoCooldownRestanteMs() / 1000,
      )}s restantes).`,
    })
    const aguardar = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        verificarCancelamento()
        const cancelar = () => {
          clearTimeout(timer)
          reject(new DOMException('Busca cancelada pelo usuário.', 'AbortError'))
        }
        const timer = setTimeout(() => {
          params.signal?.removeEventListener('abort', cancelar)
          resolve()
        }, ms)
        params.signal?.addEventListener('abort', cancelar, { once: true })
      })
    verificarCancelamento()
    if (this.circuitBreaker.isOpen()) return circuitoAberto()

    let tentativa = 0
    let ultimoErro = ''
    let ultimoStatusHttp = 500
    let tempoInicio = performance.now()
    let isErroUpstream = false
    let retryAtMs: number | undefined

    const verificarSeErroUpstream = (status: number, erroMsg: string): boolean => {
      // Falha real de upstream: 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout, 429 persistente, timeouts de rede
      if (status === 502 || status === 503 || status === 504 || status === 429) {
        return true
      }
      const msg = (erroMsg || '').toLowerCase()
      if (
        msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('connection refused') ||
        msg.includes('failed to fetch') ||
        msg.includes('networkerror') ||
        msg.includes('etimedout') ||
        msg.includes('timeout de rede')
      ) {
        return true
      }
      return false
    }

    while (tentativa <= this.maxRetries) {
      verificarCancelamento()
      if (this.circuitBreaker.isOpen()) return circuitoAberto()
      tentativa++
      try {
        const resultado = await this.rateLimiter.execute(async () => {
          verificarCancelamento()
          if (this.circuitBreaker.isOpen()) return circuitoAberto()
          return await executar()
        })
        verificarCancelamento()
        if (resultado.circuitOpen) return resultado

        if (resultado.sucesso) {
          this.circuitBreaker.registrarSucesso()
          resultado.tentativasRealizadas = tentativa
          return resultado
        }

        ultimoErro = resultado.erro || 'Falha na resposta da fonte'
        ultimoStatusHttp = resultado.statusHttp || 500
        retryAtMs = resultado.retryAtMs
        isErroUpstream =
          Boolean(resultado.isIndisponivel) || verificarSeErroUpstream(ultimoStatusHttp, ultimoErro)

        // Se for erro permanente de cliente (ex: 400 Bad Request, 401 Credencial inválida), não tenta de novo e não abre circuito por indisponibilidade da fonte
        if (ultimoStatusHttp === 400 || ultimoStatusHttp === 401 || ultimoStatusHttp === 403) {
          return resultado
        }
        // A structured throttle is terminal for this attempt; keep the work
        // pending rather than repeating the same page after a short backoff.
        if (ultimoStatusHttp === 429 || (ultimoStatusHttp === 503 && retryAtMs !== undefined)) break

        // Se for 429 ou 5xx ou timeout, aguarda backoff com jitter antes da próxima tentativa
        if (tentativa <= this.maxRetries) {
          const jitter = Math.random() * 200
          const delay = Math.pow(2, tentativa - 1) * this.retryDelayBaseMs + jitter
          await aguardar(delay)
        }
      } catch (err: any) {
        verificarCancelamento()
        ultimoErro = err?.message || String(err)
        ultimoStatusHttp = err?.status || (err?.name === 'AbortError' ? 408 : 500)
        retryAtMs = err?.retryAtMs
        isErroUpstream = verificarSeErroUpstream(ultimoStatusHttp, ultimoErro)
        if (ultimoStatusHttp === 429 || (ultimoStatusHttp === 503 && retryAtMs !== undefined)) break

        if (tentativa <= this.maxRetries) {
          const jitter = Math.random() * 200
          const delay = Math.pow(2, tentativa - 1) * this.retryDelayBaseMs + jitter
          await aguardar(delay)
        }
      }
    }

    // Se esgotou retries sem sucesso: registrarFalha SOMENTE se for falha de upstream real
    if (isErroUpstream) {
      this.circuitBreaker.registrarFalha(ultimoErro, ultimoStatusHttp)
    }

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
      retryAtMs,
      circuitOpen: this.circuitBreaker.isOpen(),
      isIndisponivel: isErroUpstream,
      erro: ultimoErro,
      tentativasRealizadas: tentativa,
    }
  }

  /**
   * Orquestrador de coleta retomável da fonte.
   * Uma fonte com 44 páginas preserva continuação entre janelas até processar as 44.
   * Preserva páginas anteriores se uma página intermediária falhar (RF-014).
   */
  public async search(
    params: ConnectorSearchParams,
    onProgress?: (novasAmostras: AmostraPreco[], info: PaginationInfo) => void,
  ): Promise<ConnectorSearchResult> {
    const t0 = performance.now()
    const observabilidade: ObservabilidadeFonte & {
      metadata?: Record<string, any>
      avisos?: string[]
    } = {
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

    // 2. Coleta retomável com janela adaptativa e streaming progressivo
    // A primeira página é consultada imediatamente para entrega dos primeiros resultados em < 3s.
    // As páginas subsequentes continuam a busca até concluir o escopo definido (padrão: até 5 páginas por ciclo de busca,
    // expansível via params.paginacaoTotal / limitePaginas ou sob demanda do usuário).
    const todasAmostras: AmostraPreco[] = []
    const chavesDedup = new Set<string>()
    const paginaInicial = Math.max(1, Math.trunc(params.pagina || 1))
    let paginaAtual = paginaInicial
    let temMais = true
    let totalPaginasApi = 1
    let totalRegistrosInformadoApi = 0
    let falhaIntermediaria: string | null = null
    let primeiraAmostraTempoRegistrado = false
    let coberturaParcial = false
    const paginacaoConfirmada = new Map<number, PaginationInfo>()
    const registrarContextoPagina = (resultado: ConnectorPageResult) => {
      const metadata = (resultado as ConnectorPageResult & { metadata?: Record<string, any> })
        .metadata
      let pendentesPersistidos: number | undefined
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        const agregado = (observabilidade.metadata ||= {})
        coberturaParcial ||= metadata.cobertura_parcial === true
        agregado.cobertura_parcial = coberturaParcial
        for (const campo of [
          'itens_pendentes',
          'itens_fila_pendente',
          'itens_nao_enfileirados',
          'itens_congelados',
        ]) {
          const valor = metadata[campo]
          if (typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0) {
            agregado[campo] = (agregado[campo] || 0) + valor
            if (campo === 'itens_fila_pendente') pendentesPersistidos = valor
          }
        }
        if (typeof metadata.fila_persistida === 'boolean') {
          agregado.fila_persistida = agregado.fila_persistida !== false && metadata.fila_persistida
        }
        if (typeof metadata.erro_fila === 'string' && metadata.erro_fila)
          agregado.erro_fila ||= metadata.erro_fila
        else if (metadata.erro_fila === null && agregado.erro_fila === undefined)
          agregado.erro_fila = null
      }
      if (resultado.aviso) {
        ;(observabilidade.avisos ||= []).push(resultado.aviso)
        if (
          pendentesPersistidos === undefined &&
          resultado.aviso.startsWith('itens_fila_pendente:')
        ) {
          pendentesPersistidos = parseInt(resultado.aviso.split(':')[1], 10) || 0
        }
      }
      if (pendentesPersistidos !== undefined && pendentesPersistidos > 0) {
        observabilidade.itens_fila_pendente =
          (observabilidade.itens_fila_pendente || 0) + pendentesPersistidos
      }
    }

    // Paginação paralela com concorrência máxima 3. Uma janela limitada nunca
    // certifica conclusão do universo; ela devolve a continuação exata.
    const maxPaginasPorBusca = Math.max(
      1,
      Math.trunc(
        params.limitePaginas && params.limitePaginas > 0
          ? params.limitePaginas
          : params.paginacaoTotal
            ? 20
            : 5,
      ),
    )

    let paginasColetadas = 0

    // Coleta a primeira página para saber o total real de páginas e entregar os primeiros resultados rapidamente
    if (temMais && paginasColetadas < maxPaginasPorBusca && !params.signal?.aborted) {
      const pageResult = await this.fetchPage(params, paginaAtual)
      paginasColetadas++
      observabilidade.paginasProcessadas++
      registrarContextoPagina(pageResult)
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
        falhaIntermediaria = pageResult.erro || 'Falha em página inicial'
      } else {
        paginacaoConfirmada.set(paginaAtual, pageResult.pagination)
        totalPaginasApi = Math.max(
          totalPaginasApi,
          pageResult.pagination.totalPaginasInformadoApi || 1,
        )
        totalRegistrosInformadoApi = Math.max(
          totalRegistrosInformadoApi,
          pageResult.pagination.totalRegistrosInformadoApi || 0,
        )
        observabilidade.quantidadeRecebidaBruta += pageResult.amostras.length

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

        if (onProgress && novasAmostrasDestaPagina.length > 0) {
          onProgress(novasAmostrasDestaPagina, pageResult.pagination)
        }

        temMais = this.hasNextPage(pageResult.pagination)
        paginaAtual++
      }
    }

    // Busca as páginas restantes em paralelo com concorrência máxima 3
    if (!falhaIntermediaria && temMais && totalPaginasApi > 1 && !params.signal?.aborted) {
      // `limitePaginas` is a window size, never an absolute page number. A
      // resumed turn starting at 21 with a 20-page window therefore ends at 40.
      const paginaFinalAlvo = Math.min(totalPaginasApi, paginaInicial + maxPaginasPorBusca - 1)
      const paginasRestantes: number[] = []
      for (let p = paginaAtual; p <= paginaFinalAlvo; p++) {
        paginasRestantes.push(p)
      }

      const CONCORRENCIA_PAGINAS = 3
      for (let i = 0; i < paginasRestantes.length; i += CONCORRENCIA_PAGINAS) {
        if (params.signal?.aborted) break
        const lotePaginas = paginasRestantes.slice(i, i + CONCORRENCIA_PAGINAS)

        const resultadosLote = await Promise.allSettled(
          lotePaginas.map((numPagina) => this.fetchPage(params, numPagina)),
        )

        for (let j = 0; j < resultadosLote.length; j++) {
          const numPagina = lotePaginas[j]
          const res = resultadosLote[j]
          paginasColetadas++
          observabilidade.paginasProcessadas++

          if (res.status === 'rejected') {
            observabilidade.errosEncontrados.push(
              `Página ${numPagina}: ${res.reason?.message || 'Falha de comunicação'}`,
            )
            falhaIntermediaria = res.reason?.message || 'Falha na página'
            continue
          }

          const pageResult = res.value
          registrarContextoPagina(pageResult)
          observabilidade.statusHttpFinal = pageResult.statusHttp || 200
          if (pageResult.tentativasRealizadas && pageResult.tentativasRealizadas > 1) {
            observabilidade.retriesExecutados += pageResult.tentativasRealizadas - 1
          }

          if (!pageResult.sucesso) {
            observabilidade.errosEncontrados.push(
              `Página ${numPagina}: ${pageResult.erro || 'Falha de comunicação'}`,
            )
            if (pageResult.isIndisponivel) {
              observabilidade.circuitBreakerAcionado = this.circuitBreaker.isOpen()
            }
            falhaIntermediaria = pageResult.erro || 'Falha em página intermediária'
            // Resiliência (RF-014): Preserva as páginas já coletadas anteriormente!
            continue
          }

          paginacaoConfirmada.set(numPagina, pageResult.pagination)
          totalPaginasApi = Math.max(
            totalPaginasApi,
            pageResult.pagination.totalPaginasInformadoApi || 1,
          )
          totalRegistrosInformadoApi = Math.max(
            totalRegistrosInformadoApi,
            pageResult.pagination.totalRegistrosInformadoApi || 0,
          )

          observabilidade.quantidadeRecebidaBruta += pageResult.amostras.length
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

          if (onProgress && novasAmostrasDestaPagina.length > 0) {
            onProgress(novasAmostrasDestaPagina, pageResult.pagination)
          }
        }
      }
    }

    // Only a contiguous prefix of the requested window is eligible to advance.
    // This keeps a failed page retryable even when later pages from the same
    // concurrent batch happened to finish successfully.
    const paginasConfirmadasOrdenadas = [...paginacaoConfirmada.keys()].sort((a, b) => a - b)
    let ultimaPaginaContigua = paginaInicial - 1
    for (const pagina of paginasConfirmadasOrdenadas) {
      if (pagina < paginaInicial) continue
      if (pagina !== ultimaPaginaContigua + 1) break
      ultimaPaginaContigua = pagina
    }
    const proximaPagina = ultimaPaginaContigua + 1
    const temPaginasOficiaisPendentes = proximaPagina <= totalPaginasApi
    let continuacaoPncp: PncpContinuation | undefined
    if (temPaginasOficiaisPendentes) {
      coberturaParcial = true
      const paginaAnterior = paginacaoConfirmada.get(proximaPagina - 1)
      if (this.id.toLowerCase() === 'pncp') {
        continuacaoPncp = {
          paginaAtual: Math.max(paginaInicial - 1, proximaPagina - 1),
          proximaPagina,
          totalPaginas: totalPaginasApi,
          proximoCursor: paginaAnterior?.proximoCursor || `pncp-page-${proximaPagina}`,
        }
      }
      const metadata = (observabilidade.metadata ||= {})
      metadata.cobertura_parcial = true
      metadata.paginas_pendentes = totalPaginasApi - proximaPagina + 1
      metadata.proxima_pagina = proximaPagina
      if (continuacaoPncp) metadata.continuacao_pncp = continuacaoPncp
    }

    observabilidade.tempoTotalMs = Math.round(performance.now() - t0)
    observabilidade.totalPaginasApi = totalPaginasApi
    observabilidade.quantidadeInformadaApi = Math.max(
      totalRegistrosInformadoApi,
      todasAmostras.length,
    )
    observabilidade.quantidadeProcessadaValida = todasAmostras.length
    observabilidade.quantidadeEntregue = todasAmostras.length

    // Determina o estado antes do cache: arrays não preservam pendências.
    let statusFinal: 'CONCLUIDA' | 'CONCLUIDA_PARCIAL' | 'FALHA_TOTAL' | 'INDISPONIVEL' =
      'CONCLUIDA'
    if (todasAmostras.length > 0 && falhaIntermediaria) {
      statusFinal = 'CONCLUIDA_PARCIAL'
    } else if (todasAmostras.length === 0 && falhaIntermediaria) {
      statusFinal = this.circuitBreaker.isOpen() ? 'INDISPONIVEL' : 'FALHA_TOTAL'
    } else if (coberturaParcial) {
      statusFinal = 'CONCLUIDA_PARCIAL'
    } else if (todasAmostras.length === 0 && observabilidade.errosEncontrados.length > 0) {
      statusFinal = 'FALHA_TOTAL'
    }

    if (
      statusFinal === 'CONCLUIDA' &&
      paginaInicial === 1 &&
      todasAmostras.length > 0 &&
      !params.signal?.aborted
    ) {
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

    return {
      sucesso:
        todasAmostras.length > 0 ||
        ((statusFinal === 'CONCLUIDA' || statusFinal === 'CONCLUIDA_PARCIAL') &&
          !falhaIntermediaria),
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
      continuacaoPncp,
    }
  }
}
