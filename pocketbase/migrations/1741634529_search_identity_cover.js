/// <reference path="../pb_data/types.d.ts" />

// Cover summary predicates without copying proofs or changing existing indexes.
// The literal eligible predicate is entailed by both search callbacks; trust and
// contract stay indexed columns because their comparisons are parameter-bound.
migrate(
  function (app) {
    app
      .db()
      .newQuery(
        'CREATE INDEX IF NOT EXISTS idx_psi_search_identity_cover_v1 ' +
          'ON price_samples_index (id, valor_unitario, source, uf, data_referencia, ' +
          'server_trust_version, search_contract, qualidade_situacao) WHERE search_eligible = 1',
      )
      .execute()
    // IF NOT EXISTS must never adopt a colliding, narrower partial index.
    var definition = new DynamicModel({ sql: '' })
    app
      .db()
      .newQuery(
        "SELECT COALESCE(sql,'') AS sql FROM sqlite_master WHERE type='index' " +
          "AND tbl_name='price_samples_index' AND name='idx_psi_search_identity_cover_v1'",
      )
      .one(definition)
    if (
      String(definition.sql).replace(/\s/g, '').toLowerCase() !==
      'createindexidx_psi_search_identity_cover_v1onprice_samples_index(id,valor_unitario,source,uf,data_referencia,server_trust_version,search_contract,qualidade_situacao)wheresearch_eligible=1'
    )
      throw new Error('SEARCH_IDENTITY_COVER_DEFINITION_MISMATCH')
  },
  function (_app) {
    // Keep the additive index on rollback; deployed callbacks may still use it.
  },
)
