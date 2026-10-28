import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('official ingestion derived state boundary', () => {
  it('locks cache, task and receipt writes while retaining authenticated reads where needed', () => {
    const schema = JSON.parse(read('../src/lib/pocketbase/schema.json'))
    for (const name of ['pncp_item_cache', 'price_index_tasks', 'price_samples_index']) {
      const collection = schema.collections.find((entry: any) => entry.name === name)
      expect(collection.apiRules).toMatchObject({ create: null, update: null, delete: null })
      expect(collection.apiRules.list).toContain('@request.auth.id')
      expect(collection.fields.some((field: any) => field.name === 'server_trust_version')).toBe(true)
    }
    const tasks = schema.collections.find((entry: any) => entry.name === 'price_index_tasks')
    expect(tasks.apiRules.list).toContain('requested_by = @request.auth.id')
    expect(tasks.apiRules.view).toContain('requested_by = @request.auth.id')
    const receipts = schema.collections.find(
      (entry: any) => entry.name === 'official_ingestion_receipts',
    )
    expect(receipts.apiRules).toEqual({
      list: null,
      view: null,
      create: null,
      update: null,
      delete: null,
    })
  })

  it('does not trust legacy cache/tasks and admits new tasks only through an authenticated hook', () => {
    const migration = read(
      '../pocketbase/migrations/1741634526_consolidate_search_and_admission.js',
    )
    const pncp = read('../pocketbase/hooks/pncp_search.js')
    const worker = read('../pocketbase/hooks/price_index_worker.js')
    const task = read('../pocketbase/hooks/index_task.js')
    const search = read('../pocketbase/hooks/prices_search.js')

    expect(migration).toContain("collection.createRule = null")
    expect(migration).not.toContain("record.set('server_trust_version'")
    expect(pncp).toContain("getString('server_trust_version') !== 'server-v1'")
    expect(worker).toContain("server_trust_version = 'server-v1'")
    expect(task).toContain("record.set('server_trust_version', 'server-v1')")
    expect(task).toContain('$apis.requireAuth()')
    expect(search).toContain("server_trust_version = 'server-v1'")
  })

  it('fully resets legacy task state before granting the server trust marker', () => {
    const pncp = read('../pocketbase/hooks/pncp_search.js')
    const task = read('../pocketbase/hooks/index_task.js')
    const requiredResets = [
      "set('task_key'",
      "set('source'",
      "set('termo'",
      "set('uf'",
      "set('status', 'pending')",
      "set('paginas_consultadas', 0)",
      "set('itens_processados', 0)",
      "set('amostras_inseridas', 0)",
      "set('amostras_atualizadas', 0)",
      "set('tentativas', 0)",
      "set('started_at', '')",
      "set('finished_at', '')",
      "set('ultimo_erro', '')",
      "set('progress_at', null)",
    ]

    for (const reset of requiredResets) {
      expect(pncp).toContain(reset)
      expect(task).toContain(reset)
    }
  })
})
