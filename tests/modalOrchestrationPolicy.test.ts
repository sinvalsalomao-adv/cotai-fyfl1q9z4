import { describe, expect, it } from 'vitest'
import {
  buildOfficialCollectionIdentity,
  buildIndexPopulationFilterPlan,
  buildOfficialQueryParams,
  buildOfficialSourceFilterCounts,
  decideFilterChange,
  decideObservationAfterSuccess,
  decidePollFailure,
  filterLoadedSamplesBySources,
  indexContinuationFailureCategory,
  loadedWindowMedian,
  resolveOfficialEvidenceUrl,
  sampleMatchesUf,
  shouldCompleteSharedObserver,
  shouldPauseSharedObserverForPncp,
  shouldRefreshIndexPopulation,
  validateConfirmationSelection,
} from '../src/components/modalSearchPolicy'

describe('index continuation failures', () => {
  it('recognizes the typed 410 snapshot-expired response without treating other failures as expired', () => {
    expect(
      indexContinuationFailureCategory({
        status: 410,
        code: 'SEARCH_SNAPSHOT_EXPIRED',
      }),
    ).toBe('expired')
    expect(indexContinuationFailureCategory({ status: 410 })).toBe('expired')
    expect(indexContinuationFailureCategory({ code: 'SEARCH_SNAPSHOT_EXPIRED' })).toBe('expired')
    expect(indexContinuationFailureCategory({ timed_out: true })).toBe('timeout')
    expect(indexContinuationFailureCategory({ status: 503 })).toBe('unavailable')
  })
})

describe('official source counters', () => {
  const loaded = [
    { id: 'pncp-ok', source: 'PNCP', verified: true },
    { id: 'pncp-rejected', source: 'PNCP', verified: false },
    { id: 'compras-ok', source: 'Compras.gov.br', verified: true },
  ]
  const eligible = (sample: (typeof loaded)[number]) => sample.verified

  it('shows each complete indexed population separately from the pages already loaded', () => {
    expect(
      buildOfficialSourceFilterCounts({
        samples: loaded,
        perSourceIndex: { PNCP: 541, 'Compras.gov.br': 4_170 },
        totalIndex: 4_711,
        summaryComplete: true,
        isEligible: eligible,
      }),
    ).toEqual([
      { key: 'PNCP', label: 'PNCP', count: 1, indexedCount: 541 },
      {
        key: 'Compras.gov.br',
        label: 'Compras.gov.br',
        count: 1,
        indexedCount: 4_170,
      },
    ])
  })

  it('uses only honest loaded counts when the per-source summary is absent or stale', () => {
    expect(
      buildOfficialSourceFilterCounts({
        samples: loaded,
        perSourceIndex: { PNCP: 541, 'Compras.gov.br': 4_170 },
        totalIndex: 4_711,
        summaryComplete: false,
        isEligible: eligible,
      }),
    ).toEqual([
      { key: 'PNCP', label: 'PNCP', count: 1 },
      { key: 'Compras.gov.br', label: 'Compras.gov.br', count: 1 },
    ])
  })

  it('does not mix an inconsistent global total into either source counter', () => {
    expect(
      buildOfficialSourceFilterCounts({
        samples: loaded,
        perSourceIndex: { PNCP: 6, 'Compras.gov.br': 1_032 },
        totalIndex: 15_370,
        summaryComplete: true,
        isEligible: eligible,
      }),
    ).toEqual([
      { key: 'PNCP', label: 'PNCP', count: 1 },
      { key: 'Compras.gov.br', label: 'Compras.gov.br', count: 1 },
    ])
  })

  it('reports a confirmed empty indexed population as zero for both official sources', () => {
    expect(
      buildOfficialSourceFilterCounts({
        samples: [],
        perSourceIndex: {},
        totalIndex: 0,
        summaryComplete: true,
      }),
    ).toEqual([
      { key: 'PNCP', label: 'PNCP', count: 0, indexedCount: 0 },
      { key: 'Compras.gov.br', label: 'Compras.gov.br', count: 0, indexedCount: 0 },
    ])
  })
})

