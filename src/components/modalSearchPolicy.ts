import { matchesExactOfficialQuery, parseStrictOfficialUrl } from '@/lib/officialUrl'

export interface SearchableBudgetItem {
  id: string
  description: string
  last_search_term?: string
}

export interface SourceSample {
  source?: string
  sourceType?: string
}

export type OfficialIndexSource = 'PNCP' | 'Compras.gov.br'

/** A daily schedule, source response, price write and drained queue are distinct events. */
export function buildOfficialFreshnessView(cycleInput: unknown, sourcesInput: unknown) {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const timestamp = (value: unknown): string | null =>
    typeof value === 'string' &&
    /^20\d\d-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
      ? value
      : null
  const cycle = object(cycleInput)
  const details = object(cycle.detalhes)
  const sourceStates = object(sourcesInput)
  const trustedCycle = details.version === 1 && details.contract === 'autonomous-daily-v1'
  const cycleSources = object(cycle.fontes)
  const complete =
    trustedCycle &&
    cycle.status === 'completed' &&
    ['PNCP', 'Compras.gov.br'].every(
      (source) => object(cycleSources[source]).daily_complete === true,
    )
  const cycleLabel = !trustedCycle
    ? 'Ciclo diário: verificação oficial não comprovada'
    : complete
      ? 'Ciclo diário: janela diária verificada'
      : cycle.status === 'error'
        ? 'Ciclo diário: pendência na verificação'
        : cycle.status === 'running'
          ? 'Ciclo diário: verificação em andamento'
          : 'Ciclo diário: verificação pendente'
  return {
    cycleLabel,
    cycleScheduledAt: trustedCycle ? timestamp(cycle.iniciado_em) : null,
    cycleCheckedCount:
      trustedCycle &&
      Number.isSafeInteger(cycle.amostras_validadas) &&
      Number(cycle.amostras_validadas) >= 0
        ? Number(cycle.amostras_validadas)
        : null,
    coverageLabel: 'Cobertura parcial do acervo oficial',
    sources: (['PNCP', 'Compras.gov.br'] as OfficialIndexSource[]).map((source) => {
      const state = object(sourceStates[source])
      return {
        source,
        checkedAt: timestamp(state.source_checked_at),
        writtenAt: timestamp(state.source_written_at),
        drainedAt: timestamp(state.last_drained_at),
        backlog:
          Number.isSafeInteger(state.backlog) && Number(state.backlog) >= 0
            ? Number(state.backlog)
            : null,
        retryAt: timestamp(state.next_attempt_at),
        statusLabel:
          state.status === 'error'
            ? 'verificação com pendência'
            : state.status === 'running'
              ? 'verificação em andamento'
              : 'verificação pendente',
      }
    }),
  }
}

export interface IndexPopulationFilterInput {
  tipoPalavras: 'palavras' | 'exata'
  ordenacao: 'menor_preco' | 'maior_preco' | 'data_recente'
  cnpj: string
  periodoMeses: number
  uf: string
  dataInicio: string
  dataFim: string
  precoMin: string
  precoMax: string
  porte: 'TODAS' | 'ME_EPP'
  unidade: string
  marca: string
  situacao: string
  toleranciaMedianaPct: string
}

export interface IndexPopulationFilterPlan {
  /** Identity of every refinement supported by the server-side index. */
  serverViewKey: string
  /** Filters evaluated only over loaded rows cannot be described as global. */
  visualOnlyFiltersActive: boolean
}

export interface OfficialSourceFilterCount {
  key: 'PNCP' | 'Compras.gov.br'
  label: 'PNCP' | 'Compras.gov.br'
  /** Quantidade elegível que já chegou às páginas carregadas. */
  count: number
  /** População completa da fonte no resumo do índice; ausente quando não comprovada. */
  indexedCount?: number
}

export interface OfficialSourceFilterCountInput<T extends SourceSample> {
  samples: T[]
  perSourceIndex?: Record<string, unknown> | null
  totalIndex: number | null
  summaryComplete: boolean
  isEligible?: (sample: T) => boolean
}

