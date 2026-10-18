migrate(
  (app) => {
    // 1. Coleção price_samples_index: Base normalizada e indexada de amostras de preços (PNCP e Compras.gov.br)
    let samplesCol
    try {
      samplesCol = app.findCollectionByNameOrId('price_samples_index')
    } catch (_) {
      samplesCol = new Collection({
        name: 'price_samples_index',
        type: 'base',
        listRule: '@request.auth.id != "" && server_trust_version = "server-v1"',
        viewRule: '@request.auth.id != "" && server_trust_version = "server-v1"',
        // O índice oficial é escrito exclusivamente por hooks executados no servidor.
        // `null` bloqueia as APIs de registro do PocketBase inclusive para clientes autenticados.
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { name: 'sample_key', type: 'text', required: true },
          { name: 'source', type: 'text', required: true },
          { name: 'source_record_id', type: 'text' },
          { name: 'purchase_id', type: 'text' },
          { name: 'item_id', type: 'text' },
          { name: 'descricao', type: 'text', required: true },
          { name: 'descricao_normalizada', type: 'text', required: true },
          { name: 'orgao', type: 'text' },
          { name: 'orgao_cnpj', type: 'text' },
          { name: 'fornecedor_nome', type: 'text' },
          { name: 'fornecedor_cnpj', type: 'text' },
          { name: 'fornecedor_porte', type: 'text' },
          { name: 'uf', type: 'text' },
          { name: 'municipio', type: 'text' },
          { name: 'unidade', type: 'text' },
          { name: 'quantidade', type: 'number' },
          { name: 'valor_unitario', type: 'number', required: true },
          { name: 'valor_total', type: 'number' },
          { name: 'natureza_preco', type: 'text' },
          { name: 'data_referencia', type: 'text' },
          { name: 'numero_processo', type: 'text' },
          { name: 'numero_ata', type: 'text' },
          { name: 'modalidade', type: 'text' },
          { name: 'marca', type: 'text' },
          { name: 'codigo_item', type: 'text' },
          { name: 'url_original', type: 'text' },
          { name: 'raw_payload', type: 'json' },
          { name: 'indexed_at', type: 'text' },
          { name: 'source_updated_at', type: 'text' },
          { name: 'last_validated_at', type: 'text' },
          { name: 'server_trust_version', type: 'text' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_psi_sample_key ON price_samples_index (sample_key)',
          'CREATE INDEX idx_psi_source_unitario ON price_samples_index (source, valor_unitario ASC)',
          'CREATE INDEX idx_psi_unitario ON price_samples_index (valor_unitario ASC)',
          'CREATE INDEX idx_psi_desc_norm ON price_samples_index (descricao_normalizada)',
          'CREATE INDEX idx_psi_data_ref ON price_samples_index (data_referencia DESC)',
          'CREATE INDEX idx_psi_uf ON price_samples_index (uf)',
          'CREATE INDEX idx_psi_codigo_item ON price_samples_index (codigo_item)',
        ],
      })
      app.save(samplesCol)
    }

    // 2. Coleção price_index_tasks: Fila persistente de atualização de índices
    let tasksCol
    try {
      tasksCol = app.findCollectionByNameOrId('price_index_tasks')
    } catch (_) {
      tasksCol = new Collection({
        name: 'price_index_tasks',
        type: 'base',
        listRule: '@request.auth.id != "" && server_trust_version = "server-v1"',
        viewRule: '@request.auth.id != "" && server_trust_version = "server-v1"',
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { name: 'task_key', type: 'text', required: true },
          { name: 'source', type: 'text', required: true },
          { name: 'termo', type: 'text', required: true },
          { name: 'uf', type: 'text' },
          { name: 'status', type: 'text', required: true }, // pending, running, completed, failed
          { name: 'paginas_consultadas', type: 'number' },
          { name: 'itens_processados', type: 'number' },
          { name: 'amostras_inseridas', type: 'number' },
          { name: 'amostras_atualizadas', type: 'number' },
          { name: 'erros', type: 'json' },
          { name: 'pendentes', type: 'json' },
          { name: 'started_at', type: 'text' },
          { name: 'finished_at', type: 'text' },
          { name: 'server_trust_version', type: 'text' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_pit_task_key ON price_index_tasks (task_key)',
          'CREATE INDEX idx_pit_status_source ON price_index_tasks (status, source)',
          'CREATE INDEX idx_pit_termo ON price_index_tasks (termo)',
        ],
      })
      app.save(tasksCol)
    }
  },
  (app) => {
    try {
      const tasksCol = app.findCollectionByNameOrId('price_index_tasks')
      if (tasksCol) app.delete(tasksCol)
    } catch (_) {}
    try {
      const samplesCol = app.findCollectionByNameOrId('price_samples_index')
      if (samplesCol) app.delete(samplesCol)
    } catch (_) {}
  },
)
