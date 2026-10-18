import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const proxySource = readFileSync(
  new URL('../pocketbase/hooks/pncp_search.js', import.meta.url),
  'utf8',
)
const workerSource = readFileSync(
  new URL('../pocketbase/hooks/price_index_worker.js', import.meta.url),
  'utf8',
)
const taskSource = readFileSync(
  new URL('../pocketbase/hooks/index_task.js', import.meta.url),
  'utf8',
)

const CNPJ = '12345678000190'
const YEAR = 2026
const SEQUENCE = 77
const ITEM = 3
const CONTROL = `${CNPJ}-1-${String(SEQUENCE).padStart(6, '0')}/${YEAR}`
const RESULT_URL =
  `https://pncp.gov.br/api/pncp/v1/orgaos/${CNPJ}/compras/${YEAR}/${SEQUENCE}` +
  `/itens/${ITEM}/resultados`

function findBalancedBlock(source: string, marker: string, from = 0) {
  const start = source.indexOf(marker, from)
  if (start < 0) throw new Error(`Production block missing: ${marker}`)
  const open = source.indexOf('{', start + marker.length)
  if (open < 0) throw new Error(`Production block has no opening brace: ${marker}`)
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
  throw new Error(`Production block is not balanced: ${marker}`)
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

function officialItem(overrides: Record<string, unknown> = {}) {
  return {
    numeroItem: ITEM,
    descricao: 'MANUTENCAO PREVENTIVA DE EQUIPAMENTO HOSPITALAR',
    quantidade: 2,
    unidadeMedida: 'SERVICO',
    ...overrides,
  }
}

function officialResult() {
  return {
    sequencialResultado: 9,
    numeroItem: ITEM,
    niFornecedor: '99888777000166',
    nomeRazaoSocialFornecedor: 'FORNECEDOR OFICIAL LTDA',
    valorUnitarioHomologado: 125.5,
    valorTotalHomologado: 251,
    dataResultado: '2026-03-04',
  }
}

function runProxyMetadata(itemOverrides: Record<string, unknown> = {}) {
  const productionFunction = findBalancedBlock(
    proxySource,
    'function processarItensDaContratacao',
  ).source
  const context = {
    itemEhCompativel: () => true,
    pncpResultKey: () => 'official-item',
    pncpValidResult: (candidate: unknown) => candidate,
    extractRawItems: (body: any) => body?.items || [],
    pncpPersistResults: () => undefined,
    extrairUnidadeQualificadaPncp: (unit: string) => unit,
    diagLogs: {
      descartes_sem_preco_unitario: 0,
      amostras_validas: 0,
      amostras_abaixo_1_real: 0,
    },
  }
  const processItems = vm.runInNewContext(`(${productionFunction})`, context) as (
    parent: Record<string, any>,
    items: Record<string, any>[],
    identity: Record<string, any>,
    cached: Record<string, any>,
  ) => boolean
  const parent: Record<string, any> = {
    numeroControlePNCP: CONTROL,
    orgaoEntidade: { cnpj: CNPJ, razaoSocial: 'SECRETARIA PAI' },
    unidadeOrgao: { ufSigla: 'CE', municipioNome: 'SOBRAL' },
    processo: 'PROC-PARENT-777',
    modalidadeNome: 'Pregão Eletrônico',
    materialOuServico: 'SERVICO',
    catalogoCodigoItem: '995555',
  }
  processItems(
    parent,
    [officialItem(itemOverrides)],
    {
      cnpj: CNPJ,
      ano: YEAR,
      sequencial: SEQUENCE,
      _pncp_compra: { controle: CONTROL },
    },
    {
      'official-item': {
        corpo_oficial: { items: [officialResult()] },
        capturado_em: '2026-03-05T00:00:00.000Z',
      },
    },
  )
  return parent.itensAta[0] as Record<string, any>
}

function workerHelpers() {
  return allBalancedBlocks(workerSource, 'function extrairCodigoItemWorker').map((source) =>
    vm.runInNewContext(`(${source})`),
  ) as Array<(item: Record<string, any>, parent?: Record<string, any>) => string>
}

function runWorkerMetadata(workerBlock: string, codeHelper: Function) {
  const persisted: Record<string, any>[] = []
  const context: Record<string, any> = {
    itensArrC: [officialItem()],
    fimTrabalhoRede: Date.now() + 60_000,
    trabalhoAdiadoPorTempo: false,
    itemEhCompativelWorker: () => true,
    aposentarItemC: () => undefined,
    cnpjC: CNPJ,
    anoC: YEAR,
    seqC: SEQUENCE,
    resultadosPositivosC: {
      official: {
        corpo_oficial: { items: [officialResult()] },
        capturado_em: '2026-03-05T00:00:00.000Z',
      },
    },
    pncpResultKey: () => 'official',
    pncpValidResult: (candidate: unknown) => candidate,
    sendHttpWithRetryUtil: () => {
      throw new Error('The verified cache fixture must not use the network')
    },
    parseJsonWorkerSafe: (value: unknown) => value,
    pncpResultEnvelope: () => null,
    novosResultadosC: {},
    cItemProcessando: {
      numeroControlePNCP: CONTROL,
      orgao: 'SECRETARIA PAI',
      uf: 'CE',
      municipio: 'SOBRAL',
      numeroProcesso: 'PROC-PARENT-777',
      codigoCatalogo: 'CATSER 995555',
      materialOuServico: 'SERVICO',
      _tipoDoc: 'ata',
      _pendente: { _pncp_compra: { controle: CONTROL } },
    },
    errosAcumulados: [],
    cacheKeyC: `${CNPJ}_${YEAR}_${SEQUENCE}`,
    canonicalNormWorkerText: (value: string) => value.toUpperCase(),
    extrairUnidadeQualificadaWorkerUtil: (unit: string) => unit,
    extrairCodigoItemWorker: codeHelper,
    calcularDiceScoreWorker: () => 100,
    tokens: ['MANUTENCAO'],
    extractWorkerTokensUtil: () => ['MANUTENCAO'],
    gerarSampleKeyUtil: (sample: Record<string, any>) => sample.source_record_id,
    colecaoAmostrasCiclo: {},
    $app: { findCollectionByNameOrId: () => ({}) },
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
  return persisted[0]
}

describe('PNCP parent metadata inheritance', () => {
  it('proxy subitem inherits missing official parent metadata and the real CATSER code', () => {
    const sample = runProxyMetadata()
    expect(sample).toMatchObject({
      orgao_comprador: 'SECRETARIA PAI',
      orgao_cnpj: CNPJ,
      uf: 'CE',
      municipio_nome: 'SOBRAL',
      processo_origem: 'PROC-PARENT-777',
      numeroControlePNCP: CONTROL,
      codigo_catalogo: 'CATSER 995555',
    })
    expect(sample.codigo_catalogo).not.toBe('CATMAT')
  })

  it('keeps item-level official metadata instead of overwriting it with the parent', () => {
    const sample = runProxyMetadata({
      orgao_comprador: 'UNIDADE FILHA',
      uf: 'SP',
      municipio_nome: 'CAMPINAS',
      processo_origem: 'PROC-ITEM-3',
      materialOuServico: 'MATERIAL',
      catalogoCodigoItem: '267676',
    })
    expect(sample).toMatchObject({
      orgao_comprador: 'UNIDADE FILHA',
      uf: 'SP',
      municipio_nome: 'CAMPINAS',
      processo_origem: 'PROC-ITEM-3',
      codigo_catalogo: 'CATMAT 267676',
    })
    expect(sample.orgao_cnpj).toBe(CNPJ)
  })

  it('treats a generic CATMAT label as missing and inherits the real parent catalog code', () => {
    const sample = runProxyMetadata({ codigo_catalogo: 'CATMAT' })
    expect(sample.codigo_catalogo).toBe('CATSER 995555')
  })

  it('classifies numeric catalog codes from their official material/service kind and never invents generic CATMAT', () => {
    const helpers = workerHelpers()
    expect(helpers).toHaveLength(2)
    for (const helper of helpers) {
      expect(helper({ codigoItem: '267676', materialOuServico: 'MATERIAL' })).toBe(
        'CATMAT 267676',
      )
      expect(helper({ codigoMaterialOuServico: '995555', materialOuServico: 'SERVICO' })).toBe(
        'CATSER 995555',
      )
      expect(helper({ catalogoCodigoItem: '995555', materialOuServico: 'S' })).toBe(
        'CATSER 995555',
      )
      expect(helper({}, { codigoCatalogo: 'CATSER 995555' })).toBe('CATSER 995555')
      expect(helper({ codigo_catalogo: 'CATMAT' }, { codigoCatalogo: 'CATSER 995555' })).toBe(
        'CATSER 995555',
      )
      expect(helper({ codigoItem: '995555' })).toBe('')
    }
  })

  const workerBlocks = allBalancedBlocks(
    workerSource,
    'for (var subI = 0; subI < itensArrC.length; subI++)',
  )

  it.each([
    ['cron worker', 0],
    ['HTTP continuation worker', 1],
  ])('%s persists inherited official metadata without changing identity', (_name, index) => {
    const sample = runWorkerMetadata(workerBlocks[index], workerHelpers()[index])
    expect(sample).toMatchObject({
      source_record_id:
        `${CNPJ}/${YEAR}/${SEQUENCE}/itens/${ITEM}` +
        '/resultados/9/fornecedor/99888777000166',
      orgao: 'SECRETARIA PAI',
      orgao_cnpj: CNPJ,
      uf: 'CE',
      municipio: 'SOBRAL',
      numero_processo: 'PROC-PARENT-777',
      codigo_item: 'CATSER 995555',
    })
  })
})

type StoredTask = {
  id: string
  data: Record<string, any>
  getString(name: string): string
  getInt(name: string): number
  set(name: string, value: unknown): void
}

function registerTaskEndpoint() {
  let handler!: (event: any) => any
  const records = new Map<string, StoredTask>()
  let nextId = 1

  class FakeRecord implements StoredTask {
    public id = ''
    public data: Record<string, any> = {}
    constructor(_collection: unknown) {}
    getString(name: string) {
      return String(this.data[name] ?? '')
    }
    getInt(name: string) {
      return Number(this.data[name] ?? 0)
    }
    set(name: string, value: unknown) {
      this.data[name] = value
    }
  }

  class FakeDynamicModel {
    [key: string]: unknown
    constructor(initial: Record<string, unknown>) {
      Object.assign(this, initial)
    }
  }

  const transaction = {
    findFirstRecordByData(_collection: string, field: string, value: string) {
      if (field !== 'task_key') throw new Error(`Unexpected lookup field: ${field}`)
      const found = records.get(value)
      if (!found) throw new Error('not found')
      return found
    },
    findCollectionByNameOrId: () => ({ name: 'price_index_tasks' }),
    save(record: StoredTask) {
      if (!record.id) record.id = `task-${nextId++}`
      records.set(record.getString('task_key'), record)
    },
    db() {
      return {
        newQuery(sql: string) {
          let params: Record<string, any> = {}
          return {
            bind(next: Record<string, any>) {
              params = next
              return this
            },
            one(target?: Record<string, unknown>) {
              if (!target) throw new Error('PocketBase JSVM requires one(model)')
              const values = [...records.values()]
              if (sql.includes('admitted_at') && sql.includes('{:cutoff}')) {
                if (!sql.includes('julianday(admitted_at) >= julianday({:cutoff})')) {
                  throw new Error('Admission window must compare PocketBase dates as dates')
                }
                Object.assign(target, {
                  total: values.filter(
                    (record) =>
                      record.getString('requested_by') === params.user &&
                      Date.parse(record.getString('admitted_at')) >= Date.parse(params.cutoff),
                  ).length,
                })
                return
              }
              if (sql.includes("status IN ('pending', 'running')")) {
                Object.assign(target, {
                  total: values.filter(
                    (record) =>
                      record.getString('requested_by') === params.user &&
                      ['pending', 'running'].includes(record.getString('status')),
                  ).length,
                })
                return
              }
              throw new Error(`Unexpected admission query: ${sql}`)
            },
          }
        },
      }
    },
  }

  vm.runInNewContext(taskSource, {
    routerAdd(_method: string, _path: string, callback: typeof handler) {
      handler = callback
    },
    Record: FakeRecord,
    DynamicModel: FakeDynamicModel,
    $app: {
      runInTransaction(callback: (tx: typeof transaction) => void) {
        callback(transaction)
      },
    },
    $apis: {
      requireAuth: () => ({ authenticated: true }),
      bodyLimit: () => ({ bodyLimit: true }),
    },
  })

  const call = (body: Record<string, unknown>, user = 'user-1') =>
    handler({
      auth: { id: user },
      requestInfo: () => ({ body }),
      json: (status: number, responseBody: any) => ({ status, body: responseBody }),
    })

  return { call, records }
}

describe('server-side index task admission', () => {
  it('admits work when JSVM one(model) populates the model and returns no row value', () => {
    const endpoint = registerTaskEndpoint()

    const admitted = endpoint.call({ termo: 'servico de calibracao', source: 'AMBAS', uf: 'CE' })

    expect(admitted).toMatchObject({
      status: 200,
      body: { sucesso: true, tarefa: { status: 'pending' } },
    })
    expect(endpoint.records.size).toBe(1)
  })

  it('rejects a term that becomes empty after canonical normalization', () => {
    const endpoint = registerTaskEndpoint()
    const denied = endpoint.call({ termo: '!!!', source: 'PNCP', uf: '' })
    expect(denied).toMatchObject({
      status: 400,
      body: { sucesso: false, error: 'INVALID_TASK' },
    })
    expect(endpoint.records.size).toBe(0)
  })

  it('is idempotent by normalized source, term and UF without trusting mutable client fields', () => {
    const endpoint = registerTaskEndpoint()
    const first = endpoint.call({
      termo: '  Dipirona--500 mg ',
      source: 'ambas',
      uf: 'ce',
      status: 'completed',
      pendentes: [{ injected: true }],
      server_trust_version: 'attacker-v9',
    })
    const repeated = endpoint.call({ termo: 'dipirona 500 mg', source: 'AMBAS', uf: 'CE' })

    expect(first.status).toBe(200)
    expect(repeated.status).toBe(200)
    expect(repeated.body.tarefa.id).toBe(first.body.tarefa.id)
    expect(endpoint.records.size).toBe(1)
    const stored = [...endpoint.records.values()][0]
    expect(stored.data).toMatchObject({
      status: 'pending',
      pendentes: '[]',
      server_trust_version: 'server-v1',
      requested_by: 'user-1',
      task_key: 'AMBAS#DIPIRONA 500 MG#CE#OWNER#user-1',
    })
    expect(stored.data).not.toHaveProperty('injected')
  })

  it('returns an explicit 429 after twelve new normalized tasks per user per minute but still permits idempotent reuse', () => {
    const endpoint = registerTaskEndpoint()
    const admitted = Array.from({ length: 12 }, (_, index) =>
      endpoint.call({ termo: `produto distinto ${index}`, source: 'PNCP', uf: '' }),
    )
    expect(admitted.every((response) => response.status === 200)).toBe(true)

    const denied = endpoint.call({ termo: 'produto distinto treze', source: 'PNCP', uf: '' })
    expect(denied).toMatchObject({
      status: 429,
      body: { sucesso: false, error: 'TASK_RATE_LIMITED' },
    })
    expect(denied.body.retry_after_seconds).toBeGreaterThan(0)

    const repeated = endpoint.call({ termo: 'PRODUTO DISTINTO 0', source: 'PNCP', uf: '' })
    expect(repeated.status).toBe(200)
    expect(endpoint.records.size).toBe(12)
  })

  it('scopes the rolling admission quota to the authenticated user', () => {
    const endpoint = registerTaskEndpoint()
    for (let index = 0; index < 12; index++) {
      expect(
        endpoint.call({ termo: `produto usuario um ${index}`, source: 'PNCP', uf: '' }, 'user-1')
          .status,
      ).toBe(200)
    }
    expect(
      endpoint.call({ termo: 'produto bloqueado', source: 'PNCP', uf: '' }, 'user-1').status,
    ).toBe(429)
    expect(
      endpoint.call({ termo: 'produto usuario dois', source: 'PNCP', uf: '' }, 'user-2').status,
    ).toBe(200)
  })

  it('admits the same normalized term independently for two authenticated users', () => {
    const endpoint = registerTaskEndpoint()

    const first = endpoint.call({ termo: 'cadeira escolar', source: 'AMBAS', uf: 'CE' }, 'user-1')
    const second = endpoint.call({ termo: 'cadeira escolar', source: 'AMBAS', uf: 'CE' }, 'user-2')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.tarefa.id).not.toBe(first.body.tarefa.id)
    expect([...endpoint.records.keys()]).toEqual(
      expect.arrayContaining([
        'AMBAS#CADEIRA ESCOLAR#CE#OWNER#user-1',
        'AMBAS#CADEIRA ESCOLAR#CE#OWNER#user-2',
      ]),
    )
  })

  it('enforces an explicit active-task quota without deleting or modifying existing tasks', () => {
    const endpoint = registerTaskEndpoint()
    const oldIso = new Date(Date.now() - 2 * 60_000).toISOString()
    for (let index = 0; index < 50; index++) {
      const key = `PNCP#OLD PRODUCT ${index}#ALL`
      const data = {
        task_key: key,
        termo: `old product ${index}`,
        source: 'PNCP',
        uf: '',
        status: 'pending',
        requested_by: 'user-1',
        admitted_at: oldIso,
        server_trust_version: 'server-v1',
      }
      endpoint.records.set(key, {
        id: `old-${index}`,
        data,
        getString: (name: string) => String(data[name as keyof typeof data] ?? ''),
        getInt: () => 0,
        set: (name: string, value: unknown) => {
          ;(data as Record<string, unknown>)[name] = value
        },
      })
    }
    const snapshot = createHash('sha256')
      .update(JSON.stringify([...endpoint.records.values()].map((record) => record.data)))
      .digest('hex')

    const denied = endpoint.call({ termo: 'novo servico', source: 'AMBAS', uf: 'CE' })
    expect(denied).toMatchObject({
      status: 429,
      body: { sucesso: false, error: 'TASK_ACTIVE_QUOTA_EXCEEDED' },
    })
    expect(endpoint.records.size).toBe(50)
    expect(
      createHash('sha256')
        .update(JSON.stringify([...endpoint.records.values()].map((record) => record.data)))
        .digest('hex'),
    ).toBe(snapshot)
  })

  it('exports private admission fields and indexes on the locked task collection', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../src/lib/pocketbase/schema.json', import.meta.url), 'utf8'),
    )
    const tasks = schema.collections.find((collection: any) => collection.name === 'price_index_tasks')
    expect(tasks.apiRules).toMatchObject({ create: null, update: null, delete: null })
    expect(tasks.fields.map((field: any) => field.name)).toEqual(
      expect.arrayContaining(['requested_by', 'admitted_at']),
    )
    expect(tasks.indexes.some((index: string) => index.includes('requested_by'))).toBe(true)
  })
})
