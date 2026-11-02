/**
 * Rate Limit & Concurrency Manager
 * Controla concorrência e ritmo de requisições por conector para evitar 429 e sobrecarga de APIs oficiais.
 * Implementa Token Bucket / Leaky Queue por conector e semáforo de concorrência global.
 */

export interface RateLimiterOptions {
  requisicoesPorSegundo: number
  concorrenciaMaxima: number
}

export class ConnectorRateLimiter {
  private fila: Array<{ conceder: () => void; signal?: AbortSignal; cancelar: () => void }> = []
  private emExecucao = 0
  private historicoExecucoes: number[] = []
  private readonly reqPorSegundo: number
  private readonly maxConcorrencia: number

  constructor(options?: Partial<RateLimiterOptions>) {
    this.reqPorSegundo = options?.requisicoesPorSegundo ?? 5
    this.maxConcorrencia = options?.concorrenciaMaxima ?? 4
  }

  public async acquire(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortError = () => new DOMException('Busca cancelada.', 'AbortError')
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const entrada = {
        signal,
        conceder: () => {
          signal?.removeEventListener('abort', entrada.cancelar)
          resolve()
        },
        cancelar: () => {
          const index = this.fila.indexOf(entrada)
          if (index < 0) return
          this.fila.splice(index, 1)
          signal?.removeEventListener('abort', entrada.cancelar)
          reject(abortError())
          this.processarFila()
        },
      }
      signal?.addEventListener('abort', entrada.cancelar, { once: true })
      this.fila.push(entrada)
      this.processarFila()
    })
  }

  public release(): void {
    this.emExecucao = Math.max(0, this.emExecucao - 1)
    this.processarFila()
  }

  public async execute<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      if (signal?.aborted) throw new DOMException('Busca cancelada.', 'AbortError')
      return await fn()
    } finally {
      this.release()
    }
  }

  private processarFila(): void {
    if (this.fila.length === 0) return
    if (this.emExecucao >= this.maxConcorrencia) return

    const agora = Date.now()
    // Limpa registros mais velhos que 1000ms
    this.historicoExecucoes = this.historicoExecucoes.filter((t) => agora - t < 1000)

    if (this.historicoExecucoes.length >= this.reqPorSegundo) {
      // Espera até que libere janela de 1s
      const proximoSlot = 1000 - (agora - this.historicoExecucoes[0]) + 10
      setTimeout(() => this.processarFila(), Math.max(10, proximoSlot))
      return
    }

    const next = this.fila.shift()
    if (next) {
      this.emExecucao++
      this.historicoExecucoes.push(agora)
      next.conceder()
    }
  }

  public getStats(): { emFila: number; emExecucao: number; reqUltimoSegundo: number } {
    const agora = Date.now()
    this.historicoExecucoes = this.historicoExecucoes.filter((t) => agora - t < 1000)
    return {
      emFila: this.fila.length,
      emExecucao: this.emExecucao,
      reqUltimoSegundo: this.historicoExecucoes.length,
    }
  }
}