export interface PollFailureState {
  now: number
  deadline: number
  consecutiveFailures: number
  automaticRecoveries: number
}

export type PollFailureDecision =
  | { action: 'retry'; delayMs: number }
  | { action: 'cooldown'; delayMs: number }
  | { action: 'stop'; delayMs: 0; reason: 'deadline' }

// Contratos de paginação e falhas compartilhados pelo modal de pesquisa.
export type IndexContinuationFailureCategory = 'expired' | 'drift' | 'timeout' | 'unavailable'

export function indexContinuationFailureCategory(error: unknown): IndexContinuationFailureCategory {
  const candidate = error as { status?: unknown; code?: unknown; timed_out?: unknown } | null
  if (candidate?.status === 409 && candidate.code === 'SEARCH_SNAPSHOT_DRIFT') return 'drift'
  if (
    Number(candidate?.status) === 410 ||
    String(candidate?.code || '') === 'SEARCH_SNAPSHOT_EXPIRED'
  ) {
    return 'expired'
  }
  return candidate?.timed_out ? 'timeout' : 'unavailable'
}

export function resolveOfficialSourceStatus(input: {
  continuationPending: boolean
  ownFailure: boolean
  processing: boolean
  partial: boolean
}): 'falha' | 'processando' | 'parcial' | 'concluido' {
  if (input.continuationPending) return 'parcial'
  if (input.ownFailure) return 'falha'
  if (input.processing) return 'processando'
  return input.partial ? 'parcial' : 'concluido'
}

export function sourceUpdateFailureMessage(diagnostic: {
  amostrasObtidas: number
  mensagem?: string
}): string {
  const preserved =
    Number.isSafeInteger(diagnostic.amostrasObtidas) && diagnostic.amostrasObtidas > 0
      ? `${diagnostic.amostrasObtidas.toLocaleString('pt-BR')} amostra(s) carregada(s) preservada(s).`
      : 'Disponibilidade total não confirmada.'
  return `${diagnostic.mensagem || 'Falha de comunicação na atualização.'} ${preserved}`
}

export interface SuccessfulPollState {
  consecutiveFailures: number
  currentWarning: string | null
  currentError: string | null
}

export interface SuccessfulPollResolution extends SuccessfulPollState {
  recovered: boolean
}

export interface SuccessfulObservationState {
  now: number
  deadline: number
  unchangedCycles: number
  terminalConfirmed: boolean
  workPending: boolean
}

export type SuccessfulObservationDecision =
  | { action: 'continue'; delayMs: number }
  | { action: 'complete'; delayMs: 0 }
  | { action: 'stop'; delayMs: 0; reason: 'deadline' }

const SEARCH_STOPWORDS = new Set([
  'A',
  'AS',
  'DE',
  'DA',
  'DO',
  'DAS',
  'DOS',
  'E',
  'EM',
  'PARA',
  'POR',
  'COM',
  'SEM',
])

function semanticTokens(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token))
}

function stemToken(token: string): string {
  if (token.length <= 3) return token
  if (token.endsWith('ES') && token.length > 4) return token.slice(0, -2)
  if (token.endsWith('S') && !token.endsWith('SS')) return token.slice(0, -1)
  return token
}

export function chooseInitialSearchTerm(item: SearchableBudgetItem): string {
  const description = (item.description || '').trim()
  const remembered = (item.last_search_term || '').trim()
  if (!remembered) return description

  const itemTokens = new Set<string>()
  for (const token of semanticTokens(description)) {
    itemTokens.add(token)
    itemTokens.add(stemToken(token))
  }
  const rememberedTokens = semanticTokens(remembered)
  const adherent =
    rememberedTokens.length > 0 &&
    rememberedTokens.every((token) => itemTokens.has(token) || itemTokens.has(stemToken(token)))
  return adherent ? remembered : description
}