describe('official collection is independent from the visual source filter', () => {
  it('keeps the collection identity and both-source query when the user views PNCP only', () => {
    const common = {
      item: 'item-1',
      termo: 'IBUPROFENO',
      tipo: 'palavras',
      uf: 'CE',
      fonte: 'PNCP',
      fontes: ['PNCP'],
    }

    expect(buildOfficialCollectionIdentity(common)).toBe(
      buildOfficialCollectionIdentity({ ...common, fonte: undefined, fontes: [] }),
    )
    expect(buildOfficialQueryParams(common)).toEqual({
      item: 'item-1',
      termo: 'IBUPROFENO',
      tipo: 'palavras',
      uf: 'CE',
      fonte: undefined,
    })
    const loaded = [
      { id: 'pncp', source: 'PNCP' },
      { id: 'compras', source: 'Compras.gov.br' },
    ]
    expect(decideFilterChange()).toEqual({
      queryOfficialSources: false,
      queryIndexView: true,
      preserveLoadedPopulation: true,
    })
    expect(filterLoadedSamplesBySources(loaded, ['PNCP']).map((row) => row.id)).toEqual(['pncp'])
    expect(loaded).toHaveLength(2)
  })

  it('excludes zero and unverified rows before the loaded population is filtered by source', () => {
    const loaded = [
      { id: 'valid-pncp', source: 'PNCP', unit_price: 1.25, verified: true },
      { id: 'zero-pncp', source: 'PNCP', unit_price: 0, verified: true },
      { id: 'unverified-pncp', source: 'PNCP', unit_price: 2.5, verified: false },
      { id: 'valid-compras', source: 'Compras.gov.br', unit_price: 3.75, verified: true },
    ]
    const eligible = (row: (typeof loaded)[number]) => row.unit_price > 0 && row.verified

    expect(filterLoadedSamplesBySources(loaded, [], eligible).map((row) => row.id)).toEqual([
      'valid-pncp',
      'valid-compras',
    ])
    expect(filterLoadedSamplesBySources(loaded, ['PNCP'], eligible).map((row) => row.id)).toEqual([
      'valid-pncp',
    ])
  })

  it('returns the proof-bound URL instead of an arbitrary legacy source URL', () => {
    const sample = {
      source_url: 'https://attacker.example/preco-falso',
      raw_data: {
        proveniencia_preco: {
          url_evidencia:
            'https://pncp.gov.br/api/pncp/v1/orgaos/12345678000199/compras/2025/7/itens/1/resultados',
        },
      },
    }
    expect(resolveOfficialEvidenceUrl(sample, () => true)).toBe(
      sample.raw_data.proveniencia_preco.url_evidencia,
    )
    expect(resolveOfficialEvidenceUrl(sample, () => false)).toBeNull()
  })

  it.each([
    ['credentials', 'https://user:pass@pncp.gov.br/api/pncp/v1/item'],
    ['explicit default port', 'https://pncp.gov.br:443/api/pncp/v1/item'],
    ['empty fragment delimiter', 'https://pncp.gov.br/api/pncp/v1/item#'],
    ['raw whitespace', 'https://pncp.gov.br/api/pncp/v1/item 1'],
    ['raw backslash', 'https://pncp.gov.br\\api\\pncp\\v1\\item'],
    ['query immediately after host', 'https://pncp.gov.br?item=1'],
  ])('never resolves a malformed official-looking URL with %s', (_label, url) => {
    const sample = {
      raw_data: { proveniencia_preco: { url_evidencia: url } },
    }
    expect(resolveOfficialEvidenceUrl(sample, () => true)).toBeNull()
  })
})

describe('indexed population refinements', () => {
  const baseFilters = {
    tipoPalavras: 'palavras' as const,
    ordenacao: 'menor_preco' as const,
    cnpj: '',
    periodoMeses: 0,
    uf: '',
    dataInicio: '',
    dataFim: '',
    precoMin: '',
    precoMax: '',
    porte: 'TODAS' as const,
    unidade: '',
    marca: '',
    situacao: 'todas',
    toleranciaMedianaPct: '',
  }

  it.each([
    ['tipoPalavras', 'exata'],
    ['ordenacao', 'maior_preco'],
    ['cnpj', '12.345.678/0001-99'],
    ['periodoMeses', 12],
    ['uf', 'CE'],
    ['dataInicio', '2025-01-01'],
    ['dataFim', '2025-12-31'],
    ['precoMin', '1,25'],
    ['precoMax', '900'],
    ['porte', 'ME_EPP'],
    ['unidade', 'UNIDADE'],
    ['marca', 'GENÉRICO'],
  ] as const)('requires a fresh index view when backend refinement %s changes', (field, value) => {
    const previous = buildIndexPopulationFilterPlan(baseFilters)
    const next = buildIndexPopulationFilterPlan({ ...baseFilters, [field]: value })

    expect(next.serverViewKey).not.toBe(previous.serverViewKey)
    expect(shouldRefreshIndexPopulation(previous.serverViewKey, next.serverViewKey, true)).toBe(
      true,
    )
  })

  it.each([
    ['situacao', 'selecionados'],
    ['toleranciaMedianaPct', '25'],
  ] as const)(
    'hides the global summary instead of claiming that visual-only filter %s changed the population',
    (field, value) => {
      const previous = buildIndexPopulationFilterPlan(baseFilters)
      const next = buildIndexPopulationFilterPlan({ ...baseFilters, [field]: value })

      expect(next.serverViewKey).toBe(previous.serverViewKey)
      expect(next.visualOnlyFiltersActive).toBe(true)
      expect(shouldRefreshIndexPopulation(previous.serverViewKey, next.serverViewKey, true)).toBe(
        false,
      )
    },
  )

  it('does not query before the user has executed a search', () => {
    const previous = buildIndexPopulationFilterPlan(baseFilters)
    const next = buildIndexPopulationFilterPlan({ ...baseFilters, uf: 'CE' })
    expect(shouldRefreshIndexPopulation(previous.serverViewKey, next.serverViewKey, false)).toBe(
      false,
    )
  })
})

