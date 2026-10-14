migrate(
  (app) => {
    let probeResult = ''
    try {
      const res = $http.send({
        url: 'https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/prices/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termo: 'dipirona', page: 1, limit: 5 }),
        timeout: 10,
      })
      probeResult = 'STATUS=' + res.statusCode + ' RAW=' + (res.raw || '').slice(0, 1500)
    } catch (err) {
      probeResult = 'EXCEPTION=' + err.message
    }

    const col = app.findCollectionByNameOrId('sync_logs')
    const r = new Record(col)
    r.set('fonte_id', 'r06he9bmdrb3yus')
    r.set('status', 'sucesso')
    r.set('detalhes', 'TESTE_BEFORE_DB: ' + probeResult)
    app.save(r)
  },
  (app) => {},
)
