import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../pocketbase/migrations/1741634522_secure_price_search_boundary.js',
  import.meta.url,
)

describe('price search server-side rate-limit storage', () => {
  it('creates a private raw table with one durable atomic quota row per user', () => {
    expect(existsSync(migrationUrl)).toBe(true)
    const db = new DatabaseSync(':memory:')
    let up: (app: any) => void = () => undefined
    vm.runInNewContext(readFileSync(migrationUrl, 'utf8'), {
      migrate(upHandler: typeof up) {
        up = upHandler
      },
    })
    const app = {
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

    const columns = db
      .prepare('PRAGMA table_info(cotai_price_search_rate_limits)')
      .all() as Array<{ name: string; notnull: number; pk: number }>
    expect(columns.map(({ name }) => name)).toEqual([
      'user_id',
      'window_started_at',
      'request_count',
      'updated_at',
    ])
    expect(columns.find(({ name }) => name === 'user_id')).toMatchObject({ notnull: 1, pk: 1 })
    expect(columns.find(({ name }) => name === 'request_count')).toMatchObject({ notnull: 1 })
    expect(
      db
        .prepare(
          "SELECT type FROM sqlite_master WHERE name = 'cotai_price_search_rate_limits'",
        )
        .get(),
    ).toEqual({ type: 'table' })
  })
})
