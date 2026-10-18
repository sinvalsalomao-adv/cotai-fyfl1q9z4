import { describe, expect, it } from 'vitest'
import { isEligibleComprasOfficialProof } from '../src/components/modalSearchPolicy'

function groupedPdmSample() {
  const url =
    'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial' +
    '?tipo=codigoPdm&codigo=19385&pagina=2&tamanhoPagina=500&estado=CE' +
    '&dataCompraInicio=2024-01-01&dataCompraFim=2026-12-31'
  return {
    id: 'sample-1',
    source: 'Compras.gov.br',
    sourceType: 'compras_gov',
    unit_price: 4.4,
    raw_data: {
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'Compras.gov.br',
        campo_unitario: 'precoUnitario',
        valor_unitario: 4.4,
        data_oficial: '2025-03-13',
        campo_data: 'dataResultado',
        url_evidencia: url,
        identidade: {
          tipo: 'material',
          codigoCatalogo: '151063',
          idCompra: '15836906900012025',
          idItemCompra: '7670225',
          numeroItemCompra: 1,
          fornecedor: '51340170000156',
        },
        contexto_consulta: {
          tipo: 'material',
          codigo: '151063',
          seletor: 'codigoPdm',
          codigoPdm: '19385',
          pagina: 2,
          tamanhoPagina: 500,
          estado: 'CE',
          dataCompraInicio: '2024-01-01',
          dataCompraFim: '2026-12-31',
          urlConsultaOficial: url,
        },
        registro_oficial: {
          idCompra: '15836906900012025',
          idItemCompra: '7670225',
          numeroItemCompra: 1,
          codigoItemCatalogo: '151063',
          codigoCatmat: '151063',
          codigoPdm: '19385',
          precoUnitario: 4.4,
          dataResultado: '2025-03-13',
        },
      },
    },
  } as any
}

function itemSample(type: 'material' | 'servico') {
  const material = type === 'material'
  const code = material ? '151063' : '18441'
  const path = material ? '1_consultarMaterial' : '3_consultarServico'
  const selector = material ? `tipo=codigoItemCatalogo&codigo=${code}` : `codigoItemCatalogo=${code}`
  const url = `https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/${path}?${selector}&pagina=1&tamanhoPagina=500`
  return {
    unit_price: 12.5,
    raw_data: {
      proveniencia_preco: {
        versao: 1,
        status: 'verificada',
        fonte: 'Compras.gov.br',
        campo_unitario: 'precoUnitario',
        valor_unitario: 12.5,
        data_oficial: '2025-03-13',
        campo_data: 'dataResultado',
        url_evidencia: url,
        identidade: {
          tipo: type,
          codigoCatalogo: code,
          idCompra: '15836906900012025',
          idItemCompra: '7670225',
          numeroItemCompra: 1,
          fornecedor: '51340170000156',
        },
        contexto_consulta: { tipo: type, codigo: code, pagina: 1, tamanhoPagina: 500 },
        registro_oficial: {
          idCompra: '15836906900012025',
          idItemCompra: '7670225',
          numeroItemCompra: 1,
          codigoItemCatalogo: code,
          ...(material ? { codigoCatmat: code } : { codigoCatser: code }),
          precoUnitario: 12.5,
          dataResultado: '2025-03-13',
        },
      },
    },
  } as any
}

