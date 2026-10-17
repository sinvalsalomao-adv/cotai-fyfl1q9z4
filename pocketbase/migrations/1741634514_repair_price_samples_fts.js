/// <reference path="../pb_data/types.d.ts" />

// Additive repair: 1741634513 may already be recorded despite a failed backfill.
// Only derived objects are rebuilt. PocketBase runs migrations in a transaction;
// propagate errors so an incomplete repair cannot be marked successfully applied.
migrate(
  (app) => {
    app.db().newQuery('DROP TRIGGER IF EXISTS trg_price_samples_fts_ai').execute()
    app.db().newQuery('DROP TRIGGER IF EXISTS trg_price_samples_fts_ad').execute()
    app.db().newQuery('DROP TRIGGER IF EXISTS trg_price_samples_fts_au').execute()
    app.db().newQuery('DROP TABLE IF EXISTS price_samples_fts').execute()
    app
      .db()
      .newQuery(`
      CREATE VIRTUAL TABLE price_samples_fts USING fts5(
        sample_id UNINDEXED,
        descricao_normalizada,
        termo,
        orgao,
        tokenize='unicode61 remove_diacritics 2'
      )
    `)
      .execute()

    // The exported collection has no termo_pesquisa column. Preserve the derived
    // table's compatible shape with an empty termo, using only real source fields.
    app
      .db()
      .newQuery(`
      INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, termo, orgao)
      SELECT rowid, id, COALESCE(descricao_normalizada, ''), '', COALESCE(orgao, '')
      FROM price_samples_index
    `)
      .execute()
    app
      .db()
      .newQuery(`
      CREATE TRIGGER trg_price_samples_fts_ai AFTER INSERT ON price_samples_index BEGIN
        INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, termo, orgao)
        VALUES (new.rowid, new.id, COALESCE(new.descricao_normalizada, ''), '', COALESCE(new.orgao, ''));
      END
    `)
      .execute()
    app
      .db()
      .newQuery(`
      CREATE TRIGGER trg_price_samples_fts_ad AFTER DELETE ON price_samples_index BEGIN
        DELETE FROM price_samples_fts WHERE rowid = old.rowid;
      END
    `)
      .execute()
    // IS NOT is null-safe. Price, proof and timestamp-only updates do not touch
    // the FTS postings; row identity/text changes replace precisely that row.
    app
      .db()
      .newQuery(`
      CREATE TRIGGER trg_price_samples_fts_au AFTER UPDATE ON price_samples_index
      WHEN new.rowid IS NOT old.rowid OR new.id IS NOT old.id
        OR COALESCE(new.descricao_normalizada, '') IS NOT COALESCE(old.descricao_normalizada, '')
        OR COALESCE(new.orgao, '') IS NOT COALESCE(old.orgao, '')
      BEGIN
        DELETE FROM price_samples_fts WHERE rowid = old.rowid;
        INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, termo, orgao)
        VALUES (new.rowid, new.id, COALESCE(new.descricao_normalizada, ''), '', COALESCE(new.orgao, ''));
      END
    `)
      .execute()
    app
      .db()
      .newQuery(`
      CREATE INDEX IF NOT EXISTS idx_psi_val_unit_id ON price_samples_index(valor_unitario, id)
    `)
      .execute()
  },
  (_app) => {
    // Retain the valid derived index: restoring the prior broken triggers would
    // reintroduce missing-column failures. No original records need undoing.
  },
)
