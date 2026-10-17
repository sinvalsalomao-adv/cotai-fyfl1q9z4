/**
 * Search Orchestrator (Motor Centralizado de Pesquisa de Preços)
 *
 * Responsabilidades:
 * - Registro e gerenciamento dinâmico de adaptadores de conectores
 * - Consulta a todas as fontes habilitadas em paralelo (RF-001..005)
 * - Isolamento total de falhas parciais (RF-010): timeout ou 5xx em uma fonte não interrompe as demais
 * - Entrega de resultados parciais progressivos em streaming (RF-019..021)
 * - Observabilidade completa por pesquisa e por fonte (RF-016..018)
 * - Estados da busca: Em processamento / Concluída / Concluída parcialmente / Falha total (RF-015)
 * - Deduplicação canônica inteligente preservando fornecedores distintos e órgãos reais
 * - Recalculo de estatísticas (mínimo, máximo, média, mediana) em tempo real
 */

import {
  IPriceConnectorAdapter,
  ConnectorSearchParams,
  ConnectorSearchResult,
  AmostraPreco,
  ObservabilidadeFonte,
  PaginationInfo,
} from './types'
import { PncpConnectorAdapter } from './pncpConnectorAdapter'
import { ComprasGovConnectorAdapter } from './comprasGovConnectorAdapter'
import { PriceIndexService } from '../priceIndexService'
import type { PncpImmediateTurn } from '../priceIndexService'

export type SearchState =
  | 'EM_PROCESSAMENTO'
  | 'CONCLUIDA'
  | 'CONCLUIDA_PARCIALMENTE'
  | 'FALHA_TOTAL'

export interface EstatisticasOrquestrador {
  totalAmostras: number
  valorMinimo: number
  valorMaximo: number
  mediaGeral: number
  medianaGeral: number
}

export interface RelatorioObservabilidadePesquisa {
  termo: string
  usuarioTenantId: string
  timestampInicio: number
  tempoTotalMs: number
  tempoAtePrimeiroResultadoMs?: number
  estadoFinal: SearchState
  fontesConsultadas: string[]
  fontesComSucesso: string[]
  fontesComFalha: string[]
  totalAmostrasInformadasApis: number
  totalAmostrasBrutasRecebidas: number
  totalAmostrasProcessadasValidas: number
  totalAmostrasDescartadas: number
  totalDuplicidadesRemovidas: number
  descartesSemPrecoUnitario?: number
  totalAmostrasEntregues: number
  detalhePorFonte: Record<
    string,
    ObservabilidadeFonte & { status?: ConnectorSearchResult['status']; aviso?: string }
  >
}

export interface OrchestratorSearchResult {
  estado: SearchState
  amostras: AmostraPreco[]
  estatisticas: EstatisticasOrquestrador
  observabilidade: RelatorioObservabilidadePesquisa
  fontesConsultadas: string[]
  fontesComSucesso: string[]
  fontesComFalha: string[]
  errosPorFonte: Record<string, string>
  avisosPorFonte: Record<string, string>
}

export class SearchOrchestrator {
  private static instance: SearchOrchestrator
  private conectores = new Map<string, IPriceConnectorAdapter>()

  public constructor(conectoresCustom?: IPriceConnectorAdapter[]) {
    if (conectoresCustom && conectoresCustom.length > 0) {
      for (const c of conectoresCustom) {
        this.registrarConector(c)
      }
    } else {
      this.registrarConectoresPadrao()
    }
  }

  public static getInstance(): SearchOrchestrator {
    if (!SearchOrchestrator.instance) {
      SearchOrchestrator.instance = new SearchOrchestrator()
    }
    return SearchOrchestrator.instance
  }

  private registrarConectoresPadrao(): void {
    // Diretriz permanente: manter SOMENTE as fontes PNCP e Compras.gov.br
    this.registrarConector(new PncpConnectorAdapter())
    this.registrarConector(new ComprasGovConnectorAdapter())
  }

