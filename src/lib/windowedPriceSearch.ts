export const PRICE_INDEX_PAGE_LIMIT = 100
export const PRICE_INDEX_WINDOW_PAGES = 6
export const PRICE_INDEX_WINDOW_ROWS = PRICE_INDEX_PAGE_LIMIT * PRICE_INDEX_WINDOW_PAGES
export type SnapshotConsistency = 'frozen_v1' | 'fixed_ids_current_evidence'

/** Shared by both loaders; a drift can spend only one index refresh per query/view. */
export function consumeIndexDriftRefresh(
  used: Set<string>,
  generation: number,
  viewKey: string,
  error: unknown,
): boolean {
  const failure = error as { status?: unknown; code?: unknown } | null
  if (failure?.status !== 409 || failure.code !== 'SEARCH_SNAPSHOT_DRIFT' || !viewKey) return false
  const key = JSON.stringify([generation, viewKey])
  if (used.has(key)) return false
  used.add(key)
  return true
}

export interface IndexWindowPage<T> {
  hits: T[]
  page?: number
  pages?: number
  snapshot?: string
  snapshotConsistency?: SnapshotConsistency
  nextCursor?: string | null
  hasMore?: boolean
}

export type IndexContinuation =
  | { kind: 'cursor'; cursor: string; snapshot: string }
  | { kind: 'page'; page: number }
  | { kind: 'unknown' }
  | null

export interface WindowPageReference {
  key: string
  ids: string[]
}

export interface WindowedPriceSearchState<T, TSummary = unknown> {
  rows: T[]
  pages: WindowPageReference[]
  selectedIds: string[]
  summary: TSummary
  snapshot?: string
  snapshotConsistency?: SnapshotConsistency
  continuation: IndexContinuation
  continuationError: string | null
  terminalConfirmed: boolean
  maxPages: number
  maxRows: number
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function deriveIndexContinuation<T>(page: IndexWindowPage<T>): IndexContinuation {
  if (page.hasMore === false) return null
  if (nonEmptyString(page.nextCursor) && nonEmptyString(page.snapshot)) {
    return { kind: 'cursor', cursor: page.nextCursor, snapshot: page.snapshot }
  }
  if (
    Number.isInteger(page.page) &&
    Number.isInteger(page.pages) &&
    (page.page as number) >= 1 &&
    (page.pages as number) >= (page.page as number)
  ) {
    return (page.page as number) < (page.pages as number)
      ? { kind: 'page', page: (page.page as number) + 1 }
      : null
  }
  // A página curta não prova que o snapshot terminou. Sem cursor ou total de
  // páginas explícito, o cliente preserva o estado como desconhecido.
  return { kind: 'unknown' }
}

function assertPageSize<T>(page: IndexWindowPage<T>): void {
  if (!Array.isArray(page.hits)) throw new Error('Página do índice sem lista de resultados.')
  if (page.hits.length > PRICE_INDEX_PAGE_LIMIT) {
    throw new Error(`Página do índice excede ${PRICE_INDEX_PAGE_LIMIT} resultados.`)
  }
}

function pageKey<T>(page: IndexWindowPage<T>, sequence: number): string {
  if (nonEmptyString(page.nextCursor)) return `cursor:${page.nextCursor}`
  if (Number.isInteger(page.page)) return `page:${page.page}`
  return `window:${sequence}`
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)))
}

function rebuildRows<T>(
  rowsById: Map<string, T>,
  pages: WindowPageReference[],
  selectedIds: string[],
  maxRows: number,
): { rows: T[]; pages: WindowPageReference[]; selectedIds: string[] } {
  const selected = uniqueIds(selectedIds).filter((id) => rowsById.has(id))
  if (selected.length > maxRows) {
    throw new Error('A seleção excede a capacidade segura da janela de resultados.')
  }

  const newestFirst: string[] = []
  for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex--) {
    const ids = pages[pageIndex].ids
    for (let rowIndex = ids.length - 1; rowIndex >= 0; rowIndex--) {
      const id = ids[rowIndex]
      if (rowsById.has(id) && !selected.includes(id) && !newestFirst.includes(id)) {
        newestFirst.push(id)
      }
    }
  }
  const keptUnselected = new Set(newestFirst.slice(0, Math.max(0, maxRows - selected.length)))
  const kept = new Set([...selected, ...keptUnselected])
  const boundedPages = pages
    .map((page) => ({ ...page, ids: page.ids.filter((id) => kept.has(id)) }))
    .filter((page) => page.ids.length > 0)

  const orderedIds: string[] = []
  for (const page of boundedPages) {
    for (const id of page.ids) if (!orderedIds.includes(id)) orderedIds.push(id)
  }
  // Uma linha selecionada de uma página expulsa continua utilizável e visível.
  for (const id of selected) if (!orderedIds.includes(id)) orderedIds.unshift(id)

  return {
    rows: orderedIds.map((id) => rowsById.get(id)!).filter(Boolean),
    pages: boundedPages,
    selectedIds: selected,
  }
}

