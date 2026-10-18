import { describe, expect, it } from 'vitest'
import {
  buildIndexViewQueryParams,
  loadIndexView,
  reconcileSelectionForIndexView,
} from '../src/components/modalSearchPolicy'

type Source = 'PNCP' | 'Compras.gov.br'

interface Row {
  id: string
  source: Source
}

const row = (id: string, source: Source): Row => ({ id, source })

describe('server-backed source view over the complete index population', () => {
  it('finds PNCP on the server even when the first 600 unfiltered rows are Compras.gov.br', async () => {
    const persisted: Row[] = [
      ...Array.from({ length: 600 }, (_, index) => row(`compras-${index + 1}`, 'Compras.gov.br')),
      ...Array.from({ length: 25 }, (_, index) => row(`pncp-${index + 1}`, 'PNCP')),
    ]

    const loaded = await loadIndexView(
      {
        palavra_chave: 'IBUPROFENO',
        pagina: 4,
        tamanho_pagina: 100,
        cursor: 'old-cursor',
        snapshot: 'old-snapshot',
      },
      ['PNCP'],
      async (params) => {
        const sources = new Set((params.sources as string[] | undefined) ?? [])
        const filtered = sources.size
          ? persisted.filter((candidate) => sources.has(candidate.source))
          : persisted
        return {
          hits: filtered.slice(0, Number(params.tamanho_pagina)),
          total: filtered.length,
          aggregations: {
            por_fonte: filtered.reduce<Record<string, number>>((counts, candidate) => {
              counts[candidate.source] = (counts[candidate.source] ?? 0) + 1
              return counts
            }, {}),
          },
        }
      },
    )

    expect(loaded.response.total).toBe(25)
    expect(loaded.response.hits).toHaveLength(25)
    expect(loaded.response.hits.every((candidate) => candidate.source === 'PNCP')).toBe(true)
    expect(loaded.params).toMatchObject({
      pagina: 1,
      page: 1,
      tamanho_pagina: 100,
      limit: 100,
      fonte: 'PNCP',
      sources: ['PNCP'],
    })
    expect(loaded.params.cursor).toBeUndefined()
    expect(loaded.params.snapshot).toBeUndefined()
  })

  it('removing the source filter re-queries both official sources from page one', () => {
    expect(
      buildIndexViewQueryParams(
        {
          palavra_chave: 'MANUTENCAO PREDIAL',
          pagina: 6,
          page: 6,
          fonte: 'PNCP',
          sources: ['PNCP'],
          cursor: 'stale',
          snapshot: 'stale',
        },
        [],
      ),
    ).toEqual({
      palavra_chave: 'MANUTENCAO PREDIAL',
      pagina: 1,
      page: 1,
      tamanho_pagina: 100,
      limit: 100,
      fonte: undefined,
      sources: undefined,
      cursor: undefined,
      snapshot: undefined,
    })
  })

  it('clears and reports selected rows hidden by the new source view', () => {
    const currentRows = [
      row('selected-compras', 'Compras.gov.br'),
      row('selected-pncp', 'PNCP'),
      row('not-selected', 'Compras.gov.br'),
    ]

    expect(
      reconcileSelectionForIndexView(currentRows, ['selected-compras', 'selected-pncp'], ['PNCP']),
    ).toEqual({
      selectedIds: ['selected-pncp'],
      hiddenSelectedIds: ['selected-compras'],
      pinnedRows: [currentRows[1]],
    })
  })
})
