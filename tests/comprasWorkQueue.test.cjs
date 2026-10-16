'use strict'

// OFFLINE: actual isolated helper; synthetic strings only, no APIs or prices.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { executarFilaCompras } = require('../src/lib/connectors/comprasWorkQueue.ts')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const prices = (codigo, pagina = 1, tipo = 'material') => ({ etapa: 'precos', tipo, codigo, pagina })
const batch = (amostras = [], continuacoes = [], paginacao) => ({ amostras, continuacoes, paginacao })

test('pre-aborted signal rejects with AbortError and executes zero jobs', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(executarFilaCompras({
    trabalhos: [prices('A')], signal: controller.signal,
    executar: async () => { calls++; return batch(['synthetic']) },
  }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('aborting one overlapping run stops dispatch and suppresses its late batch', async () => {
  const controller = new AbortController()
  const gate = deferred()
  const firstBatches = []
  const calls = []
  const first = executarFilaCompras({
    trabalhos: [prices('A'), prices('B')], concorrencia: 1, signal: controller.signal,
    executar: async (job) => { calls.push(job.codigo); await gate.promise; return batch(['late']) },
    onBatch: (items) => firstBatches.push(...items),
  })
  await tick()
  const second = executarFilaCompras({
    trabalhos: [prices('A')], executar: async () => batch(['independent']),
  })
  controller.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.deepEqual((await second).amostras, ['independent'])
  gate.resolve()
  await tick()
  assert.deepEqual(calls, ['A'])
  assert.deepEqual(firstBatches, [])
})

test('two discovery roots share one PDM job and preserve material/service namespaces', async () => {
  const calls = []
  const pdm = { etapa: 'pdm', codigoPdm: 'P1' }
  const result = await executarFilaCompras({
    trabalhos: [
      { etapa: 'catalogo', tipo: 'material', termo: 'synthetic A' },
      { etapa: 'catalogo', tipo: 'material', termo: 'synthetic B' },
    ],
    executar: async (job) => {
      calls.push(job)
      if (job.etapa === 'catalogo') return batch([], [pdm, pdm])
      if (job.etapa === 'pdm') return batch([], [prices('7'), prices('7'), prices('7', 1, 'servico')])
      return batch([job.tipo])
    },
  })
  assert.equal(calls.filter((job) => job.etapa === 'pdm').length, 1)
  assert.equal(calls.filter((job) => job.etapa === 'precos').length, 2)
  assert.deepEqual(result.amostras.sort(), ['material', 'servico'])
  assert.equal(result.concluida, true)
})

test('mid-run cancellation preserves delivered batches and prevents the next dispatch', async () => {
  const controller = new AbortController()
  const delivered = []
  const calls = []
  await assert.rejects(executarFilaCompras({
    trabalhos: [prices('A'), prices('B')], concorrencia: 1, signal: controller.signal,
    executar: async (job) => { calls.push(job.codigo); return batch([job.codigo]) },
    onBatch: (items) => { delivered.push(...items); controller.abort() },
  }), { name: 'AbortError' })
  assert.deepEqual(delivered, ['A'])
  assert.deepEqual(calls, ['A'])
})

test('independent pagination totals are recorded once per type/code, without a page cap', async () => {
  const calls = []
  const result = await executarFilaCompras({
    trabalhos: [prices('7'), prices('7', 1, 'servico')],
    executar: async (job) => {
      calls.push(job)
      const paginas = job.tipo === 'material' ? 65 : 2
      const total = job.tipo === 'material' ? 650 : 17
      return batch([job.tipo + ':' + job.pagina],
        job.pagina < paginas ? [prices(job.codigo, job.pagina + 1, job.tipo)] : [],
        { tipo: job.tipo, codigo: job.codigo, pagina: job.pagina, tamanho: 10, total, paginas })
    },
  })
  assert.equal(calls.length, 67)
  assert.equal(result.amostras.length, 67)
  assert.deepEqual(result.paginacao.map(({ tipo, total, paginas }) => ({ tipo, total, paginas }))
    .sort((a, b) => a.tipo.localeCompare(b.tipo)), [
    { tipo: 'material', total: 650, paginas: 65 },
    { tipo: 'servico', total: 17, paginas: 2 },
  ])
  assert.equal(result.parcial, false)
})

test('first batch is delivered before another in-flight job finishes', async () => {
  const gate = deferred()
  const delivered = deferred()
  let done = false
  const output = []
  const run = executarFilaCompras({
    trabalhos: [prices('fast'), prices('slow')],
    executar: async (job) => { if (job.codigo === 'slow') await gate.promise; return batch([job.codigo]) },
    onBatch: (items) => { output.push(...items); delivered.resolve() },
  }).then((result) => { done = true; return result })
  await delivered.promise
  assert.deepEqual(output, ['fast'])
  assert.equal(done, false)
  gate.resolve()
  assert.deepEqual((await run).amostras, ['fast', 'slow'])
})

test('ready first price pages run before all 19 PDMs while discovery and later pages also progress', async () => {
  let resolvedPdms = 0
  let firstBatchAfterPdms
  let secondPageAfterPdms
  const pdms = Array.from({ length: 19 }, (_, index) => ({ etapa: 'pdm', codigoPdm: String(index + 1) }))
  const result = await executarFilaCompras({
    trabalhos: pdms, concorrencia: 1,
    executar: async (job) => {
      if (job.etapa === 'pdm') {
        resolvedPdms++
        return batch([], [prices(job.codigoPdm)])
      }
      if (job.pagina === 2 && secondPageAfterPdms === undefined) secondPageAfterPdms = resolvedPdms
      return batch([job.codigo + ':' + job.pagina], job.pagina === 1 ? [prices(job.codigo, 2)] : [])
    },
    onBatch: (items) => { if (items.length && firstBatchAfterPdms === undefined) firstBatchAfterPdms = resolvedPdms },
  })
  assert.ok(firstBatchAfterPdms < 19, 'First useful price batch must not wait for all PDM lookups')
  assert.ok(secondPageAfterPdms < 19, 'Remaining pages must also get turns before discovery ends')
  assert.equal(resolvedPdms, 19)
  assert.equal(result.amostras.length, 38)
  assert.equal(result.concluida, true)
})

test('requested concurrency above three still runs at most three executors', async () => {
  const gate = deferred()
  let active = 0
  let peak = 0
  let calls = 0
  const run = executarFilaCompras({
    trabalhos: Array.from({ length: 8 }, (_, index) => prices(String(index))), concorrencia: 20,
    executar: async () => {
      calls++; active++; peak = Math.max(peak, active)
      await gate.promise
      active--
      return batch()
    },
  })
  await tick()
  assert.equal(active, 3)
  gate.resolve()
  assert.equal((await run).concluida, true)
  assert.equal(calls, 8)
  assert.equal(peak, 3)
})

test('failed jobs remain retryable while successful batches survive', async () => {
  const delivered = []
  const result = await executarFilaCompras({
    trabalhos: [prices('ok'), prices('failed'), prices('failed')],
    executar: async (job) => { if (job.codigo === 'failed') throw new Error('synthetic failure'); return batch(['ok']) },
    onBatch: (items) => delivered.push(...items),
  })
  assert.deepEqual(delivered, ['ok'])
  assert.deepEqual(result.pendencias, [prices('failed')])
  assert.equal(result.falhas.length, 1)
  assert.equal(result.parcial, true)
  assert.equal(result.concluida, false)
  const retried = await executarFilaCompras({ trabalhos: result.pendencias, executar: async () => batch(['recovered']) })
  assert.deepEqual(retried.amostras, ['recovered'])
  assert.equal(retried.concluida, true)
})

test('expired explicit deadline executes nothing and returns pending work', async () => {
  let calls = 0
  const result = await executarFilaCompras({
    trabalhos: [prices('A')], deadlineAtMs: Date.now() - 1,
    executar: async () => { calls++; return batch() },
  })
  assert.equal(calls, 0)
  assert.deepEqual(result.pendencias, [prices('A')])
  assert.equal(result.parcial, true)
  assert.equal(result.concluida, false)
})

test('deadline also stops dispatch when fast promise chains prevent timers from firing', async () => {
  const deadlineAtMs = Date.now() + 5
  const calls = []
  const result = await executarFilaCompras({
    trabalhos: [prices('A'), prices('B')], concorrencia: 1, deadlineAtMs,
    executar: async (job) => {
      calls.push(job.codigo)
      // Controlled synchronous boundary: timer callbacks cannot run here.
      while (Date.now() <= deadlineAtMs) {}
      return batch([job.codigo])
    },
  })
  assert.deepEqual(calls, ['A'])
  assert.equal(result.parcial, true)
  assert.equal(result.concluida, false)
  assert.ok(result.pendencias.some((job) => job.codigo === 'B'))
})

test('deadline returns queued and in-flight work even when executor ignores cancellation', { timeout: 1000 }, async () => {
  const gate = deferred()
  const delivered = []
  let taskSignal
  const result = await executarFilaCompras({
    trabalhos: [prices('A'), prices('B')], concorrencia: 1, deadlineAtMs: Date.now() + 30,
    executar: async (_, signal) => { taskSignal = signal; await gate.promise; return batch(['late']) },
    onBatch: (items) => delivered.push(...items),
  })
  assert.equal(taskSignal.aborted, true)
  assert.deepEqual(result.pendencias.map((job) => job.codigo).sort(), ['A', 'B'])
  assert.equal(result.parcial, true)
  assert.equal(result.concluida, false)
  gate.resolve()
  await tick()
  assert.deepEqual(delivered, [])
})
