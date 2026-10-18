import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PncpConnectorAdapter } from '../src/lib/connectors/pncpConnectorAdapter'

const proxySource = readFileSync(
  new URL('../pocketbase/hooks/pncp_search.js', import.meta.url),
  'utf8',
)
const workerSource = readFileSync(
  new URL('../pocketbase/hooks/price_index_worker.js', import.meta.url),
  'utf8',
)

const CNPJ_ORGAO = '00000000000001'
const ANO = 2026
const SEQUENCIAL_COMPRA = 9
const NUMERO_ITEM = 2
const CONTROLE_PNCP = `${CNPJ_ORGAO}-1-${SEQUENCIAL_COMPRA}/${ANO}`
const URL_ITEM =
  `https://pncp.gov.br/api/pncp/v1/orgaos/${CNPJ_ORGAO}` +
  `/compras/${ANO}/${SEQUENCIAL_COMPRA}/itens/${NUMERO_ITEM}`
const URL_RESULTADOS = `${URL_ITEM}/resultados`

const resultadosOficiais = [
  {
    sequencialResultado: 11,
    niFornecedor: '00000000000011',
    nomeRazaoSocialFornecedor: 'FORNECEDOR UM LTDA',
    valorUnitarioHomologado: 0.47,
    valorTotalHomologado: 47,
    dataResultado: '2026-01-11',
  },
  {
    sequencialResultado: 12,
    niFornecedor: '00000000000012',
    nomeRazaoSocialFornecedor: 'FORNECEDOR DOIS LTDA',
    valorUnitarioHomologado: 0.53,
    valorTotalHomologado: 53,
    dataResultado: '2026-01-12',
  },
  {
    sequencialResultado: 13,
    niFornecedor: '00000000000013',
    nomeRazaoSocialFornecedor: 'FORNECEDOR TRES LTDA',
    valorUnitarioHomologado: 0.61,
    valorTotalHomologado: 61,
    dataResultado: '2026-01-13',
  },
] as const

function findBalancedBlock(source: string, marker: string, from = 0) {
  const start = source.indexOf(marker, from)
  if (start < 0) throw new Error(`Bloco de produção ausente: ${marker}`)
  const open = source.indexOf('{', start + marker.length)
  if (open < 0) throw new Error(`Bloco sem abertura: ${marker}`)

  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = open; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth++
    if (character === '}') {
      depth--
      if (depth === 0) return { source: source.slice(start, index + 1), end: index + 1 }
    }
  }
  throw new Error(`Bloco sem fechamento: ${marker}`)
}

function allBalancedBlocks(source: string, marker: string) {
  const blocks: string[] = []
  let cursor = 0
  while (source.indexOf(marker, cursor) >= 0) {
    const block = findBalancedBlock(source, marker, cursor)
    blocks.push(block.source)
    cursor = block.end
  }
  return blocks
}

function itemOficial(valorEstimado = 7.5) {
  return {
    numeroItem: NUMERO_ITEM,
    descricao: 'COMPRIMIDO REVESTIDO CONTENDO IBUPROFENO 600 MG',
    materialOuServico: 'MATERIAL',
    materialOuServicoNome: 'IBUPROFENO 600 MG',
    codigoItem: '267676',
    valorUnitarioEstimado: valorEstimado,
    quantidade: 100,
    unidadeMedida: 'COMPRIMIDO',
    marcaNome: 'NÃO INFORMADO',
  }
}

function envelope(resultados: readonly Record<string, unknown>[]) {
  return {
    corpo_oficial: { items: resultados },
    capturado_em: '2026-01-20T00:00:00.000Z',
  }
}

