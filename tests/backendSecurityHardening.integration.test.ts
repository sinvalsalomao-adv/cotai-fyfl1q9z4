import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const readHook = (name: string) =>
  readFileSync(new URL(`../pocketbase/hooks/${name}`, import.meta.url), 'utf8')

type RegisteredRoute = {
  method: string
  path: string
  handler: (event: any) => any
  middleware: Array<Record<string, unknown>>
}

function registerRoutes(source: string, extra: Record<string, unknown> = {}) {
  const routes: RegisteredRoute[] = []
  const cronCallbacks: Array<() => void> = []
  const context = {
    routerAdd(
      method: string,
      path: string,
      handler: (event: any) => any,
      ...middleware: Array<Record<string, unknown>>
    ) {
      routes.push({ method, path, handler, middleware })
    },
    cronAdd(_name: string, _schedule: string, callback: () => void) {
      cronCallbacks.push(callback)
    },
    $apis: {
      requireAuth: () => ({ authenticated: true }),
      bodyLimit: (bytes: number) => ({ bodyLimit: bytes }),
    },
    console: { log() {}, error() {}, warn() {} },
    ...extra,
  }
  vm.runInNewContext(source, context)
  return { routes, cronCallbacks }
}

const event = (query: Record<string, string>, auth: any = { id: 'user-1' }) => ({
  auth,
  requestInfo: () => ({ query, body: {} }),
  json: (status: number, body: any) => ({ status, body }),
})

