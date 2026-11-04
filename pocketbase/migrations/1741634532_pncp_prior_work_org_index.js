/// <reference path="../pb_data/types.d.ts" />

// Bound prior-work checks to the existing source/organization equalities.
// Keep the worker's conservative contains/OR predicates and all price evidence.
migrate(
  function (app) {
    app
      .db()
      .newQuery(
        'CREATE INDEX IF NOT EXISTS idx_psi_source_orgao_prior_work ' +
          'ON price_samples_index (source, orgao_cnpj)',
      )
      .execute()
    // IF NOT EXISTS must not adopt a colliding, narrower or differently ordered index.
    var definition = new DynamicModel({ sql: '' })
    app
      .db()
      .newQuery(
        "SELECT COALESCE(sql,'') AS sql FROM sqlite_master WHERE type='index' " +
          "AND tbl_name='price_samples_index' AND name='idx_psi_source_orgao_prior_work'",
      )
      .one(definition)
    if (
      String(definition.sql).replace(/\s/g, '').toLowerCase() !==
      'createindexidx_psi_source_orgao_prior_workonprice_samples_index(source,orgao_cnpj)'
    )
      throw new Error('PNCP_PRIOR_WORK_ORG_INDEX_DEFINITION_MISMATCH')
  },
  function (_app) {
    // Retain the additive index on rollback; active workers may rely on its latency.
  },
)
