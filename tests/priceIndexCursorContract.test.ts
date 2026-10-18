import { afterEach, describe, expect, it, vi } from 'vitest'
import { PriceIndexService } from '../src/lib/priceIndexService'

vi.mock('../src/lib/pocketbase/client', () => ({
  default: {
    baseUrl: 'https://index.example',
    authStore: { token: 'test-token' },
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('price index cursor/snapshot transport', () => {
  it('caps the first page to the same 100-row size used by six-page cursor windows', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        sucesso: true,
        summary_included: true,
        summary_valid: true,
        total: 0,
        page: 1,
        limit: 100,
        hits: [],
        aggregations: { total: 0, estatisticas: {} },
      }),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    await PriceIndexService.searchIndex({ palavra_chave: 'IBUPROFENO', tamanho_pagina: 200 })

    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))
    expect(body).toMatchObject({ limit: 100, tamanho_pagina: 100 })
  })

  it('keeps the first-page cursor contract alongside the global summary', () => {
    const result = PriceIndexService.normalizeSearchResult({
      sucesso: true,
      summary_included: true,
      summary_valid: true,
      total: 4_711,
      page: 1,
      limit: 100,
      hits: [{ id: 'one', valor_unitario: 1 }],
      snapshot: 'snapshot-4711',
      next_cursor: 'opaque-2',
      has_more: true,
      snapshot_window_count: 600,
      snapshot_population_complete: false,
      population_has_more: true,
      aggregations: {
        total: 4_711,
        por_fonte: { PNCP: 541, 'Compras.gov.br': 4_170 },
        estatisticas: {
          n: 4_711,
          minimo: 0.19,
          maximo: 631.5,
          media: 18.42,
          mediana: 4.73,
          q1: 1.2,
          q3: 11.8,
          desvio_padrao: 2,
          iqr: 10.6,
          limite_inferior_iqr: 0,
          limite_superior_iqr: 27.7,
          regra_outlier: 'IQR',
        },
      },
    })

    expect(result).toMatchObject({
      total: 4_711,
      snapshot: 'snapshot-4711',
      next_cursor: 'opaque-2',
      has_more: true,
      snapshot_window_count: 600,
      snapshot_population_complete: false,
      population_has_more: true,
      statistics_valid: true,
    })
    expect(PriceIndexService.extractHits(result)).toHaveLength(1)
  })

  it('marks a synthesized or incoherent statistics block as unavailable', () => {
    const missing = PriceIndexService.normalizeSearchResult({
      sucesso: true,
      summary_included: true,
      summary_valid: true,
      total: 8,
      hits: [{ id: 'one', valor_unitario: 2.5 }],
      aggregations: { total: 8, por_fonte: { PNCP: 8 } },
    })
    const incoherent = PriceIndexService.normalizeSearchResult({
      sucesso: true,
      summary_included: true,
      summary_valid: true,
      total: 8,
      hits: [{ id: 'one', valor_unitario: 2.5 }],
      aggregations: {
        total: 8,
        estatisticas: {
          n: 7,
          minimo: 1,
          maximo: 10,
          media: 4,
          mediana: 3,
          q1: 2,
          q3: 5,
        },
      },
    })

    expect(missing.statistics_valid).toBe(false)
    expect(incoherent.statistics_valid).toBe(false)
  })

  it('does not promote legacy statistics without explicit global-summary markers', () => {
    const withoutMarkers = PriceIndexService.normalizeSearchResult({
      sucesso: true,
      total: 8,
      hits: [{ id: 'one', valor_unitario: 2.5 }],
      aggregations: {
        total: 8,
        estatisticas: {
          n: 8,
          minimo: 1,
          maximo: 10,
          media: 4,
          mediana: 3,
          q1: 2,
          q3: 5,
        },
      },
    })

    expect(withoutMarkers.summary_valid).toBe(false)
    expect(withoutMarkers.statistics_valid).toBe(false)
  })

  it('requests a continuation with the same snapshot, no summary, and at most 100 hits', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        sucesso: true,
        summary_included: false,
        hits: [{ id: 'second', valor_unitario: 2 }],
        snapshot: 'snapshot-4711',
        next_cursor: null,
        has_more: false,
        limit: 100,
      }),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const result = await PriceIndexService.searchIndexContinuation(
      { palavra_chave: 'IBUPROFENO', tamanho_pagina: 200 },
      { kind: 'cursor', cursor: 'opaque-2', snapshot: 'snapshot-4711' },
    )

    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))
    expect(body).toMatchObject({
      palavra_chave: 'IBUPROFENO',
      cursor: 'opaque-2',
      snapshot: 'snapshot-4711',
      include_summary: false,
      limit: 100,
      tamanho_pagina: 100,
    })
    expect(body).not.toHaveProperty('page')
    expect(body).not.toHaveProperty('pagina')
    expect(result).toMatchObject({
      hits: [{ id: 'second', valor_unitario: 2 }],
      snapshot: 'snapshot-4711',
      next_cursor: null,
      has_more: false,
    })
  })

  it('rejects a cursor response that omits explicit snapshot or completion state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          sucesso: true,
          summary_included: false,
          hits: [],
          limit: 100,
          next_cursor: null,
        }),
      })),
    )

    await expect(
      PriceIndexService.searchIndexContinuation(
        { palavra_chave: 'IBUPROFENO' },
        { kind: 'cursor', cursor: 'opaque-2', snapshot: 'snapshot-4711' },
      ),
    ).rejects.toThrow(/cursor|snapshot|continua/i)
  })

  it.each([
    {
      status: 409,
      code: 'SEARCH_SNAPSHOT_MISMATCH',
      message: 'Os filtros não correspondem ao snapshot.',
    },
    {
      status: 410,
      code: 'SEARCH_SNAPSHOT_EXPIRED',
      message: 'A sessão de busca expirou.',
    },
  ])('preserves the typed HTTP $status cursor error', async ({ status, code, message }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({ status, code, message }),
      })),
    )

    let caught: unknown
    try {
      await PriceIndexService.searchIndexContinuation(
        { palavra_chave: 'IBUPROFENO' },
        { kind: 'cursor', cursor: 'opaque-2', snapshot: 'snapshot-4711' },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ status, code, message })
  })

  it('preserves status and code when the initial summary request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({
          code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
          error: 'Não foi possível fixar a janela.',
        }),
      })),
    )

    const result = await PriceIndexService.searchIndex({ palavra_chave: 'IBUPROFENO' })

    expect(result).toMatchObject({
      sucesso: false,
      status: 503,
      code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
      error: 'Não foi possível fixar a janela.',
    })
  })

  it('keeps numeric-page compatibility without treating an unknown page as terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          sucesso: true,
          summary_included: false,
          page: 2,
          pages: 5,
          hits: [{ id: 'legacy-page', valor_unitario: 3 }],
          limit: 100,
        }),
      })),
    )

    const result = await PriceIndexService.searchIndexContinuation(
      { palavra_chave: 'IBUPROFENO' },
      { kind: 'page', page: 2 },
    )
    expect(result).toMatchObject({ page: 2, pages: 5 })
    expect(result.has_more).toBe(true)
  })

  it('carries the first-page total-pages contract across legacy continuation responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          sucesso: true,
          summary_included: false,
          page: 2,
          hits: [{ id: 'legacy-page', valor_unitario: 3 }],
          limit: 100,
        }),
      })),
    )

    const result = await PriceIndexService.searchIndexContinuation(
      { palavra_chave: 'IBUPROFENO' },
      { kind: 'page', page: 2 },
      { expectedPages: 5 },
    )
    expect(result).toMatchObject({ page: 2, pages: 5, has_more: true })
  })
})
