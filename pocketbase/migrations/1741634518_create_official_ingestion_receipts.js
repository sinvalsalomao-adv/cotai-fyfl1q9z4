/// <reference path="../pb_data/types.d.ts" />

// Short-lived attestations created only by the authenticated official-source hooks.
// No client may list, view, create, update or delete these records through PocketBase APIs.
migrate(
  (app) => {
    let collection
    let existed = true
    try {
      collection = app.findCollectionByNameOrId('official_ingestion_receipts')
    } catch (_) {
      existed = false
      collection = new Collection({
        name: 'official_ingestion_receipts',
        type: 'base',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { name: 'token_hash', type: 'text', required: true },
          { name: 'user_id', type: 'text', required: true },
          { name: 'source', type: 'text', required: true },
          { name: 'query_hash', type: 'text', required: true },
          { name: 'claims', type: 'json', required: true },
          { name: 'expires_at', type: 'date', required: true },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_oir_token_hash ON official_ingestion_receipts (token_hash)',
          'CREATE INDEX idx_oir_expires_at ON official_ingestion_receipts (expires_at)',
          'CREATE INDEX idx_oir_user_source ON official_ingestion_receipts (user_id, source)',
        ],
      })
      app.save(collection)
    }
    if (existed) {
      // Existing deployments keep the same deny-all boundary after repeated migration runs.
      collection.listRule = null
      collection.viewRule = null
      collection.createRule = null
      collection.updateRule = null
      collection.deleteRule = null
      app.save(collection)
    }
  },
  (_app) => {
    // Deliberately do not delete security receipts on rollback. They expire naturally and
    // retaining the deny-all collection cannot expose application data.
  },
)
