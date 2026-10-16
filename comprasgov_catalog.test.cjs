#!/usr/bin/env node
'use strict'

// OFFLINE: real patch hook, synthetic catalog metadata, no monetary values,
// network, application database, credentials, or imports from the dirty checkout.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const hookPath = path.join(__dirname, 'pocketbase/hooks/comprasgov_catalog.js')
const source = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : ''
const clone = (value) => JSON.parse(JSON.stringify(value))

function harness(upstream) {
  const routes = []
  const calls = []
  const context = vm.createContext({
    routerAdd(method, url, handler, ...middleware) { routes.push({ method, url, handler, middleware }) },
    $apis: { requireAuth() { return { marker: 'requireAuth' } } },
    $http: {
      send(request) {
        calls.push(clone(request))
        return upstream(request)
      },
    },
    // Any attempted database access is an unexpected side effect.
    $app: new Proxy({}, { get() { throw new Error('Database use is forbidden in catalog resolver') } }),
  })
  new vm.Script(source, { filename: hookPath }).runInContext(context, { timeout: 1000 })
  function route() {
    const selected = routes.filter((r) => r.method === 'GET' && r.url === '/backend/v1/comprasgov/catalogo')
    assert.equal(selected.length, 1, 'Actual catalog route must exist exactly once')
    return selected[0]
  }
  return {
    calls, route,
    run(query, authenticated = true) {
      return route().handler({
        auth: authenticated ? { id: 'SYNTHETIC-USER' } : null,
        requestInfo: () => ({ query: clone(query) }),
        json(status, body) { return { status, body: clone(body) } },
      })
    },
  }
}
const ok = (payload) => ({ statusCode: 200, json: clone(payload) })
const tests = []
const add = (name, run) => tests.push({ name, run })
const pdm = {
  codigoPDM: 991111, codigoPdm: 991111, codigoClasse: 9911, codigoGrupo: 99,
  descricaoPDM: 'SYNTHETIC POLIMERO', nomePdm: 'SYNTHETIC POLIMERO',
  descricaoClasse: 'SYNTHETIC CLASS', nomeClasse: 'SYNTHETIC CLASS',
  descricaoGrupo: 'SYNTHETIC GROUP', statusPDM: false, statusClasse: true, statusGrupo: true,
}
const item = {
  codigoPdm: 991111, codigoItem: 991222, nomePdm: 'SYNTHETIC POLIMERO',
  statusItem: true, itemSuspenso: true, itemSustentavel: false,
  itemExclusivoUasgCentral: false, codigoClasse: 9911,
  codigoNcm: 'SYNTHETIC-NCM', nomeNcm: 'SYNTHETIC NCM', aplicaMargemPreferencia: false,
  buscaItemCaracteristica: [{
    codigoCaracteristica: 'SYNTHETIC-CHAR', codigoValorCaracteristica: 'SYNTHETIC-VALUE',
    nomeCaracteristica: 'SYNTHETIC ATTRIBUTE', nomeValorCaracteristica: 'SYNTHETIC VALUE',
    siglaUnidadeMedida: 'ML', caracteristicaObrigatoria: true, statusCaracteristica: true,
    numeroCaracteristica: 1, statusValorCaracteristica: true,
    tuplaCaracteristica: ['SYNTHETIC-CHAR', 'SYNTHETIC-VALUE', 'ML'],
  }],
}
const service = {
  codigoServico: 997250, codigo: 123456, descricaoServicoAcentuado: 'SYNTHETIC CONSERVACAO',
  nomeServicoAcentuado: 'SYNTHETIC CONSERVACAO', codigoGrupo: 991,
  nomeGrupo: 'SYNTHETIC GROUP', statusServico: false, suspenso: true,
  indicadoItemSuspenso: true, exclusivoCentralCompras: false,
}

