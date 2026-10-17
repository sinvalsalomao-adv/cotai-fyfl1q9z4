/// <reference path="../pb_data/types.d.ts" />

// Cover the existing explicit-source summary and page-ID scan without reading
// proof-bearing table rows for each description/quality predicate candidate.
// Retain the default price-first covering index and every original index.
migrate(
  (app) => {
    app
      .db()
      .newQuery(`
      CREATE INDEX IF NOT EXISTS idx_psi_source_search_cover
      ON price_samples_index (
        source, valor_unitario, id, qualidade_situacao, descricao_normalizada, uf
      )
    `)
      .execute()
  },
  (_app) => {
    // Retain this additive index and all original data/indexes on rollback.
  },
)
