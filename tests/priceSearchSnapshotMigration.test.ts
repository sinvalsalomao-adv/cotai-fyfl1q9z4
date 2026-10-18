import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../pocketbase/migrations/1741634523_materialized_price_search_snapshots.js',
  import.meta.url,
)

describe('private materialized price-search snapshot storage', () => {
  it('creates bounded owner-scoped sessions and compact JSON rows outside PocketBase collections', () => {
    expect(existsSync(migrationUrl)).toBe(true)
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
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

    expect(
      db.prepare('PRAGMA table_info(cotai_price_search_snapshots)').all().map((row: any) => row.name),
    ).toEqual([
      'id',
      'token_hash',
      'owner_user_id',
      'query_hash',
      'cursor_secret',
      'sort_name',
      'page_size',
      'page_count',
      'captured_count',
      'total_count',
      'population_complete',
      'created_at',
      'expires_at',
    ])
    expect(
      db
        .prepare('PRAGMA table_info(cotai_price_search_snapshot_items)')
        .all()
        .map((row: any) => row.name),
    ).toEqual(['snapshot_id', 'position', 'hit_json'])
    expect(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'cotai_price_search_snapshots'")
        .get(),
    ).toMatchObject({
      sql: expect.stringContaining('page_size BETWEEN 1 AND 100'),
    })
    expect(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'cotai_price_search_snapshots'")
        .get(),
    ).toMatchObject({ sql: expect.stringContaining('WITHOUT ROWID') })
    expect(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'cotai_price_search_snapshot_items'")
        .get(),
    ).toMatchObject({
      sql: expect.stringContaining('length(CAST(hit_json AS BLOB)) <= 32768'),
    })
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cotai_price_search_snapshots'")
        .all()
        .map((row: any) => row.name),
    ).toContain('idx_cotai_price_search_snapshots_owner_expiry')
  })
})
