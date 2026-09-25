migrate(
  (app) => {
    const budgetsCol = app.findCollectionByNameOrId('budgets')
    const extRefField = budgetsCol.fields.getByName('external_reference')
    if (extRefField) {
      extRefField.required = false
      app.save(budgetsCol)
    }
  },
  (app) => {
    const budgetsCol = app.findCollectionByNameOrId('budgets')
    const extRefField = budgetsCol.fields.getByName('external_reference')
    if (extRefField) {
      extRefField.required = true
      app.save(budgetsCol)
    }
  },
)