export function buildInitialIndexSearchParams(searchTerm: string) {
  return {
    palavra_chave: searchTerm,
    palavra_exata: false,
    fonte: undefined,
    uf: undefined,
    data_inicio: undefined,
    data_fim: undefined,
    preco_min: undefined,
    preco_max: undefined,
    unidade: undefined,
    marca: undefined,
    porte: undefined,
    tamanho_pagina: 100,
    pagina: 1,
    ordenar: 'valor_unitario:asc' as const,
  }
}

/**
 * The source picker is a view over one complete official collection. It must
 * never narrow collection identity, the live request, index hydration or the
 * observer. Only `filterLoadedSamplesBySources` consumes that visual choice.
 */
export function buildOfficialQueryParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, 'fontes' | 'fonte'> & { fonte: undefined } {
  const { fontes: _visualSources, fonte: _visualSource, ...official } = params
  return { ...official, fonte: undefined } as Omit<T, 'fontes' | 'fonte'> & {
    fonte: undefined
  }
}

export function buildOfficialCollectionIdentity(params: Record<string, unknown>): string {
  return JSON.stringify(buildOfficialQueryParams(params))
}

function normalizedOptionalDecimal(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Separates server-population refinements from filters that exist only over the
 * loaded browser window. The stable key drives one index-only refresh per
 * effective server-side change.
 */
export function buildIndexPopulationFilterPlan(
  filters: IndexPopulationFilterInput,
): IndexPopulationFilterPlan {
  const tolerance = Number(filters.toleranciaMedianaPct.replace(',', '.'))
  const serverFilters = {
    tipoPalavras: filters.tipoPalavras,
    ordenacao: filters.ordenacao,
    cnpj: filters.cnpj.trim(),
    periodoMeses:
      Number.isSafeInteger(filters.periodoMeses) && filters.periodoMeses > 0
        ? filters.periodoMeses
        : 0,
    uf: filters.uf.trim().toUpperCase(),
    dataInicio: filters.dataInicio,
    dataFim: filters.dataFim,
    precoMin: normalizedOptionalDecimal(filters.precoMin),
    precoMax: normalizedOptionalDecimal(filters.precoMax),
    porte: filters.porte,
    unidade: filters.unidade.trim().toUpperCase(),
    marca: filters.marca.trim().toUpperCase(),
  }
  return {
    serverViewKey: JSON.stringify(serverFilters),
    visualOnlyFiltersActive:
      filters.situacao !== 'todas' || (Number.isFinite(tolerance) && tolerance > 0),
  }
}

export function shouldRefreshIndexPopulation(
  previousServerViewKey: string,
  nextServerViewKey: string,
  searchExecuted: boolean,
): boolean {
  return searchExecuted && previousServerViewKey !== nextServerViewKey
}

export function createItemSessionDefaults() {
  return {
    tipoPesquisa: 'PALAVRA_CHAVE' as const,
    cnpjFiltro: '',
    tipoPalavras: 'palavras' as const,
    loadingSearch: false,
    loadingMoreProgressive: false,
    loadingConfirm: false,
    statusIaProgresso: '',
    isOrigemRealPncp: false,
    isOrigemRealBps: false,
    isOrigemRealPcp: false,
    pcpAguardandoCredencial: false,
    paginaPncpCarregada: 1,
    totalPaginasPncpDisponiveis: 1,
    tookIndexMs: null,
    totalIndexLocal: null,
    resumoIndiceDesatualizado: false,
    frescorSincronizacao: {} as Record<string, unknown>,
    cicloDiarioInfo: null,
    metricasConsultaLocal: null,
    gradeScrollTop: 0,
    estadoPesquisa: null,
    diagnosticoFontes: [] as unknown[],
    agregacoesPorFonteIndice: {} as Record<string, number>,
    statusTarefaIndice: null,
    estatisticasCalculadas: null,
    fontesSelecionadas: [] as string[],
    filtroSituacao: 'todas',
    filtroPeriodoMeses: 0,
    filtroUf: '',
    filtroDataInicio: '',
    filtroDataFim: '',
    filtroPrecoMin: '',
    filtroPrecoMax: '',
    filtroPrecoSlider: [0, 1000] as [number, number],
    sliderPrecoMaximoAbsoluto: 1000,
    filtroVariacaoMedianaPct: '',
    filtroPorteOpcao: 'TODAS' as const,
    filtroMedida: '',
    filtroMarca: '',
    ordenacao: 'menor_preco' as const,
    paginaAtual: 1,
    itensFilaPendente: 0,
    continuandoFila: false,
    cancelarFilaPendente: false,
    coletaEmTempoRealAtiva: false,
    statusColetaTempoReal: '',
    editandoValorRef: false,
    salvandoValorRef: false,
    mostrandoCampoJustificativa: false,
    justificativaCritica: '',
    salvandoJustificativa: false,
    justificativaSalvaTexto: '',
  }
}

export function decideFilterChange(): {
  queryOfficialSources: boolean
  queryIndexView: boolean
  preserveLoadedPopulation: boolean
} {
  return { queryOfficialSources: false, queryIndexView: true, preserveLoadedPopulation: true }
}

function canonicalSource(source?: string, sourceType?: string): string {
  const raw = `${source || ''} ${sourceType || ''}`.trim().toLowerCase()
  if (!raw) return ''
  if (raw.includes('pncp') || raw.includes('portal nacional de contrata')) return 'PNCP'
  if (raw.includes('compras') || raw.includes('catmat')) return 'Compras.gov.br'
  return (source || sourceType || '').trim()
}

function canonicalOfficialSources(selectedSources: string[]): OfficialIndexSource[] {
  const sources = new Set<OfficialIndexSource>()
  for (const selected of selectedSources) {
    const canonical = canonicalSource(selected)
    if (canonical === 'PNCP' || canonical === 'Compras.gov.br') sources.add(canonical)
  }
  return Array.from(sources)
}

/**
 * Builds a fresh server-side view over the persisted index. This is deliberately
 * separate from `buildOfficialQueryParams`: changing the view must never change
 * the identity of, or restart, the official PNCP + Compras.gov.br collection.
 */
export function buildIndexViewQueryParams<T extends Record<string, unknown>>(
  baseParams: T,
  selectedSources: string[],
): T & {
  pagina: 1
  page: 1
  tamanho_pagina: 100
  limit: 100
  fonte: OfficialIndexSource | undefined
  sources: OfficialIndexSource[] | undefined
  cursor: undefined
  snapshot: undefined
} {
  const sources = canonicalOfficialSources(selectedSources)
  return {
    ...baseParams,
    pagina: 1,
    page: 1,
    tamanho_pagina: 100,
    limit: 100,
    fonte: sources.length === 1 ? sources[0] : undefined,
    sources: sources.length > 0 ? sources : undefined,
    cursor: undefined,
    snapshot: undefined,
  }
}

export async function loadIndexView<T extends Record<string, unknown>, TResponse>(
  baseParams: T,
  selectedSources: string[],
  search: (params: ReturnType<typeof buildIndexViewQueryParams<T>>) => Promise<TResponse>,
): Promise<{
  params: ReturnType<typeof buildIndexViewQueryParams<T>>
  response: TResponse
}> {
  const params = buildIndexViewQueryParams(baseParams, selectedSources)
  const response = await search(params)
  return { params, response }
}

/**
 * A source-view change cannot leave an invisible row selected for confirmation.
 * Visible selected rows remain pinned; hidden or no-longer-loaded IDs are
 * explicitly reported to the caller so it can clear them and notify the user.
 */
export function reconcileSelectionForIndexView<T extends SourceSample & { id: string }>(
  rows: T[],
  selectedIds: string[],
  selectedSources: string[],
): { selectedIds: string[]; hiddenSelectedIds: string[]; pinnedRows: T[] } {
  const rowsById = new Map(rows.map((candidate) => [candidate.id, candidate]))
  const sources = new Set(canonicalOfficialSources(selectedSources))
  const kept: string[] = []
  const hidden: string[] = []
  const pinnedRows: T[] = []

  for (const id of Array.from(new Set(selectedIds))) {
    const candidate = rowsById.get(id)
    const visible =
      candidate &&
      (sources.size === 0 ||
        sources.has(canonicalSource(candidate.source, candidate.sourceType) as OfficialIndexSource))
    if (!visible) {
      hidden.push(id)
      continue
    }
    kept.push(id)
    pinnedRows.push(candidate)
  }
  return { selectedIds: kept, hiddenSelectedIds: hidden, pinnedRows }
}

export function filterLoadedSamplesBySources<T extends SourceSample>(
  samples: T[],
  selectedSources: string[],
  isEligible: (sample: T) => boolean = () => true,
): T[] {
  const eligibleSamples = samples.filter(isEligible)
  if (selectedSources.length === 0) return eligibleSamples
  const selected = new Set(selectedSources.map((source) => canonicalSource(source)))
  return eligibleSamples.filter((sample) =>
    selected.has(canonicalSource(sample.source, sample.sourceType)),
  )
}

/**
 * Mantém separadas duas grandezas diferentes no filtro:
 * - `count`: linhas elegíveis já carregadas;
 * - `indexedCount`: população completa por fonte, somente quando o resumo fecha
 *   exatamente com o total da mesma consulta.
 *
 * O total global nunca é repartido ou usado como substituto de uma agregação por
 * fonte. Se o resumo estiver ausente, desatualizado ou inconsistente, a UI mostra
 * apenas as linhas carregadas.
 */
export function buildOfficialSourceFilterCounts<T extends SourceSample>({
  samples,
  perSourceIndex,
  totalIndex,
  summaryComplete,
  isEligible = () => true,
}: OfficialSourceFilterCountInput<T>): OfficialSourceFilterCount[] {
  const loaded: Record<'PNCP' | 'Compras.gov.br', number> = {
    PNCP: 0,
    'Compras.gov.br': 0,
  }
  for (const sample of samples) {
    if (!isEligible(sample)) continue
    const source = canonicalSource(sample.source, sample.sourceType)
    if (source === 'PNCP' || source === 'Compras.gov.br') loaded[source]++
  }

  let completeIndexCounts: Record<'PNCP' | 'Compras.gov.br', number> | null = null
  if (
    summaryComplete &&
    Number.isSafeInteger(totalIndex) &&
    (totalIndex as number) >= 0 &&
    perSourceIndex &&
    typeof perSourceIndex === 'object'
  ) {
    const indexed: Record<'PNCP' | 'Compras.gov.br', number> = {
      PNCP: 0,
      'Compras.gov.br': 0,
    }
    let valid = true
    for (const [rawSource, rawCount] of Object.entries(perSourceIndex)) {
      const source = canonicalSource(rawSource)
      if (
        (source !== 'PNCP' && source !== 'Compras.gov.br') ||
        !Number.isSafeInteger(rawCount) ||
        (rawCount as number) < 0
      ) {
        valid = false
        break
      }
      indexed[source] += rawCount as number
    }
    if (valid && indexed.PNCP + indexed['Compras.gov.br'] === totalIndex) {
      completeIndexCounts = indexed
    }
  }

  return (['PNCP', 'Compras.gov.br'] as const).map((source) => ({
    key: source,
    label: source,
    count: loaded[source],
    ...(completeIndexCounts ? { indexedCount: completeIndexCounts[source] } : {}),
  }))
}

/** Returns only the evidence URL of a sample already accepted by its official proof validator. */
export function resolveOfficialEvidenceUrl<T extends { raw_data?: any }>(
  sample: T,
  isEligible: (sample: T) => boolean,
): string | null {
  if (!isEligible(sample)) return null
  const evidenceUrl = sample.raw_data?.proveniencia_preco?.url_evidencia
  return parseStrictOfficialUrl(evidenceUrl)?.raw ?? null
}

export function shouldPauseSharedObserverForPncp(state: {
  pausada: boolean
  backendContinua?: boolean
}): boolean {
  return state.pausada && state.backendContinua !== true
}

export interface SharedObserverCompletionState {
  directSourcesActive: boolean
  pncpBackendContinues: boolean
  pncpContinuationPaused: boolean
  taskFailed: boolean
  taskActive: boolean
  taskPending: number
  queuePending: number
  reconciliationPending: boolean
}

/** A clean index read is not terminal while PNCP explicitly reports backend work. */
export function shouldCompleteSharedObserver(state: SharedObserverCompletionState): boolean {
  if (state.directSourcesActive || state.pncpBackendContinues || state.reconciliationPending)
    return false
  return (
    state.pncpContinuationPaused ||
    state.taskFailed ||
    (!state.taskActive && state.taskPending <= 0 && state.queuePending <= 0)
  )
}

export function decidePollFailure(state: PollFailureState): PollFailureDecision {
  if (Number.isFinite(state.deadline) && state.now >= state.deadline)
    return { action: 'stop', delayMs: 0, reason: 'deadline' }
  if (state.consecutiveFailures >= 4) {
    const boundedBackoff = Math.min(30_000, 12_000 * 2 ** Math.min(1, state.automaticRecoveries))
    return { action: 'cooldown', delayMs: boundedBackoff }
  }
  return {
    action: 'retry',
    delayMs: Math.min(11_500, 3_500 + Math.max(1, state.consecutiveFailures) * 2_000),
  }
}

export function decideObservationAfterSuccess(
  state: SuccessfulObservationState,
): SuccessfulObservationDecision {
  if (state.terminalConfirmed && !state.workPending) return { action: 'complete', delayMs: 0 }
  if (Number.isFinite(state.deadline) && state.now >= state.deadline)
    return { action: 'stop', delayMs: 0, reason: 'deadline' }
  // No-progress is not completion. Slow persistent queues are observed with a
  // progressive, bounded delay until the backend confirms a terminal state.
  const delayMs = Math.min(21_000, 3_500 + Math.floor(state.unchangedCycles / 3) * 3_500)
  return { action: 'continue', delayMs }
}

export interface UfSampleView {
  government_entity?: string
  raw_data?: {
    uf?: unknown
    municipio_uf?: unknown
  }
}

/** Defensive window check for rows already filtered globally by the backend. */
export function sampleMatchesUf(sample: UfSampleView, requestedUf: string): boolean {
  const uf = requestedUf.trim().toUpperCase()
  if (!uf) return true
  const rawUf = String(sample.raw_data?.uf || '')
    .trim()
    .toUpperCase()
  if (rawUf && rawUf !== 'NÃO INFORMADO' && rawUf !== 'NAO INFORMADO') return rawUf === uf
  const searchable = `${String(sample.raw_data?.municipio_uf || '')} ${String(
    sample.government_entity || '',
  )}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
  return new RegExp(`(^|[^A-Z])${uf}([^A-Z]|$)`).test(searchable)
}

export function loadedWindowMedian(samples: Array<{ unit_price: number }>): number {
  const values = samples
    .map((sample) => sample.unit_price)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right)
  if (!values.length) return 0
  const middle = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle]
}

export function validateConfirmationSelection(
  selectedIds: string[],
  max = 3,
): { ok: boolean; ids: string[]; max: number } {
  const ids = Array.from(new Set(selectedIds.filter(Boolean)))
  return { ok: ids.length > 0 && ids.length <= max, ids, max }
}

function positiveIdentifier(value: unknown): boolean {
  return (
    (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
    /^\d+$/.test(String(value)) &&
    /[1-9]/.test(String(value))
  )
}

function boundedPositiveInteger(value: unknown, minimum: number, maximum?: number): boolean {
  if (!positiveIdentifier(value)) return false
  const numeric = Number(value)
  return (
    Number.isSafeInteger(numeric) &&
    numeric >= minimum &&
    (maximum === undefined || numeric <= maximum)
  )
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/** Strict client-side eligibility for an evidenced Compras.gov.br price. */
export function isEligibleComprasOfficialProof(proof: any, unitPrice: number): boolean {
  const id = proof?.identidade
  const row = proof?.registro_oficial
  const context = proof?.contexto_consulta
  if (
    proof?.versao !== 1 ||
    proof?.status !== 'verificada' ||
    proof?.fonte !== 'Compras.gov.br' ||
    !id ||
    !row ||
    !context ||
    !['material', 'servico'].includes(id.tipo) ||
    context.tipo !== id.tipo ||
    !['precoUnitarioHomologado', 'valorUnitario', 'precoUnitario', 'precoPraticado'].includes(
      proof.campo_unitario,
    ) ||
    Number(proof.valor_unitario) !== unitPrice ||
    Number(row[proof.campo_unitario]) !== unitPrice ||
    !positiveIdentifier(id.codigoCatalogo) ||
    String(context.codigo) !== String(id.codigoCatalogo) ||
    !id.idCompra ||
    String(id.idCompra) !== String(row.idCompra ?? row.codigoCompra) ||
    !String(id.idItemCompra ?? id.numeroItemCompra ?? '') ||
    String(id.idItemCompra ?? id.numeroItemCompra) !==
      String(row.idItemCompra ?? row.numeroItemCompra ?? row.numeroItem) ||
    !id.fornecedor ||
    !proof.campo_data ||
    String(row[proof.campo_data]) !== proof.data_oficial ||
    !Number.isFinite(Date.parse(proof.data_oficial)) ||
    !Number.isFinite(unitPrice) ||
    unitPrice <= 0
  )
    return false

  const catalogCode = String(id.codigoCatalogo)
  const rowCatalogCode =
    row.codigoItemCatalogo ?? (id.tipo === 'material' ? row.codigoCatmat : row.codigoCatser)
  if (!positiveIdentifier(rowCatalogCode) || String(rowCatalogCode) !== catalogCode) return false
  if (row.codigoItemCatalogo !== undefined && String(row.codigoItemCatalogo) !== catalogCode)
    return false
  const namespaceCode = id.tipo === 'material' ? row.codigoCatmat : row.codigoCatser
  if (namespaceCode !== undefined && String(namespaceCode) !== catalogCode) return false

  const url = parseStrictOfficialUrl(proof.url_evidencia)
  if (!url) return false

  const groupedPdm = context.seletor === 'codigoPdm'
  if (groupedPdm) {
    const state = context.estado
    const dateStart = context.dataCompraInicio
    const dateEnd = context.dataCompraFim
    if (
      id.tipo !== 'material' ||
      !positiveIdentifier(context.codigoPdm) ||
      !boundedPositiveInteger(context.pagina, 1) ||
      !boundedPositiveInteger(context.tamanhoPagina, 10, 500) ||
      (state !== undefined &&
        state !== null &&
        String(state) !== '' &&
        !/^[A-Z]{2}$/.test(String(state))) ||
      (dateStart !== undefined &&
        dateStart !== null &&
        String(dateStart) !== '' &&
        !validIsoDate(dateStart)) ||
      (dateEnd !== undefined &&
        dateEnd !== null &&
        String(dateEnd) !== '' &&
        !validIsoDate(dateEnd)) ||
      (validIsoDate(dateStart) && validIsoDate(dateEnd) && dateStart > dateEnd)
    )
      return false
    const pdm = String(context.codigoPdm)
    for (const alias of [row.codigoPdm, row.codigoPDM]) {
      if (alias !== undefined && alias !== null) {
        if (!positiveIdentifier(alias) || String(alias) !== pdm) return false
      }
    }
    const queryUrl = parseStrictOfficialUrl(context.urlConsultaOficial)
    const expectedQuery: Record<string, unknown> = {
      tipo: 'codigoPdm',
      codigo: pdm,
      pagina: context.pagina,
      tamanhoPagina: context.tamanhoPagina,
    }
    for (const field of ['estado', 'dataCompraInicio', 'dataCompraFim']) {
      if (
        context[field] !== undefined &&
        context[field] !== null &&
        String(context[field]) !== ''
      ) {
        expectedQuery[field] = context[field]
      }
    }
    if (
      !queryUrl ||
      queryUrl.host !== 'dadosabertos.compras.gov.br' ||
      queryUrl.pathname !== '/modulo-pesquisa-preco/1_consultarMaterial' ||
      !matchesExactOfficialQuery(queryUrl, expectedQuery)
    )
      return false
    if (proof.url_evidencia === context.urlConsultaOficial) return true
    return [row.linkEditalOuCompra, row.link_resultado, row.url].some(
      (candidate) => typeof candidate === 'string' && candidate === proof.url_evidencia,
    )
  }

  if (
    context.seletor !== undefined &&
    context.seletor !== null &&
    context.seletor !== '' &&
    context.seletor !== 'codigoItemCatalogo'
  )
    return false
  const boundReturnedLink = [row.linkEditalOuCompra, row.link_resultado, row.url].some(
    (candidate) => typeof candidate === 'string' && candidate === proof.url_evidencia,
  )
  if (url.host !== 'dadosabertos.compras.gov.br') return boundReturnedLink
  const material = id.tipo === 'material'
  const route = material
    ? '/modulo-pesquisa-preco/1_consultarMaterial'
    : '/modulo-pesquisa-preco/3_consultarServico'
  const expectedQuery: Record<string, unknown> = {
    ...(material
      ? { tipo: 'codigoItemCatalogo', codigo: catalogCode }
      : { codigoItemCatalogo: catalogCode }),
    pagina: context.pagina,
    tamanhoPagina: context.tamanhoPagina,
  }
  for (const field of ['estado', 'dataInicial', 'dataFinal']) {
    if (context[field] !== undefined && context[field] !== null && String(context[field]) !== '') {
      expectedQuery[field] = context[field]
    }
  }
  const exactItemQuery =
    url.pathname === route &&
    boundedPositiveInteger(context.pagina, 1) &&
    boundedPositiveInteger(context.tamanhoPagina, 10, 500) &&
    matchesExactOfficialQuery(url, expectedQuery)
  return exactItemQuery || boundReturnedLink
}

export function resolveSuccessfulPoll(state: SuccessfulPollState): SuccessfulPollResolution {
  const recovered = state.consecutiveFailures > 0 || state.currentWarning !== null
  return {
    recovered,
    consecutiveFailures: 0,
    currentWarning: null,
    currentError:
      state.currentWarning !== null && state.currentError === state.currentWarning
        ? null
        : state.currentError,
  }
}

function hasCalculatedValue(value: number, validCount: number): boolean {
  return validCount > 0 && Number.isFinite(value)
}

export function formatCalculatedMoney(value: number, validCount: number, decimals: number): string {
  if (!hasCalculatedValue(value, validCount)) return '— / não calculado'
  const safeDecimals = Math.max(0, Math.min(20, Math.trunc(decimals)))
  const smallestDisplayedUnit = 10 ** -safeDecimals
  if (value > 0 && value < smallestDisplayedUnit / 2) {
    return `< R$ ${smallestDisplayedUnit.toLocaleString('pt-BR', {
      minimumFractionDigits: safeDecimals,
      maximumFractionDigits: safeDecimals,
    })}`
  }
  return `R$ ${value.toLocaleString('pt-BR', {
    minimumFractionDigits: safeDecimals,
    maximumFractionDigits: safeDecimals,
  })}`
}

export function formatCalculatedNumber(
  value: number,
  validCount: number,
  decimals: number,
): string {
  if (!hasCalculatedValue(value, validCount)) return '— / não calculado'
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export function formatCalculatedPercent(value: number, validCount: number): string {
  if (!hasCalculatedValue(value, validCount)) return '— / não calculado'
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`
}
