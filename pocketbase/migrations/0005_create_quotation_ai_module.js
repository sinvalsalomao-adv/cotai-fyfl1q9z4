migrate(
  (app) => {
    const orgsCol = app.findCollectionByNameOrId('organizacoes')
    const usersCol = app.findCollectionByNameOrId('_pb_users_auth_')
    const demandasCol = app.findCollectionByNameOrId('demandas')

    // 1. quotation_quotations (Cotações com múltiplos itens)
    let quotationsCol
    try {
      quotationsCol = app.findCollectionByNameOrId('quotations')
    } catch (_) {
      quotationsCol = new Collection({
        name: 'quotations',
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
          { name: 'numero', type: 'text', required: true },
          { name: 'titulo', type: 'text', required: true },
          {
            name: 'demanda_id',
            type: 'relation',
            collectionId: demandasCol.id,
            maxSelect: 1,
          },
          {
            name: 'status',
            type: 'select',
            required: true,
            values: [
              'rascunho',
              'em_processamento',
              'revisao_necessaria',
              'concluida',
              'erro',
              'cancelada',
            ],
            maxSelect: 1,
          },
          {
            name: 'responsavel_id',
            type: 'relation',
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          { name: 'versao_atual', type: 'number' },
          { name: 'total_itens', type: 'number' },
          { name: 'itens_concluidos', type: 'number' },
          { name: 'itens_revisao', type: 'number' },
          { name: 'itens_sem_resultados', type: 'number' },
          { name: 'valor_total_estimado', type: 'number' },
          { name: 'configuracao_execucao', type: 'json' },
          { name: 'metrica_estagios', type: 'json' }, // { encontrados, compativeis, normalizados, validos, selecionados }
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_quotations_tenant ON quotations (tenant_id)',
          'CREATE UNIQUE INDEX idx_quotations_num ON quotations (tenant_id, numero)',
        ],
      })
      app.save(quotationsCol)
    }

    // 2. quotation_items (Itens da cotação)
    let quotationItemsCol
    try {
      quotationItemsCol = app.findCollectionByNameOrId('quotation_items')
    } catch (_) {
      quotationItemsCol = new Collection({
        name: 'quotation_items',
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
          {
            name: 'quotation_id',
            type: 'relation',
            required: true,
            collectionId: quotationsCol.id,
            maxSelect: 1,
          },
          { name: 'numero_item', type: 'number', required: true },
          { name: 'codigo_interno', type: 'text' },
          { name: 'descricao_original', type: 'text', required: true },
          { name: 'descricao_normalizada', type: 'text' },
          { name: 'quantidade', type: 'number', required: true },
          { name: 'unidade', type: 'text', required: true },
          { name: 'unidade_normalizada', type: 'text' },
          // Atributos identificados pela IA
          { name: 'principio_ativo', type: 'text' },
          { name: 'concentracao', type: 'text' },
          { name: 'forma_farmaceutica', type: 'text' },
          { name: 'apresentacao', type: 'text' },
          { name: 'codigo_catalogo', type: 'text' }, // CATMAT / CATSER
          { name: 'tipo_catalogo', type: 'text' }, // CATMAT, CATSER, BPS
          { name: 'confidence_score', type: 'number' },
          { name: 'correspondencias_alternativas', type: 'json' },
          // Status do ciclo assíncrono
          {
            name: 'status',
            type: 'select',
            required: true,
            values: [
              'pendente',
              'pesquisando',
              'processando',
              'resultados_encontrados',
              'normalizando',
              'analisando',
              'revisao_necessaria',
              'concluido',
              'sem_resultados',
              'erro',
            ],
            maxSelect: 1,
          },
          { name: 'mensagem_status', type: 'text' },
          // Contadores por estágio
          { name: 'qtd_encontrados', type: 'number' },
          { name: 'qtd_compativeis', type: 'number' },
          { name: 'qtd_normalizados', type: 'number' },
          { name: 'qtd_validos', type: 'number' },
          { name: 'qtd_selecionados', type: 'number' },
          { name: 'qtd_outliers', type: 'number' },
          // Métricas estatísticas calculadas
          { name: 'preco_minimo', type: 'number' },
          { name: 'preco_media', type: 'number' },
          { name: 'preco_mediana', type: 'number' },
          { name: 'preco_media_ponderada', type: 'number' },
          { name: 'preco_referencia', type: 'number' },
          { name: 'valor_total_item', type: 'number' },
          { name: 'metodo_sugerido', type: 'text' },
          { name: 'motivo_sugestao_metodo', type: 'text' },
          { name: 'metodo_adotado', type: 'text' },
          { name: 'analise_inteligente', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_qitems_quotation ON quotation_items (quotation_id, numero_item)',
          'CREATE INDEX idx_qitems_status ON quotation_items (status)',
        ],
      })
      app.save(quotationItemsCol)
    }

    // 3. quotation_jobs (Fila e controle assíncrono de jobs)
    let quotationJobsCol
    try {
      quotationJobsCol = app.findCollectionByNameOrId('quotation_jobs')
    } catch (_) {
      quotationJobsCol = new Collection({
        name: 'quotation_jobs',
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
          {
            name: 'quotation_id',
            type: 'relation',
            required: true,
            collectionId: quotationsCol.id,
            maxSelect: 1,
          },
          {
            name: 'tipo_job',
            type: 'select',
            required: true,
            values: [
              'cotar_todos_itens',
              'cotar_item_individual',
              'atualizar_fontes',
              'recalcular_estatisticas',
            ],
            maxSelect: 1,
          },
          {
            name: 'status',
            type: 'select',
            required: true,
            values: ['enfileirado', 'executando', 'concluido', 'falha', 'cancelado'],
            maxSelect: 1,
          },
          { name: 'progresso_percentual', type: 'number' },
          { name: 'itens_processados', type: 'number' },
          { name: 'itens_total', type: 'number' },
          { name: 'resultados_total', type: 'number' },
          { name: 'erros_count', type: 'number' },
          { name: 'etapa_atual', type: 'text' },
          { name: 'item_atual_id', type: 'text' },
          { name: 'fontes_consultadas', type: 'json' },
          { name: 'fontes_com_erro', type: 'json' },
          { name: 'payload_config', type: 'json' },
          { name: 'mensagem_log', type: 'text' },
          { name: 'iniciado_em', type: 'date' },
          { name: 'finalizado_em', type: 'date' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_qjobs_quotation ON quotation_jobs (quotation_id, status)',
          'CREATE INDEX idx_qjobs_status_created ON quotation_jobs (status, created DESC)',
        ],
      })
      app.save(quotationJobsCol)
    }

    // 4. quotation_price_records (Registros de preços dos itens com estágios bem definidos)
    let quotationPriceRecordsCol
    try {
      quotationPriceRecordsCol = app.findCollectionByNameOrId('quotation_price_records')
    } catch (_) {
      quotationPriceRecordsCol = new Collection({
        name: 'quotation_price_records',
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
          {
            name: 'quotation_id',
            type: 'relation',
            required: true,
            collectionId: quotationsCol.id,
            maxSelect: 1,
          },
          {
            name: 'quotation_item_id',
            type: 'relation',
            required: true,
            collectionId: quotationItemsCol.id,
            maxSelect: 1,
          },
          { name: 'fonte', type: 'text', required: true },
          { name: 'source_identifier', type: 'text' },
          { name: 'source_record_id', type: 'text' },
          { name: 'source_url', type: 'text' },
          { name: 'document_url', type: 'text' },
          { name: 'document_hash', type: 'text' },
          { name: 'source_capture_date', type: 'date' },
          { name: 'original_description', type: 'text', required: true },
          { name: 'normalized_description', type: 'text' },
          { name: 'catalog_code', type: 'text' },
          { name: 'unit', type: 'text', required: true },
          { name: 'normalized_unit', type: 'text' },
          { name: 'quantity', type: 'number', required: true },
          { name: 'unit_price', type: 'number', required: true },
          { name: 'normalized_unit_price', type: 'number', required: true },
          { name: 'total_price', type: 'number' },
          { name: 'supplier', type: 'text' },
          { name: 'supplier_cnpj', type: 'text' },
          { name: 'orgao_comprador', type: 'text' },
          { name: 'municipio', type: 'text' },
          { name: 'uf', type: 'text' },
          { name: 'modalidade', type: 'text' },
          { name: 'numero_processo', type: 'text' },
          { name: 'purchase_date', type: 'date' },
          { name: 'publication_date', type: 'date' },
          { name: 'natureza_preco', type: 'text' }, // contratado, homologado, regulatorio_tabela...
          { name: 'is_regulatorio', type: 'bool' }, // CMED
          // Estágio do preço no fluxo determinístico
          {
            name: 'estagio',
            type: 'select',
            required: true,
            values: ['encontrado', 'compativel', 'normalizado', 'valido', 'selecionado'],
            maxSelect: 1,
          },
          { name: 'confidence_score', type: 'number' },
          { name: 'similarity_score', type: 'number' },
          { name: 'faixa_similaridade', type: 'text' }, // ALTA, BOA, REVISAO, BAIXA
          { name: 'possivel_duplicata', type: 'bool' },
          { name: 'canonical_price_id', type: 'text' },
          { name: 'is_outlier', type: 'bool' },
          { name: 'outlier_classificacao', type: 'text' },
          { name: 'decisao_humana', type: 'text' }, // manter, descartar, pendente
          { name: 'motivo_decisao', type: 'text' },
          { name: 'data_version', type: 'number' },
          { name: 'original_payload', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_qprices_item ON quotation_price_records (quotation_item_id, estagio)',
          'CREATE INDEX idx_qprices_quotation ON quotation_price_records (quotation_id)',
          'CREATE INDEX idx_qprices_canonical ON quotation_price_records (canonical_price_id)',
        ],
      })
      app.save(quotationPriceRecordsCol)
    }

    // 5. quotation_outliers (Tratamento de outliers)
    let quotationOutliersCol
    try {
      quotationOutliersCol = app.findCollectionByNameOrId('quotation_outliers')
    } catch (_) {
      quotationOutliersCol = new Collection({
        name: 'quotation_outliers',
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
          {
            name: 'quotation_id',
            type: 'relation',
            required: true,
            collectionId: quotationsCol.id,
            maxSelect: 1,
          },
          {
            name: 'quotation_item_id',
            type: 'relation',
            required: true,
            collectionId: quotationItemsCol.id,
            maxSelect: 1,
          },
          {
            name: 'price_record_id',
            type: 'relation',
            required: true,
            collectionId: quotationPriceRecordsCol.id,
            maxSelect: 1,
          },
          { name: 'valor', type: 'number', required: true },
          { name: 'mediana_referencia', type: 'number', required: true },
          { name: 'desvio_percentual', type: 'number', required: true },
          { name: 'metodo_deteccao', type: 'text', required: true },
          { name: 'motivo_identificacao', type: 'text' },
          {
            name: 'decisao_humana',
            type: 'select',
            required: true,
            values: ['pendente', 'descartado', 'mantido'],
            maxSelect: 1,
          },
          { name: 'justificativa', type: 'text' },
          {
            name: 'decidido_por',
            type: 'relation',
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          { name: 'decidido_em', type: 'date' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_qoutliers_item ON quotation_outliers (quotation_item_id, decisao_humana)',
        ],
      })
      app.save(quotationOutliersCol)
    }

    // 6. quotation_justifications (Justificativas formais do processo)
    let quotationJustificationsCol
    try {
      quotationJustificationsCol = app.findCollectionByNameOrId('quotation_justifications')
    } catch (_) {
      quotationJustificationsCol = new Collection({
        name: 'quotation_justifications',
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
          {
            name: 'quotation_id',
            type: 'relation',
            required: true,
            collectionId: quotationsCol.id,
            maxSelect: 1,
          },
          {
            name: 'quotation_item_id',
            type: 'relation',
            collectionId: quotationItemsCol.id,
            maxSelect: 1,
          },
          {
            name: 'tipo',
            type: 'select',
            required: true,
            values: [
              'quantidade_insuficiente',
              'exclusao_preco',
              'manutencao_outlier',
              'alteracao_metodo',
              'utilizacao_fonte_especifica',
              'ausencia_fornecedor',
              'outro',
            ],
            maxSelect: 1,
          },
          { name: 'texto_justificativa', type: 'text', required: true },
          {
            name: 'usuario_id',
            type: 'relation',
            required: true,
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          { name: 'dados_contexto', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE INDEX idx_qjust_quotation ON quotation_justifications (quotation_id)'],
      })
      app.save(quotationJustificationsCol)
    }

    // 7. quotation_versions (Versionamento de cotações IA — Versão 1, 2, 3...)
    let quotationVersionsCol
    try {
      quotationVersionsCol = app.findCollectionByNameOrId('quotation_versions')
    } catch (_) {
      quotationVersionsCol = new Collection({
        name: 'quotation_versions',
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
          {
            name: 'quotation_id',
            type: 'relation',
            required: true,
            collectionId: quotationsCol.id,
            maxSelect: 1,
          },
          { name: 'numero_versao', type: 'number', required: true },
          { name: 'titulo_versao', type: 'text', required: true },
          { name: 'motivo_versao', type: 'text' },
          { name: 'snapshot_dados', type: 'json', required: true },
          { name: 'total_estimado', type: 'number' },
          {
            name: 'criado_por',
            type: 'relation',
            collectionId: usersCol.id,
            maxSelect: 1,
          },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_qvers_num ON quotation_versions (quotation_id, numero_versao)',
        ],
      })
      app.save(quotationVersionsCol)
    }

    // 8. quotation_ai_logs (Registro das inferências e chamadas de IA)
    let quotationAiLogsCol
    try {
      quotationAiLogsCol = app.findCollectionByNameOrId('quotation_ai_logs')
    } catch (_) {
      quotationAiLogsCol = new Collection({
        name: 'quotation_ai_logs',
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
          {
            name: 'quotation_id',
            type: 'relation',
            collectionId: quotationsCol.id,
            maxSelect: 1,
          },
          {
            name: 'quotation_item_id',
            type: 'relation',
            collectionId: quotationItemsCol.id,
            maxSelect: 1,
          },
          { name: 'item_descricao', type: 'text' },
          { name: 'modelo', type: 'text', required: true },
          { name: 'versao_modelo', type: 'text' },
          { name: 'resultado_estruturado', type: 'json' },
          { name: 'confidence_score', type: 'number' },
          { name: 'campos_identificados', type: 'json' },
          { name: 'codigos_encontrados', type: 'json' },
          { name: 'fontes_consultadas', type: 'json' },
          { name: 'tempo_resposta_ms', type: 'number' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE INDEX idx_qailogs_quotation ON quotation_ai_logs (quotation_id, created DESC)',
        ],
      })
      app.save(quotationAiLogsCol)
    }
  },
  (app) => {
    // Reverter coleções se necessário
    const cols = [
      'quotation_ai_logs',
      'quotation_versions',
      'quotation_justifications',
      'quotation_outliers',
      'quotation_price_records',
      'quotation_jobs',
      'quotation_items',
      'quotations',
    ]
    for (const c of cols) {
      try {
        const col = app.findCollectionByNameOrId(c)
        app.delete(col)
      } catch (_) {}
    }
  },
)