add('registers the authenticated route using existing requireAuth convention', () => {
  const h = harness(() => ok([]))
  assert.ok(h.route().middleware.some((m) => m.marker === 'requireAuth'))
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC' }, false)
  assert.equal(response.status, 401)
  assert.equal(response.body.sucesso, false)
  assert.equal(h.calls.length, 0)
})

add('missing or invalid type is explicit validation error without upstream requests', () => {
  const h = harness(() => ok([]))
  for (const query of [{ termo: 'SYNTHETIC' }, { tipo: 'todos', termo: 'SYNTHETIC' }]) {
    const response = h.run(query)
    assert.equal(response.status, 400)
    assert.equal(response.body.erro.codigo, 'INVALID_PARAMETERS')
  }
  assert.equal(h.calls.length, 0)
})

add('material text makes one official lookup and creates PDM work preserving flags', () => {
  const h = harness(() => ok([pdm]))
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC POLIMERO' })
  assert.equal(response.status, 200)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, 'https://cnbs.estaleiro.serpro.gov.br/cnbs-api/material/v1/palavra?palavra=SYNTHETIC%20POLIMERO')
  assert.equal(h.calls[0].method, 'GET')
  assert.equal(h.calls[0].timeout, 5)
  assert.deepEqual(response.body.candidatos, [pdm])
  assert.deepEqual(response.body.trabalhos, [{ etapa: 'pdm', codigoPdm: '991111' }])
  assert.equal(response.body.metadados.paginacaoInformada, false)
  assert.equal(response.body.metadados.totalInformadoApi, null)
})

add('one PDM resolves codigoItem into price work without fetching any price', () => {
  const h = harness(() => ok([item]))
  const response = h.run({ codigo_pdm: '991111' })
  assert.equal(response.status, 200)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, 'https://cnbs.estaleiro.serpro.gov.br/cnbs-api/material/v1/materialCaracteristcaValorporPDM?codigo_pdm=991111')
  assert.deepEqual(response.body.candidatos, [item])
  assert.deepEqual(response.body.trabalhos, [{ etapa: 'precos', tipo: 'material', codigo: '991222', pagina: 1 }])
  assert.equal(response.body.tipo, 'material')
  assert.equal(response.body.etapa, 'pdm')
  assert.equal(response.body.metadados.codigoPdm, '991111')
})

add('service text uses codigoServico, preserves suspension, and creates service price work', () => {
  const h = harness(() => ok([service]))
  const response = h.run({ tipo: 'servico', termo: 'SYNTHETIC CONSERVACAO' })
  assert.equal(response.status, 200)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, 'https://cnbs.estaleiro.serpro.gov.br/cnbs-api/servico/v1/palavra?palavra=SYNTHETIC%20CONSERVACAO')
  assert.deepEqual(response.body.candidatos, [service])
  assert.deepEqual(response.body.trabalhos, [{ etapa: 'precos', tipo: 'servico', codigo: '997250', pagina: 1 }])
})

add('valid empty catalog array is success with no fabricated pagination or work', () => {
  const h = harness(() => ok([]))
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC EMPTY' })
  assert.equal(response.status, 200)
  assert.equal(response.body.sucesso, true)
  assert.deepEqual(response.body.candidatos, [])
  assert.deepEqual(response.body.trabalhos, [])
  assert.equal(response.body.metadados.quantidadeRetornada, 0)
  assert.equal(response.body.metadados.totalInformadoApi, null)
  assert.equal(Object.hasOwn(response.body, 'totalPaginas'), false)
})

add('more than five unique candidates are all returned and duplicate work is deduplicated', () => {
  const records = Array.from({ length: 12 }, (_, i) => ({ ...pdm, codigoPdm: 991100 + i, codigoPDM: 991100 + i }))
  const h = harness(() => ok([...records, records[0]]))
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC MANY' })
  assert.equal(response.status, 200)
  assert.equal(response.body.candidatos.length, 13)
  assert.equal(response.body.trabalhos.length, 12)
  assert.equal(h.calls.length, 1)
})

