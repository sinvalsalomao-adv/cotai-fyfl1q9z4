migrate(
  (app) => {
    try {
      const res = $http.send({
        url: 'https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/tasks/stats',
        method: 'GET',
        timeout: 15,
      })
      const bodyStr = res.rawText || ''
      // Grava o resultado na tabela sync_logs para podermos ler com db_query!
      const col = app.findCollectionByNameOrId('sync_logs')
      const r = new Record(col)
      r.set('status', 'sucesso')
      r.set('detalhes', bodyStr.slice(0, 4000))
      app.save(r)
    } catch (err) {
      const col = app.findCollectionByNameOrId('sync_logs')
      const r = new Record(col)
      r.set('status', 'falha')
      r.set('detalhes', 'Erro ao chamar stats: ' + err.message)
      app.save(r)
    }
  },
  (app) => {},
)
