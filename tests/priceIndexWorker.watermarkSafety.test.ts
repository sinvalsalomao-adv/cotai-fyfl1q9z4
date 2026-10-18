import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workerSource = readFileSync(
  new URL('../pocketbase/hooks/price_index_worker.js', import.meta.url),
  'utf8',
)

function allSections(start: string, end: string): string[] {
  const sections: string[] = []
  let cursor = 0
  while (cursor < workerSource.length) {
    const startAt = workerSource.indexOf(start, cursor)
    if (startAt < 0) break
    const endAt = workerSource.indexOf(end, startAt + start.length)
    if (endAt < 0) throw new Error(`Seção sem terminador: ${start}`)
    sections.push(workerSource.slice(startAt, endAt))
    cursor = endAt + end.length
  }
  return sections
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

describe('segurança do watermark legado do worker', () => {
  it('mantém a varredura PNCP oficial intacta nas duas cópias do worker', () => {
    const sections = allSections(
      "if (fName === 'PNCP') {",
      "} else if (fName === 'Compras.gov.br') {",
    )

    expect(sections).toHaveLength(2)
    for (const section of sections) {
      expect(section).toContain('https://pncp.gov.br/api/search/')
      expect(section).toContain('sendHttpWithRetryUtil(urlPncpWm')
    }
  })

  it('não consulta nem persiste Compras pelo watermark sem prova e acknowledgement', () => {
    const sections = allSections(
      "} else if (fName === 'Compras.gov.br') {",
      '// Persiste watermark atualizado',
    )

    expect(sections).toHaveLength(2)
    for (const section of sections) {
      expect(section).toContain('COMPRAS_WATERMARK_DISABLED_PROOF_ACK_V1')
      expect(section).not.toContain('dadosabertos.compras.gov.br')
      expect(section).not.toContain('sendHttpWithRetryUtil')
      expect(section).not.toContain('novasAmostrasWm.push')
      expect(section).not.toContain('persistirLoteAmostrasProgressivo')
    }
  })

  it('expõe contadores somente da projeção oficial selada e com valor positivo', () => {
    const countQueryStart = workerSource.indexOf(
      "SELECT source, COUNT(*) as cnt FROM price_samples_index",
    )
    expect(countQueryStart).toBeGreaterThan(-1)
    const countQuery = workerSource.slice(countQueryStart, countQueryStart + 1_300)

    expect(countQuery).toContain("source IN ('PNCP', 'Compras.gov.br')")
    expect(countQuery).toContain('valor_unitario > 0')
    expect(countQuery).toContain('search_eligible = 1')
    expect(countQuery).toContain("search_contract = 'cotai-official-price-v3'")
    expect(countQuery).not.toContain('json_extract')
  })

  it('só persiste PNCP assíncrono depois do mesmo contrato estrito e de um selo do servidor', () => {
    expect(occurrences(workerSource, 'function validarESelarAmostraPncpWorker(a)')).toBe(2)
    expect(occurrences(workerSource, 'var estrita = validarESelarAmostraPncpWorker(a)')).toBe(2)
    expect(occurrences(workerSource, 'if (!estrita) continue')).toBe(2)
    expect(occurrences(workerSource, "contrato: 'cotai-official-price-v3'")).toBe(2)
    expect(occurrences(workerSource, 'proof.validacao_indice = seal')).toBe(2)
    expect(occurrences(workerSource, 'var pHash = estrita.payload_hash')).toBe(2)
    expect(occurrences(workerSource, "existente.set('purchase_id', a.purchase_id)")).toBe(2)

    const persistenceSections = allSections(
      'function persistirLoteAmostrasProgressivo(amostras, colecaoAmostras)',
      '// =========================================================================',
    )
    expect(persistenceSections).toHaveLength(2)
    for (const section of persistenceSections) {
      expect(section).not.toContain('computeHashSimple(rawStr)')
    }
    const strictSections = allSections(
      'function validarESelarAmostraPncpWorker(a)',
      '// Persistência progressiva',
    )
    expect(strictSections).toHaveLength(2)
    for (const section of strictSections) {
      expect(section).toContain("a.source !== 'PNCP'")
      expect(section).toContain('a.purchase_id !== a.source_record_id')
      expect(section).toContain('a.sample_key !== gerarSampleKeyUtil(a)')
      expect(section).toContain('proof.valor_unitario')
      expect(section).toContain('proof.url_evidencia')
      expect(section).toContain('proof.registro_oficial')
    }
  })

  it('constrói a identidade externa do PNCP assíncrono no item/resultado, não só na compra', () => {
    expect(occurrences(workerSource, 'purchase_id: identidadeItem')).toBe(2)
    expect(occurrences(workerSource, 'purchase_id: numControlePncp')).toBe(0)
  })
})