  public registrarConector(conector: IPriceConnectorAdapter): void {
    this.conectores.set(conector.id.toLowerCase(), conector)
  }

  public removerConector(id: string): void {
    this.conectores.delete(id.toLowerCase())
  }

  public getConector(id: string): IPriceConnectorAdapter | undefined {
    return this.conectores.get(id.toLowerCase())
  }

  public listarConectores(): Array<{
    id: string
    nome: string
    metadata: ReturnType<IPriceConnectorAdapter['getSourceMetadata']>
    failureStatus: ReturnType<IPriceConnectorAdapter['getFailureStatus']>
  }> {
    return Array.from(this.conectores.values()).map((c) => ({
      id: c.id,
      nome: c.nome,
      metadata: c.getSourceMetadata(),
      failureStatus: c.getFailureStatus(),
    }))
  }

  /**
   * Identifica quais conectores devem ser consultados com base no filtro e regras de domínio
   */
  public resolverConectoresParaBusca(
    fonteSolicitada?: string,
    termo?: string,
  ): IPriceConnectorAdapter[] {
    const fonteNorm = (fonteSolicitada || 'todas').toLowerCase().trim()
    const termoNorm = (termo || '').toLowerCase()

    if (fonteNorm === 'todas') {
      return Array.from(this.conectores.values())
    }

    const selecionados: IPriceConnectorAdapter[] = []

    for (const [id, conector] of this.conectores.entries()) {
      if (
        (id === 'pncp' && (fonteNorm.includes('pncp') || fonteNorm === 'pncp')) ||
        (id === 'compras_gov' &&
          (fonteNorm.includes('compras_gov') ||
            fonteNorm.includes('compras.gov') ||
            fonteNorm.includes('comprasgov') ||
            fonteNorm.includes('catmat')))
      ) {
        selecionados.push(conector)
      }
    }

    // Se nada coincidiu, consulta todos os habilitados
    return selecionados.length > 0 ? selecionados : Array.from(this.conectores.values())
  }

  /**
   * Executa a pesquisa paralela e progressiva em todas as fontes
   */
  public async search(
    params: ConnectorSearchParams,
    opcoes?: {
      usuarioTenantId?: string
      fonteSolicitada?: string
      onPncpTurn?: (turno: PncpImmediateTurn) => void
      onProgress?: (resultadoParcial: {
        amostrasAcumuladas: AmostraPreco[]
        novasAmostrasFonte: AmostraPreco[]
        fonteId: string
        estatisticasAtuais: EstatisticasOrquestrador
        observabilidadeParcial: Partial<RelatorioObservabilidadePesquisa>
      }) => void
    },
  ): Promise<OrchestratorSearchResult> {
    return this.executarPesquisa(params, opcoes)
  }

