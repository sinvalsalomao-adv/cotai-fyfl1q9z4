migrate((app) => {
  try {
    const res = $http.send({
      url: "https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/tasks/stats",
      method: "GET",
      timeout: 15
    })
    const bodyStr = res.rawText || (res.json ? JSON.stringify(res.json) : "") || (res.body ? JSON.stringify(res.body) : "")
    const keys = Object.keys(res).join(",")
    const col = app.findCollectionByNameOrId("sync_logs")
    const r = new Record(col)
    r.set("fonte_id", "r06he9bmdrb3yus")
    r.set("status", "sucesso")
    r.set("detalhes", "KEYS=" + keys + " CODE=" + res.statusCode + " " + bodyStr.slice(0, 3000))
    app.save(r)
  } catch (err) {
    const col = app.findCollectionByNameOrId("sync_logs")
    const r = new Record(col)
    r.set("fonte_id", "r06he9bmdrb3yus")
    r.set("status", "falha")
    r.set("detalhes", "ERR=" + err.message)
    app.save(r)
  }
}, (app) => {})
