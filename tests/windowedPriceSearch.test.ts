import { describe, expect, it } from 'vitest'
import {
  appendWindowPage,
  boundRowsPreservingSelection,
  createWindowFromFirstPage,
  deriveIndexContinuation,
  filterWindowRows,
  markWindowContinuationFailure,
  shouldAutoLoadWindow,
  updateWindowSelection,
} from '../src/lib/windowedPriceSearch'

interface Row {
  id: string
  source: 'PNCP' | 'Compras.gov.br'
  price: number
}

const rows = (prefix: string, count: number, source: Row['source'] = 'PNCP'): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    source,
    price: index + 1,
  }))

const idOf = (row: Row) => row.id

describe('windowed index results', () => {
  it('keeps the first response to 100 hits while retaining the complete summary', () => {
    const summary = { total: 4_711, perSource: { PNCP: 541, 'Compras.gov.br': 4_170 } }
    const state = createWindowFromFirstPage(
      {
        hits: rows('p1', 100),
        page: 1,
        pages: 48,
      },
      summary,
      idOf,
    )

    expect(state.rows).toHaveLength(100)
    expect(state.summary).toEqual(summary)
    expect(state.continuation).toEqual({ kind: 'page', page: 2 })
    expect(state.terminalConfirmed).toBe(false)
  })

  it('keeps at most six pages and 600 rows while advancing a cursor snapshot', () => {
    let state = createWindowFromFirstPage(
      {
        hits: rows('p1', 100),
        snapshot: 'snap-1',
        nextCursor: 'cursor-2',
        hasMore: true,
      },
      { total: 800 },
      idOf,
    )

    for (let page = 2; page <= 7; page++) {
      state = appendWindowPage(
        state,
        {
          hits: rows(`p${page}`, 100),
          snapshot: 'snap-1',
          nextCursor: page < 8 ? `cursor-${page + 1}` : null,
          hasMore: page < 8,
        },
        idOf,
      )
    }

    expect(state.pages).toHaveLength(6)
    expect(state.rows).toHaveLength(600)
    expect(state.rows.some((row) => row.id === 'p1-1')).toBe(false)
    expect(state.rows.some((row) => row.id === 'p7-100')).toBe(true)
    expect(state.continuation).toEqual({
      kind: 'cursor',
      cursor: 'cursor-8',
      snapshot: 'snap-1',
    })
  })

  it('pins a selected row when its old page leaves the six-page window', () => {
    let state = createWindowFromFirstPage(
      { hits: rows('p1', 100), page: 1, pages: 8 },
      { total: 800 },
      idOf,
    )
    state = updateWindowSelection(state, ['p1-9'], idOf)
    for (let page = 2; page <= 7; page++) {
      state = appendWindowPage(
        state,
        { hits: rows(`p${page}`, 100), page, pages: 8 },
        idOf,
      )
    }

    expect(state.rows).toHaveLength(600)
    expect(state.rows.some((row) => row.id === 'p1-9')).toBe(true)
    expect(state.selectedIds).toEqual(['p1-9'])
    expect(state.rows.some((row) => row.id === 'p2-1')).toBe(false)
  })

  it('bounds mixed live/index rows to 600 and keeps selected rows outside the newest slice', () => {
    const all = rows('mixed', 750)
    const bounded = boundRowsPreservingSelection(all, ['mixed-3'], idOf)

    expect(bounded).toHaveLength(600)
    expect(bounded.some((row) => row.id === 'mixed-3')).toBe(true)
    expect(bounded.some((row) => row.id === 'mixed-750')).toBe(true)
    expect(bounded.some((row) => row.id === 'mixed-4')).toBe(false)
  })

  it('filters a source locally without changing the loaded window or continuation', () => {
    const state = createWindowFromFirstPage(
      {
        hits: [...rows('pncp', 40), ...rows('compras', 60, 'Compras.gov.br')],
        page: 1,
        pages: 3,
      },
      { total: 300 },
      idOf,
    )

    const pncp = filterWindowRows(state, (row) => row.source === 'PNCP')
    expect(pncp).toHaveLength(40)
    expect(state.rows).toHaveLength(100)
    expect(state.continuation).toEqual({ kind: 'page', page: 2 })
  })

  it('retains the current rows and never invents completion after a continuation failure', () => {
    const state = createWindowFromFirstPage(
      { hits: rows('p1', 100), page: 1, pages: 5 },
      { total: 500 },
      idOf,
    )
    const failed = markWindowContinuationFailure(state, 'timeout')

    expect(failed.rows).toEqual(state.rows)
    expect(failed.continuation).toEqual({ kind: 'page', page: 2 })
    expect(failed.continuationError).toBe('timeout')
    expect(failed.terminalConfirmed).toBe(false)
  })

  it('preserves loaded rows but disables an expired snapshot continuation', () => {
    const state = createWindowFromFirstPage(
      {
        hits: rows('p1', 100),
        snapshot: 'snap-expiring',
        nextCursor: 'cursor-2',
        hasMore: true,
      },
      { total: 500 },
      idOf,
    )

    const expired = markWindowContinuationFailure(state, 'expired')

    expect(expired.rows).toEqual(state.rows)
    expect(expired.continuation).toBeNull()
    expect(expired.continuationError).toBe('expired')
    expect(expired.terminalConfirmed).toBe(false)
  })

  it('does not infer completion from a short page when the endpoint omits a cursor contract', () => {
    expect(deriveIndexContinuation({ hits: rows('short', 7) })).toEqual({ kind: 'unknown' })
    expect(
      deriveIndexContinuation({
        hits: rows('cursor', 10),
        snapshot: 'snap-2',
        nextCursor: 'opaque-next',
        hasMore: true,
      }),
    ).toEqual({ kind: 'cursor', cursor: 'opaque-next', snapshot: 'snap-2' })
    expect(deriveIndexContinuation({ hits: rows('last', 20), page: 3, pages: 3 })).toBeNull()
  })

  it('auto-loads only near the scroll edge and only with a known continuation', () => {
    const base = {
      scrollTop: 4_200,
      clientHeight: 500,
      scrollHeight: 5_000,
      loading: false,
      continuation: { kind: 'page', page: 2 } as const,
    }
    expect(shouldAutoLoadWindow(base)).toBe(true)
    expect(shouldAutoLoadWindow({ ...base, scrollTop: 1_000 })).toBe(false)
    expect(shouldAutoLoadWindow({ ...base, loading: true })).toBe(false)
    expect(
      shouldAutoLoadWindow({ ...base, continuation: { kind: 'unknown' } as const }),
    ).toBe(false)
  })

  it('rejects a drifting snapshot without mutating the current window', () => {
    const state = createWindowFromFirstPage(
      {
        hits: rows('p1', 100),
        snapshot: 'snap-a',
        nextCursor: 'cursor-2',
        hasMore: true,
      },
      { total: 200 },
      idOf,
    )

    expect(() =>
      appendWindowPage(
        state,
        {
          hits: rows('p2', 100),
          snapshot: 'snap-b',
          nextCursor: null,
          hasMore: false,
        },
        idOf,
      ),
    ).toThrow(/snapshot/i)
    expect(state.rows).toHaveLength(100)
    expect(state.snapshot).toBe('snap-a')
  })
})
