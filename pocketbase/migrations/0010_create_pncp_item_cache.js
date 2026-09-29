migrate(
  (app) => {
    let cacheCol
    try {
      cacheCol = app.findCollectionByNameOrId('pncp_item_cache')
    } catch (_) {
      cacheCol = new Collection({
        name: 'pncp_item_cache',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          { name: 'cache_key', type: 'text', required: true },
          { name: 'cnpj', type: 'text', required: true },
          { name: 'ano', type: 'number', required: true },
          { name: 'sequencial', type: 'number', required: true },
          { name: 'raw_itens', type: 'json' },
          { name: 'total_itens', type: 'number' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_pncp_cache_key ON pncp_item_cache (cache_key)',
          'CREATE INDEX idx_pncp_cache_compra ON pncp_item_cache (cnpj, ano, sequencial)',
        ],
      })
      app.save(cacheCol)
    }
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId('pncp_item_cache')
      if (col) app.delete(col)
    } catch (_) {}
  },
)
