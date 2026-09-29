/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Migration 0031: Expurgar do banco de budget_price_results amostras contaminadas
    // com playground, tobogã, piscina de bolinhas, brinquedos, futebol inflável, etc.,
    // atribuídas indevidamente a itens de picolé/sorvete/alimentos.
    try {
      // 1. Deletar registros específicos conhecidos (como pydioj9gzzpby2t) e variações
      app
        .db()
        .newQuery(
          "DELETE FROM budget_price_results WHERE id = 'pydioj9gzzpby2t' OR (budget_item_id IN (SELECT id FROM budget_items WHERE LOWER(description) LIKE '%picole%' OR LOWER(description) LIKE '%picolé%' OR LOWER(last_search_term) LIKE '%picole%' OR LOWER(last_search_term) LIKE '%picolé%') AND (UPPER(description_original) LIKE '%PLAYGROUND%' OR UPPER(description_original) LIKE '%BOLINHA%' OR UPPER(description_original) LIKE '%TOBOG%' OR UPPER(description_original) LIKE '%BRINQUEDO%' OR UPPER(description_original) LIKE '%INFL%' OR UPPER(description_original) LIKE '%FUTEBOL%' OR UPPER(description_original) LIKE '%CAMA EL%' OR UPPER(description_original) LIKE '%KID PLAY%' OR UPPER(description_original) LIKE '%TOMBO LEGAL%' OR UPPER(description_original) LIKE '%ESCORREGADOR%' OR UPPER(description_original) LIKE '%PULA-PULA%' OR UPPER(description_original) LIKE '%PULA PULA%'))",
        )
        .execute()

      // 2. Deletar também qualquer amostra geral de brinquedo/playground/locação atribuída a alimentos
      app
        .db()
        .newQuery(
          "DELETE FROM budget_price_results WHERE (UPPER(description_original) LIKE '%PLAYGROUND%' OR UPPER(description_original) LIKE '%PISCINA DE BOLINHA%' OR UPPER(description_original) LIKE '%TOBOGÃ%' OR UPPER(description_original) LIKE '%TOBOGA%') AND (budget_item_id IN (SELECT id FROM budget_items WHERE LOWER(description) LIKE '%picole%' OR LOWER(description) LIKE '%picolé%' OR LOWER(description) LIKE '%sorvete%'))",
        )
        .execute()

      console.log(
        '[Migration 0031] Amostras contaminadas de brinquedos/playground/tobogã expurgadas com sucesso.',
      )
    } catch (err) {
      console.log('[Migration 0031] Aviso ao expurgar amostras contaminadas:', err.message)
    }
  },
  (app) => {
    // Reversão não necessária (expurgo de contaminação)
  },
)
