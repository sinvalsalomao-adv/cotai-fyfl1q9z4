/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Migration 0028: Purga de amostras contaminadas remanescentes (ex: PRENSA associada a picolé)
    // e garantia de integridade da base de resultados de preços (v0.0.55).
    try {
      app
        .db()
        .newQuery(
          "DELETE FROM budget_price_results WHERE UPPER(description_original) LIKE '%PRENSA%' AND (budget_item_id IN (SELECT id FROM budget_items WHERE LOWER(description) LIKE '%picole%' OR LOWER(description) LIKE '%picolé%'))",
        )
        .execute()
      console.log(
        '[Migration 0028] Amostras contaminadas de prensas em picolé expurgadas com sucesso.',
      )
    } catch (err) {
      console.log('[Migration 0028] Aviso ao expurgar contaminadas:', err.message)
    }
  },
  (app) => {
    // Reversão não necessária (purga de dados contaminados)
  },
)
