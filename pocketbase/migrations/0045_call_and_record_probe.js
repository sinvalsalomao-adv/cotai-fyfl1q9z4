migrate(
  (app) => {
    // Probe de diagnóstico: NUNCA deve derrubar o batch de migrações.
    // sync_logs.fonte_id é obrigatório (relation) — escrita best-effort, com fonte_id.
    const logProbe = (status, detalhes) => {
      try {
        const col = app.findCollectionByNameOrId('sync_logs')
        const r = new Record(col)
        r.set('fonte_id', 'r06he9bmdrb3yus')
        r.set('status', status)
        r.set('detalhes', detalhes)
        app.save(r)
      } catch (_) {
        // log de diagnóstico é secundário: falha de validação nunca aborta a migração
      }
    }
    try {
      const res = $http.send({
        url: 'https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/tasks/stats',
        method: 'GET',
        timeout: 15,
      })
      const bodyStr = res.rawText || ''
      logProbe('sucesso', bodyStr.slice(0, 4000))
    } catch (err) {
      logProbe('falha', 'Erro ao chamar stats: ' + err.message)
    }
  },
  (app) => {},
)
