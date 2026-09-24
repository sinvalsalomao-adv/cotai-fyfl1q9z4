migrate(
  (app) => {
    // 1. Adicionar campos cidade_orgao e lote na collection budget_items
    const colItems = app.findCollectionByNameOrId('budget_items')
    if (!colItems.fields.getByName('cidade_orgao')) {
      colItems.fields.add(
        new TextField({
          name: 'cidade_orgao',
          required: false,
        }),
      )
    }
    if (!colItems.fields.getByName('lote')) {
      colItems.fields.add(
        new TextField({
          name: 'lote',
          required: false,
        }),
      )
    }
    app.save(colItems)

    // 2. Adicionar campo orgaos_participantes na collection budgets
    const colBudgets = app.findCollectionByNameOrId('budgets')
    if (!colBudgets.fields.getByName('orgaos_participantes')) {
      colBudgets.fields.add(
        new JSONField({
          name: 'orgaos_participantes',
          required: false,
        }),
      )
    }
    app.save(colBudgets)
  },
  (app) => {
    const colItems = app.findCollectionByNameOrId('budget_items')
    if (colItems.fields.getByName('cidade_orgao')) {
      colItems.fields.removeByName('cidade_orgao')
    }
    if (colItems.fields.getByName('lote')) {
      colItems.fields.removeByName('lote')
    }
    app.save(colItems)

    const colBudgets = app.findCollectionByNameOrId('budgets')
    if (colBudgets.fields.getByName('orgaos_participantes')) {
      colBudgets.fields.removeByName('orgaos_participantes')
    }
    app.save(colBudgets)
  },
)
