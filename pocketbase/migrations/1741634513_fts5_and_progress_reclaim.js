/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // 1. Adicionar campo progress_at na coleção price_index_tasks
    try {
      const tasksCollection = app.findCollectionByNameOrId('price_index_tasks')
      let hasProgressAt = false
      for (let i = 0; i < tasksCollection.fields.length; i++) {
        if (tasksCollection.fields[i].name === 'progress_at') {
          hasProgressAt = true
          break
        }
      }
      if (!hasProgressAt) {
        tasksCollection.fields.add(
          new DateField({
            name: 'progress_at',
            required: false,
          }),
        )
        app.save(tasksCollection)
      }
    } catch (errTask) {
      console.log('[MIGRATION_1741634513] Campo progress_at já existe ou erro: ' + errTask)
    }

    // 2. Criar tabela virtual FTS5 para busca textual ultra-rápida sem acentos
    try {
      app
        .db()
        .newQuery(`
      CREATE VIRTUAL TABLE IF NOT EXISTS price_samples_fts USING fts5(
        sample_id UNINDEXED,
        descricao_normalizada,
        termo,
        orgao,
        tokenize='unicode61 remove_diacritics 2'
      );
    `)
        .execute()

      // Sincronizar dados já existentes de price_samples_index para price_samples_fts
      app
        .db()
        .newQuery(`
      INSERT OR IGNORE INTO price_samples_fts(rowid, sample_id, descricao_normalizada, termo, orgao)
      SELECT rowid, id, descricao_normalizada, COALESCE(termo_pesquisa, ''), COALESCE(orgao, '')
      FROM price_samples_index;
    `)
        .execute()

      // 3. Triggers para manter FTS5 sempre sincronizado de forma transparente
      app.db().newQuery(`DROP TRIGGER IF EXISTS trg_price_samples_fts_ai;`).execute()
      app
        .db()
        .newQuery(`
      CREATE TRIGGER trg_price_samples_fts_ai AFTER INSERT ON price_samples_index BEGIN
        INSERT INTO price_samples_fts(rowid, sample_id, descricao_normalizada, termo, orgao)
        VALUES (new.rowid, new.id, new.descricao_normalizada, COALESCE(new.termo_pesquisa, ''), COALESCE(new.orgao, ''));
      END;
    `)
        .execute()

      app.db().newQuery(`DROP TRIGGER IF EXISTS trg_price_samples_fts_ad;`).execute()
      app
        .db()
        .newQuery(`
      CREATE TRIGGER trg_price_samples_fts_ad AFTER DELETE ON price_samples_index BEGIN
        DELETE FROM price_samples_fts WHERE rowid = old.rowid;
      END;
    `)
        .execute()

      app.db().newQuery(`DROP TRIGGER IF EXISTS trg_price_samples_fts_au;`).execute()
      app
        .db()
        .newQuery(`
      CREATE TRIGGER trg_price_samples_fts_au AFTER UPDATE ON price_samples_index BEGIN
        UPDATE price_samples_fts
        SET descricao_normalizada = new.descricao_normalizada,
            termo = COALESCE(new.termo_pesquisa, ''),
            orgao = COALESCE(new.orgao, '')
        WHERE rowid = old.rowid;
      END;
    `)
        .execute()

      // Índices adicionais para ordenação e keyset pagination de alta performance
      app
        .db()
        .newQuery(`
      CREATE INDEX IF NOT EXISTS idx_psi_val_unit_id ON price_samples_index(valor_unitario, id);
    `)
        .execute()

      app
        .db()
        .newQuery(`
      CREATE INDEX IF NOT EXISTS idx_pit_progress_at ON price_index_tasks(status, progress_at);
    `)
        .execute()
    } catch (errFts) {
      console.log('[MIGRATION_1741634513] Erro ao criar FTS5 / triggers: ' + errFts)
    }
  },
  (app) => {
    try {
      app.db().newQuery(`DROP TRIGGER IF EXISTS trg_price_samples_fts_ai;`).execute()
      app.db().newQuery(`DROP TRIGGER IF EXISTS trg_price_samples_fts_ad;`).execute()
      app.db().newQuery(`DROP TRIGGER IF EXISTS trg_price_samples_fts_au;`).execute()
      app.db().newQuery(`DROP TABLE IF EXISTS price_samples_fts;`).execute()
    } catch (_) {}
  },
)
