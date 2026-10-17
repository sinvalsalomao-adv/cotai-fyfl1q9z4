/// <reference path="../pb_data/types.d.ts" />

// Cover the existing price-ordered ID scan and complete summary without reading
// proof-bearing table rows for each description/quality predicate candidate.
// Independent of the optional FTS repair; preserve every existing index.
migrate(
  (app) => {
    app
      .db()
      .newQuery(`
      CREATE INDEX IF NOT EXISTS idx_psi_search_cover
      ON price_samples_index (
        valor_unitario, id, qualidade_situacao, descricao_normalizada, source, uf
      )
    `)
      .execute()
  },
  (_app) => {
    // Retain this additive index and all original data/indexes on rollback.
  },
)