describe('index observation lifecycle', () => {
  it('does not stop after six unchanged successful observations while work is pending', () => {
    expect(
      decideObservationAfterSuccess({
        now: 10_000,
        deadline: 120_000,
        unchangedCycles: 6,
        terminalConfirmed: false,
        workPending: true,
      }),
    ).toEqual({ action: 'continue', delayMs: 10_500 })
  })

  it('stops on confirmed completion and bounds orphan observation at its deadline', () => {
    expect(
      decideObservationAfterSuccess({
        now: 10_000,
        deadline: 120_000,
        unchangedCycles: 20,
        terminalConfirmed: true,
        workPending: false,
      }),
    ).toEqual({ action: 'complete', delayMs: 0 })
    expect(
      decideObservationAfterSuccess({
        now: 120_000,
        deadline: 120_000,
        unchangedCycles: 1,
        terminalConfirmed: false,
        workPending: true,
      }),
    ).toEqual({ action: 'stop', delayMs: 0, reason: 'deadline' })
    expect(
      decideObservationAfterSuccess({
        now: 119_500,
        deadline: 120_000,
        unchangedCycles: 20,
        terminalConfirmed: false,
        workPending: true,
      }),
    ).toEqual({ action: 'continue', delayMs: 21_000 })
  })

  it('uses bounded retries before the deadline and stops failed orphan polling at the deadline', () => {
    const retry = decidePollFailure({
      now: 10_000,
      deadline: 120_000,
      consecutiveFailures: 4,
      automaticRecoveries: 3,
    })
    expect(retry.action).toBe('cooldown')
    expect(retry.delayMs).toBeGreaterThanOrEqual(12_000)
    expect(retry.delayMs).toBeLessThanOrEqual(30_000)
    expect(
      decidePollFailure({
        now: 119_500,
        deadline: 120_000,
        consecutiveFailures: 1,
        automaticRecoveries: 0,
      }),
    ).toEqual({ action: 'retry', delayMs: 5_500 })
    expect(
      decidePollFailure({
        now: 120_000,
        deadline: 120_000,
        consecutiveFailures: 4,
        automaticRecoveries: 3,
      }),
    ).toEqual({ action: 'stop', delayMs: 0, reason: 'deadline' })
  })

  it('does not pause the shared observer when only the bounded direct PNCP turn expires', () => {
    expect(shouldPauseSharedObserverForPncp({ pausada: true, backendContinua: true })).toBe(false)
    expect(shouldPauseSharedObserverForPncp({ pausada: true, backendContinua: false })).toBe(true)
  })

  it('does not complete after a clean index read while PNCP confirms backend work remains', () => {
    const settledView = {
      directSourcesActive: false,
      pncpContinuationPaused: false,
      taskFailed: false,
      taskActive: false,
      taskPending: 0,
      queuePending: 0,
      reconciliationPending: false,
    }

    expect(
      shouldCompleteSharedObserver({
        ...settledView,
        pncpBackendContinues: true,
      }),
    ).toBe(false)
    expect(
      shouldCompleteSharedObserver({
        ...settledView,
        pncpBackendContinues: false,
      }),
    ).toBe(true)
  })
})

describe('loaded-window refinements and confirmation', () => {
  it('derives tolerance from the currently loaded and already-refined window only', () => {
    expect(loadedWindowMedian([{ unit_price: 2 }, { unit_price: 100 }, { unit_price: 4 }])).toBe(4)
    expect(loadedWindowMedian([{ unit_price: 2 }, { unit_price: 4 }])).toBe(3)
    expect(loadedWindowMedian([{ unit_price: 0 }, { unit_price: Number.NaN }])).toBe(0)
  })

  it('keeps an indexed row whose canonical raw UF matches the server-side UF view', () => {
    expect(
      sampleMatchesUf(
        {
          government_entity: 'Órgão sem sigla no nome',
          raw_data: { uf: 'ce', municipio_uf: 'Fortaleza - CE' },
        },
        'CE',
      ),
    ).toBe(true)
    expect(sampleMatchesUf({ raw_data: { uf: 'SP' } }, 'CE')).toBe(false)
    expect(sampleMatchesUf({ raw_data: { uf: 'SP' } }, '')).toBe(true)
  })

  it('rejects more than three selected samples instead of silently discarding the extras', () => {
    expect(validateConfirmationSelection(['a', 'b', 'b', 'c'])).toEqual({
      ok: true,
      ids: ['a', 'b', 'c'],
      max: 3,
    })
    expect(validateConfirmationSelection(['a', 'b', 'c', 'd'])).toEqual({
      ok: false,
      ids: ['a', 'b', 'c', 'd'],
      max: 3,
    })
  })
})
