import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../pocketbase/migrations/1741634525_owner_scope_price_index_task_keys.js',
  import.meta.url,
)

describe('owner-scoped price-index task key migration', () => {
  it('migrates trusted owned legacy keys idempotently without adopting ownerless rows or colliding', () => {
    expect(existsSync(migrationUrl)).toBe(true)
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE price_index_tasks (
        id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL UNIQUE,
        requested_by TEXT,
        server_trust_version TEXT
      );
      INSERT INTO price_index_tasks VALUES
        ('owned', 'AMBAS#CADEIRA#ALL', 'user-1', 'server-v1'),
        ('ownerless', 'AMBAS#MESA#ALL', '', 'server-v1'),
        ('scoped', 'AMBAS#CARRO#ALL#OWNER#user-2', 'user-2', 'server-v1'),
        ('collision-legacy', 'AMBAS#LAPIS#ALL', 'user-3', 'server-v1'),
        ('collision-scoped', 'AMBAS#LAPIS#ALL#OWNER#user-3', 'user-3', 'server-v1'),
        ('untrusted', 'AMBAS#BORRACHA#ALL', 'user-4', 'client-v1');
    `)
    let up: (app: any) => void = () => undefined
    let down: (app: any) => void = () => undefined
    vm.runInNewContext(readFileSync(migrationUrl, 'utf8'), {
      migrate(upHandler: typeof up, downHandler: typeof down) {
        up = upHandler
        down = downHandler
      },
    })
    const app = {
      db: () => ({
        newQuery(sql: string) {
          return { execute: () => db.exec(sql) }
        },
      }),
    }

    up(app)
    down(app)
    up(app)

    const keys = db
      .prepare('SELECT id, task_key FROM price_index_tasks ORDER BY id')
      .all() as Array<{ id: string; task_key: string }>
    expect(keys).toEqual([
      { id: 'collision-legacy', task_key: 'AMBAS#LAPIS#ALL' },
      { id: 'collision-scoped', task_key: 'AMBAS#LAPIS#ALL#OWNER#user-3' },
      { id: 'owned', task_key: 'AMBAS#CADEIRA#ALL#OWNER#user-1' },
      { id: 'ownerless', task_key: 'AMBAS#MESA#ALL' },
      { id: 'scoped', task_key: 'AMBAS#CARRO#ALL#OWNER#user-2' },
      { id: 'untrusted', task_key: 'AMBAS#BORRACHA#ALL' },
    ])
  })
})
