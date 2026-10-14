/**
 * Circuit Breaker Pattern implementation
 * Protege contra cascata de falhas, 429 Too Many Requests, 502/503/504 Upstream Errors e timeouts repetidos.
 * Estados: CLOSED (normal) -> OPEN (em cooldown, rejeita imediatamente) -> HALF_OPEN (teste controlado).
 */

export interface CircuitBreakerConfig {
  falhasParaAbrir: number // Quantidade consecutiva de falhas para abrir o circuito (padrão: 3)
  tempoCooldownMs: number // Tempo que o circuito permanece aberto em cooldown (padrão: 20000ms)
  sucessosParaFechar: number // Sucessos em half-open para fechar o circuito (padrão: 2)
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export class CircuitBreaker {
  private estado: CircuitState = 'CLOSED'
  private falhasConsecutivas = 0
  private sucessosConsecutivosEmHalfOpen = 0
  private ultimoErroTime = 0
  private ultimoErroMensagem = ''
  private ultimoStatusHttp = 200
  private readonly config: CircuitBreakerConfig

  constructor(
    public readonly nome: string,
    config?: Partial<CircuitBreakerConfig>,
  ) {
    this.config = {
      falhasParaAbrir: config?.falhasParaAbrir ?? 3,
      tempoCooldownMs: config?.tempoCooldownMs ?? 20000,
      sucessosParaFechar: config?.sucessosParaFechar ?? 2,
    }
  }

  public getEstado(): CircuitState {
    if (this.estado === 'OPEN') {
      const agora = Date.now()
      if (agora - this.ultimoErroTime >= this.config.tempoCooldownMs) {
        this.estado = 'HALF_OPEN'
        this.sucessosConsecutivosEmHalfOpen = 0
      }
    }
    return this.estado
  }

  public isOpen(): boolean {
    return this.getEstado() === 'OPEN'
  }

  public isHalfOpen(): boolean {
    return this.getEstado() === 'HALF_OPEN'
  }

  public getTempoCooldownRestanteMs(): number {
    if (this.estado !== 'OPEN') return 0
    const decorrido = Date.now() - this.ultimoErroTime
    return Math.max(0, this.config.tempoCooldownMs - decorrido)
  }

  public getUltimoErro(): { mensagem: string; statusHttp: number } {
    return {
      mensagem: this.ultimoErroMensagem,
      statusHttp: this.ultimoStatusHttp,
    }
  }

  public registrarSucesso(): void {
    if (this.estado === 'HALF_OPEN') {
      this.sucessosConsecutivosEmHalfOpen++
      if (this.sucessosConsecutivosEmHalfOpen >= this.config.sucessosParaFechar) {
        this.reset()
      }
    } else if (this.estado === 'CLOSED') {
      this.falhasConsecutivas = 0
    }
  }

  public registrarFalha(erro: string, statusHttp = 500): void {
    this.ultimoErroTime = Date.now()
    this.ultimoErroMensagem = erro
    this.ultimoStatusHttp = statusHttp

    // Se for 429 ou erro 5xx grave, o circuito abre mais rápido
    const pesoFalha = statusHttp === 429 || statusHttp === 503 || statusHttp === 504 ? 2 : 1
    this.falhasConsecutivas += pesoFalha

    if (this.estado === 'HALF_OPEN') {
      // Reabre imediatamente se falhar em teste controlado
      this.estado = 'OPEN'
    } else if (this.falhasConsecutivas >= this.config.falhasParaAbrir) {
      this.estado = 'OPEN'
    }
  }

  public reset(): void {
    this.estado = 'CLOSED'
    this.falhasConsecutivas = 0
    this.sucessosConsecutivosEmHalfOpen = 0
    this.ultimoErroMensagem = ''
  }
}
