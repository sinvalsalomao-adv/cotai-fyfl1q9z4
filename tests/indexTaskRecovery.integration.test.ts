import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const hookSource = readFileSync(
  new URL('../pocketbase/hooks/index_task.js', import.meta.url),
  'utf8',
)

type StoredTask = {
  id: string
  data: Record<string, unknown>
  getString(name: string): string
  getInt(name: string): number
  set(name: string, value: unknown): void
}

function createTaskEndpoint() {
  let handler!: (event: any) => any
  let nextId = 1
  let saves = 0
  let admissionQueries = 0
  const records = new Map<string, StoredTask>()

  class FakeRecord implements StoredTask {
    public id = ''
    public data: Record<string, unknown> = {}
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
      if (field !== 'task_key') throw new Error(`Unexpected lookup: ${field}`)
      const record = records.get(value)
      if (!record) throw new Error('not found')
      return record
    },
    findCollectionByNameOrId: () => ({ name: 'price_index_tasks' }),
    save(record: StoredTask) {
      saves++
      if (!record.id) record.id = `task-${nextId++}`
      for (const [key, stored] of records) {
        if (stored === record && key !== record.getString('task_key')) records.delete(key)
      }
      records.set(record.getString('task_key'), record)
    },
    db() {
      return {
        newQuery(sql: string) {
          admissionQueries++
          let params: Record<string, string> = {}
          return {
            bind(next: Record<string, string>) {
              params = next
              return this
            },
            one(target: Record<string, unknown>) {
              const all = [...records.values()]
              if (sql.includes('admitted_at')) {
                Object.assign(target, {
                  total: all.filter(
                    (record) =>
                      record.getString('server_trust_version') === 'server-v1' &&
                      record.getString('requested_by') === params.user &&
                      Date.parse(record.getString('admitted_at')) >= Date.parse(params.cutoff),
                  ).length,
                })
                return
              }
              if (sql.includes("status IN ('pending', 'running')")) {
                Object.assign(target, {
                  total: all.filter(
                    (record) =>
                      record.getString('server_trust_version') === 'server-v1' &&
                      record.getString('requested_by') === params.user &&
                      ['pending', 'running'].includes(record.getString('status')),
                  ).length,
                })
                return
              }
              throw new Error(`Unexpected query: ${sql}`)
            },
          }
        },
      }
    },
  }

  vm.runInNewContext(hookSource, {
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

  function seed(data: Record<string, unknown>) {
    const record = new FakeRecord({})
    record.id = String(data.id || `seed-${nextId++}`)
    record.data = {
      task_key: 'AMBAS#IBUPROFENO#ALL#OWNER#user-1',
      source: 'AMBAS',
      termo: 'ibuprofeno',
      uf: '',
      status: 'failed',
      pendentes: '[]',
      tentativas: 7,
      erros: JSON.stringify(['falha oficial preservada']),
      paginas_consultadas: 12,
      itens_processados: 34,
      amostras_inseridas: 5,
      amostras_atualizadas: 2,
      requested_by: 'user-1',
      admitted_at: '2026-10-18T10:00:00.000Z',
      finished_at: '2026-10-18T10:05:00.000Z',
      server_trust_version: 'server-v1',
      ...data,
    }
    records.set(record.getString('task_key'), record)
    return record
  }

  const call = (user = 'user-1') =>
    handler({
      auth: { id: user },
      requestInfo: () => ({ body: { termo: 'IBUPROFENO', source: 'AMBAS', uf: '' } }),
      json: (status: number, body: any) => ({ status, body }),
    })

  return {
    call,
    seed,
    records,
    saveCount: () => saves,
    admissionQueryCount: () => admissionQueries,
  }
}

function actionablePurchase(overrides: Record<string, unknown> = {}) {
  return {
    c: '12345678000190',
    a: 2026,
    s: 77,
    t: 'ata',
    r: 2,
    i: 0,
    b: 0,
    numeroControlePNCP: '12345678000190-1-000077/2026',
    ...overrides,
  }
}

describe('server-side terminal index-task recovery', () => {
  it('rearms an owned failed task with validated actionable PNCP work without erasing evidence', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({
      task_key: 'AMBAS#IBUPROFENO#ALL',
      pendentes: JSON.stringify([actionablePurchase()]),
    })
    const evidence = {
      tentativas: task.data.tentativas,
      erros: task.data.erros,
      paginas_consultadas: task.data.paginas_consultadas,
      itens_processados: task.data.itens_processados,
      amostras_inseridas: task.data.amostras_inseridas,
      amostras_atualizadas: task.data.amostras_atualizadas,
      admitted_at: task.data.admitted_at,
      finished_at: task.data.finished_at,
      pendentes: task.data.pendentes,
    }

    const response = endpoint.call()

    expect(response).toMatchObject({
      status: 200,
      body: { sucesso: true, tarefa: { id: task.id, status: 'pending' } },
    })
    expect(task.data).toMatchObject(evidence)
    expect(task.data.status).toBe('pending')
    expect(task.data.task_key).toBe('AMBAS#IBUPROFENO#ALL#OWNER#user-1')
    expect(endpoint.saveCount()).toBe(1)
  })

  it('never promotes an untrusted row that already occupies the owners qualified key', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({ server_trust_version: 'client-v1', requested_by: 'user-1' })
    const before = structuredClone(task.data)

    const response = endpoint.call('user-1')

    expect(response).toMatchObject({
      status: 409,
      body: { sucesso: false, error: 'TASK_KEY_CONFLICT' },
    })
    expect(task.data).toEqual(before)
    expect(endpoint.saveCount()).toBe(0)
  })

  it('keeps a failed task terminal when every pending purchase exhausted its retry ceiling', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({ pendentes: JSON.stringify([actionablePurchase({ r: 4 })]) })

    const response = endpoint.call()

    expect(response.body.tarefa.status).toBe('failed')
    expect(task.data.status).toBe('failed')
    expect(endpoint.saveCount()).toBe(0)
  })

  it('keeps a completed task terminal when it has no actionable pending work', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({ status: 'completed', pendentes: '[]' })

    const response = endpoint.call()

    expect(response.body.tarefa.status).toBe('completed')
    expect(task.data.status).toBe('completed')
    expect(endpoint.saveCount()).toBe(0)
  })

  it('rearms at most once and then idempotently reuses the pending task', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({ pendentes: JSON.stringify([actionablePurchase()]) })

    expect(endpoint.call().body.tarefa.status).toBe('pending')
    expect(endpoint.call().body.tarefa.status).toBe('pending')

    expect(task.data.status).toBe('pending')
    expect(endpoint.saveCount()).toBe(1)
  })

  it('rearming the same task bypasses new-admission quotas but does not change admission evidence', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({
      admitted_at: new Date().toISOString(),
      pendentes: JSON.stringify([actionablePurchase()]),
    })
    for (let index = 0; index < 12; index++) {
      endpoint.seed({
        id: `quota-${index}`,
        task_key: `PNCP#OUTRO ${index}#ALL`,
        termo: `outro ${index}`,
        source: 'PNCP',
        status: 'completed',
        pendentes: '[]',
        admitted_at: new Date().toISOString(),
      })
    }
    const admittedAt = task.data.admitted_at

    const response = endpoint.call()

    expect(response).toMatchObject({ status: 200, body: { tarefa: { status: 'pending' } } })
    expect(task.data.admitted_at).toBe(admittedAt)
    expect(endpoint.admissionQueryCount()).toBe(0)
  })

  it('gives another user an isolated task instead of rearming the first users task', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({ pendentes: JSON.stringify([actionablePurchase()]) })

    const response = endpoint.call('user-2')

    expect(response).toMatchObject({ status: 200, body: { sucesso: true } })
    expect(response.body.tarefa.id).not.toBe(task.id)
    expect(response.body.tarefa.task_key).toBeUndefined()
    expect(task.data.status).toBe('failed')
    expect(endpoint.saveCount()).toBe(1)
    const isolated = [...endpoint.records.values()].find((candidate) => candidate.id !== task.id)!
    expect(isolated.data).toMatchObject({
      task_key: 'AMBAS#IBUPROFENO#ALL#OWNER#user-2',
      requested_by: 'user-2',
      status: 'pending',
    })
  })

  it('does not assign an ownerless legacy task implicitly to an authenticated caller', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({
      task_key: 'AMBAS#IBUPROFENO#ALL',
      requested_by: '',
      admitted_at: '',
      pendentes: JSON.stringify([actionablePurchase()]),
    })

    const response = endpoint.call('user-2')

    expect(response).toMatchObject({ status: 200, body: { sucesso: true } })
    expect(task.data.requested_by).toBe('')
    expect(task.data.admitted_at).toBe('')
    expect(task.data.status).toBe('failed')
    const isolated = [...endpoint.records.values()].find((candidate) => candidate.id !== task.id)!
    expect(isolated.data).toMatchObject({
      task_key: 'AMBAS#IBUPROFENO#ALL#OWNER#user-2',
      requested_by: 'user-2',
    })
  })

  it('does not disclose or reuse an active task owned by another user', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({ status: 'running', pendentes: JSON.stringify([actionablePurchase()]) })

    const response = endpoint.call('user-2')

    expect(response).toMatchObject({ status: 200, body: { sucesso: true } })
    expect(response.body.tarefa.id).not.toBe(task.id)
    expect(task.data.status).toBe('running')
    expect(endpoint.saveCount()).toBe(1)
  })

  it('does not rearm quarantined work or a relationship recovery with an active claim/cooldown', () => {
    const endpoint = createTaskEndpoint()
    const quarantined = endpoint.seed({
      pendentes: JSON.stringify([
        actionablePurchase({
          t: 'contrato',
          numeroControlePNCP: '12345678000190-2-000077/2026',
          _pncp_relacao: {
            v: 1,
            falhas: 1,
            lastStatus: 'contrato_http',
            quarentena: true,
          },
        }),
      ]),
    })
    expect(endpoint.call().body.tarefa.status).toBe('failed')
    expect(quarantined.data.status).toBe('failed')

    quarantined.data.pendentes = JSON.stringify([
      actionablePurchase({
        t: 'contrato',
        numeroControlePNCP: '12345678000190-2-000077/2026',
        _pncp_relacao: {
          v: 1,
          falhas: 1,
          lastStatus: 'resolvendo',
          claim: 'active-operation',
          ate: Date.now() + 60_000,
        },
      }),
    ])
    expect(endpoint.call().body.tarefa.status).toBe('failed')
    expect(quarantined.data.status).toBe('failed')
    expect(endpoint.saveCount()).toBe(0)
  })

  it('does not rearm otherwise valid purchase work while its operation is quarantined or cooling down', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({
      pendentes: JSON.stringify([
        actionablePurchase({
          _pncp_relacao: {
            v: 1,
            falhas: 1,
            lastStatus: 'contrato_http',
            quarentena: true,
          },
        }),
      ]),
    })

    expect(endpoint.call().body.tarefa.status).toBe('failed')
    expect(task.data.status).toBe('failed')

    task.data.pendentes = JSON.stringify([
      actionablePurchase({
        _pncp_relacao: {
          v: 1,
          falhas: 1,
          lastStatus: 'adiado',
          cooldown_ate: Date.now() + 60_000,
        },
      }),
    ])
    expect(endpoint.call().body.tarefa.status).toBe('failed')
    expect(task.data.status).toBe('failed')
    expect(endpoint.saveCount()).toBe(0)
  })

  it('accepts the worker queue boundary of 300 purchases plus its single discovery marker', () => {
    const endpoint = createTaskEndpoint()
    const purchases = Array.from({ length: 300 }, (_, index) =>
      actionablePurchase({ s: index + 1, numeroControlePNCP: undefined }),
    )
    const task = endpoint.seed({
      status: 'completed',
      pendentes: JSON.stringify([
        ...purchases,
        { _pncp_discovery: { esgotados: { ata: true, edital: false, contrato: false } } },
      ]),
    })

    expect(endpoint.call().body.tarefa.status).toBe('pending')
    expect(task.data.status).toBe('pending')
    expect(endpoint.saveCount()).toBe(1)
  })

  it('does not rearm from a malformed discovery marker', () => {
    const endpoint = createTaskEndpoint()
    const task = endpoint.seed({
      status: 'completed',
      pendentes: JSON.stringify([{ _pncp_discovery: {} }]),
    })

    expect(endpoint.call().body.tarefa.status).toBe('completed')
    expect(task.data.status).toBe('completed')
    expect(endpoint.saveCount()).toBe(0)
  })
})
