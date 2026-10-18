import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComprasQuerySession } from '../src/lib/connectors/comprasQuerySession'
import { PncpQuerySession, type EstadoContinuacaoPncp } from '../src/lib/connectors/pncpQuerySession'
import type { PncpImmediateTurn } from '../src/lib/priceIndexService'

afterEach(() => {
  vi.useRealTimers()
})

const comprasWork = {
  etapa: 'precos' as const,
  tipo: 'material' as const,
  codigo: '12345',
  pagina: 1,
  seletor: 'codigoItemCatalogo' as const,
}

function comprasObservation(pending: boolean, completed = 0) {
  return {
    observabilidade: {
      detalhePorFonte: {
        compras_gov: {
          continuacoesCompras: pending ? [comprasWork] : [],
          paginacaoCompras: [],
          trabalhosConcluidosCompras: completed,
          retryAtComprasMs: Date.now(),
        },
      },
    },
  }
}

function pncpTurn(status: string = 'pending', progress = 0): PncpImmediateTurn {
  return {
    tarefa_id: 'task-1',
    status,
    fonte_processada: 'PNCP',
    cobertura_parcial: status !== 'completed',
    amostras: [],
    amostras_resposta_parcial: false,
    paginas_consultadas: progress,
    itens_processados: progress,
    amostras_inseridas: 0,
    amostras_atualizadas: 0,
  }
}

describe('Compras query continuation', () => {
  it('preserves pending work through more than three no-progress turns and eventually completes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const session = new ComprasQuerySession('query-1')
    session.registrar(comprasObservation(true).observabilidade.detalhePorFonte.compras_gov)
    const controller = new AbortController()
    let turns = 0
    const published: unknown[] = []

    session.acompanhar(
      controller.signal,
      async () => comprasObservation(++turns < 5, turns === 5 ? 1 : 0),
      (result) => published.push(result),
      () => undefined,
    )

    await vi.advanceTimersByTimeAsync(120_000)

    expect(turns).toBe(5)
    expect(published).toHaveLength(5)
    expect(session.estado).toMatchObject({ pendentes: 0, pausada: false })
  })

  it('backs off after transient errors without dropping work and honors abort', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const session = new ComprasQuerySession('query-2')
    session.registrar(comprasObservation(true).observabilidade.detalhePorFonte.compras_gov)
    const controller = new AbortController()
    const attemptTimes: number[] = []

    session.acompanhar(
      controller.signal,
      async () => {
        attemptTimes.push(Date.now())
        if (attemptTimes.length <= 2) throw new Error('transient')
        return comprasObservation(true)
      },
      () => undefined,
      () => undefined,
    )

    await vi.advanceTimersByTimeAsync(15_000)
    controller.abort()
    await vi.runOnlyPendingTimersAsync()

    expect(attemptTimes.length).toBeGreaterThanOrEqual(3)
    expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(2_000)
    expect(attemptTimes[2] - attemptTimes[1]).toBeGreaterThanOrEqual(4_000)
    expect(session.estado.pendentes).toBe(1)
    const countAfterAbort = attemptTimes.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attemptTimes).toHaveLength(countAfterAbort)
  })

  it('treats a bounded-turn AbortError as transient while the query signal remains active', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const session = new ComprasQuerySession('query-deadline')
    session.registrar(comprasObservation(true).observabilidade.detalhePorFonte.compras_gov)
    let turns = 0

    session.acompanhar(
      new AbortController().signal,
      async () => {
        if (++turns === 1) throw new DOMException('turn deadline', 'AbortError')
        return comprasObservation(false, 1)
      },
      () => undefined,
      () => undefined,
    )
    await vi.advanceTimersByTimeAsync(30_000)

    expect(turns).toBe(2)
    expect(session.estado).toMatchObject({ pendentes: 0, pausada: false })
  })
})

describe('PNCP persisted task continuation', () => {
  it('does not stop after three unchanged pending turns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let turns = 0
    const statuses: EstadoContinuacaoPncp[] = []
    const controller = new AbortController()
    const session = new PncpQuerySession({
      signal: controller.signal,
      ativa: () => true,
      deadlineMs: 60_000,
      executar: async () => (++turns >= 5 ? pncpTurn('completed', 1) : pncpTurn()),
      publicar: async () => undefined,
      status: (status) => statuses.push(status),
    })

    session.iniciar(pncpTurn())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(turns).toBe(5)
    expect(statuses.at(-1)).toEqual({
      ativa: false,
      pausada: false,
      motivo: 'concluida',
      backendContinua: false,
    })
  })

  it('ends local observation at deadline without claiming that persisted backend work failed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const statuses: EstadoContinuacaoPncp[] = []
    const session = new PncpQuerySession({
      signal: new AbortController().signal,
      ativa: () => true,
      deadlineMs: 5_000,
      executar: async () => pncpTurn(),
      publicar: async () => undefined,
      status: (status) => statuses.push(status),
    })

    session.iniciar(pncpTurn())
    await vi.advanceTimersByTimeAsync(10_000)

    expect(statuses.at(-1)).toEqual({
      ativa: false,
      pausada: true,
      motivo: 'prazo',
      backendContinua: true,
    })
  })
})
