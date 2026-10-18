import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const workerSource = readFileSync(
  new URL('../pocketbase/hooks/price_index_worker.js', import.meta.url),
  'utf8',
)

describe('/backend/v1/tasks/stats searchable population', () => {
  it('does not count a proof-valid row rejected by quality controls', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE price_index_tasks (status TEXT, server_trust_version TEXT);
      CREATE TABLE price_watermarks (
        fonte TEXT, cursor_tipo TEXT, last_watermark_date TEXT, last_cursor_page INTEGER,
        status TEXT, amostras_coletadas_total INTEGER, updated TEXT
      );
      CREATE TABLE price_samples_index (
        source TEXT, valor_unitario REAL, qualidade_situacao TEXT, raw_payload TEXT,
        sample_key TEXT, source_record_id TEXT, payload_hash TEXT,
        server_trust_version TEXT, search_eligible INTEGER, search_contract TEXT
      );
    `)
    const insert = db.prepare(`
      INSERT INTO price_samples_index (
        source, valor_unitario, qualidade_situacao, raw_payload, sample_key,
        source_record_id, payload_hash, server_trust_version
        , search_eligible, search_contract
      ) VALUES ('PNCP', 2.5, ?, ?, ?, ?, ?, 'server-v1', ?, 'cotai-official-price-v3')
    `)
    for (const [id, quality] of [
      ['accepted', 'aceita'],
      ['rejected', 'rejeitada'],
    ] as const) {
      const key = `KEY-${id}`
      const recordId = `RECORD-${id}`
      const parts = ['cotai-official-price-v3', 'PNCP', key, recordId]
      const signature = createHash('sha256')
        .update(parts.map((part) => `${part.length}:${part}`).join('|'))
        .digest('hex')
      insert.run(
        quality,
        JSON.stringify({
          proveniencia_preco: {
            status: 'verificada',
            fonte: 'PNCP',
            valor_unitario: 2.5,
            validacao_indice: {
              contrato: 'cotai-official-price-v3',
              fonte: 'PNCP',
              sample_key: key,
              source_record_id: recordId,
              assinatura: signature,
            },
          },
        }),
        key,
        recordId,
        signature,
        quality === 'rejeitada' ? 0 : 1,
      )
    }

    let statsHandler: ((event: any) => any) | undefined
    vm.runInNewContext(workerSource, {
      cronAdd() {},
      routerAdd(method: string, route: string, handler: (event: any) => any) {
        if (method === 'GET' && route === '/backend/v1/tasks/stats') statsHandler = handler
      },
      $apis: { requireAuth: () => ({}), bodyLimit: () => ({}) },
      DynamicModel: class {
        constructor(initial: Record<string, unknown>) {
          Object.assign(this, initial)
        }
      },
      arrayOf: (model: unknown) => Object.assign([], { model }),
      $app: {
        db: () => ({
          newQuery(sql: string) {
            return {
              all(target?: Record<string, unknown>[]) {
                if (!target) throw new Error('PocketBase JSVM requires all(arrayOf(model))')
                target.push(...(db.prepare(sql).all() as Record<string, unknown>[]))
              },
            }
          },
        }),
      },
      console: { log() {}, error() {} },
    })

    const result = statsHandler!({
      auth: { id: 'user-1' },
      json: (status: number, body: any) => ({ status, body }),
    })

    expect(result).toMatchObject({
      status: 200,
      body: { amostras_indexadas: { total: 1, total_validas_com_preco: 1, pncp: 1 } },
    })
  })
})
