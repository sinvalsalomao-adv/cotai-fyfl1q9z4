import { describe, expect, it } from 'vitest'
import { amostraElegivelParaCalculo, urlOficialDaAmostra } from '../src/components/ModalPesquisarPrecos'

function pncpSample(evidenceUrl: string) {
  return {
    id: 'pncp-1',
    source: 'PNCP',
    sourceType: 'pncp',
    unit_price: 12.34,
    raw_data: {
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'PNCP',
        campo_unitario: 'valorUnitarioHomologado',
        valor_unitario: 12.34,
        url_evidencia: evidenceUrl,
        identidade: {
          cnpj: '00000000000001',
          ano: 2026,
          sequencial: 9,
          numeroItem: 2,
        },
        registro_oficial: {
          valorUnitarioHomologado: 12.34,
        },
      },
    },
  } as any
}

const validEvidence =
  'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/9/itens/2/resultados'
const validItemEvidence = validEvidence.replace('/resultados', '')

describe('modal PNCP raw official URL contract', () => {
  it.each([validItemEvidence, validEvidence])('accepts the exact official item evidence URL %s', (evidence) => {
    const sample = pncpSample(evidence)
    expect(amostraElegivelParaCalculo(sample)).toBe(true)
    expect(urlOficialDaAmostra(sample)).toBe(evidence)
  })

  it('compares the exact raw PNCP identity segments without URL normalization', () => {
    const evidence =
      'https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/09/itens/02/resultados'
    const sample = pncpSample(evidence)
    sample.raw_data.proveniencia_preco.identidade.sequencial = '09'
    sample.raw_data.proveniencia_preco.identidade.numeroItem = '02'

    expect(amostraElegivelParaCalculo(sample)).toBe(true)
    expect(urlOficialDaAmostra(sample)).toBe(evidence)
  })

  it.each([
    ['a signed sequence', '+9', '2'],
    ['a hexadecimal item', '9', '0x2'],
  ])('rejects %s even when the evidence URL repeats the same raw identity', (_label, sequence, item) => {
    const evidence =
      `https://pncp.gov.br/api/pncp/v1/orgaos/00000000000001/compras/2026/${sequence}/itens/${item}/resultados`
    const sample = pncpSample(evidence)
    sample.raw_data.proveniencia_preco.identidade.sequencial = sequence
    sample.raw_data.proveniencia_preco.identidade.numeroItem = item

    expect(amostraElegivelParaCalculo(sample)).toBe(false)
    expect(urlOficialDaAmostra(sample)).toBeNull()
  })

  it.each([
    ['credentials', validEvidence.replace('https://', 'https://user:pass@')],
    ['explicit default port', validEvidence.replace('pncp.gov.br/', 'pncp.gov.br:443/')],
    ['non-empty fragment', `${validEvidence}#spoof`],
    ['empty fragment delimiter', `${validEvidence}#`],
    ['raw whitespace', validEvidence.replace('/resultados', '/resul tados')],
    ['raw backslash', validEvidence.replace('pncp.gov.br/', 'pncp.gov.br\\')],
    ['query immediately after host', 'https://pncp.gov.br?item=2'],
    ['non-government host', validEvidence.replace('pncp.gov.br', 'pncp.invalid')],
    ['catalogue host', validEvidence.replace('pncp.gov.br', 'catalogo.compras.gov.br')],
    ['an empty government label', validEvidence.replace('pncp.gov.br', '.gov.br')],
    ['an empty middle host label', validEvidence.replace('pncp.gov.br', 'pncp..gov.br')],
    ['a leading host hyphen', validEvidence.replace('pncp.gov.br', '-pncp.gov.br')],
    ['a trailing host hyphen', validEvidence.replace('pncp.gov.br', 'pncp-.gov.br')],
    ['an extra query', `${validEvidence}?pagina=1`],
  ])('rejects %s before eligibility and link rendering', (_label, evidenceUrl) => {
    const sample = pncpSample(evidenceUrl)
    expect(amostraElegivelParaCalculo(sample)).toBe(false)
    expect(urlOficialDaAmostra(sample)).toBeNull()
  })
})
