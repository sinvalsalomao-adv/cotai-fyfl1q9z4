export interface IndexPopulationStatistics {
  n: number
  minimum: number
  maximum: number
  average: number
  median: number
  q1: number
  q3: number
}

export type IndexPopulationViewStatus = 'idle' | 'pending' | 'ready' | 'unavailable'

export interface IndexPopulationViewState {
  viewKey: string
  status: IndexPopulationViewStatus
  statistics: IndexPopulationStatistics | null
}

interface IndexPopulationResponse {
  sucesso?: boolean
  timed_out?: boolean
  summary_valid?: boolean
  statistics_valid?: boolean
  total?: unknown
  aggregations?: {
    estatisticas?: Record<string, unknown> | null
  } | null
}

const IDLE_VIEW: IndexPopulationViewState = {
  viewKey: '',
  status: 'idle',
  statistics: null,
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function orderedPositiveStatistics(statistics: IndexPopulationStatistics): boolean {
  if (statistics.n === 0) {
    return [
      statistics.minimum,
      statistics.maximum,
      statistics.average,
      statistics.median,
      statistics.q1,
      statistics.q3,
    ].every((value) => value === 0)
  }

  return (
    statistics.minimum > 0 &&
    statistics.minimum <= statistics.q1 &&
    statistics.q1 <= statistics.median &&
    statistics.median <= statistics.q3 &&
    statistics.q3 <= statistics.maximum &&
    statistics.average >= statistics.minimum &&
    statistics.average <= statistics.maximum
  )
}

/**
 * Accepts only a complete, current summary produced by the index query itself.
 * Loaded rows are deliberately not used as a fallback for the full population.
 */
export function extractIndexPopulationStatistics(
  response: IndexPopulationResponse,
): IndexPopulationStatistics | null {
  if (
    !response ||
    response.sucesso === false ||
    response.timed_out === true ||
    response.summary_valid !== true ||
    response.statistics_valid !== true ||
    !Number.isSafeInteger(response.total) ||
    (response.total as number) < 0
  ) {
    return null
  }

  const raw = response.aggregations?.estatisticas
  if (!raw || typeof raw !== 'object') return null

  const values = [raw.minimo, raw.maximo, raw.media, raw.mediana, raw.q1, raw.q3]
  if (!Number.isSafeInteger(raw.n) || raw.n !== response.total || !values.every(finiteNumber)) {
    return null
  }

  const statistics: IndexPopulationStatistics = {
    n: raw.n as number,
    minimum: raw.minimo as number,
    maximum: raw.maximo as number,
    average: raw.media as number,
    median: raw.mediana as number,
    q1: raw.q1 as number,
    q3: raw.q3 as number,
  }
  return orderedPositiveStatistics(statistics) ? statistics : null
}

export function emptyIndexPopulationView(): IndexPopulationViewState {
  return { ...IDLE_VIEW }
}

/** Semantic reset used when the typed term no longer identifies the shown population. */
export function invalidateIndexPopulationView(): IndexPopulationViewState {
  return emptyIndexPopulationView()
}

export function shouldInvalidateIndexPopulationForTerm(
  displayedTerm: string,
  nextTerm: string,
): boolean {
  return displayedTerm.trim().toUpperCase() !== nextTerm.trim().toUpperCase()
}

export function beginIndexPopulationView(viewKey: string): IndexPopulationViewState {
  return {
    viewKey,
    status: 'pending',
    statistics: null,
  }
}

/**
 * Settles only the currently displayed query/filter view. A late response from
 * an older view is ignored instead of replacing the visible population cards.
 */
export function acceptIndexPopulationResponse(
  current: IndexPopulationViewState,
  viewKey: string,
  response: IndexPopulationResponse,
): IndexPopulationViewState {
  if (current.viewKey !== viewKey) return current
  const statistics = extractIndexPopulationStatistics(response)
  return {
    viewKey,
    status: statistics ? 'ready' : 'unavailable',
    statistics,
  }
}

export function populationStatisticsCards(
  state: IndexPopulationViewState,
  summaryCurrent = true,
): IndexPopulationStatistics | null {
  return summaryCurrent && state.status === 'ready' ? state.statistics : null
}

/**
 * Live collection updates may feed only the exact AMBAS view they were started
 * for. A source/refinement view remains isolated until it returns to that key.
 */
export function shouldIsolateIndexPopulationView(
  activeCollectionViewKey: string,
  nextViewKey: string,
): boolean {
  return activeCollectionViewKey.length === 0 || nextViewKey !== activeCollectionViewKey
}

const PAGINATION_FIELDS = new Set([
  'pagina',
  'page',
  'tamanho_pagina',
  'limit',
  'cursor',
  'snapshot',
  'include_summary',
])

/** Stable identity for the population represented by a first-page summary. */
export function buildIndexPopulationViewKey(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([key, value]) => !PAGINATION_FIELDS.has(key) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
  return JSON.stringify(entries)
}
