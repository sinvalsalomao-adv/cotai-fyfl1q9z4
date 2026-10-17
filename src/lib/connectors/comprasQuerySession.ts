import type { ConnectorSearchParams, ObservabilidadeFonte } from './types'
import type { TrabalhoCompras, PaginacaoCompras } from './comprasWorkQueue'

export interface EstadoContinuacaoCompras {
  pendentes: number
  retryAtMs: number
  pausada: boolean
}

/** Transient, query-owned work only. No storage, catalogue cap or price fabrication. */
export class ComprasQuerySession {
  readonly identidade: string
  private pendencias: TrabalhoCompras[] | undefined
  private paginacao: PaginacaoCompras[] = []
  private retryAtMs = 0
  private semProgresso = 0
  private geracao = 0
  private controller: AbortController | undefined

  constructor(identidade: string) {
    this.identidade = identidade
  }

  prepararBusca(): void {
    this.cancelar()
    this.semProgresso = 0
    // A completed explicit search refreshes the source rather than replaying a cache.
    if (this.pendencias?.length === 0) {
      this.pendencias = undefined
      this.paginacao = []
      this.retryAtMs = 0
    }
  }

  parametros(
    deadlineAtMs?: number,
  ): Pick<
    ConnectorSearchParams,
    'continuacoesCompras' | 'paginacaoComprasAnterior' | 'retryAtComprasMs' | 'deadlineAtMs'
  > {
    return {
      continuacoesCompras: this.pendencias?.map((work) => ({ ...work })),
      paginacaoComprasAnterior: this.paginacao.map((page) => ({ ...page })),
      retryAtComprasMs: this.retryAtMs || undefined,
      deadlineAtMs: Math.min(Date.now() + 20000, deadlineAtMs ?? Infinity),
    }
  }

  registrar(obs: Partial<ObservabilidadeFonte> | undefined): void {
    if (!obs || !Array.isArray(obs.continuacoesCompras)) return
    this.pendencias = obs.continuacoesCompras.map((work) => ({ ...work }))
    this.paginacao = (obs.paginacaoCompras || this.paginacao).map((page) => ({ ...page }))
    this.retryAtMs = Number.isFinite(obs.retryAtComprasMs) ? obs.retryAtComprasMs! : 0
    this.semProgresso = (obs.trabalhosConcluidosCompras || 0) > 0 ? 0 : this.semProgresso + 1
  }

  get estado(): EstadoContinuacaoCompras {
    return {
      pendentes: this.pendencias?.length || 0,
      retryAtMs: this.retryAtMs,
      pausada: this.semProgresso >= 3,
    }
  }

  cancelar(): void {
    this.geracao++
    this.controller?.abort()
    this.controller = undefined
  }

  /** Detached from first BUSCAR. Every subsequent call is one bounded Compras-only turn. */
  acompanhar<
    T extends {
      observabilidade?: { detalhePorFonte?: Record<string, Partial<ObservabilidadeFonte>> }
    },
  >(
    signal: AbortSignal,
    executar: (
      params: ReturnType<ComprasQuerySession['parametros']> & {
        somenteContinuacaoCompras: true
        signal: AbortSignal
      },
    ) => Promise<T>,
    publicar: (resultado: T) => void,
    status: (estado: EstadoContinuacaoCompras) => void,
  ): void {
    this.cancelar()
    if (signal.aborted || !this.pendencias?.length) return
    const controller = new AbortController()
    this.controller = controller
    const geracao = this.geracao
    const cancelar = () => controller.abort()
    signal.addEventListener('abort', cancelar, { once: true })
    const ativa = () => geracao === this.geracao && !controller.signal.aborted && !signal.aborted
    const esperar = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const abortar = () => {
          clearTimeout(timer)
          reject(new DOMException('Busca cancelada.', 'AbortError'))
        }
        const timer = setTimeout(
          () => {
            controller.signal.removeEventListener('abort', abortar)
            resolve()
          },
          Math.min(ms, 2_147_483_647),
        )
        controller.signal.addEventListener('abort', abortar, { once: true })
      })
    void (async () => {
      try {
        while (ativa() && this.pendencias?.length && this.semProgresso < 3) {
          status(this.estado)
          // A minimum gap prevents hot retries even for a deadline or local failure.
          const allowed = Math.max(Date.now() + 1000, this.retryAtMs)
          while (ativa() && Date.now() < allowed) await esperar(allowed - Date.now())
          if (!ativa()) return
          const result = await executar({
            ...this.parametros(),
            somenteContinuacaoCompras: true,
            signal: controller.signal,
          })
          if (!ativa()) return
          const obs = result.observabilidade?.detalhePorFonte?.compras_gov
          if (Array.isArray(obs?.continuacoesCompras)) this.registrar(obs)
          else {
            this.semProgresso++
            this.retryAtMs = Math.max(this.retryAtMs, Date.now() + 20000)
          }
          publicar(result)
        }
      } catch {
        if (ativa()) this.semProgresso = 3
      } finally {
        signal.removeEventListener('abort', cancelar)
        if (ativa()) status(this.estado)
        if (this.controller === controller) this.controller = undefined
      }
    })()
  }
}
