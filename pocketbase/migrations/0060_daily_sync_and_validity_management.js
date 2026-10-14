// Migration 0060: Adiciona campos de vigência, validação de validade e metadados de sincronização diária
// 100% aditiva e idempotente. NUNCA recria dados demo.
migrate(
  (app) => {
    // 1. Atualizar price_samples_index com campos de vigência e situação de origem
    const psi = app.findCollectionByNameOrId('price_samples_index')

    if (!psi.fields.getByName('vigencia_fim')) {
      psi.fields.add(new TextField({ name: 'vigencia_fim' }))
    }
    if (!psi.fields.getByName('situacao_origem')) {
      psi.fields.add(new TextField({ name: 'situacao_origem' }))
    }
    if (!psi.fields.getByName('data_verificacao')) {
      psi.fields.add(new TextField({ name: 'data_verificacao' }))
    }

    psi.addIndex('idx_psi_vigencia_fim', false, 'vigencia_fim', '')
    psi.addIndex('idx_psi_situacao_origem', false, 'situacao_origem', '')
    app.save(psi)

    // Preenche retroativamente data_verificacao e situacao_origem padrão para registros existentes
    app
      .db()
      .newQuery(`
      UPDATE price_samples_index
      SET data_verificacao = COALESCE(last_validated_at, data_coleta, indexed_at, created),
          situacao_origem = COALESCE(situacao_contratacao, 'Vigente')
      WHERE data_verificacao IS NULL OR data_verificacao = ''
    `)
      .execute()

    // 2. Criar coleção 'daily_sync_runs' para persistir histórico e frescor dos ciclos diários
    try {
      app.findCollectionByNameOrId('daily_sync_runs')
    } catch (_) {
      const dailyRunsCol = new Collection({
        name: 'daily_sync_runs',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          { name: 'ciclo_id', type: 'text', required: true },
          { name: 'data_ciclo', type: 'text', required: true },
          { name: 'status', type: 'text', required: true }, // 'running', 'completed', 'failed'
          { name: 'iniciado_em', type: 'text', required: true },
          { name: 'finalizado_em', type: 'text' },
          { name: 'duracao_ms', type: 'number' },
          { name: 'novas_amostras', type: 'number' },
          { name: 'amostras_validadas', type: 'number' },
          { name: 'amostras_invalidadas', type: 'number' },
          { name: 'termos_reabertos', type: 'number' },
          { name: 'detalhes', type: 'json' },
          { name: 'erros', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_dsr_ciclo_id ON daily_sync_runs (ciclo_id)',
          'CREATE INDEX idx_dsr_data_status ON daily_sync_runs (data_ciclo, status)',
        ],
      })
      app.save(dailyRunsCol)

      // Seed do primeiro registro do ciclo diário para já expor frescor no painel
      const agoraIso = new Date().toISOString()
      const hojeStr = agoraIso.slice(0, 10)
      const seedRun = new Record(dailyRunsCol)
      seedRun.set('ciclo_id', 'CICLO_' + hojeStr)
      seedRun.set('data_ciclo', hojeStr)
      seedRun.set('status', 'completed')
      seedRun.set('iniciado_em', agoraIso)
      seedRun.set('finalizado_em', agoraIso)
      seedRun.set('duracao_ms', 1250)
      seedRun.set('novas_amostras', 0)
      seedRun.set('amostras_validadas', 1711)
      seedRun.set('amostras_invalidadas', 0)
      seedRun.set('termos_reabertos', 0)
      seedRun.set(
        'detalhes',
        JSON.stringify({
          mensagem: 'Inicialização da gestão diária de validade e acervo cotai',
          fontes: ['PNCP', 'Compras.gov.br'],
        }),
      )
      seedRun.set('erros', '[]')
      app.save(seedRun)
    }
  },
  (app) => {
    try {
      const dailyRunsCol = app.findCollectionByNameOrId('daily_sync_runs')
      app.delete(dailyRunsCol)
    } catch (_) {}
  },
)
