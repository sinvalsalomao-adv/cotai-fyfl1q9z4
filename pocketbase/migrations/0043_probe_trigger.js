migrate(
  (app) => {
    try {
      const res = $http.send({
        url: 'https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/tasks/stats',
        method: 'GET',
        timeout: 10,
      })
      console.log('[MIG-0043-STATS] status:', res.statusCode, 'body:', res.rawText)
    } catch (err) {
      console.log('[MIG-0043-STATS] error:', err.message)
    }
  },
  (app) => {},
)
