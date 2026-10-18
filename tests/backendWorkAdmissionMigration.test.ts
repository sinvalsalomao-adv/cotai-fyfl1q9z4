import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'

const migrationUrl = new URL(
  '../pocketbase/migrations/1741634524_harden_backend_work_admission.js',
  import.meta.url,
)

describe('backend work admission security migration', () => {
  it('creates private per-route quotas and reapplies owner-scoped task ACL idempotently', () => {
    expect(existsSync(migrationUrl)).toBe(true)
    const db = new DatabaseSync(':memory:')
    let up: (app: any) => void = () => undefined
    let down: (app: any) => void = () => undefined
    vm.runInNewContext(readFileSync(migrationUrl, 'utf8'), {
      migrate(upHandler: typeof up, downHandler: typeof down) {
        up = upHandler
        down = downHandler
      },
    })
    const tasks = {
      listRule: '',
      viewRule: '',
      createRule: 'unsafe',
      updateRule: 'unsafe',
      deleteRule: 'unsafe',
    }
    const save = vi.fn()
    const app = {
      findCollectionByNameOrId: () => tasks,
      save,
      db: () => ({
        newQuery(sql: string) {
          return {
            execute() {
              db.exec(sql)
            },
          }
        },
      }),
    }

    up(app)
    down(app)
    up(app)

    expect(tasks.listRule).toContain('requested_by = @request.auth.id')
    expect(tasks.viewRule).toContain('requested_by = @request.auth.id')
    expect(tasks.createRule).toBeNull()
    expect(tasks.updateRule).toBeNull()
    expect(tasks.deleteRule).toBeNull()
    expect(save).toHaveBeenCalledTimes(2)

    const columns = db
      .prepare('PRAGMA table_info(cotai_backend_rate_limits)')
      .all() as Array<{ name: string; notnull: number; pk: number }>
    expect(columns.map(({ name }) => name)).toEqual([
      'user_id',
      'route_key',
      'window_started_at',
      'request_count',
      'updated_at',
    ])
    expect(columns.find(({ name }) => name === 'user_id')).toMatchObject({ notnull: 1, pk: 1 })
    expect(columns.find(({ name }) => name === 'route_key')).toMatchObject({ notnull: 1, pk: 2 })
  })
})
