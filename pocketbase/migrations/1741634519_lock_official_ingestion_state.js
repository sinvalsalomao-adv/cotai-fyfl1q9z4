/// <reference path="../pb_data/types.d.ts" />

// Derived PNCP cache and worker tasks are written only by server hooks.  The marker is
// deliberately not backfilled: rows created before this boundary remain readable for
// diagnostics but are never trusted as official input.
migrate(
  (app) => {
    const names = ['pncp_item_cache', 'price_index_tasks']
    for (let i = 0; i < names.length; i++) {
      const collection = app.findCollectionByNameOrId(names[i])
      collection.listRule = '@request.auth.id != "" && server_trust_version = "server-v1"'
      collection.viewRule = '@request.auth.id != "" && server_trust_version = "server-v1"'
      collection.createRule = null
      collection.updateRule = null
      collection.deleteRule = null
      if (!collection.fields.getByName('server_trust_version')) {
        collection.fields.add(
          new TextField({
            name: 'server_trust_version',
            required: false,
          }),
        )
      }
      app.save(collection)
    }
    const samples = app.findCollectionByNameOrId('price_samples_index')
    samples.listRule = '@request.auth.id != "" && server_trust_version = "server-v1"'
    samples.viewRule = '@request.auth.id != "" && server_trust_version = "server-v1"'
    samples.createRule = null
    samples.updateRule = null
    samples.deleteRule = null
    if (!samples.fields.getByName('server_trust_version')) {
      samples.fields.add(
        new TextField({
          name: 'server_trust_version',
          required: false,
        }),
      )
    }
    app.save(samples)
  },
  (_app) => {
    // Never reopen client writes or mark legacy derived rows as trusted on rollback.
  },
)
