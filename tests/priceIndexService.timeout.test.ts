import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PriceIndexService } from '../src/lib/priceIndexService'

const sdk = vi.hoisted(() => ({ getList: vi.fn() }))
vi.mock('../src/lib/pocketbase/client', () => ({ default: {
  baseUrl: 'https://offline-index.invalid', authStore: { token: '' },
  collection: () => ({ getList: sdk.getList }),
} }))

// Exercise the real service while replacing only the external HTTP boundaries.
const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
  if (signal.aborted) rejectAbort()
  else signal.addEventListener('abort', rejectAbort, { once: true })
})
const params = { palavra_chave: 'SYNTHETIC', pagina: 1, tamanho_pagina: 100 }

beforeEach(() => {
  vi.useFakeTimers()
  sdk.getList.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('index polling timeout is not user cancellation', () => {
  it.each(['response', 'body'])('reports local %s timeout as failed query without SDK fallback', async (stage) => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
      if (stage === 'response') return waitForAbort(init.signal as AbortSignal)
      return { ok: true, json: () => waitForAbort(init.signal as AbortSignal) }
    }))
    const controller = new AbortController()
    const request = PriceIndexService.searchIndex(params, { signal: controller.signal, timeoutMs: 20 })
    await Promise.all([
      expect(request).resolves.toMatchObject({ sucesso: false, timed_out: true }),
      vi.advanceTimersByTimeAsync(20),
    ])
    expect(controller.signal.aborted).toBe(false)
    expect(sdk.getList).not.toHaveBeenCalled()
  })

  it('propagates caller cancellation during the request without SDK fallback', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init: RequestInit) => waitForAbort(init.signal as AbortSignal)))
    const controller = new AbortController()
    const request = PriceIndexService.searchIndex(params, { signal: controller.signal, timeoutMs: 20 })
    const check = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await check
    expect(sdk.getList).not.toHaveBeenCalled()
  })

  it('propagates unrelated AbortError when neither local deadline nor caller fired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted upstream', 'AbortError') }))
    await expect(PriceIndexService.searchIndex(params, { timeoutMs: 20 }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(sdk.getList).not.toHaveBeenCalled()
  })

  it('does not expose unverified SDK rows when the native endpoint rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    sdk.getList.mockResolvedValue({
      items: [{ id: 'legacy', valor_unitario: 0.01, source: 'PNCP' }],
      totalItems: 999_999,
      page: 1,
      perPage: 100,
      totalPages: 10_000,
    })

    const result = await PriceIndexService.searchIndex(params, { timeoutMs: 20 })

    expect(result).toMatchObject({
      sucesso: false,
      summary_valid: false,
      timed_out: false,
      total: 0,
    })
    expect(PriceIndexService.extractHits(result)).toHaveLength(0)
    expect(result.aggregations.total).toBe(0)
    expect(sdk.getList).not.toHaveBeenCalled()
  })

  it('returns an explicit unavailable result on network failure without scanning legacy rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    sdk.getList.mockResolvedValue({
      items: [{ id: 'legacy', valor_unitario: 35, source: 'Compras.gov.br' }],
      totalItems: 42,
    })

    const result = await PriceIndexService.searchIndex(params, { timeoutMs: 20 })
    expect(result).toMatchObject({
      sucesso: false,
      summary_valid: false,
      timed_out: false,
      total: 0,
    })
    expect(PriceIndexService.extractHits(result)).toHaveLength(0)
    expect(sdk.getList).not.toHaveBeenCalled()
  })
})
