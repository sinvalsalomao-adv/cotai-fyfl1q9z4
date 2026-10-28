/// <reference path="../pb_data/types.d.ts" />

// Consolida a fila 1741634518..1741634525, que ficou presa como pending.
// Reenviada após restart da instância (28/10/2026).
//
// Só estrutura: tudo aqui roda em segundos e é idempotente. O apply do Skip Cloud
// espera ~2 min pela transação inteira; reescrever price_samples_index (raw_payload
// grande) dentro dela estourava esse prazo ("This operation was aborted") e
// derrubava o lote todo. O backfill de search_eligible e os índices de busca
// rodam em lotes pelo cron search_eligibility_backfill (hooks/).
//
// 1. official_ingestion_receipts: coleção deny-all (só hooks escrevem).
// 2. server_trust_version + escrita só pelo servidor em pncp_item_cache,
//    price_index_tasks e price_samples_index.
// 3. price_samples_index: campos search_eligible/search_contract (sem backfill).
//    O FTS atual (descricao_normalizada) é mantido; a busca já filtra
//    search_eligible = 1, então linhas não processadas ficam de fora.
// 4. price_index_tasks: requested_by/admitted_at, índices de cota e ACL por dono.
// 5. Tabelas privadas (fora da Records API): rate limits, snapshots de paginação
//    e o cursor do backfill.
// 6. task_key qualificada por dono (#OWNER#).
migrate(
  (app) => {
    const run = (sql) => app.db().newQuery(sql).execute()
    const trustedRule = '@request.auth.id != "" && server_trust_version = "server-v1"'
    const ownerRule = trustedRule + ' && requested_by = @request.auth.id'

    const ensureTextField = (collection, name) => {
      if (!collection.fields.getByName(name)) {
        collection.fields.add(new TextField({ name: name, required: false }))
      }
    }
    const closeWrites = (collection) => {
      collection.createRule = null
      collection.updateRule = null
      collection.deleteRule = null
    }

    // 1. Recibos de ingestão oficial
    let receipts
    try {
      receipts = app.findCollectionByNameOrId('official_ingestion_receipts')
    } catch (_) {
      receipts = new Collection({
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
    }
    receipts.listRule = null
    receipts.viewRule = null
    closeWrites(receipts)
    app.save(receipts)

    // 2. Marcador de confiança + escrita só pelo servidor
    const cache = app.findCollectionByNameOrId('pncp_item_cache')
    ensureTextField(cache, 'server_trust_version')
    cache.listRule = trustedRule
    cache.viewRule = trustedRule
    closeWrites(cache)
    app.save(cache)

    // 3. Campos da busca segura (colunas novas nulas: ADD COLUMN não reescreve a tabela)
    const samples = app.findCollectionByNameOrId('price_samples_index')
    ensureTextField(samples, 'server_trust_version')
    ensureTextField(samples, 'search_contract')
    if (!samples.fields.getByName('search_eligible')) {
      samples.fields.add(
        new NumberField({
          name: 'search_eligible',
          required: false,
          min: 0,
          max: 1,
          onlyInt: true,
        }),
      )
    }
    samples.listRule = trustedRule
    samples.viewRule = trustedRule
    closeWrites(samples)
    app.save(samples)

    // 4. Fila de tarefas: admissão por usuário e ACL por dono
    const tasks = app.findCollectionByNameOrId('price_index_tasks')
    ensureTextField(tasks, 'server_trust_version')
    ensureTextField(tasks, 'requested_by')
    if (!tasks.fields.getByName('admitted_at')) {
      tasks.fields.add(new DateField({ name: 'admitted_at', required: false }))
    }
    const taskIndexes = [
      'CREATE INDEX idx_pit_admission_user_time ON price_index_tasks (requested_by, admitted_at DESC)',
      'CREATE INDEX idx_pit_admission_user_status ON price_index_tasks (requested_by, status)',
    ]
    for (let i = 0; i < taskIndexes.length; i++) {
      if (tasks.indexes.indexOf(taskIndexes[i]) < 0) tasks.indexes.push(taskIndexes[i])
    }
    tasks.listRule = ownerRule
    tasks.viewRule = ownerRule
    closeWrites(tasks)
    app.save(tasks)

    // 5. Tabelas privadas de cota, paginação e manutenção
    run(`
      CREATE TABLE IF NOT EXISTS cotai_price_search_rate_limits (
        user_id TEXT PRIMARY KEY NOT NULL,
        window_started_at TEXT NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count >= 0),
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID
    `)
    run(`
      CREATE TABLE IF NOT EXISTS cotai_backend_rate_limits (
        user_id TEXT NOT NULL,
        route_key TEXT NOT NULL,
        window_started_at TEXT NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, route_key)
      ) WITHOUT ROWID
    `)
    run(`
      CREATE TABLE IF NOT EXISTS cotai_price_search_snapshots (
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
      ) WITHOUT ROWID
    `)
    run(`CREATE INDEX IF NOT EXISTS idx_cotai_price_search_snapshots_owner_expiry
      ON cotai_price_search_snapshots(owner_user_id, expires_at, created_at DESC)`)
    run(`CREATE INDEX IF NOT EXISTS idx_cotai_price_search_snapshots_expiry
      ON cotai_price_search_snapshots(expires_at)`)
    run(`
      CREATE TABLE IF NOT EXISTS cotai_price_search_snapshot_items (
        snapshot_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 1),
        hit_json TEXT NOT NULL CHECK (
          json_valid(hit_json)
          AND json_type(hit_json) = 'object'
          AND length(CAST(hit_json AS BLOB)) <= 32768
        ),
        PRIMARY KEY(snapshot_id, position),
        FOREIGN KEY(snapshot_id) REFERENCES cotai_price_search_snapshots(id) ON DELETE CASCADE
      ) WITHOUT ROWID
    `)
    // Cursor do backfill em lotes (hooks/search_eligibility_backfill.js)
    run(`
      CREATE TABLE IF NOT EXISTS cotai_maintenance_state (
        key TEXT PRIMARY KEY NOT NULL,
        value INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID
    `)

    // 6. task_key única por dono, para um tenant não bloquear a busca de outro
    run(`
      UPDATE price_index_tasks
      SET task_key = task_key || '#OWNER#' || requested_by
      WHERE server_trust_version = 'server-v1'
        AND requested_by IS NOT NULL
        AND requested_by != ''
        AND instr(task_key, '#OWNER#') = 0
        AND NOT EXISTS (
          SELECT 1 FROM price_index_tasks AS scoped
          WHERE scoped.id != price_index_tasks.id
            AND scoped.task_key = price_index_tasks.task_key || '#OWNER#' || price_index_tasks.requested_by
        )
    `)
  },
  (_app) => {
    // Sem rollback: não reabrir escrita de clientes nem descartar evidência de cota.
  },
)
