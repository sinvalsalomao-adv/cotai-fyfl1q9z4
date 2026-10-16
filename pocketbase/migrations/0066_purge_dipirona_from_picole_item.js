/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Migration 0066: Saneamento anti-contaminação em budget_price_results
    // Remove registros de dipirona indevidamente vinculados ao item Picolé (budget_item_id '0m379nc3v73870w')
    // ou qualquer registro de dipirona vinculado a itens cujo termo/descrição seja picolé.
    // Idempotente e focado estritamente na remoção do vínculo errado (sem criar dados sintéticos).

    try {
      console.log(
        '[Migration 0066] Iniciando saneamento de registros contaminados em budget_price_results...',
      )

      // 1. Purgar especificamente os registros onde a descrição é dipirona no item de picolé
      var resDeletePicole = app
        .db()
        .newQuery(
          `DELETE FROM budget_price_results
           WHERE budget_item_id = '0m379nc3v73870w'
             AND (
               UPPER(description_original) LIKE '%DIPIRONA%'
               OR UPPER(description_normalized) LIKE '%DIPIRONA%'
               OR UPPER(description_original) NOT LIKE '%PICOLE%'
             )`,
        )
        .execute()

      // 2. Purgar genericamente registros de dipirona vinculados a itens cujo description ou last_search_term é picolé
      var resDeleteGenerico = app
        .db()
        .newQuery(
          `DELETE FROM budget_price_results
           WHERE id IN (
             SELECT r.id
             FROM budget_price_results r
             INNER JOIN budget_items i ON r.budget_item_id = i.id
             WHERE (
               UPPER(i.description) LIKE '%PICOLE%'
               OR UPPER(i.last_search_term) LIKE '%PICOLE%'
             )
             AND (
               UPPER(r.description_original) LIKE '%DIPIRONA%'
               OR UPPER(r.description_normalized) LIKE '%DIPIRONA%'
             )
           )`,
        )
        .execute()

      console.log('[Migration 0066] Saneamento concluído com sucesso!')
    } catch (err) {
      console.log('[Migration 0066] Erro durante saneamento:', err.message)
      throw err
    }
  },
  (app) => {
    // Rollback no-op
  },
)
