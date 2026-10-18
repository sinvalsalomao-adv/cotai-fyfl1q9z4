/// <reference path="../pb_data/types.d.ts" />

// Durable, server-only admission metadata for the authenticated worker queue.  It is
// intentionally stored on the task itself so normalized idempotent reuse does not consume
// another quota slot and no caller-controlled admission log can be forged or deleted.
migrate(
  (app) => {
    const tasks = app.findCollectionByNameOrId('price_index_tasks')
    if (!tasks.fields.getByName('requested_by')) {
      tasks.fields.add(
        new TextField({
          name: 'requested_by',
          required: false,
        }),
      )
    }
    if (!tasks.fields.getByName('admitted_at')) {
      tasks.fields.add(
        new DateField({
          name: 'admitted_at',
          required: false,
        }),
      )
    }
    const admissionIndex =
      'CREATE INDEX idx_pit_admission_user_time ON price_index_tasks (requested_by, admitted_at DESC)'
    const activeIndex =
      'CREATE INDEX idx_pit_admission_user_status ON price_index_tasks (requested_by, status)'
    if (tasks.indexes.indexOf(admissionIndex) < 0) tasks.indexes.push(admissionIndex)
    if (tasks.indexes.indexOf(activeIndex) < 0) tasks.indexes.push(activeIndex)
    // Preserve the server-owned ACL boundary established by the prior security migration.
    tasks.createRule = null
    tasks.updateRule = null
    tasks.deleteRule = null
    tasks.listRule =
      '@request.auth.id != "" && server_trust_version = "server-v1" && requested_by = @request.auth.id'
    tasks.viewRule =
      '@request.auth.id != "" && server_trust_version = "server-v1" && requested_by = @request.auth.id'
    app.save(tasks)
  },
  (_app) => {
    // Admission evidence remains in place on rollback; never reopen caller writes.
  },
)
