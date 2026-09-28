/// <reference path="../pb_data/types.d.ts" />
migrate(
  (app) => {
    // 1. Purgar todas as amostras contaminadas de máquinas/equipamentos (ex: PRENSA) gravadas em itens alimentares
    try {
      app
        .db()
        .newQuery(`
          DELETE FROM budget_price_results
          WHERE (
            description_original LIKE '%PRENSA PRODUTO%'
            OR description_normalized LIKE '%PRENSA PRODUTO%'
            OR description_original LIKE '%PRENSA%'
            OR description_normalized LIKE '%PRENSA%'
          )
        `)
        .execute()
    } catch (err) {
      console.log('Erro ao purgar prensas na migração 0026:', err)
    }

    // 2. Touch em registro para garantir recarregamento de hooks se necessário
    try {
      const col = app.findCollectionByNameOrId('integracoes')
      try {
        const pncpReg = app.findFirstRecordByData('integracoes', 'nome', 'PNCP')
        pncpReg.set('documentation_status', 'confirmada')
        pncpReg.set('runtime_enabled', true)
        app.save(pncpReg)
      } catch (_) {}

      try {
        const cgovReg = app.findFirstRecordByData('integracoes', 'nome', 'Compras.gov.br')
        cgovReg.set('documentation_status', 'confirmada')
        cgovReg.set('runtime_enabled', true)
        app.save(cgovReg)
      } catch (_) {}
    } catch (_) {}
  },
  (app) => {
    // no-op
  },
)
