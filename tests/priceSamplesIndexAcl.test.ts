import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

type CollectionShape = {
  name: string
  listRule?: string | null
  viewRule?: string | null
  createRule?: string | null
  updateRule?: string | null
  deleteRule?: string | null
}

function executeMigration(path: string, initial: CollectionShape[] = []) {
  const collections = new Map(initial.map((collection) => [collection.name, collection]))
  let up: ((app: any) => void) | undefined
  const context = vm.createContext({
    migrate(upMigration: (app: any) => void) {
      up = upMigration
    },
    Collection: class Collection {
      constructor(config: CollectionShape) {
        Object.assign(this, config)
      }
    },
  })
  new vm.Script(readFileSync(path, 'utf8')).runInContext(context)
  if (!up) throw new Error('Migration did not register an up function.')
  const app = {
    findCollectionByNameOrId(name: string) {
      const collection = collections.get(name)
      if (!collection) throw new Error(`missing collection ${name}`)
      return collection
    },
    save(collection: CollectionShape) {
      collections.set(collection.name, collection)
    },
  }
  up(app)
  return collections
}

const createPath = fileURLToPath(
  new URL('../pocketbase/migrations/0036_create_price_samples_index.js', import.meta.url),
)
const lockPath = fileURLToPath(
  new URL(
    '../pocketbase/migrations/1741634517_lock_price_samples_index_writes.js',
    import.meta.url,
  ),
)
const schemaPath = fileURLToPath(new URL('../src/lib/pocketbase/schema.json', import.meta.url))

function expectServerOnlyWrites(collection: CollectionShape) {
  expect(collection.createRule).toBeNull()
  expect(collection.updateRule).toBeNull()
  expect(collection.deleteRule).toBeNull()
}

describe('price_samples_index client access control', () => {
  it('creates fresh databases with client writes locked while authenticated reads remain available', () => {
    const collection = executeMigration(createPath).get('price_samples_index')

    expect(collection).toBeDefined()
    expect(collection).toMatchObject({
      listRule: '@request.auth.id != "" && server_trust_version = "server-v1"',
      viewRule: '@request.auth.id != "" && server_trust_version = "server-v1"',
    })
    expectServerOnlyWrites(collection!)
  })

  it('locks all three write operations on an already deployed collection', () => {
    expect(existsSync(lockPath)).toBe(true)
    const existing: CollectionShape = {
      name: 'price_samples_index',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
    }

    const migrated = executeMigration(lockPath, [existing]).get('price_samples_index')

    expect(migrated).toBe(existing)
    expectServerOnlyWrites(migrated!)
  })

  it('exports the same server-only write rules in the checked-in PocketBase schema', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
    const collection = schema.collections.find(
      (candidate: CollectionShape) => candidate.name === 'price_samples_index',
    )

    expect(collection).toBeDefined()
    expect(collection.apiRules).toMatchObject({
      list: '@request.auth.id != "" && server_trust_version = "server-v1"',
      view: '@request.auth.id != "" && server_trust_version = "server-v1"',
      create: null,
      update: null,
      delete: null,
    })
  })
})