function balancedBlock(source: string, marker: string) {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Missing production block: ${marker}`)
  const open = source.indexOf('{', start + marker.length)
  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth++
    if (char === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`Unbalanced production block: ${marker}`)
}

describe('backend authentication boundaries', () => {
  it.each([
    ['POST', '/backend/v1/sync/daily/trigger'],
    ['GET', '/backend/v1/sync/daily/status'],
  ])('%s %s rejects anonymous callers before touching persistence', (method, path) => {
    const registered = registerRoutes(readHook('daily_sync_job.js'))
    const route = registered.routes.find((candidate) => candidate.method === method && candidate.path === path)

    expect(route?.middleware).toEqual(expect.arrayContaining([{ authenticated: true }]))
    expect(route?.handler(event({}, null))).toMatchObject({
      status: 401,
      body: { error: 'AUTH_REQUIRED' },
    })
  })

  it('protects task statistics and rejects anonymous callers before running queries', () => {
    const registered = registerRoutes(readHook('price_index_worker.js'))
    const route = registered.routes.find(
      (candidate) => candidate.method === 'GET' && candidate.path === '/backend/v1/tasks/stats',
    )

    expect(route?.middleware).toEqual(expect.arrayContaining([{ authenticated: true }]))
    expect(route?.handler(event({}, null))).toMatchObject({
      status: 401,
      body: { error: 'AUTH_REQUIRED' },
    })
  })

  it('does not let an authenticated caller process another users task', () => {
    const registered = registerRoutes(readHook('price_index_worker.js'), {
      $app: {
        findRecordById: () => ({
          getString: (field: string) =>
            field === 'server_trust_version' ? 'server-v1' : field === 'requested_by' ? 'user-2' : '',
        }),
      },
    })
    const route = registered.routes.find(
      (candidate) => candidate.method === 'POST' && candidate.path === '/backend/v1/tasks/process',
    )!

    expect(
      route.handler({
        ...event({}),
        requestInfo: () => ({ body: { tarefa_id: 'task-other-user' }, query: {} }),
      }),
    ).toMatchObject({ status: 403, body: { error: 'TASK_FORBIDDEN' } })
  })

  it('applies a durable per-user quota before processing an owned task', () => {
    class FakeDynamicModel {
      constructor(initial: Record<string, unknown>) {
        Object.assign(this, initial)
      }
    }
    const registered = registerRoutes(readHook('price_index_worker.js'), {
      DynamicModel: FakeDynamicModel,
      arrayOf: (model: FakeDynamicModel) => Object.assign([], { model }),
      $app: {
        findRecordById: () => ({
          getString: (field: string) =>
            field === 'server_trust_version' ? 'server-v1' : field === 'requested_by' ? 'user-1' : '',
        }),
        db: () => ({
          newQuery: () => ({
            bind() {
              return this
            },
            all(_target: unknown[]) {},
          }),
        }),
      },
    })
    const route = registered.routes.find(
      (candidate) => candidate.method === 'POST' && candidate.path === '/backend/v1/tasks/process',
    )!

    expect(
      route.handler({
        ...event({}),
        requestInfo: () => ({ body: { tarefa_id: 'task-owned' }, query: {} }),
      }),
    ).toMatchObject({ status: 429, body: { error: 'TASK_PROCESS_RATE_LIMITED' } })
  })
})

describe('daily sync PocketBase JSVM query contract', () => {
  it('populates DynamicModel destinations and uses a portable bounded update', () => {
    class FakeDynamicModel {
      [key: string]: unknown
      constructor(initial: Record<string, unknown>) {
        Object.assign(this, initial)
      }
    }
    class FakeRecord {
      data: Record<string, unknown> = {}
      constructor(_collection: unknown) {}
      set(name: string, value: unknown) {
        this.data[name] = value
      }
    }
    const executedSql: string[] = []
    const saved: FakeRecord[] = []
    const fakeApp = {
      db: () => ({
        newQuery(sql: string) {
          let binds: Record<string, unknown> = {}
          return {
            bind(next: Record<string, unknown>) {
              binds = next
              return this
            },
            all(target?: Array<Record<string, unknown>>) {
              if (!target) throw new Error('PocketBase JSVM requires all(arrayOf(model))')
              if (sql.includes('FROM daily_sync_runs')) {
                target.push({ ciclo_id: 'cycle-1', status: 'completed' })
              } else if (sql.includes('GROUP BY search_eligible')) {
                target.push({ qualidade_situacao: 'aceita', cnt: 7 })
              }
              return undefined
            },
            one(target?: Record<string, unknown>) {
              if (!target) throw new Error('PocketBase JSVM requires one(model)')
              Object.assign(target, { total: 7 })
              return undefined
            },
            execute() {
              executedSql.push(sql)
              if (
                /UPDATE\s+price_samples_index[\s\S]+LIMIT\s+/i.test(sql) &&
                !sql.includes('id IN (SELECT id')
              ) {
                throw new Error('SQLite build does not support UPDATE LIMIT')
              }
              expect(binds).toBeTypeOf('object')
            },
          }
        },
      }),
      findCollectionByNameOrId: (name: string) => ({ name }),
      findRecordsByFilter: () => [],
      save(record: FakeRecord) {
        saved.push(record)
      },
    }
    const registered = registerRoutes(readHook('daily_sync_job.js'), {
      $app: fakeApp,
      Record: FakeRecord,
      DynamicModel: FakeDynamicModel,
      arrayOf: (model: FakeDynamicModel) => Object.assign([], { model }),
      $security: { sha256: () => 'a'.repeat(64) },
    })
    const trigger = registered.routes.find(
      (candidate) => candidate.path === '/backend/v1/sync/daily/trigger',
    )!
    const status = registered.routes.find(
      (candidate) => candidate.path === '/backend/v1/sync/daily/status',
    )!

    const triggerResult = trigger.handler(event({}))
    const statusResult = status.handler(event({}))

    expect(triggerResult).toMatchObject({
      status: 200,
      body: {
        resultado: {
          amostras_validadas: 7,
          erros: [],
        },
      },
    })
    expect(statusResult).toMatchObject({
      status: 200,
      body: {
        ultimo_ciclo: { ciclo_id: 'cycle-1' },
        amostras_totais: { ativas_elegiveis: 7 },
      },
    })
    expect(executedSql.some((sql) => sql.includes('id IN (SELECT id'))).toBe(true)
    expect(saved.length).toBeGreaterThan(0)
  })
})

describe('official source request bounds and rate limits', () => {
  const sources = [
    {
      name: 'PNCP',
      hook: 'pncp_search.js',
      path: '/backend/v1/pncp/search',
      valid: { q: 'SERVICO', pagina: '1', tam_pagina: '50', tipos_documento: 'ata' },
      invalid: { q: 'SERVICO', tipos_documento: 'ata,origem-inventada' },
      oversized: { q: 'X'.repeat(161), tipos_documento: 'ata' },
      invalidUf: { q: 'SERVICO', uf: 'XX', tipos_documento: 'ata' },
      excessivePages: { q: 'SERVICO', limite_paginas: '21', tipos_documento: 'ata' },
      excessiveDocumentTypes: { q: 'SERVICO', tipos_documento: 'ata,ata,ata,ata' },
    },
    {
      name: 'Compras.gov.br',
      hook: 'comprasgov_search.js',
      path: '/backend/v1/cotai/comprasgov-search',
      valid: { termo: 'SERVICO', pagina: '1', limite_paginas: '1' },
      invalid: { termo: 'SERVICO', pagina: '0' },
      oversized: { termo: 'X'.repeat(161) },
      invalidUf: { termo: 'SERVICO', uf: 'XX' },
      excessivePages: { termo: 'SERVICO', limite_paginas: '21' },
      excessiveDocumentTypes: null,
    },
  ] as const

  it.each(sources)('$name rejects malformed or excessive work before network access', (fixture) => {
    const send = vi.fn(() => {
      throw new Error('network must not run for invalid input')
    })
    const registered = registerRoutes(readHook(fixture.hook), {
      $http: { send },
    })
    const route = registered.routes.find((candidate) => candidate.path === fixture.path)!

    for (const query of [
      fixture.invalid,
      fixture.oversized,
      fixture.invalidUf,
      fixture.excessivePages,
      fixture.excessiveDocumentTypes,
    ].filter(Boolean)) {
      expect(route.handler(event(query as Record<string, string>))).toMatchObject({ status: 400 })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it.each(sources)('$name returns 429 before network access when its durable quota is exhausted', (fixture) => {
    const send = vi.fn(() => {
      throw new Error('network must not run after rate-limit rejection')
    })
    class FakeDynamicModel {
      constructor(initial: Record<string, unknown>) {
        Object.assign(this, initial)
      }
    }
    const registered = registerRoutes(readHook(fixture.hook), {
      $http: { send },
      DynamicModel: FakeDynamicModel,
      arrayOf: (model: FakeDynamicModel) => Object.assign([], { model }),
      $app: {
        db: () => ({
          newQuery: () => ({
            bind() {
              return this
            },
            all(_target: unknown[]) {
              // Atomic INSERT .. ON CONFLICT .. RETURNING returns no row when the quota is full.
            },
          }),
        }),
      },
    })
    const route = registered.routes.find((candidate) => candidate.path === fixture.path)!

    expect(route.handler(event(fixture.valid as Record<string, string>))).toMatchObject({
      status: 429,
      body: { error: 'SOURCE_RATE_LIMITED' },
    })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('PNCP queue ownership boundary', () => {
  const enqueueBlock = balancedBlock(
    readHook('pncp_search.js'),
    'if (contratacoesNaoDetalhasParaFila.length > 0)',
  )

  function runEnqueue(existingTask: any) {
    const saves: any[] = []
    const lookups: string[] = []
    const context: Record<string, any> = {
      contratacoesNaoDetalhasParaFila: [
        { cnpj: '12345678000190', ano: 2026, sequencial: 7, _tipoDoc: 'ata' },
      ],
      q: 'SERVICO',
      uf: '',
      e: { auth: { id: 'user-1' } },
      pncpPendingKey: () => 'pending-key',
      pncpReceiptRecords: () => [],
      pncpSuperseded: () => false,
      pncpAdmittedBefore: () => false,
      pncpActionable: () => true,
      registrarFilaPersistida: () => undefined,
      console: { log() {} },
      Record: class {
        data: Record<string, unknown> = {}
        constructor(_collection: unknown) {}
        set(name: string, value: unknown) {
          this.data[name] = value
        }
      },
      $app: {
        findCollectionByNameOrId: () => ({}),
        findFirstRecordByData: (_collection: string, _field: string, value: string) => {
          lookups.push(value)
          if (!existingTask || existingTask.getString('task_key') !== value) throw new Error('not found')
          return existingTask
        },
        findRecordById: () => existingTask,
        runInTransaction(callback: (tx: any) => void) {
          callback({
            findRecordById: () => existingTask,
            save(record: any) {
              saves.push(record)
            },
          })
        },
        save(record: any) {
          saves.push(record)
        },
      },
    }
    vm.runInNewContext(enqueueBlock, context)
    return { saves, lookups }
  }

  it('does not append discoveries to a trusted task owned by another user', () => {
    const task = {
      id: 'task-user-2',
      data: {
        server_trust_version: 'server-v1',
        requested_by: 'user-2',
        task_key: 'AMBAS#SERVICO#ALL#OWNER#user-2',
        status: 'pending',
        pendentes: '[]',
        erros: '[]',
      },
      getString(name: string) {
        return String(this.data[name as keyof typeof this.data] ?? '')
      },
      set(name: string, value: unknown) {
        ;(this.data as Record<string, unknown>)[name] = value
      },
    }

    expect(runEnqueue(task).saves).toEqual([])
    expect(task.data.pendentes).toBe('[]')
  })

  it('does not create a queue task outside the quota-enforcing admission endpoint', () => {
    expect(runEnqueue(null).saves).toEqual([])
  })

  it('looks up and appends only to the authenticated owners qualified task key', () => {
    const task = {
      id: 'task-user-1',
      data: {
        server_trust_version: 'server-v1',
        requested_by: 'user-1',
        task_key: 'AMBAS#SERVICO#ALL#OWNER#user-1',
        status: 'pending',
        pendentes: '[]',
        erros: '[]',
      },
      getString(name: string) {
        return String(this.data[name as keyof typeof this.data] ?? '')
      },
      set(name: string, value: unknown) {
        ;(this.data as Record<string, unknown>)[name] = value
      },
    }

    const result = runEnqueue(task)

    expect(result.lookups[0]).toBe('AMBAS#SERVICO#ALL#OWNER#user-1')
    expect(result.saves).toContain(task)
  })
})
