import { describe, expect, it } from 'vitest'
import {
  acceptIndexPopulationResponse,
  beginIndexPopulationView,
  invalidateIndexPopulationView,
  populationStatisticsCards,
  shouldIsolateIndexPopulationView,
  shouldInvalidateIndexPopulationForTerm,
} from '../src/lib/indexPopulationStatistics'
import { appendWindowPage, createWindowFromFirstPage } from '../src/lib/windowedPriceSearch'

interface Row {
  id: string
  unitPrice: number
}

const officialSummary = (
  total: number,
  statistics: {
    minimo: number
    maximo: number
    media: number
    mediana: number
    q1: number
    q3: number
  },
) => ({
  sucesso: true,
  summary_valid: true,
  statistics_valid: true,
  total,
  aggregations: {
    estatisticas: {
      n: total,
      ...statistics,
    },
  },
})

describe('indexed population statistics', () => {
  it('keeps global cards unchanged while old pages are evicted from the loaded window', () => {
    const initialView = acceptIndexPopulationResponse(
      beginIndexPopulationView('DIPIRONA|AMBAS'),
      'DIPIRONA|AMBAS',
      officialSummary(2_035, {
        minimo: 0.19,
        maximo: 631.5,
        media: 18.42,
        mediana: 4.73,
        q1: 1.2,
        q3: 11.8,
      }),
    )
    expect(initialView.status).toBe('ready')

    let window = createWindowFromFirstPage<Row, typeof initialView>(
      {
        hits: [{ id: 'page-1', unitPrice: 0.19 }],
        page: 1,
        pages: 8,
      },
      initialView,
      (row) => row.id,
      { maxPages: 2, maxRows: 2 },
    )
    const originalCards = populationStatisticsCards(window.summary)

    window = appendWindowPage(
      window,
      { hits: [{ id: 'page-2', unitPrice: 9 }], page: 2, pages: 8 },
      (row) => row.id,
    )
    window = appendWindowPage(
      window,
      { hits: [{ id: 'page-3', unitPrice: 50 }], page: 3, pages: 8 },
      (row) => row.id,
    )

    expect(window.rows.map((row) => row.id)).toEqual(['page-2', 'page-3'])
    expect(populationStatisticsCards(window.summary)).toEqual(originalCards)
    expect(originalCards).toMatchObject({
      n: 2_035,
      minimum: 0.19,
      maximum: 631.5,
      average: 18.42,
      median: 4.73,
      q1: 1.2,
      q3: 11.8,
    })
  })

  it('replaces the complete-population summary when the user changes PNCP/Compras.gov.br', () => {
    const combined = acceptIndexPopulationResponse(
      beginIndexPopulationView('IBUPROFENO|AMBAS'),
      'IBUPROFENO|AMBAS',
      officialSummary(2_566, {
        minimo: 0.08,
        maximo: 900,
        media: 22,
        mediana: 5,
        q1: 1,
        q3: 12,
      }),
    )
    expect(populationStatisticsCards(combined)?.n).toBe(2_566)

    const pncpPending = beginIndexPopulationView('IBUPROFENO|PNCP')
    expect(populationStatisticsCards(pncpPending)).toBeNull()
    const pncp = acceptIndexPopulationResponse(
      pncpPending,
      'IBUPROFENO|PNCP',
      officialSummary(2_035, {
        minimo: 0.19,
        maximo: 631.5,
        media: 18.42,
        mediana: 4.73,
        q1: 1.2,
        q3: 11.8,
      }),
    )

    expect(populationStatisticsCards(pncp)).toMatchObject({
      n: 2_035,
      minimum: 0.19,
      maximum: 631.5,
    })
    expect(populationStatisticsCards(pncp)?.maximum).not.toBe(900)

    // A resposta atrasada da visão anterior não pode contaminar a visão PNCP.
    const afterStaleCombined = acceptIndexPopulationResponse(
      pncp,
      'IBUPROFENO|AMBAS',
      officialSummary(9_999, {
        minimo: 1,
        maximo: 999,
        media: 99,
        mediana: 90,
        q1: 50,
        q3: 120,
      }),
    )
    expect(afterStaleCombined).toBe(pncp)
  })

  it('does not invent zero or a global population when the summary is absent or invalid', () => {
    const pending = beginIndexPopulationView('PICOLE|COMPRAS')
    const missing = acceptIndexPopulationResponse(pending, 'PICOLE|COMPRAS', {
      sucesso: true,
      summary_valid: true,
      statistics_valid: false,
      total: 148,
      hits: [{ id: 'loaded-row', unitPrice: 2.5 }],
      aggregations: { por_fonte: { 'Compras.gov.br': 148 } },
    })
    expect(missing).toEqual({
      viewKey: 'PICOLE|COMPRAS',
      status: 'unavailable',
      statistics: null,
    })
    expect(populationStatisticsCards(missing)).toBeNull()

    const invalid = acceptIndexPopulationResponse(
      beginIndexPopulationView('PICOLE|PNCP'),
      'PICOLE|PNCP',
      {
        ...officialSummary(148, {
          minimo: 1,
          maximo: 10,
          media: 4,
          mediana: 3,
          q1: 2,
          q3: 5,
        }),
        summary_valid: false,
      },
    )
    expect(populationStatisticsCards(invalid)).toBeNull()
  })

  it('hides a formerly valid population summary once the live index marks it stale', () => {
    const ready = acceptIndexPopulationResponse(
      beginIndexPopulationView('CARRO|AMBAS'),
      'CARRO|AMBAS',
      officialSummary(320, {
        minimo: 15_000,
        maximo: 410_000,
        media: 98_000,
        mediana: 82_000,
        q1: 60_000,
        q3: 120_000,
      }),
    )

    expect(populationStatisticsCards(ready, false)).toBeNull()
  })

  it('invalidates the previous product summary immediately when the search term changes', () => {
    const dipirona = acceptIndexPopulationResponse(
      beginIndexPopulationView('DIPIRONA|AMBAS'),
      'DIPIRONA|AMBAS',
      officialSummary(2_035, {
        minimo: 0.19,
        maximo: 631.5,
        media: 18.42,
        mediana: 4.73,
        q1: 1.2,
        q3: 11.8,
      }),
    )

    expect(populationStatisticsCards(dipirona)?.n).toBe(2_035)
    const afterTypingIbuprofeno = invalidateIndexPopulationView()
    expect(afterTypingIbuprofeno).toEqual({
      viewKey: '',
      status: 'idle',
      statistics: null,
    })
    expect(populationStatisticsCards(afterTypingIbuprofeno)).toBeNull()
    expect(shouldInvalidateIndexPopulationForTerm('DIPIRONA', 'IBUPROFENO')).toBe(true)
    expect(shouldInvalidateIndexPopulationForTerm(' DIPIRONA ', 'dipirona')).toBe(false)
  })

  it('leaves an isolated source view when Todas returns to the active AMBAS population', () => {
    const activeBothSources = 'IBUPROFENO|AMBAS|UF=CE'
    expect(shouldIsolateIndexPopulationView(activeBothSources, 'IBUPROFENO|PNCP|UF=CE')).toBe(
      true,
    )
    expect(shouldIsolateIndexPopulationView(activeBothSources, activeBothSources)).toBe(false)
  })
})
