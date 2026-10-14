migrate(
  (app) => {
    try {
      const res = $http.send({
        url: 'https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/tasks/stats',
        method: 'GET',
        timeout: 15,
      })
      const bodyStr = res.raw || (res.json ? JSON.stringify(res.json) : '') || ''
      const col = app.findCollectionByNameOrId('sync_logs')
      const r = new Record(col)
      r.set('fonte_id', 'r06he9bmdrb3yus')
      r.set('status', 'sucesso')
      r.set('detalhes', 'PROBE=' + bodyStr.slice(0, 3000))
      app.save(r)
    } catch (err) {
      const col = app.findCollectionByNameOrId('sync_logs')
      const r = new Record(col)
      r.set('fonte_id', 'r06he9bmdrb3yus')
      r.set('status', 'falha')
      r.set('detalhes', 'ERR=' + err.message)
      app.save(r)
    }
  },
  (app) => {},
)
