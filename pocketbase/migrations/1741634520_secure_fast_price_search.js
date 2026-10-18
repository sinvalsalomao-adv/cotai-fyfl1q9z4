/// <reference path="../pb_data/types.d.ts" />

// A searchable row is a server-owned projection of the already validated v3 proof.
// Search never reparses caller JSON. Legacy v2 and pre-lock rows are deliberately left out.
migrate(
  (app) => {
    const samples = app.findCollectionByNameOrId('price_samples_index')
    if (!samples.fields.getByName('search_eligible')) {
      samples.fields.add(
        new NumberField({
          name: 'search_eligible',
          required: false,
          min: 0,
          max: 1,
          onlyInt: true,
        }),
      )
    }
    if (!samples.fields.getByName('search_contract')) {
      samples.fields.add(
        new TextField({
          name: 'search_contract',
          required: false,
        }),
      )
    }
    app.save(samples)

    // Reset first so neither v2 nor an old caller-controlled marker can survive as searchable.
    app
      .db()
      .newQuery(`
        UPDATE price_samples_index
        SET search_eligible = 0, search_contract = ''
      `)
      .execute()
    app
      .db()
      .newQuery(`
        UPDATE price_samples_index
        SET search_eligible = 1, search_contract = 'cotai-official-price-v3'
        WHERE server_trust_version = 'server-v1'
          AND source IN ('PNCP', 'Compras.gov.br')
          AND valor_unitario > 0
          AND (qualidade_situacao IS NULL OR qualidade_situacao != 'rejeitada')
          AND json_valid(raw_payload)
          AND json_extract(raw_payload, '$.proveniencia_preco.status') = 'verificada'
          AND json_extract(raw_payload, '$.proveniencia_preco.fonte') = source
          AND CAST(json_extract(raw_payload, '$.proveniencia_preco.valor_unitario') AS REAL) = valor_unitario
          AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.contrato') = 'cotai-official-price-v3'
          AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.fonte') = source
          AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.sample_key') = sample_key
          AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.source_record_id') = source_record_id
          AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.assinatura') = payload_hash
          AND length(payload_hash) = 64
          AND lower(payload_hash) = payload_hash
          AND payload_hash NOT GLOB '*[^0-9a-f]*'
      `)
      .execute()

    app.db().newQuery('DROP TRIGGER IF EXISTS trg_price_samples_fts_ai').execute()
    app.db().newQuery('DROP TRIGGER IF EXISTS trg_price_samples_fts_ad').execute()
    app.db().newQuery('DROP TRIGGER IF EXISTS trg_price_samples_fts_au').execute()
    app.db().newQuery('DROP TABLE IF EXISTS price_samples_fts').execute()
    // Let CREATE VIRTUAL TABLE fail the migration when FTS5 is unavailable. A half-fast
    // installation must never silently fall back to a full table scan.
    app
      .db()
      .newQuery(`
        CREATE VIRTUAL TABLE price_samples_fts USING fts5(
          sample_id UNINDEXED,
          descricao_normalizada,
          codigo_item,
          tokenize='unicode61 remove_diacritics 2'
        )
      `)
      .execute()
    app
      .db()
      .newQuery(`
        INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, codigo_item)
        SELECT rowid, id, COALESCE(descricao_normalizada, ''), COALESCE(codigo_item, '')
        FROM price_samples_index
        WHERE search_eligible = 1
          AND search_contract = 'cotai-official-price-v3'
          AND server_trust_version = 'server-v1'
          AND source IN ('PNCP', 'Compras.gov.br')
          AND valor_unitario > 0
          AND (qualidade_situacao IS NULL OR qualidade_situacao != 'rejeitada')
      `)
      .execute()
    app
      .db()
      .newQuery(`
        CREATE TRIGGER trg_price_samples_fts_ai AFTER INSERT ON price_samples_index
        WHEN new.search_eligible = 1
          AND new.search_contract = 'cotai-official-price-v3'
          AND new.server_trust_version = 'server-v1'
          AND new.source IN ('PNCP', 'Compras.gov.br')
          AND new.valor_unitario > 0
          AND COALESCE(new.qualidade_situacao, '') != 'rejeitada'
        BEGIN
          INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, codigo_item)
          VALUES (
            new.rowid,
            new.id,
            COALESCE(new.descricao_normalizada, ''),
            COALESCE(new.codigo_item, '')
          );
        END
      `)
      .execute()
    app
      .db()
      .newQuery(`
        CREATE TRIGGER trg_price_samples_fts_ad AFTER DELETE ON price_samples_index
        BEGIN
          DELETE FROM price_samples_fts WHERE rowid = old.rowid;
        END
      `)
      .execute()
    // Re-evaluate membership on every update. Official rows are write-infrequent and this
    // guarantees that rejection, proof revocation or text correction cannot leave stale hits.
    app
      .db()
      .newQuery(`
        CREATE TRIGGER trg_price_samples_fts_au AFTER UPDATE ON price_samples_index
        BEGIN
          DELETE FROM price_samples_fts WHERE rowid = old.rowid;
          INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, codigo_item)
          SELECT
            new.rowid,
            new.id,
            COALESCE(new.descricao_normalizada, ''),
            COALESCE(new.codigo_item, '')
          WHERE new.search_eligible = 1
            AND new.search_contract = 'cotai-official-price-v3'
            AND new.server_trust_version = 'server-v1'
            AND new.source IN ('PNCP', 'Compras.gov.br')
            AND new.valor_unitario > 0
            AND COALESCE(new.qualidade_situacao, '') != 'rejeitada';
        END
      `)
      .execute()

    app
      .db()
      .newQuery(`
        CREATE INDEX IF NOT EXISTS idx_psi_searchable_source_value
        ON price_samples_index(
          search_eligible,
          search_contract,
          source,
          valor_unitario,
          id
        )
      `)
      .execute()
    app
      .db()
      .newQuery(`
        CREATE INDEX IF NOT EXISTS idx_psi_searchable_uf_value
        ON price_samples_index(
          search_eligible,
          search_contract,
          uf,
          valor_unitario,
          id
        )
      `)
      .execute()
    app
      .db()
      .newQuery(`
        CREATE INDEX IF NOT EXISTS idx_psi_searchable_date
        ON price_samples_index(
          search_eligible,
          search_contract,
          data_referencia DESC,
          id
        )
      `)
      .execute()
  },
  (_app) => {
    // Security boundary: never make legacy/v2 rows searchable again during rollback.
  },
)
