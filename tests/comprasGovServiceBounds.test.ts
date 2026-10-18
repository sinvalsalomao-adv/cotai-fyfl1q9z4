import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/pocketbase/client', () => ({
  default: {
    baseUrl: 'https://cotai.test',
    authStore: { token: 'test-token' },
  },
}))

import { ComprasGovService } from '../src/lib/comprasGovService'

afterEach(() => vi.unstubAllGlobals())

describe('ComprasGovService request bounds', () => {
  it.each([
    [undefined, '20'],
    [999, '20'],
    [3, '3'],
  ])('keeps limite_paginas inside the backend contract (%s -> %s)', async (requested, expected) => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ dados: { resultado: [], totalRegistros: 0 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await ComprasGovService.consultarComprasGov({
      termo: 'cadeira escolar',
      limite_paginas: requested,
    })

    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get('limite_paginas')).toBe(expected)
  })
})
