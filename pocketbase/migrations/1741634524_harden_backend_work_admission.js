/// <reference path="../pb_data/types.d.ts" />

// Applies the owner boundary to installations where the task collection already exists and
// keeps source/process admission evidence outside the Records API.  The single private table
// gives each authenticated user an independent fixed-window quota per expensive route.
migrate(
  (app) => {
    const tasks = app.findCollectionByNameOrId('price_index_tasks')
    tasks.listRule =
      '@request.auth.id != "" && server_trust_version = "server-v1" && requested_by = @request.auth.id'
    tasks.viewRule =
      '@request.auth.id != "" && server_trust_version = "server-v1" && requested_by = @request.auth.id'
    tasks.createRule = null
    tasks.updateRule = null
    tasks.deleteRule = null
    app.save(tasks)

    app
      .db()
      .newQuery(
        `CREATE TABLE IF NOT EXISTS cotai_backend_rate_limits (
          user_id TEXT NOT NULL,
          route_key TEXT NOT NULL,
          window_started_at TEXT NOT NULL,
          request_count INTEGER NOT NULL CHECK (request_count >= 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(user_id, route_key)
        ) WITHOUT ROWID`,
      )
      .execute()
  },
  (_app) => {
    // Keep server-owned security evidence and the closed task ACL across rollback.
  },
)
