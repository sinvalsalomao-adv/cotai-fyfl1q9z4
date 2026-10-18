/// <reference path="../pb_data/types.d.ts" />

// Internal-only quota state for the authenticated search routes. This is a raw
// table on purpose: PocketBase does not expose it through the Records API, so
// clients cannot create, reset, increment or delete their own quota evidence.
migrate(
  (app) => {
    app
      .db()
      .newQuery(
        `CREATE TABLE IF NOT EXISTS cotai_price_search_rate_limits (
          user_id TEXT PRIMARY KEY NOT NULL,
          window_started_at TEXT NOT NULL,
          request_count INTEGER NOT NULL CHECK (request_count >= 0),
          updated_at TEXT NOT NULL
        ) WITHOUT ROWID`,
      )
      .execute()
  },
  (_app) => {
    // Preserve security evidence on rollback. The table is private and bounded
    // to one row per authenticated user, so retaining it is safe and avoids an
    // accidental quota reset while deployments roll forward/backward.
  },
)
