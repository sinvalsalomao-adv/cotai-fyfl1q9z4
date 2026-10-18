/// <reference path="../pb_data/types.d.ts" />

// Private, short-lived windows for deterministic pagination. These raw SQLite
// tables are deliberately not PocketBase collections: clients cannot list,
// mutate, extend or delete sessions through the Records API.
migrate(
  (app) => {
    app
      .db()
      .newQuery(
        `CREATE TABLE IF NOT EXISTS cotai_price_search_snapshots (
          id TEXT PRIMARY KEY NOT NULL,
          token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
          owner_user_id TEXT NOT NULL,
          query_hash TEXT NOT NULL CHECK (length(query_hash) = 64),
          cursor_secret TEXT NOT NULL CHECK (length(cursor_secret) = 64),
          sort_name TEXT NOT NULL,
          page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 100),
          page_count INTEGER NOT NULL CHECK (page_count >= 1),
          captured_count INTEGER NOT NULL CHECK (captured_count >= 1),
          total_count INTEGER NOT NULL CHECK (total_count >= captured_count),
          population_complete INTEGER NOT NULL CHECK (population_complete IN (0, 1)),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) WITHOUT ROWID`,
      )
      .execute()
    app
      .db()
      .newQuery(
        `CREATE INDEX IF NOT EXISTS idx_cotai_price_search_snapshots_owner_expiry
          ON cotai_price_search_snapshots(owner_user_id, expires_at, created_at DESC)`,
      )
      .execute()
    app
      .db()
      .newQuery(
        `CREATE INDEX IF NOT EXISTS idx_cotai_price_search_snapshots_expiry
          ON cotai_price_search_snapshots(expires_at)`,
      )
      .execute()
    app
      .db()
      .newQuery(
        `CREATE TABLE IF NOT EXISTS cotai_price_search_snapshot_items (
          snapshot_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          hit_json TEXT NOT NULL CHECK (
            json_valid(hit_json)
            AND json_type(hit_json) = 'object'
            AND length(CAST(hit_json AS BLOB)) <= 32768
          ),
          PRIMARY KEY(snapshot_id, position),
          FOREIGN KEY(snapshot_id) REFERENCES cotai_price_search_snapshots(id) ON DELETE CASCADE
        ) WITHOUT ROWID`,
      )
      .execute()
  },
  (app) => {
    app.db().newQuery('DROP TABLE IF EXISTS cotai_price_search_snapshot_items').execute()
    app.db().newQuery('DROP TABLE IF EXISTS cotai_price_search_snapshots').execute()
  },
)