  public async executarPesquisa(
    params: ConnectorSearchParams,
    opcoes?: {
      usuarioTenantId?: string
      fonteSolicitada?: string
      onPncpTurn?: (turno: PncpImmediateTurn) => void
      onProgress?: (resultadoParcial: {
        amostrasAcumuladas: AmostraPreco[]
        novasAmostrasFonte: AmostraPreco[]
        fonteId: string
        estatisticasAtuais: EstatisticasOrquestrador
        observabilidadeParcial: Partial<RelatorioObservabilidadePesquisa>
      }) => void
    },
  ): Promise<OrchestratorSearchResult> {
    const tInicio = performance.now()
    const tenantId = opcoes?.usuarioTenantId || 'global'
    const conectoresAtivos = this.resolverConectoresParaBusca(opcoes?.fonteSolicitada, params.termo)
      .filter(conector => !params.somenteContinuacaoCompras || conector.id === 'compras_gov')

    const relatorio: RelatorioObservabilidadePesquisa = {
      termo: params.termo,
      usuarioTenantId: tenantId,
      timestampInicio: Date.now(),
      tempoTotalMs: 0,
      estadoFinal: 'EM_PROCESSAMENTO',
      fontesConsultadas: conectoresAtivos.map((c) => c.id),
      fontesComSucesso: [],
      fontesComFalha: [],
      totalAmostrasInformadasApis: 0,
      totalAmostrasBrutasRecebidas: 0,
      totalAmostrasProcessadasValidas: 0,
      totalAmostrasDescartadas: 0,
      totalDuplicidadesRemovidas: 0,
      descartesSemPrecoUnitario: 0,
      totalAmostrasEntregues: 0,
      detalhePorFonte: {},
    }

    const precosAcumulados: AmostraPreco[] = []
    const chavesDedupGlobal = new Set<string>()
    const errosPorFonte: Record<string, string> = {}
    const avisosPorFonte: Record<string, string> = {}
    let tempoPrimeiroResultado: number | undefined

    // Se o sinal já está abortado antes de iniciar a busca externa, interrompe
    if (params.signal?.aborted) {
      throw new DOMException('Busca abortada pelo usuário.', 'AbortError')
    }

    const incorporarAmostras = (fonteId: string, novasAmostras: AmostraPreco[]) => {
      if (params.signal?.aborted) return
      // Callback de streaming progressivo por página (RF-019..021)
      const amostrasInseridasDesteLote: AmostraPreco[] = []
      for (const item of novasAmostras) {
        // Diretiva: "O preço unitário de todos os itens tem que aparecer. Se não houver preços, não deve constar."
        if (
          typeof item.valorUnitario !== 'number' ||
          isNaN(item.valorUnitario) ||
          item.valorUnitario <= 0
        ) {
          relatorio.descartesSemPrecoUnitario = (relatorio.descartesSemPrecoUnitario || 0) + 1
          relatorio.totalAmostrasDescartadas++
          continue
        }

        const chaveGlobal = `${item.fonte}#${item.idExterno}#${item.orgaoComprador}#${item.fornecedorNome}#${item.valorUnitario.toFixed(4)}`
        if (!chavesDedupGlobal.has(chaveGlobal)) {
          chavesDedupGlobal.add(chaveGlobal)
          precosAcumulados.push(item)
          amostrasInseridasDesteLote.push(item)
        } else {
          relatorio.totalDuplicidadesRemovidas++
        }
      }

      if (!tempoPrimeiroResultado && precosAcumulados.length > 0) {
        tempoPrimeiroResultado = Math.round(performance.now() - tInicio)
        relatorio.tempoAtePrimeiroResultadoMs = tempoPrimeiroResultado
      }

      if (opcoes?.onProgress && amostrasInseridasDesteLote.length > 0) {
        const estatisticasAtuais = this.calcularEstatisticas(precosAcumulados)
        opcoes.onProgress({
          amostrasAcumuladas: [...precosAcumulados],
          novasAmostrasFonte: amostrasInseridasDesteLote,
          fonteId: fonteId,
          estatisticasAtuais,
          observabilidadeParcial: {
            totalAmostrasEntregues: precosAcumulados.length,
            tempoTotalMs: Math.round(performance.now() - tInicio),
          },
        })
      }
        
    }

    // Starts alongside live providers; never waits for an index/cache prerequisite.
    // This is one PNCP turn. A completed AMBAS row does not certify both sources.
    const turnoImediato = conectoresAtivos.some((conector) => conector.id.toLowerCase() === 'pncp')
      ? (async () => {
        // A single budget includes task lookup/registration AND processing. It is
        // separate from Compras' 20s turn; registration cannot bypass this bound.
        const deadlineAtMs = Date.now() + 25000
        const controller = new AbortController()
        let stage: 'register' | 'process' = 'register'
        const abortar = () => controller.abort()
        let rejeitarInterrupcao!: () => void
        const interrompido = new Promise<never>((_resolve, reject) => {
          rejeitarInterrupcao = () => reject(new DOMException('Turno PNCP interrompido.', 'AbortError'))
        })
        controller.signal.addEventListener('abort', rejeitarInterrupcao, { once: true })
        params.signal?.addEventListener('abort', abortar, { once: true })
        const timeout = setTimeout(abortar, Math.max(0, deadlineAtMs - Date.now()))
        const verificarAtivo = () => {
          if (params.signal?.aborted || controller.signal.aborted || Date.now() >= deadlineAtMs) {
            throw new DOMException('Turno PNCP interrompido.', 'AbortError')
          }
        }
        const executar = async () => {
          verificarAtivo()
          const tarefa = await PriceIndexService.registrarTarefaAtualizacao(params.termo, 'AMBAS', params.uf,
            { signal: controller.signal, deadlineAtMs })
          verificarAtivo()
          if (tarefa.status === 'failed') {
            avisosPorFonte.pncp = 'Tarefa PNCP falhou; trabalho preservado sem reabrir tentativas esgotadas.'
            return null
          }
          stage = 'process'
          const turno = await PriceIndexService.processarTarefaImediata(tarefa.id,
            { signal: controller.signal, deadlineAtMs })
          verificarAtivo()
          return turno
        }
        try {
          // Also settle when a transport ignores abort. The guarded execution
          // cannot start a later stage or publish late samples after expiry.
          const turno = await Promise.race([executar(), interrompido])
          verificarAtivo()
          if (!turno) return
          incorporarAmostras('pncp', turno.amostras || [])
          // The consumer owns any detached continuation. Never await it inside
          // this first 25s budget or rediscover/reregister for subsequent turns.
          opcoes?.onPncpTurn?.(turno)
          if (turno.status !== 'completed' || turno.cobertura_parcial || turno.amostras_resposta_parcial) {
            avisosPorFonte.pncp = turno.aviso || 'Turno PNCP parcial; trabalho restante preservado na fila.'
          }
        } catch (error: unknown) {
          if (!params.signal?.aborted) {
            // Log only bounded class/status metadata; error messages and payloads
            // may contain query text, credentials or an upstream response body.
            const failure = error as { name?: unknown; status?: unknown } | null
            const name = typeof failure?.name === 'string' ? failure.name : ''
            const errorName = /^(?:Error|TypeError|SyntaxError|RangeError|ReferenceError|URIError|EvalError|AbortError|TimeoutError)$/.test(name)
              ? name : /^ClientResponseError(?: \d{1,3})?$/.test(name) ? 'ClientResponseError' : 'UnknownError'
            const status = typeof failure?.status === 'number' && Number.isInteger(failure.status)
              && failure.status >= 0 && failure.status <= 599 ? failure.status : undefined
            console.warn('[ORCHESTRATOR-PNCP:TURN_FAILED] ' + JSON.stringify({ stage, errorName, status }))
            avisosPorFonte.pncp = Date.now() >= deadlineAtMs
              ? 'Prazo de 25 segundos do turno PNCP atingido; resultados ao vivo preservados, conclusão não confirmada.'
              : 'Turno imediato PNCP não confirmado; resultados ao vivo preservados.'
          }
        } finally {
          clearTimeout(timeout)
          params.signal?.removeEventListener('abort', abortar)
          controller.signal.removeEventListener('abort', rejeitarInterrupcao)
          controller.abort()
        }
      })()
      : Promise.resolve()

    // CORREÇÃO 7: Log estruturado de diagnóstico por pesquisa (sem segredos/tokens)
    console.log('[ORCHESTRATOR-SEARCH:START]', {
      termo: params.termo,
      uf: params.uf || 'TODAS',
      periodoMeses: params.periodoMeses || null,
      fontesHabilitadas: conectoresAtivos.map((c) => c.id),
      pagina: params.pagina || 1,
      tamPagina: params.tamanhoPagina || 10,
      amostrasIndexadasImediatas: precosAcumulados.length,
    })

    // Se o índice está vazio, busca via conectores externos mantendo concorrência assíncrona
    // com salvamento progressivo no índice e retorno imediato por streaming quando disponível
    const promessasBusca = conectoresAtivos.map(async (conector) => {
      try {
        const resultadoFonte = await conector.search(params, (novasAmostras) =>
          incorporarAmostras(conector.id, novasAmostras),
        )

        const metadata = (
          resultadoFonte.observabilidade as ObservabilidadeFonte & {
            metadata?: { cobertura_parcial?: boolean }
          }
        ).metadata
        const statusFonte =
          resultadoFonte.status === 'CONCLUIDA' && metadata?.cobertura_parcial === true
            ? 'CONCLUIDA_PARCIAL'
            : resultadoFonte.status
        relatorio.detalhePorFonte[conector.id] = {
          ...resultadoFonte.observabilidade,
          status: statusFonte,
          ...(statusFonte === 'CONCLUIDA_PARCIAL' && resultadoFonte.erro
            ? { aviso: resultadoFonte.erro }
            : {}),
        }
        relatorio.totalAmostrasInformadasApis += resultadoFonte.totalRegistrosInformadosApi
        relatorio.totalAmostrasBrutasRecebidas +=
          resultadoFonte.observabilidade.quantidadeRecebidaBruta

        if (resultadoFonte.sucesso) {
          relatorio.fontesComSucesso.push(conector.id)
        } else {
          relatorio.fontesComFalha.push(conector.id)
          errosPorFonte[conector.id] = resultadoFonte.erro || 'Fonte indisponível'
        }

        // Se o conector não usou onProgress para todas ou retornou em bloco:
        for (const item of resultadoFonte.amostras) {
          if (
            typeof item.valorUnitario !== 'number' ||
            isNaN(item.valorUnitario) ||
            item.valorUnitario <= 0
          ) {
            relatorio.descartesSemPrecoUnitario = (relatorio.descartesSemPrecoUnitario || 0) + 1
            relatorio.totalAmostrasDescartadas++
            continue
          }

          const chaveGlobal = `${item.fonte}#${item.idExterno}#${item.orgaoComprador}#${item.fornecedorNome}#${item.valorUnitario.toFixed(4)}`
          if (!chavesDedupGlobal.has(chaveGlobal)) {
            chavesDedupGlobal.add(chaveGlobal)
            precosAcumulados.push(item)
          }
        }
      } catch (fatalErr: any) {
        relatorio.fontesComFalha.push(conector.id)
        const msg = fatalErr?.message || String(fatalErr)
        errosPorFonte[conector.id] = msg
        relatorio.detalhePorFonte[conector.id] = {
          fonte: conector.id,
          tempoTotalMs: 0,
          quantidadeInformadaApi: 0,
          quantidadeRecebidaBruta: 0,
          quantidadeProcessadaValida: 0,
          quantidadeEntregue: 0,
          quantidadeDescartadaAntiContaminacao: 0,
          quantidadeDuplicidadesInternas: 0,
          paginasProcessadas: 0,
          totalPaginasApi: 0,
          retriesExecutados: 0,
          statusHttpFinal: 500,
          timeoutsCount: 1,
          errosEncontrados: [msg],
          circuitBreakerAcionado: false,
          cacheHit: false,
        }
      }
    })

    await Promise.allSettled([...promessasBusca, turnoImediato])

    if (avisosPorFonte.pncp && relatorio.detalhePorFonte.pncp) {
      relatorio.detalhePorFonte.pncp.aviso = avisosPorFonte.pncp
      if (relatorio.detalhePorFonte.pncp.status === 'CONCLUIDA') {
        relatorio.detalhePorFonte.pncp.status = 'CONCLUIDA_PARCIAL'
      }
    }

    relatorio.tempoTotalMs = Math.round(performance.now() - tInicio)
    relatorio.totalAmostrasProcessadasValidas = precosAcumulados.length
    relatorio.totalAmostrasEntregues = precosAcumulados.length

    // CORREÇÃO 7: Log estruturado com métricas completas
    console.log('[ORCHESTRATOR-SEARCH:COMPLETE]', {
      termo: params.termo,
      fontesConsultadas: relatorio.fontesConsultadas,
      fontesSucesso: relatorio.fontesComSucesso,
      fontesFalha: relatorio.fontesComFalha,
      tempoPrimeiroResultadoMs: relatorio.tempoAtePrimeiroResultadoMs || null,
      tempoTotalMs: relatorio.tempoTotalMs,
      totalInformadoApis: relatorio.totalAmostrasInformadasApis,
      totalBrutoRecebido: relatorio.totalAmostrasBrutasRecebidas,
      totalValidoEntregue: relatorio.totalAmostrasEntregues,
      duplicidadesRemovidas: relatorio.totalDuplicidadesRemovidas,
    })

    // Ordenação garantida por menor preço unitário numérico (menor -> maior)
    precosAcumulados.sort((a, b) => a.valorUnitario - b.valorUnitario)

    // Determinar estado da pesquisa (RF-015)
    let estadoFinal: SearchState = 'CONCLUIDA'
    if (relatorio.fontesComSucesso.length > 0 && relatorio.fontesComFalha.length > 0) {
      estadoFinal = 'CONCLUIDA_PARCIALMENTE'
    } else if (relatorio.fontesComSucesso.length === 0 && relatorio.fontesComFalha.length > 0) {
      estadoFinal = 'FALHA_TOTAL'
    } else if (relatorio.fontesComSucesso.length > 0 && relatorio.fontesComFalha.length === 0) {
      estadoFinal = Object.values(relatorio.detalhePorFonte).some(
        (fonte) => fonte.status === 'CONCLUIDA_PARCIAL',
      )
        ? 'CONCLUIDA_PARCIALMENTE'
        : 'CONCLUIDA'
    }
    if (estadoFinal === 'CONCLUIDA' && Object.keys(avisosPorFonte).length > 0) {
      estadoFinal = 'CONCLUIDA_PARCIALMENTE'
    }
    relatorio.estadoFinal = estadoFinal

    const estatisticas = this.calcularEstatisticas(precosAcumulados)

    return {
      estado: estadoFinal,
      amostras: precosAcumulados,
      estatisticas,
      observabilidade: relatorio,
      fontesConsultadas: relatorio.fontesConsultadas,
      fontesComSucesso: relatorio.fontesComSucesso,
      fontesComFalha: relatorio.fontesComFalha,
      errosPorFonte,
      avisosPorFonte,
    }
  }

  public calcularEstatisticas(amostras: AmostraPreco[]): EstatisticasOrquestrador {
    if (!amostras || amostras.length === 0) {
      return {
        totalAmostras: 0,
        valorMinimo: 0,
        valorMaximo: 0,
        mediaGeral: 0,
        medianaGeral: 0,
      }
    }

    const valores = amostras
      .map((a) => a.valorUnitario)
      .filter((v) => !isNaN(v) && v > 0)
      .sort((a, b) => a - b)

    if (valores.length === 0) {
      return {
        totalAmostras: 0,
        valorMinimo: 0,
        valorMaximo: 0,
        mediaGeral: 0,
        medianaGeral: 0,
      }
    }

    const totalAmostras = valores.length
    const valorMinimo = valores[0]
    const valorMaximo = valores[totalAmostras - 1]
    const soma = valores.reduce((acc, v) => acc + v, 0)
    const mediaGeral = soma / totalAmostras

    const meio = Math.floor(totalAmostras / 2)
    const medianaGeral =
      totalAmostras % 2 === 0 ? (valores[meio - 1] + valores[meio]) / 2 : valores[meio]

    return {
      totalAmostras,
      valorMinimo,
      valorMaximo,
      mediaGeral,
      medianaGeral,
    }
  }
}

