import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dailySource = readFileSync(
  new URL('../pocketbase/hooks/daily_sync_job.js', import.meta.url),
  'utf8',
)
const searchSource = readFileSync(
  new URL('../pocketbase/hooks/prices_search.js', import.meta.url),
  'utf8',
)

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

function allSections(source: string, start: string, end: string): string[] {
  const sections: string[] = []
  let cursor = 0
  while (cursor < source.length) {
    const startAt = source.indexOf(start, cursor)
    if (startAt < 0) break
    const endAt = source.indexOf(end, startAt + start.length)
    if (endAt < 0) throw new Error(`Seção sem terminador: ${start}`)
    sections.push(source.slice(startAt, endAt))
    cursor = endAt + end.length
  }
  return sections
}

describe('coletores legados sem contrato de prova', () => {
  it('mantém validade e status, mas desativa coleta e persistência nos ciclos diário e manual', () => {
    expect(occurrences(dailySource, 'DAILY_LEGACY_COLLECTION_DISABLED_PROOF_ACK_V1')).toBe(2)
    expect(occurrences(dailySource, 'DAILY_AUTONOMOUS_REOPEN_DISABLED_V1')).toBe(2)
    expect(dailySource).toContain('Gestão de validade')
    expect(dailySource).toMatch(
      /routerAdd\(\s*['"]GET['"]\s*,\s*['"]\/backend\/v1\/sync\/daily\/status['"]/,
    )
    expect(dailySource).not.toContain('amostrasNovasColetadas')
    expect(dailySource).not.toContain("var catCodesT = ['267203'")
    expect(dailySource).not.toContain('q=DIPIRONA')
    expect(dailySource).not.toContain("new Record(colPsi)")
    expect(dailySource).not.toContain('tarefasParaReabrir')
    expect(dailySource).not.toContain("tRec.set('status', 'pending')")
    // Os contadores operacionais devem consumir a projeção selada/indexada.
    // Reabrir cada raw_payload aqui causava varredura completa e timeout.
    expect(occurrences(dailySource, 'search_eligible = 1')).toBeGreaterThanOrEqual(2)
    expect(occurrences(dailySource, "search_contract = 'cotai-official-price-v3'")).toBe(3)
    expect(dailySource).not.toContain('json_extract(raw_payload')
    expect(dailySource).not.toContain(
      "SELECT qualidade_situacao, COUNT(*) as cnt FROM price_samples_index GROUP BY qualidade_situacao",
    )
  })
})

describe('elegibilidade SQL do índice', () => {
  it('consome a projeção oficial selada e a FTS sem reabrir JSON ao filtrar a população', () => {
    expect(occurrences(searchSource, 'psi.search_eligible = 1')).toBe(2)
    expect(occurrences(searchSource, 'psi.search_contract = {:search_contract}')).toBe(2)
    expect(occurrences(searchSource, 'psi.server_trust_version = {:server_trust_version}')).toBe(2)
    expect(occurrences(searchSource, 'price_samples_fts MATCH {:fts_query}')).toBe(2)
    expect(occurrences(searchSource, 'WITH filtered AS MATERIALIZED')).toBe(2)
    const populationFilters = allSections(searchSource, 'function filterSpec(', 'function orderSpec(')
    const populationQueries = allSections(searchSource, 'function summarySql(', 'function loadFreshness(')
    expect(populationFilters).toHaveLength(2)
    expect(populationQueries).toHaveLength(2)
    for (const section of [...populationFilters, ...populationQueries]) {
      expect(section).not.toContain('json_extract')
    }
    expect(searchSource).not.toMatch(/descricao_normalizada\s+LIKE/i)
  })
})