describe('modal grouped PDM evidence contract', () => {
  it.each(['material', 'servico'] as const)('preserves valid %s item evidence', (type) => {
    const sample = itemSample(type)
    expect(
      isEligibleComprasOfficialProof(sample.raw_data.proveniencia_preco, sample.unit_price),
    ).toBe(true)
  })

  it('accepts an item record link on the data host when it is byte-exactly bound to the row', () => {
    const sample = itemSample('material')
    const proof = sample.raw_data.proveniencia_preco
    const recordLink = 'https://dadosabertos.compras.gov.br/compra/123'
    proof.url_evidencia = recordLink
    proof.registro_oficial.linkEditalOuCompra = recordLink

    expect(isEligibleComprasOfficialProof(proof, sample.unit_price)).toBe(true)
  })

  it.each([undefined, null, '', 'codigoItemCatalogo'])(
    'matches the index contract for an item selector represented as %s',
    (selector) => {
      const sample = itemSample('material')
      sample.raw_data.proveniencia_preco.contexto_consulta.seletor = selector
      expect(
        isEligibleComprasOfficialProof(sample.raw_data.proveniencia_preco, sample.unit_price),
      ).toBe(true)
    },
  )

  it.each([
    ['an unknown query key', (proof: any) => { proof.url_evidencia += '&unexpected=1' }],
    ['a duplicate catalog code', (proof: any) => { proof.url_evidencia += `&${proof.identidade.tipo === 'material' ? 'codigo' : 'codigoItemCatalogo'}=${proof.identidade.codigoCatalogo}` }],
    ['page zero', (proof: any) => {
      proof.contexto_consulta.pagina = 0
      proof.url_evidencia = proof.url_evidencia.replace('pagina=1', 'pagina=0')
    }],
    ['an oversized page size', (proof: any) => {
      proof.contexto_consulta.tamanhoPagina = 501
      proof.url_evidencia = proof.url_evidencia.replace('tamanhoPagina=500', 'tamanhoPagina=501')
    }],
  ])('rejects material item evidence with %s', (_label, mutate) => {
    const sample = itemSample('material')
    mutate(sample.raw_data.proveniencia_preco)
    expect(
      isEligibleComprasOfficialProof(sample.raw_data.proveniencia_preco, sample.unit_price),
    ).toBe(false)
  })

  it('accepts a material row whose CATMAT identity is tied to the exact official PDM query', () => {
    const sample = groupedPdmSample()
    expect(
      isEligibleComprasOfficialProof(sample.raw_data.proveniencia_preco, sample.unit_price),
    ).toBe(true)
  })

  it('accepts grouped PDM evidence when the official row omits both optional PDM aliases', () => {
    const sample = groupedPdmSample()
    delete sample.raw_data.proveniencia_preco.registro_oficial.codigoPdm
    delete sample.raw_data.proveniencia_preco.registro_oficial.codigoPDM
    expect(
      isEligibleComprasOfficialProof(sample.raw_data.proveniencia_preco, sample.unit_price),
    ).toBe(true)
  })

  it('accepts an exact safe official purchase link while proving the PDM query separately', () => {
    const sample = groupedPdmSample()
    const proof = sample.raw_data.proveniencia_preco
    const purchaseLink = 'https://pncp.gov.br/app/editais/15836906900012025/2025/1'
    proof.url_evidencia = purchaseLink
    proof.registro_oficial.linkEditalOuCompra = purchaseLink
    expect(isEligibleComprasOfficialProof(proof, sample.unit_price)).toBe(true)
  })

  it('rejects a legacy Compras link that is official-looking but is not bound to the returned row', () => {
    const sample = groupedPdmSample()
    const proof = sample.raw_data.proveniencia_preco
    proof.contexto_consulta.seletor = 'codigoItemCatalogo'
    delete proof.contexto_consulta.codigoPdm
    proof.url_evidencia = 'https://www.gov.br/compras/pt-br/acesso-a-informacao'
    delete proof.registro_oficial.linkEditalOuCompra
    delete proof.registro_oficial.link_resultado
    delete proof.registro_oficial.url

    expect(isEligibleComprasOfficialProof(proof, sample.unit_price)).toBe(false)
  })

  it.each([
    ['service grouped selector', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.identidade.tipo = 'servico'
      proof.contexto_consulta.tipo = 'servico'
      proof.registro_oficial.codigoCatser = proof.registro_oficial.codigoCatmat
      delete proof.registro_oficial.codigoCatmat
    }],
    ['PDM mismatch', (sample: any) => (sample.raw_data.proveniencia_preco.contexto_consulta.codigoPdm = '19386')],
    ['zero PDM echo', (sample: any) => (sample.raw_data.proveniencia_preco.registro_oficial.codigoPdm = '0')],
    ['conflicting PDM alias', (sample: any) => (sample.raw_data.proveniencia_preco.registro_oficial.codigoPDM = '19386')],
    ['CATMAT context mismatch', (sample: any) => (sample.raw_data.proveniencia_preco.contexto_consulta.codigo = '151064')],
    ['CATMAT row mismatch', (sample: any) => (sample.raw_data.proveniencia_preco.registro_oficial.codigoCatmat = '151064')],
    ['spoofed extra code', (sample: any) => (sample.raw_data.proveniencia_preco.url_evidencia += '&codigo=151063')],
    ['missing official query', (sample: any) => delete sample.raw_data.proveniencia_preco.contexto_consulta.urlConsultaOficial],
    ['spoofed official query', (sample: any) => (sample.raw_data.proveniencia_preco.contexto_consulta.urlConsultaOficial += '&codigo=151063')],
    ['non-positive query page', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.contexto_consulta.pagina = -1
      proof.contexto_consulta.urlConsultaOficial = proof.contexto_consulta.urlConsultaOficial.replace('pagina=2', 'pagina=-1')
      proof.url_evidencia = proof.contexto_consulta.urlConsultaOficial
    }],
    ['oversized query page size', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.contexto_consulta.tamanhoPagina = 501
      proof.contexto_consulta.urlConsultaOficial = proof.contexto_consulta.urlConsultaOficial.replace('tamanhoPagina=500', 'tamanhoPagina=501')
      proof.url_evidencia = proof.contexto_consulta.urlConsultaOficial
    }],
    ['invalid state filter', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.contexto_consulta.estado = 'ce'
      proof.contexto_consulta.urlConsultaOficial = proof.contexto_consulta.urlConsultaOficial.replace('estado=CE', 'estado=ce')
      proof.url_evidencia = proof.contexto_consulta.urlConsultaOficial
    }],
    ['reversed date filters', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.contexto_consulta.dataCompraInicio = '2027-01-01'
      proof.contexto_consulta.urlConsultaOficial = proof.contexto_consulta.urlConsultaOficial.replace('dataCompraInicio=2024-01-01', 'dataCompraInicio=2027-01-01')
      proof.url_evidencia = proof.contexto_consulta.urlConsultaOficial
    }],
    ['official query with explicit default port', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.contexto_consulta.urlConsultaOficial = proof.contexto_consulta.urlConsultaOficial.replace('dadosabertos.compras.gov.br/', 'dadosabertos.compras.gov.br:443/')
      proof.url_evidencia = proof.contexto_consulta.urlConsultaOficial
    }],
    ['unbound purchase link', (sample: any) => (sample.raw_data.proveniencia_preco.url_evidencia = 'https://pncp.gov.br/app/editais/outro')],
    ['purchase link with credentials', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://user:pass@pncp.gov.br/app/editais/1'
      proof.registro_oficial.link_resultado = proof.url_evidencia
    }],
    ['purchase link on a nonofficial host', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://attacker.example/compra/1'
      proof.registro_oficial.linkEditalOuCompra = proof.url_evidencia
    }],
    ['purchase link on a malformed government host', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://.gov.br/compra/1'
      proof.registro_oficial.linkEditalOuCompra = proof.url_evidencia
    }],
    ['purchase link with port', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://pncp.gov.br:8443/app/editais/1'
      proof.registro_oficial.url = proof.url_evidencia
    }],
    ['purchase link with explicit default port', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://pncp.gov.br:443/app/editais/1'
      proof.registro_oficial.url = proof.url_evidencia
    }],
    ['purchase link with fragment', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://pncp.gov.br/app/editais/1#spoof'
      proof.registro_oficial.linkEditalOuCompra = proof.url_evidencia
    }],
    ['purchase link with empty fragment delimiter', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://pncp.gov.br/app/editais/1#'
      proof.registro_oficial.linkEditalOuCompra = proof.url_evidencia
    }],
    ['purchase link with raw whitespace', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://pncp.gov.br/app/editais/item 1'
      proof.registro_oficial.linkEditalOuCompra = proof.url_evidencia
    }],
    ['purchase link with a raw backslash', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://pncp.gov.br\\app\\editais\\1'
      proof.registro_oficial.linkEditalOuCompra = proof.url_evidencia
    }],
    ['purchase link with query immediately after host', (sample: any) => {
      const proof = sample.raw_data.proveniencia_preco
      proof.url_evidencia = 'https://pncp.gov.br?edital=1'
      proof.registro_oficial.linkEditalOuCompra = proof.url_evidencia
    }],
  ])('rejects %s', (_name, mutate) => {
    const sample = groupedPdmSample()
    mutate(sample)
    expect(
      isEligibleComprasOfficialProof(sample.raw_data.proveniencia_preco, sample.unit_price),
    ).toBe(false)
  })
})
