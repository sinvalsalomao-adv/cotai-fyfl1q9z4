/// <reference path="../pb_data/types.d.ts" />

// The task_key column is globally unique. Once queue ACLs became owner-scoped,
// leaving the owner out of that key meant that the first tenant to search a
// term/UF prevented every other tenant from admitting equivalent work.
migrate(
  (app) => {
    app
      .db()
      .newQuery(
        `UPDATE price_index_tasks
         SET task_key = task_key || '#OWNER#' || requested_by
         WHERE server_trust_version = 'server-v1'
           AND requested_by IS NOT NULL
           AND requested_by != ''
           AND instr(task_key, '#OWNER#') = 0
           AND NOT EXISTS (
             SELECT 1
             FROM price_index_tasks AS scoped
             WHERE scoped.id != price_index_tasks.id
               AND scoped.task_key = price_index_tasks.task_key || '#OWNER#' || price_index_tasks.requested_by
           )`,
      )
      .execute()
  },
  (_app) => {
    // Do not collapse owner-qualified keys on rollback: multiple owners may now
    // legitimately have the same source/term/UF and the legacy key is UNIQUE.
  },
)
