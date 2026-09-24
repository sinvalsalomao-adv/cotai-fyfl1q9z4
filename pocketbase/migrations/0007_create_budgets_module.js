migrate(
  (app) => {
    const orgsCol = app.findCollectionByNameOrId('organizacoes')
    const usersCol = app.findCollectionByNameOrId('_pb_users_auth_')

    // 1. budgets
    let budgetsCol
    try {
      budgetsCol = app.findCollectionByNameOrId('budgets')
    } catch (_) {
      budgetsCol = new Collection({
        name: 'budgets',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'tenant_id',
            type: 'relation',
            required: true,
            collectionId: orgsCol.id,
            maxSelect: 1,
          },
          { name: 'internal_number', type: 'text', required: true },
          { name: 'name', type: 'text', required: true },
          { name: 'external_reference', type: 'text', required: true },
          { name: 'object', type: 'text', required: true },
          {
            name: 'organization_id',
            type: 'relation',
            required: true,
            collectionId: orgsCol.id,
            maxSelect: 1,
          },
          {
            name: 'created_by',
            type: 'relation',
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          {
            name: 'status',
            type: 'select',
            required: true,
            values: ['rascunho', 'em_pesquisa', 'em_revisao', 'concluido', 'cancelado'],
            maxSelect: 1,
          },
          { name: 'total_items', type: 'number' },
          { name: 'quoted_items', type: 'number' },
          { name: 'pending_items', type: 'number' },
          { name: 'estimated_total_value', type: 'number' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_budgets_tenant ON budgets (tenant_id)',
          'CREATE UNIQUE INDEX idx_budgets_internal_num ON budgets (tenant_id, internal_number)',
          'CREATE INDEX idx_budgets_status ON budgets (status)',
        ],
      })
      app.save(budgetsCol)
    }

    // 2. budget_methodologies
    let budgetMethodologiesCol
    try {
      budgetMethodologiesCol = app.findCollectionByNameOrId('budget_methodologies')
    } catch (_) {
      budgetMethodologiesCol = new Collection({
        name: 'budget_methodologies',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'budget_id',
            type: 'relation',
            required: true,
            collectionId: budgetsCol.id,
            maxSelect: 1,
          },
          {
            name: 'critical_judgment_method',
            type: 'select',
            required: true,
            values: ['nao_aplicar', 'desvio_padrao', 'percentual'],
            maxSelect: 1,
          },
          { name: 'percentage_upper', type: 'number' },
          { name: 'percentage_lower', type: 'number' },
          { name: 'standard_deviation_parameter', type: 'number' },
          {
            name: 'estimated_price_method',
            type: 'select',
            required: true,
            values: ['media', 'mediana', 'menor', 'media_ponderada', 'automatico_cv'],
            maxSelect: 1,
          },
          { name: 'cv_threshold', type: 'number' },
          { name: 'decimal_places', type: 'number', required: true },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE INDEX idx_bmethod_budget ON budget_methodologies (budget_id)'],
      })
      app.save(budgetMethodologiesCol)
    }

    // 3. budget_items
    let budgetItemsCol
    try {
      budgetItemsCol = app.findCollectionByNameOrId('budget_items')
    } catch (_) {
      budgetItemsCol = new Collection({
        name: 'budget_items',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'budget_id',
            type: 'relation',
            required: true,
            collectionId: budgetsCol.id,
            maxSelect: 1,
          },
          { name: 'sequence', type: 'number', required: true },
          { name: 'description', type: 'text', required: true },
          { name: 'unit', type: 'text', required: true },
          { name: 'quantity', type: 'number', required: true },
          { name: 'brand', type: 'text' },
          {
            name: 'type',
            type: 'select',
            required: true,
            values: ['PRODUTO', 'SERVICO'],
            maxSelect: 1,
          },
          { name: 'unit_price', type: 'number' },
          { name: 'total_price', type: 'number' },
          { name: 'abc_class', type: 'text' },
          { name: 'quotation_count', type: 'number' },
          {
            name: 'status',
            type: 'select',
            required: true,
            values: ['pendente', 'cotado', 'revisao_necessaria', 'sem_cotacoes'],
            maxSelect: 1,
          },
          { name: 'alert_messages', type: 'json' },
          { name: 'last_search_term', type: 'text' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_bitems_budget_seq ON budget_items (budget_id, sequence)',
          'CREATE INDEX idx_bitems_status ON budget_items (status)',
        ],
      })
      app.save(budgetItemsCol)
    }

    // 4. budget_price_results
    let budgetPriceResultsCol
    try {
      budgetPriceResultsCol = app.findCollectionByNameOrId('budget_price_results')
    } catch (_) {
      budgetPriceResultsCol = new Collection({
        name: 'budget_price_results',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'budget_item_id',
            type: 'relation',
            required: true,
            collectionId: budgetItemsCol.id,
            maxSelect: 1,
          },
          { name: 'source', type: 'text', required: true }, // PNCP, Compras.gov.br, BPS, CMED, BEC-SP, etc.
          { name: 'source_record_id', type: 'text' },
          { name: 'source_url', type: 'text' },
          { name: 'source_date', type: 'date' },
          { name: 'government_entity', type: 'text' },
          { name: 'supplier', type: 'text' },
          { name: 'supplier_document', type: 'text' },
          { name: 'description_original', type: 'text', required: true },
          { name: 'description_normalized', type: 'text' },
          { name: 'unit', type: 'text', required: true },
          { name: 'quantity', type: 'number', required: true },
          { name: 'unit_price', type: 'number', required: true },
          { name: 'similarity_score', type: 'number' },
          {
            name: 'status',
            type: 'select',
            required: true,
            values: ['encontrado', 'selecionado', 'nao_selecionado', 'expurgado'],
            maxSelect: 1,
          },
          { name: 'raw_data', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_bpresults_item ON budget_price_results (budget_item_id, status)',
          'CREATE INDEX idx_bpresults_source ON budget_price_results (source)',
        ],
      })
      app.save(budgetPriceResultsCol)
    }

    // 5. budget_selected_prices
    let budgetSelectedPricesCol
    try {
      budgetSelectedPricesCol = app.findCollectionByNameOrId('budget_selected_prices')
    } catch (_) {
      budgetSelectedPricesCol = new Collection({
        name: 'budget_selected_prices',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'budget_item_id',
            type: 'relation',
            required: true,
            collectionId: budgetItemsCol.id,
            maxSelect: 1,
          },
          {
            name: 'price_result_id',
            type: 'relation',
            required: true,
            collectionId: budgetPriceResultsCol.id,
            maxSelect: 1,
          },
          {
            name: 'selected_by',
            type: 'relation',
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          { name: 'selected_at', type: 'date' },
          { name: 'justification', type: 'text' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_bsprices_item ON budget_selected_prices (budget_item_id)',
          'CREATE INDEX idx_bsprices_price ON budget_selected_prices (price_result_id)',
        ],
      })
      app.save(budgetSelectedPricesCol)
    }

    // 6. budget_expurgated_prices
    let budgetExpurgatedPricesCol
    try {
      budgetExpurgatedPricesCol = app.findCollectionByNameOrId('budget_expurgated_prices')
    } catch (_) {
      budgetExpurgatedPricesCol = new Collection({
        name: 'budget_expurgated_prices',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'budget_item_id',
            type: 'relation',
            required: true,
            collectionId: budgetItemsCol.id,
            maxSelect: 1,
          },
          {
            name: 'price_result_id',
            type: 'relation',
            required: true,
            collectionId: budgetPriceResultsCol.id,
            maxSelect: 1,
          },
          { name: 'method', type: 'text', required: true },
          { name: 'threshold', type: 'text' },
          { name: 'reason', type: 'text', required: true },
          { name: 'expurgated_at', type: 'date' },
          {
            name: 'expurgated_by',
            type: 'relation',
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE INDEX idx_bexpprices_item ON budget_expurgated_prices (budget_item_id)'],
      })
      app.save(budgetExpurgatedPricesCol)
    }

    // 7. budget_statistics
    let budgetStatisticsCol
    try {
      budgetStatisticsCol = app.findCollectionByNameOrId('budget_statistics')
    } catch (_) {
      budgetStatisticsCol = new Collection({
        name: 'budget_statistics',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'budget_item_id',
            type: 'relation',
            required: true,
            collectionId: budgetItemsCol.id,
            maxSelect: 1,
          },
          { name: 'sample_count_total', type: 'number' },
          { name: 'sample_count_valid', type: 'number' },
          { name: 'sample_count_expurgated', type: 'number' },
          { name: 'min_price', type: 'number' },
          { name: 'max_price', type: 'number' },
          { name: 'mean_price', type: 'number' },
          { name: 'median_price', type: 'number' },
          { name: 'weighted_mean_price', type: 'number' },
          { name: 'standard_deviation', type: 'number' },
          { name: 'coefficient_variation', type: 'number' },
          { name: 'method_applied', type: 'text' },
          { name: 'final_estimated_price', type: 'number' },
          { name: 'calculated_at', type: 'date' },
          { name: 'details_json', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE INDEX idx_bstats_item ON budget_statistics (budget_item_id)'],
      })
      app.save(budgetStatisticsCol)
    }

    // 8. budget_audit_logs
    let budgetAuditLogsCol
    try {
      budgetAuditLogsCol = app.findCollectionByNameOrId('budget_audit_logs')
    } catch (_) {
      budgetAuditLogsCol = new Collection({
        name: 'budget_audit_logs',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'budget_id',
            type: 'relation',
            required: true,
            collectionId: budgetsCol.id,
            maxSelect: 1,
          },
          {
            name: 'user_id',
            type: 'relation',
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          { name: 'action', type: 'text', required: true },
          { name: 'entity_type', type: 'text', required: true },
          { name: 'entity_id', type: 'text' },
          { name: 'description', type: 'text', required: true },
          { name: 'metadata', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE INDEX idx_baudit_budget ON budget_audit_logs (budget_id, created DESC)'],
      })
      app.save(budgetAuditLogsCol)
    }
  },
  (app) => {
    const list = [
      'budget_audit_logs',
      'budget_statistics',
      'budget_expurgated_prices',
      'budget_selected_prices',
      'budget_price_results',
      'budget_items',
      'budget_methodologies',
      'budgets',
    ]
    for (const name of list) {
      try {
        const c = app.findCollectionByNameOrId(name)
        app.delete(c)
      } catch (_) {}
    }
  },
)
