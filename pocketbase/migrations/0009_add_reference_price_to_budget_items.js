migrate(
  (app) => {
    const col = app.findCollectionByNameOrId('budget_items')
    if (!col.fields.getByName('reference_price')) {
      col.fields.add(
        new NumberField({
          name: 'reference_price',
          required: false,
        }),
      )
    }
    app.save(col)
  },
  (app) => {
    const col = app.findCollectionByNameOrId('budget_items')
    const field = col.fields.getByName('reference_price')
    if (field) {
      col.fields.removeByName('reference_price')
      app.save(col)
    }
  },
)
