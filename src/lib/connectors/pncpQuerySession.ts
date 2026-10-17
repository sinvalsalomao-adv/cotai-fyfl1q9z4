import type { PncpImmediateTurn } from '../priceIndexService'

export interface EstadoContinuacaoPncp { ativa: boolean; pausada: boolean }

/** One explicit query generation owns this detached, bounded PNCP-only session. */
export class PncpQuerySession {
  private iniciada = false
  private readonly options: {
    signal: AbortSignal
    ativa: () => boolean
    executar: (id: string, options: { signal: AbortSignal; deadlineAtMs: number }) => Promise<PncpImmediateTurn>
    publicar: (turno: PncpImmediateTurn, options: { signal: AbortSignal }) => Promise<void>
    status: (estado: EstadoContinuacaoPncp) => void
  }
  constructor(options: PncpQuerySession['options']) { this.options = options }

  iniciar(primeiro: PncpImmediateTurn): void {
    if (this.iniciada || !this.ativa()) return
    this.iniciada = true
    if (primeiro.status !== 'pending' || !this.valido(primeiro, primeiro.tarefa_id)) return
    const deadline = Date.now() + 180000
    this.options.status({ ativa: true, pausada: false })
    void this.continuar(primeiro, deadline)
  }

  private ativa(): boolean { return !this.options.signal.aborted && this.options.ativa() }

  private valido(turno: PncpImmediateTurn, id: string): boolean {
    return Boolean(id) && turno?.tarefa_id === id && turno.fonte_processada === 'PNCP' &&
      ['pending', 'running', 'completed', 'failed'].includes(turno.status) &&
      typeof turno.cobertura_parcial === 'boolean' && Array.isArray(turno.amostras) &&
      [turno.paginas_consultadas, turno.itens_processados, turno.amostras_inseridas, turno.amostras_atualizadas]
        .every(n => Number.isInteger(n) && n! >= 0)
  }

  private async continuar(anterior: PncpImmediateTurn, deadline: number): Promise<void> {
    let terminal = false
    let semProgresso = 0
    const signal = this.options.signal
    const aguardar = (ms: number) => new Promise<void>((resolve, reject) => {
      const abortar = () => { clearTimeout(timer); reject(new DOMException('Sessão PNCP cancelada.', 'AbortError')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abortar); resolve() }, ms)
      signal.addEventListener('abort', abortar, { once: true })
    })
    try {
      while (this.ativa() && Date.now() + 1000 < deadline) {
        await aguardar(1000)
        if (!this.ativa() || Date.now() >= deadline) return
        const controller = new AbortController()
        const abortar = () => controller.abort()
        signal.addEventListener('abort', abortar, { once: true })
        const limiteTurno = Math.min(deadline, Date.now() + 25000)
        let interromper!: () => void
        const interrompido = new Promise<never>((_resolve, reject) => {
          interromper = () => reject(new DOMException('Prazo PNCP interrompido.', 'AbortError'))
        })
        controller.signal.addEventListener('abort', interromper, { once: true })
        const timer = setTimeout(abortar, limiteTurno - Date.now())
        let turno: PncpImmediateTurn
        try {
          turno = await Promise.race([
            this.options.executar(anterior.tarefa_id, { signal: controller.signal, deadlineAtMs: limiteTurno }),
            interrompido,
          ])
          if (!this.ativa() || controller.signal.aborted || Date.now() >= limiteTurno) return
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abortar)
          controller.signal.removeEventListener('abort', interromper)
          controller.abort()
        }
        if (!this.valido(turno, anterior.tarefa_id)) break
        const houveProgresso = (['paginas_consultadas', 'itens_processados', 'amostras_inseridas', 'amostras_atualizadas'] as const)
          .some(campo => turno[campo]! > anterior[campo]!)
        semProgresso = houveProgresso ? 0 : semProgresso + 1
        anterior = turno
        // Reconcile every confirmed completion, even for busy/failed results. The
        // consumer shares its single index observer and guards generation again.
        const publicacao = new AbortController()
        const cancelarPublicacao = () => publicacao.abort()
        signal.addEventListener('abort', cancelarPublicacao, { once: true })
        let rejeitarPublicacao!: () => void
        const publicacaoInterrompida = new Promise<never>((_resolve, reject) => {
          rejeitarPublicacao = () => reject(new DOMException('Reconciliação PNCP interrompida.', 'AbortError'))
        })
        publicacao.signal.addEventListener('abort', rejeitarPublicacao, { once: true })
        const limitePublicacao = setTimeout(cancelarPublicacao, Math.max(0, deadline - Date.now()))
        try {
          await Promise.race([this.options.publicar(turno, { signal: publicacao.signal }), publicacaoInterrompida])
        } finally {
          clearTimeout(limitePublicacao)
          signal.removeEventListener('abort', cancelarPublicacao)
          publicacao.signal.removeEventListener('abort', rejeitarPublicacao)
          publicacao.abort()
        }
        if (!this.ativa()) return
        terminal = turno.status === 'completed'
        if (turno.status !== 'pending' || semProgresso >= 3) break
      }
    } catch {
      // A failed/ambiguous request may still be active on the server. Never retry.
    } finally {
      if (this.ativa()) this.options.status({ ativa: false, pausada: !terminal })
    }
  }
}
