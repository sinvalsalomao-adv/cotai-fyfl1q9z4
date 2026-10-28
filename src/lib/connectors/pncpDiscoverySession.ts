import type {
  AmostraPreco,
  ConnectorSearchParams,
  ConnectorSearchResult,
  PaginationInfo,
  PncpContinuation,
} from './types'

export interface EstadoDescobertaPncp {
  pendente: boolean
  executando: boolean
  pausada: boolean
  proximaPagina?: number
  retryAtMs: number
  motivo?: string
}

export interface ContextoLeituraPncp {
  revisao: number
  executando: boolean
}

/** Apply one discovery window to the query generation's observation. */
export function preservarEvidenciasPncp<
  T extends {
    metadata?: Record<string, any>
    status?: string
    errosEncontrados?: string[]
  },
>(anterior: T | undefined, atual: T): T {
  const previa = anterior?.metadata
  const metadata = { ...atual.metadata }
  // A later page window cannot prove recovery of discovery/queue losses.
  // Transport errors, cursors and queued-count snapshots belong to the latest window.
  if (typeof previa?.erro_fila === 'string' && previa.erro_fila.trim())
    metadata.erro_fila = previa.erro_fila
  if (previa?.descoberta_parcial === true) metadata.descoberta_parcial = true
  if (previa?.fila_persistida === false) metadata.fila_persistida = false
  for (const campo of ['itens_nao_enfileirados', 'itens_congelados']) {
    const antes = previa?.[campo]
    if (Number.isSafeInteger(antes) && antes > 0) {
      const agora = metadata[campo]
      metadata[campo] = Math.max(antes, Number.isSafeInteger(agora) && agora > 0 ? agora : 0)
    }
  }
  return { ...atual, metadata }
}

export function pncpContextoLeituraAtual(
  inicio: ContextoLeituraPncp | undefined,
  atual: ContextoLeituraPncp,
): boolean {
  return Boolean(
    inicio && !inicio.executando && !atual.executando && inicio.revisao === atual.revisao,
  )
}

/** A generic task row only certifies the PNCP task bound by a validated worker DTO. */
export function pncpLeituraConfirmaWorker(
  tarefa: { id?: string; status?: string; ativa?: boolean; pendentes_count?: number } | undefined,
  tarefaPncpId: string | undefined,
  inicio: ContextoLeituraPncp | undefined,
  atual: ContextoLeituraPncp,
): boolean {
  return Boolean(
    tarefaPncpId &&
    tarefa?.id === tarefaPncpId &&
    pncpContextoLeituraAtual(inicio, atual) &&
    tarefa.status === 'completed' &&
    tarefa.ativa === false &&
    tarefa.pendentes_count === 0,
  )
}

/** A worker receipt cannot certify pages that discovery has not acknowledged. */
export function pncpPodeConcluir(
  workerStatus: string | undefined,
  descoberta: Pick<EstadoDescobertaPncp, 'pendente' | 'executando' | 'pausada'>,
  obs: { metadata?: Record<string, any>; errosEncontrados?: string[]; status?: string },
  workerConfirmadoAposDescoberta = false,
): boolean {
  const metadata = obs.metadata
  return (
    workerConfirmadoAposDescoberta &&
    workerStatus === 'completed' &&
    !descoberta.pendente &&
    !descoberta.executando &&
    !descoberta.pausada &&
    !obs.metadata?.continuacao_pncp &&
    !metadata?.erro_fila &&
    metadata?.descoberta_parcial !== true &&
    !(metadata?.itens_nao_enfileirados > 0) &&
    !(metadata?.itens_congelados > 0) &&
    metadata?.fila_persistida !== false &&
    !obs.errosEncontrados?.length &&
    !['FALHA_TOTAL', 'INDISPONIVEL'].includes(obs.status || '')
  )
}

const esperarCancelavel = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const cancelar = () => {
      clearTimeout(timer)
      reject(new DOMException('Descoberta PNCP cancelada.', 'AbortError'))
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', cancelar)
        resolve()
      },
      Math.min(ms, 2_147_483_647),
    )
    signal.addEventListener('abort', cancelar, { once: true })
    if (signal.aborted) cancelar()
  })

/** Query-owned page discovery. The caller injects the existing PNCP adapter directly. */
export class PncpDiscoverySession {
  private continuacao?: PncpContinuation
  private readonly identidades = new Set<string>()
  private executando = false
  private pausada = false
  private motivo?: string
  private semProgresso = 0
  private geracao = 0
  private controller?: AbortController
  private readonly agora: () => number
  private readonly esperar: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(
    readonly identidade: string,
    deps: {
      agora?: () => number
      esperar?: (ms: number, signal: AbortSignal) => Promise<void>
    } = {},
  ) {
    this.agora = deps.agora || Date.now
    this.esperar = deps.esperar || esperarCancelavel
  }

