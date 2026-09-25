migrate(
  (app) => {
    // Definir cascadeDelete: true nas relações que apontam para budget_items
    const cascadeCollections = [
      'budget_price_results',
      'budget_selected_prices',
      'budget_expurgated_prices',
      'budget_statistics',
    ]

    for (const colName of cascadeCollections) {
      try {
        const col = app.findCollectionByNameOrId(colName)
        const field = col.fields.getByName('budget_item_id')
        if (field) {
          field.cascadeDelete = true
          app.save(col)
        }
      } catch (err) {
        console.warn(`Erro ao configurar cascadeDelete em ${colName}:`, err)
      }
    }

    // Também em budget_selected_prices e budget_expurgated_prices quando price_result_id for deletado
    for (const colName of ['budget_selected_prices', 'budget_expurgated_prices']) {
      try {
        const col = app.findCollectionByNameOrId(colName)
        const field = col.fields.getByName('price_result_id')
        if (field) {
          field.cascadeDelete = true
          app.save(col)
        }
      } catch (err) {
        console.warn(`Erro ao configurar cascadeDelete em ${colName}.price_result_id:`, err)
      }
    }
  },
  (app) => {
    const cascadeCollections = [
      'budget_price_results',
      'budget_selected_prices',
      'budget_expurgated_prices',
      'budget_statistics',
    ]

    for (const colName of cascadeCollections) {
      try {
        const col = app.findCollectionByNameOrId(colName)
        const field = col.fields.getByName('budget_item_id')
        if (field) {
          field.cascadeDelete = false
          app.save(col)
        }
      } catch (_) {}
    }
  },
)