export function createWindowFromFirstPage<T, TSummary>(
  page: IndexWindowPage<T>,
  summary: TSummary,
  getId: (row: T) => string,
  options: { maxPages?: number; maxRows?: number } = {},
): WindowedPriceSearchState<T, TSummary> {
  assertPageSize(page)
  const maxPages = options.maxPages ?? PRICE_INDEX_WINDOW_PAGES
  const maxRows = options.maxRows ?? PRICE_INDEX_WINDOW_ROWS
  const rowsById = new Map(page.hits.map((row) => [getId(row), row]))
  const pages = [{ key: pageKey(page, 1), ids: uniqueIds(page.hits.map(getId)) }]
  const rebuilt = rebuildRows(rowsById, pages, [], maxRows)
  const continuation = deriveIndexContinuation(page)
  return {
    ...rebuilt,
    summary,
    snapshot: nonEmptyString(page.snapshot) ? page.snapshot : undefined,
    snapshotConsistency: page.snapshotConsistency,
    continuation,
    continuationError: null,
    terminalConfirmed: continuation === null,
    maxPages,
    maxRows,
  }
}

export function updateWindowSelection<T, TSummary>(
  state: WindowedPriceSearchState<T, TSummary>,
  selectedIds: string[],
  getId: (row: T) => string,
): WindowedPriceSearchState<T, TSummary> {
  const rowsById = new Map(state.rows.map((row) => [getId(row), row]))
  const rebuilt = rebuildRows(rowsById, state.pages, selectedIds, state.maxRows)
  return { ...state, ...rebuilt }
}

export function appendWindowPage<T, TSummary>(
  state: WindowedPriceSearchState<T, TSummary>,
  page: IndexWindowPage<T>,
  getId: (row: T) => string,
): WindowedPriceSearchState<T, TSummary> {
  assertPageSize(page)
  if (state.snapshot && page.snapshot && state.snapshot !== page.snapshot) {
    throw new Error('O snapshot do índice mudou durante a continuação.')
  }
  if (state.snapshotConsistency && page.snapshotConsistency !== state.snapshotConsistency)
    throw new Error('A semântica do snapshot mudou durante a continuação.')
  const rowsById = new Map(state.rows.map((row) => [getId(row), row]))
  for (const row of page.hits) rowsById.set(getId(row), row)
  const pages = [
    ...state.pages,
    { key: pageKey(page, state.pages.length + 1), ids: uniqueIds(page.hits.map(getId)) },
  ].slice(-state.maxPages)
  const rebuilt = rebuildRows(rowsById, pages, state.selectedIds, state.maxRows)
  const continuation = deriveIndexContinuation(page)
  return {
    ...state,
    ...rebuilt,
    snapshot: state.snapshot || (nonEmptyString(page.snapshot) ? page.snapshot : undefined),
    continuation,
    continuationError: null,
    terminalConfirmed: continuation === null,
  }
}

export function markWindowContinuationFailure<T, TSummary>(
  state: WindowedPriceSearchState<T, TSummary>,
  category: string,
): WindowedPriceSearchState<T, TSummary> {
  return {
    ...state,
    // An expired materialized snapshot can never be resumed. Retain the rows
    // already shown, but remove the cursor so scroll cannot retry it forever.
    continuation: category === 'expired' || category === 'drift' ? null : state.continuation,
    continuationError: category || 'unavailable',
    terminalConfirmed: false,
  }
}

export function filterWindowRows<T, TSummary>(
  state: WindowedPriceSearchState<T, TSummary>,
  predicate: (row: T) => boolean,
): T[] {
  return state.rows.filter(predicate)
}

export function boundRowsPreservingSelection<T>(
  rows: T[],
  selectedIds: string[],
  getId: (row: T) => string,
  maxRows = PRICE_INDEX_WINDOW_ROWS,
): T[] {
  const byId = new Map(rows.map((row) => [getId(row), row]))
  const selected = uniqueIds(selectedIds)
    .map((id) => byId.get(id))
    .filter((row): row is T => Boolean(row))
  if (selected.length > maxRows) {
    throw new Error('A seleção excede a capacidade segura da janela de resultados.')
  }
  const selectedSet = new Set(selected.map(getId))
  const newestUnselected = rows
    .filter((row) => !selectedSet.has(getId(row)))
    .slice(-(maxRows - selected.length))
  return [...selected, ...newestUnselected]
}

export function shouldAutoLoadWindow(input: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  loading: boolean
  continuation: IndexContinuation
  thresholdPx?: number
}): boolean {
  if (
    input.loading ||
    !input.continuation ||
    input.continuation.kind === 'unknown' ||
    input.clientHeight <= 0 ||
    input.scrollHeight <= 0
  )
    return false
  const remaining = input.scrollHeight - (input.scrollTop + input.clientHeight)
  return remaining <= (input.thresholdPx ?? 320)
}

