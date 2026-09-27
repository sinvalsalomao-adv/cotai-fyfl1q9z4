/// <reference path="../pb_data/types.d.ts" />
migrate(
  (app) => {
    // Limpar amostras contaminadas de outros itens ou duplicatas gravadas em budget_price_results para qualquer item
    try {
      app
        .db()
        .newQuery(`
      DELETE FROM budget_price_results 
      WHERE (
          description_original LIKE '%CLOREXIDINA%' 
          OR description_original LIKE '%HEMODIÁLISE%' 
          OR description_original LIKE '%HEMODIALISE%' 
          OR description_original LIKE '%HASTE INTRAMEDULAR%' 
          OR description_original LIKE '%PAPEL RECADO%' 
          OR description_original LIKE '%CLIPE%' 
          OR description_original LIKE '%ESTILETE%' 
          OR description_original LIKE '%TESOURA%' 
          OR description_original LIKE '%ASSISTÊNCIA MÉDICA%' 
          OR description_original LIKE '%COOPERATIVA%' 
          OR description_original LIKE '%ÁGUA TRATADA%' 
          OR description_original LIKE '%AGUA TRATADA%' 
          OR description_original LIKE '%AR CONDICIONADO%' 
          OR description_original LIKE '%MULTIVITAMINAS%' 
          OR description_original LIKE '%PLACA ORTOPÉDICA%' 
          OR description_original LIKE '%LÂMINA P/ SERRA%' 
          OR description_original LIKE '%LENÇOL DESCARTÁVEL%' 
          OR id = '6l95ofps9vpd4i6'
        )
        AND (
          SELECT description FROM budget_items WHERE budget_items.id = budget_price_results.budget_item_id
        ) LIKE '%DIPIRONA%'
    `)
        .execute()
    } catch (err) {
      console.error('Erro ao expurgar amostras contaminadas na migração 0022:', err)
    }
  },
  (app) => {
    // rollback no-op
  },
)
