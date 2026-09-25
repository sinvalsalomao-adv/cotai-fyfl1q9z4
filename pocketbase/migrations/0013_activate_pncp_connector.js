migrate(
  (app) => {
    // Ativa a fonte PNCP mantendo as demais 7 fontes com runtime_enabled = false
    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 1, updated = DATETIME('now') WHERE codigo = 'pncp'",
      )
      .execute()
    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 0, updated = DATETIME('now') WHERE codigo != 'pncp'",
      )
      .execute()
  },
  (app) => {
    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 0, updated = DATETIME('now') WHERE codigo = 'pncp'",
      )
      .execute()
  },
)
