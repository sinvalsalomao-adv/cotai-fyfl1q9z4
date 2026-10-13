migrate(
  (app) => {
    // Adiciona campo 'tentativas' em price_index_tasks para controle de retry e tolerância a falhas
    const col = app.findCollectionByNameOrId('price_index_tasks')
    if (!col.fields.getByName('tentativas')) {
      col.fields.add(
        new NumberField({
          name: 'tentativas',
          min: 0,
          onlyInt: true,
        }),
      )
    }
    if (!col.fields.getByName('ultimo_erro')) {
      col.fields.add(
        new TextField({
          name: 'ultimo_erro',
        }),
      )
    }
    app.save(col)
  },
  (app) => {
    const col = app.findCollectionByNameOrId('price_index_tasks')
    if (col.fields.getByName('tentativas')) {
      col.fields.removeByName('tentativas')
    }
    if (col.fields.getByName('ultimo_erro')) {
      col.fields.removeByName('ultimo_erro')
    }
    app.save(col)
  },
)