function runProxyFanout(
  resultados: readonly Record<string, unknown>[],
  valorEstimado = 7.5,
) {
  const productionFunction = findBalancedBlock(
    proxySource,
    'function processarItensDaContratacao',
  ).source
  const context = {
    itemEhCompativel: () => true,
    pncpResultKey: () => 'item-2',
    pncpValidResult: (candidate: unknown) => candidate,
    extractRawItems: (body: any) =>
      Array.isArray(body) ? body : body?.items || body?.data || body?.resultado || [],
    pncpResultEnvelope: () => null,
    pncpPersistResults: () => undefined,
    extrairUnidadeQualificadaPncp: (unit: string) => unit,
    diagLogs: { descartes_sem_preco_unitario: 0, amostras_validas: 0, amostras_abaixo_1_real: 0 },
  }
  const processar = vm.runInNewContext(`(${productionFunction})`, context) as (
    entry: Record<string, any>,
    items: Record<string, any>[],
    purchase: Record<string, any>,
    cachedResults: Record<string, any>,
  ) => boolean
  const entry: Record<string, any> = { fornecedor: null }

  processar(
    entry,
    [itemOficial(valorEstimado)],
    {
      cnpj: CNPJ_ORGAO,
      ano: ANO,
      sequencial: SEQUENCIAL_COMPRA,
      _pncp_compra: { controle: CONTROLE_PNCP },
    },
    { 'item-2': envelope(resultados) },
  )

  return entry.itensAta as Record<string, any>[]
}

function normalizedIdentities(samples: Record<string, any>[]) {
  const adapter = new PncpConnectorAdapter()
  return samples.map((sample, index) => {
    const normalized = adapter.normalize(
      {
        ...sample,
        orgao_cnpj: CNPJ_ORGAO,
        anoCompra: ANO,
        sequencialCompra: SEQUENCIAL_COMPRA,
        numeroControlePNCP: CONTROLE_PNCP,
        orgao_comprador: 'ÓRGÃO DE TESTE',
      },
      index,
    )
    if (!normalized) throw new Error(`Amostra PNCP ${index} descartada pelo adapter`)
    return normalized.idExterno
  })
}

function runWorkerFanout(workerBlock: string, resultados: readonly Record<string, unknown>[]) {
  const persisted: Record<string, any>[] = []
  const officialEnvelope = envelope(resultados)
  const context: Record<string, any> = {
    itensArrC: [itemOficial()],
    fimTrabalhoRede: Date.now() + 60_000,
    trabalhoAdiadoPorTempo: false,
    itemEhCompativelWorker: () => true,
    aposentarItemC: () => undefined,
    cnpjC: CNPJ_ORGAO,
    anoC: ANO,
    seqC: SEQUENCIAL_COMPRA,
    resultadosPositivosC: { 'item-2': officialEnvelope },
    pncpResultKey: () => 'item-2',
    pncpValidResult: (candidate: unknown) => candidate,
    sendHttpWithRetryUtil: () => {
      throw new Error('O fixture possui cache oficial e não deve acessar a rede')
    },
    parseJsonWorkerSafe: (body: unknown) => body,
    pncpResultEnvelope: () => null,
    novosResultadosC: {},
    cItemProcessando: {
      numeroControlePNCP: CONTROLE_PNCP,
      orgao: 'ÓRGÃO DE TESTE',
      uf: 'CE',
      municipio: 'FORTALEZA',
      _tipoDoc: 'ata',
      _pendente: { _pncp_compra: { controle: CONTROLE_PNCP } },
    },
    errosAcumulados: [],
    cacheKeyC: `${CNPJ_ORGAO}_${ANO}_${SEQUENCIAL_COMPRA}`,
    canonicalNormWorkerText: (value: string) => value.toUpperCase(),
    extrairUnidadeQualificadaWorkerUtil: (unit: string) => unit,
    extrairCodigoItemWorker: (item: Record<string, any>) => item.codigoItem,
    calcularDiceScoreWorker: () => 1,
    tokens: ['ibuprofeno'],
    extractWorkerTokensUtil: () => ['ibuprofeno'],
    gerarSampleKeyUtil: (sample: Record<string, any>) => sample.source_record_id,
    colecaoAmostrasCiclo: {},
    $app: {
      findCollectionByNameOrId: () => ({}),
    },
    persistirLoteAmostrasProgressivo: (samples: Record<string, any>[]) => {
      persisted.push(...samples.map((sample) => structuredClone(sample)))
      return { inseridas: samples.length, atualizadas: 0, falhou: false }
    },
    amostrasInseridasTotal: 0,
    amostrasAtualizadasTotal: 0,
    modoHttp: false,
    totalAmostrasHttp: 0,
    amostrasHttp: [],
  }

  vm.runInNewContext(workerBlock, context)
  return persisted
}

