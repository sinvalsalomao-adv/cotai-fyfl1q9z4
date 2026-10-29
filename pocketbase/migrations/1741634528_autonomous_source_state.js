/// <reference path="../pb_data/types.d.ts" />
// Additive security boundary. Existing rows, evidence and read rules are preserved.
migrate(
  function (app) {
    // Private SQL tables have no API ACL or formerly client-controlled metadata.
    app
      .db()
      .newQuery(
        "CREATE TABLE IF NOT EXISTS cotai_pncp_scope_state (scope TEXT PRIMARY KEY NOT NULL, cancelled_at TEXT NOT NULL DEFAULT '', active_at TEXT NOT NULL DEFAULT '', cancellation_evidence TEXT NOT NULL DEFAULT '{}', active_evidence TEXT NOT NULL DEFAULT '{}') WITHOUT ROWID",
      )
      .execute()
    var initialized = new DynamicModel({ value: 0 })
    app
      .db()
      .newQuery(
        "SELECT COUNT(*) AS value FROM cotai_maintenance_state WHERE key='autonomous-state-v1-initialized' AND value=1",
      )
      .one(initialized)
    if (Number(initialized.value) === 1) return

    app
      .db()
      .newQuery(
        'CREATE INDEX IF NOT EXISTS idx_psi_source_record_identity ON price_samples_index (source, source_record_id)',
      )
      .execute()
    // Pre-lock daily rows cannot reserve the new trusted scheduler namespace.
    app
      .db()
      .newQuery(
        "UPDATE daily_sync_runs SET ciclo_id = 'legacy-untrusted-' || id WHERE substr(ciclo_id, 1, length('CICLO_AUTONOMOUS_V1_')) = 'CICLO_AUTONOMOUS_V1_'",
      )
      .execute()
    var watermarks = app.findCollectionByNameOrId('price_watermarks')
    var runs = app.findCollectionByNameOrId('daily_sync_runs')
    ;[watermarks, runs].forEach(function (c) {
      c.createRule = null
      c.updateRule = null
      c.deleteRule = null
      app.save(c)
    })
    ;['PNCP', 'Compras.gov.br'].forEach(function (source) {
      // A colliding pre-migration row was client-writable; never adopt it as trusted state.
      var collisions = app.findRecordsByFilter(
        'price_watermarks',
        'fonte = {:source} && cursor_tipo = "autonomous-v1"',
        '',
        100,
        0,
        { source: source },
      )
      collisions.forEach(function (old) {
        old.set('cursor_tipo', 'legacy-untrusted-' + old.id)
        app.save(old)
      })
      var rec = new Record(watermarks)
      rec.set('fonte', source)
      rec.set('cursor_tipo', 'autonomous-v1')
      // Required legacy text only; actual cursor and freshness live in detalhes.
      rec.set('last_watermark_date', 'uninitialized')
      rec.set('status', 'idle')
      rec.set('last_cursor_page', 1)
      rec.set(
        'detalhes',
        JSON.stringify({
          version: 1,
          source: source,
          lanes: {},
          claim: null,
          next_attempt_at: '',
          backlog: 0,
          source_checked_at: '',
          source_written_at: '',
          last_drained_at: '',
          modalities: [],
        }),
      )
      app.save(rec)
    })
    // PocketBase commits the migration and this marker atomically.
    app
      .db()
      .newQuery(
        "INSERT INTO cotai_maintenance_state(key,value) VALUES('autonomous-state-v1-initialized',1) ON CONFLICT(key) DO UPDATE SET value=1",
      )
      .execute()
  },
  function (_app) {
    // No destructive rollback or reopening of client-controlled scheduler state.
  },
)
