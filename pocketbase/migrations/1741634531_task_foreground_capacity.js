// Additive scheduling metadata only. Existing work and price evidence are untouched.
migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId('price_index_tasks')
    const names = ['foreground_until', 'deferred_at']
    const missing = []
    for (const name of names) {
      const field = collection.fields.getByName(name)
      if (!field) missing.push(name)
      else {
        const type = typeof field.type === 'function' ? field.type() : field.type
        if (type !== 'date') throw new Error('TASK_CAPACITY_FIELD_TYPE: ' + name)
      }
    }
    for (const name of missing) collection.fields.add(new DateField({ name, required: false }))
    if (missing.length) app.save(collection)
  },
  () => {
    // Retain scheduling metadata on rollback; never erase a durable suspended queue.
  },
)