export const NUMBERED_PRICE_PAGE_SIZE = 20
export interface NumberedPricePage<T> {
  rows: T[]
  rawCount: number
  page?: number
  pages?: number | null
  total?: number | null
  snapshot?: string
  snapshotConsistency?: SnapshotConsistency
}
export interface NumberedPriceSearchState<T> extends NumberedPricePage<T> {
  page: number
  pages: number | null
  summary: { total: number | null }
  sequence: number
  pendingPage: number | null
  failedPage: number | null
  continuationError: string | null
}

export function createNumberedPricePage<T>(
  input: NumberedPricePage<T>,
): NumberedPriceSearchState<T> {
  if (input.rows.length > NUMBERED_PRICE_PAGE_SIZE || input.rawCount > NUMBERED_PRICE_PAGE_SIZE)
    throw new Error('A página excede 20 resultados.')
  return {
    ...input,
    page: Number.isSafeInteger(input.page) && input.page! > 0 ? input.page! : 1,
    pages: Number.isSafeInteger(input.pages) && input.pages! > 0 ? input.pages! : null,
    summary: {
      total: Number.isSafeInteger(input.total) && input.total! >= 0 ? input.total! : null,
    },
    sequence: 0,
    pendingPage: null,
    failedPage: null,
    continuationError: null,
  }
}

export function beginNumberedPageRequest<T>(
  state: NumberedPriceSearchState<T>,
  page: number,
): NumberedPriceSearchState<T> {
  if (
    !state.snapshot ||
    !state.pages ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > state.pages
  )
    throw new Error('Página indisponível nesta captura.')
  return {
    ...state,
    sequence: state.sequence + 1,
    pendingPage: page,
    failedPage: null,
    continuationError: null,
  }
}

export function acceptNumberedPage<T>(
  state: NumberedPriceSearchState<T>,
  response: NumberedPricePage<T>,
  sequence: number,
): NumberedPriceSearchState<T> {
  if (sequence !== state.sequence) return state
  if (
    response.snapshot !== state.snapshot ||
    response.snapshotConsistency !== state.snapshotConsistency ||
    response.page !== state.pendingPage ||
    response.pages !== state.pages ||
    response.total !== state.summary.total
  )
    throw new Error('A página não pertence à mesma captura de resultados.')
  return { ...createNumberedPricePage(response), sequence }
}

export function failNumberedPage<T>(
  state: NumberedPriceSearchState<T>,
  sequence: number,
  category: string,
): NumberedPriceSearchState<T> {
  if (sequence !== state.sequence) return state
  return { ...state, pendingPage: null, failedPage: state.pendingPage, continuationError: category }
}

export function canAutoFillNumberedPage<T>(state: NumberedPriceSearchState<T> | null): boolean {
  return Boolean(
    state &&
    state.rawCount === 0 &&
    state.page === 1 &&
    state.pendingPage === null &&
    !state.continuationError,
  )
}

/** Selection keeps its exact evidence; only current-page IDs are rendered by the caller. */
export function retainSelectedPriceEvidence<T extends { id: string }>(
  previous: T[],
  selectedIds: string[],
  page: T[],
): T[] {
  const selected = new Set(selectedIds)
  const pinned = previous.filter((row) => selected.has(row.id))
  const pinnedIds = new Set(pinned.map((row) => row.id))
  return [...pinned, ...page.filter((row) => !pinnedIds.has(row.id))]
}

export function visibleNumberedPages(page: number, pages: number | null): (number | string)[] {
  if (pages === null) return [page]
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const left = Math.max(2, page - 1),
    right = Math.min(pages - 1, page + 1)
  return [
    1,
    ...(left > 2 ? ['…'] : []),
    ...Array.from({ length: right - left + 1 }, (_, index) => left + index),
    ...(right < pages - 1 ? ['…'] : []),
    pages,
  ]
}

export function numberedPageRange<T>(
  state: NumberedPriceSearchState<T>,
  visibleCount: number,
  localFilters: boolean,
): string {
  const start = state.rawCount ? (state.page - 1) * NUMBERED_PRICE_PAGE_SIZE + 1 : 0
  const end = state.rawCount ? start + state.rawCount - 1 : 0
  const total = state.summary.total
  const range =
    total === null
      ? `${start}–${end} · Total não confirmado`
      : `${start}–${end} de ${total.toLocaleString('pt-BR')}`
  const position = `Página ${state.page}${state.pages === null ? ' · quantidade de páginas não confirmada' : ` de ${state.pages}`}`
  return localFilters || visibleCount !== state.rawCount
    ? `${visibleCount} amostra(s) visível(is) nesta página · Posições ${range} na captura antes dos filtros locais · ${position}`
    : `${range} resultados · ${position}`
}