describe('PNCP /resultados fan-out', () => {
  it('proxy emits every positive homologated result and never the estimate when results exist', () => {
    const samples = runProxyFanout(resultadosOficiais)

    expect(samples).toHaveLength(3)
    expect(samples.map((sample) => sample.valorUnitarioHomologado)).toEqual([0.47, 0.53, 0.61])
    expect(samples.map((sample) => sample.valorUnitarioEstimado)).toEqual([0, 0, 0])
    expect(samples.every((sample) => sample.naturezaPreco === 'homologado')).toBe(true)
  })

  it('proxy preserves one estimated fallback only when the official result set is empty', () => {
    const samples = runProxyFanout([])

    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      valorUnitarioHomologado: 0,
      valorUnitarioEstimado: 7.5,
      naturezaPreco: 'estimado',
    })
  })

  it('adapter identities keep supplier and sequencialResultado distinct after proxy fan-out', () => {
    const identities = normalizedIdentities(runProxyFanout(resultadosOficiais))

    expect(identities).toEqual([
      `${CNPJ_ORGAO}/${ANO}/${SEQUENCIAL_COMPRA}/itens/${NUMERO_ITEM}/resultados/11/fornecedor/00000000000011`,
      `${CNPJ_ORGAO}/${ANO}/${SEQUENCIAL_COMPRA}/itens/${NUMERO_ITEM}/resultados/12/fornecedor/00000000000012`,
      `${CNPJ_ORGAO}/${ANO}/${SEQUENCIAL_COMPRA}/itens/${NUMERO_ITEM}/resultados/13/fornecedor/00000000000013`,
    ])
    expect(new Set(identities).size).toBe(3)
  })

  const workerBlocks = allBalancedBlocks(
    workerSource,
    'for (var subI = 0; subI < itensArrC.length; subI++)',
  )

  it('keeps executable coverage over both duplicated PNCP worker paths', () => {
    expect(workerBlocks).toHaveLength(2)
  })

  it.each([
    ['worker HTTP/cron path', 0],
    ['worker persistent continuation path', 1],
  ])('%s persists all homologated results with distinct identities', (_name, pathIndex) => {
    const persisted = runWorkerFanout(workerBlocks[pathIndex], resultadosOficiais)

    expect(persisted).toHaveLength(3)
    expect(persisted.map((sample) => sample.valor_unitario)).toEqual([0.47, 0.53, 0.61])
    expect(persisted.map((sample) => sample.natureza_preco)).toEqual([
      'homologado',
      'homologado',
      'homologado',
    ])
    expect(new Set(persisted.map((sample) => sample.source_record_id)).size).toBe(3)
    expect(persisted.map((sample) => sample.source_record_id)).toEqual([
      `${CNPJ_ORGAO}/${ANO}/${SEQUENCIAL_COMPRA}/itens/${NUMERO_ITEM}/resultados/11/fornecedor/00000000000011`,
      `${CNPJ_ORGAO}/${ANO}/${SEQUENCIAL_COMPRA}/itens/${NUMERO_ITEM}/resultados/12/fornecedor/00000000000012`,
      `${CNPJ_ORGAO}/${ANO}/${SEQUENCIAL_COMPRA}/itens/${NUMERO_ITEM}/resultados/13/fornecedor/00000000000013`,
    ])
  })
})