  private registrarIdentidades(amostras: AmostraPreco[]): number {
    let novas = 0
    for (const amostra of amostras) {
      const row = amostra.ingestionReceipt?.indexRow
      const key =
        row?.source === amostra.fonte && typeof row.sample_key === 'string' && row.sample_key.trim()
          ? `${amostra.fonte}#${row.sample_key}`
          : `${amostra.fonte}#${amostra.idExterno}#${amostra.orgaoComprador}#${amostra.fornecedorNome}#${amostra.valorUnitario.toFixed(4)}`
      if (!this.identidades.has(key)) {
        this.identidades.add(key)
        novas++
      }
    }
    return novas
  }

  registrar(continuacao: PncpContinuation | undefined, amostras: AmostraPreco[] = []): void {
    this.continuacao = continuacao ? { ...continuacao } : undefined
    this.registrarIdentidades(amostras)
  }

  get estado(): EstadoDescobertaPncp {
    return {
      pendente: Boolean(this.continuacao),
      executando: this.executando,
      pausada: this.pausada,
      proximaPagina: this.continuacao?.proximaPagina,
      retryAtMs: this.continuacao?.retryAtMs || 0,
      motivo: this.motivo,
    }
  }

  cancelar(): void {
    this.geracao++
    this.controller?.abort()
    this.controller = undefined
    this.executando = false
  }

  async acompanhar(
    signal: AbortSignal,
    executar: (
      params: Pick<ConnectorSearchParams, 'pagina' | 'forcarAtualizacaoCache' | 'signal'>,
      onProgress: (amostras: AmostraPreco[], info: PaginationInfo) => void,
    ) => Promise<ConnectorSearchResult>,
    publicar: (resultado: ConnectorSearchResult) => void,
    status: (estado: EstadoDescobertaPncp) => void,
    ativa: () => boolean = () => true,
    onProgress?: (amostras: AmostraPreco[], info: PaginationInfo) => void,
  ): Promise<void> {
    this.cancelar()
    if (signal.aborted || !this.continuacao || this.pausada) return
    const geracao = this.geracao
    const controller = new AbortController()
    this.controller = controller
    const cancelar = () => controller.abort()
    signal.addEventListener('abort', cancelar, { once: true })
    const vigente = () =>
      geracao === this.geracao && !signal.aborted && !controller.signal.aborted && ativa()
    try {
      while (vigente() && this.continuacao && !this.pausada) {
        this.executando = false
        status(this.estado)
        const prazo = Math.max(
          this.continuacao.retryAtMs || 0,
          this.semProgresso > 0 ? this.agora() + 1000 : 0,
        )
        while (vigente() && this.agora() < prazo)
          await this.esperar(prazo - this.agora(), controller.signal)
        if (!vigente()) return
        const pagina = this.continuacao.proximaPagina
        this.executando = true
        status(this.estado)
        let novasIdentidades = 0
        try {
          // No global deadline is carried over from the initial search or quota wait.
          const resultado = await executar(
            { pagina, forcarAtualizacaoCache: true, signal: controller.signal },
            (amostras, info) => {
              if (!vigente()) return
              novasIdentidades += this.registrarIdentidades(amostras)
              onProgress?.(amostras, info)
            },
          )
          if (!vigente()) return
          novasIdentidades += this.registrarIdentidades(resultado.amostras)
          const proxima = resultado.continuacaoPncp
          const falhou =
            Boolean(resultado.erro) || ['FALHA_TOTAL', 'INDISPONIVEL'].includes(resultado.status)
          if (proxima) this.continuacao = { ...proxima }
          else if (!falhou) this.continuacao = undefined
          const avancou =
            !this.continuacao || this.continuacao.proximaPagina > pagina || novasIdentidades > 0
          this.semProgresso = avancou ? 0 : this.semProgresso + 1
          this.motivo = resultado.erro
          publicar(resultado)
        } catch (error) {
          if (!vigente()) return
          this.semProgresso = novasIdentidades > 0 ? 0 : this.semProgresso + 1
          this.motivo = (error as Error)?.message || 'Falha na descoberta PNCP.'
        } finally {
          if (geracao === this.geracao) this.executando = false
        }
        if (this.semProgresso >= 3) {
          this.pausada = true
          this.motivo =
            `Descoberta PNCP pausada após 3 janelas sem progresso. ${this.motivo || ''}`.trim()
        }
      }
    } catch (error) {
      if (vigente()) {
        this.pausada = true
        this.motivo = (error as Error)?.message
      }
    } finally {
      signal.removeEventListener('abort', cancelar)
      if (vigente()) {
        this.executando = false
        status(this.estado)
      }
      if (this.controller === controller) this.controller = undefined
    }
  }
}