add('raw JSON response contract is accepted without executing remote content', () => {
  const h = harness(() => ({ statusCode: 200, raw: JSON.stringify([service]) }))
  const response = h.run({ tipo: 'servico', termo: 'SYNTHETIC' })
  assert.equal(response.status, 200)
  assert.equal(response.body.trabalhos[0].codigo, '997250')
})

add('upstream HTTP failure is not a successful empty result', () => {
  const h = harness(() => ({ statusCode: 503, json: { error: 'SYNTHETIC UNAVAILABLE' } }))
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC' })
  assert.equal(response.status, 502)
  assert.equal(response.body.sucesso, false)
  assert.equal(response.body.erro.codigo, 'UPSTREAM_HTTP')
  assert.equal(response.body.erro.statusUpstream, 503)
  assert.equal(response.body.metadados.quantidadeRetornada, null)
})

add('timeout is bounded and has a distinct explicit failure', () => {
  const h = harness(() => { throw new Error('SYNTHETIC network timeout') })
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC' })
  assert.equal(response.status, 504)
  assert.equal(response.body.sucesso, false)
  assert.equal(response.body.erro.codigo, 'UPSTREAM_TIMEOUT')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].timeout, 5)
})

add('invalid JSON and incompatible schema are explicit failures, never zero matches', () => {
  for (const reply of [{ statusCode: 200, raw: '<SYNTHETIC HTML>' }, ok({ resultado: [] }), ok([{ codigoPdm: 'INVALID' }])]) {
    const h = harness(() => reply)
    const response = h.run({ tipo: 'material', termo: 'SYNTHETIC' })
    assert.equal(response.status, 502)
    assert.equal(response.body.sucesso, false)
    assert.ok(['UPSTREAM_JSON', 'UPSTREAM_SCHEMA'].includes(response.body.erro.codigo))
    assert.equal(response.body.metadados.quantidadeRetornada, null)
  }
})

add('invalid PDM and conflicting service scope make no upstream request', () => {
  const h = harness(() => ok([]))
  for (const query of [{ codigo_pdm: '../SYNTHETIC' }, { tipo: 'servico', codigo_pdm: '991111' }]) {
    assert.equal(h.run(query).status, 400)
  }
  assert.equal(h.calls.length, 0)
})

add('input cannot select arbitrary host, endpoint, or forward credentials', () => {
  const h = harness(() => ok([]))
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC & url=https://evil.invalid', url: 'https://evil.invalid', token: 'SYNTHETIC-NOT-A-TOKEN' })
  assert.equal(response.status, 200)
  const request = h.calls[0]
  assert.equal(new URL(request.url).hostname, 'cnbs.estaleiro.serpro.gov.br')
  assert.equal(new URL(request.url).pathname, '/cnbs-api/material/v1/palavra')
  assert.equal(new URL(request.url).searchParams.size, 1)
  assert.equal(Object.hasOwn(request.headers || {}, 'Authorization'), false)
  assert.equal(request.url.includes('SYNTHETIC-NOT-A-TOKEN'), false)
})

add('catalog candidates cannot expose injected monetary fields as catalog schema', () => {
  const h = harness(() => ok([{ ...pdm, valorUnitario: 'SYNTHETIC-NOT-A-PRICE', prices: [] }]))
  const response = h.run({ tipo: 'material', termo: 'SYNTHETIC' })
  assert.equal(response.status, 200)
  assert.equal(Object.hasOwn(response.body.candidatos[0], 'valorUnitario'), false)
  assert.equal(Object.hasOwn(response.body.candidatos[0], 'prices'), false)
  assert.equal(Object.hasOwn(response.body, 'amostras'), false)
})

let failed = 0
for (const test of tests) {
  try { test.run(); console.log('PASS ' + test.name) }
  catch (error) { failed++; console.log('FAIL ' + test.name + '\n     ' + error.message) }
}
console.log('OFFLINE PATCH: ' + (tests.length - failed) + '/' + tests.length + ' passed; ' + failed + ' failed.')
process.exitCode = failed ? 1 : 0
