// Migration 0041: Adiciona campos de qualidade, auditoria, hash de payload e coleção de watermarks
// Preserva 100% dos dados existentes (migração aditiva).
// Atende a especificação:
// - hash do payload
// - modelo/marca separados ou enriquecidos
// - processo, modalidade e situação
// - situação de qualidade (aceita | revisao | rejeitada) + motivos de exclusão/rejeição
// - data de coleta
// - coleção 'price_watermarks' para sincronização incremental contínua que sobrevive a restarts

migrate(
  (app) => {
    // 1. Atualizar price_samples_index com campos faltantes de qualidade e auditoria
    const psi = app.findCollectionByNameOrId('price_samples_index')

    if (!psi.fields.getByName('payload_hash')) {
      psi.fields.add(new TextField({ name: 'payload_hash' }))
    }
    if (!psi.fields.getByName('modelo')) {
      psi.fields.add(new TextField({ name: 'modelo' }))
    }
    if (!psi.fields.getByName('situacao_contratacao')) {
      psi.fields.add(new TextField({ name: 'situacao_contratacao' }))
    }
    if (!psi.fields.getByName('data_coleta')) {
      psi.fields.add(new TextField({ name: 'data_coleta' }))
    }
    if (!psi.fields.getByName('qualidade_situacao')) {
      psi.fields.add(
        new SelectField({
          name: 'qualidade_situacao',
          values: ['aceita', 'revisao', 'rejeitada'],
          maxSelect: 1,
        }),
      )
    }
    if (!psi.fields.getByName('motivos_rejeicao')) {
      psi.fields.add(new JSONField({ name: 'motivos_rejeicao' }))
    }
    if (!psi.fields.getByName('matching_score')) {
      psi.fields.add(new NumberField({ name: 'matching_score' }))
    }
    if (!psi.fields.getByName('matching_tipo')) {
      psi.fields.add(new TextField({ name: 'matching_tipo' }))
    }

    psi.addIndex('idx_psi_qualidade', false, 'qualidade_situacao', '')
    psi.addIndex('idx_psi_payload_hash', false, 'payload_hash', '')
    app.save(psi)

    // 2. Preencher campos padrão retroativamente para dados existentes
    app
      .db()
      .newQuery(`
      UPDATE price_samples_index 
      SET qualidade_situacao = 'aceita',
          data_coleta = COALESCE(indexed_at, created)
      WHERE qualidade_situacao IS NULL OR qualidade_situacao = ''
    `)
      .execute()

    // 3. Criar coleção 'price_watermarks' para sincronização incremental contínua
    try {
      app.findCollectionByNameOrId('price_watermarks')
    } catch (_) {
      const watermarksCol = new Collection({
        name: 'price_watermarks',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          { name: 'fonte', type: 'text', required: true },
          { name: 'cursor_tipo', type: 'text', required: true }, // ex: 'data_publicacao', 'data_atualizacao'
          { name: 'last_watermark_date', type: 'text', required: true }, // ISO date ou string de controle
          { name: 'last_cursor_page', type: 'number' },
          { name: 'status', type: 'text' }, // 'idle', 'syncing', 'error'
          { name: 'amostras_coletadas_total', type: 'number' },
          { name: 'ultimo_erro', type: 'text' },
          { name: 'tentativas_consecutivas_falha', type: 'number' },
          { name: 'detalhes', type: 'json' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_pw_fonte_cursor ON price_watermarks (fonte, cursor_tipo)',
        ],
      })
      app.save(watermarksCol)

      // Seed inicial dos watermarks para PNCP e Compras.gov.br
      const wmRecPncp = new Record(watermarksCol)
      wmRecPncp.set('fonte', 'PNCP')
      wmRecPncp.set('cursor_tipo', 'data_publicacao')
      wmRecPncp.set(
        'last_watermark_date',
        new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      )
      wmRecPncp.set('last_cursor_page', 1)
      wmRecPncp.set('status', 'idle')
      wmRecPncp.set('amostras_coletadas_total', 0)
      wmRecPncp.set('tentativas_consecutivas_falha', 0)
      app.save(wmRecPncp)

      const wmRecCgov = new Record(watermarksCol)
      wmRecCgov.set('fonte', 'Compras.gov.br')
      wmRecCgov.set('cursor_tipo', 'data_publicacao')
      wmRecCgov.set(
        'last_watermark_date',
        new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      )
      wmRecCgov.set('last_cursor_page', 1)
      wmRecCgov.set('status', 'idle')
      wmRecCgov.set('amostras_coletadas_total', 0)
      wmRecCgov.set('tentativas_consecutivas_falha', 0)
      app.save(wmRecCgov)
    }
  },
  (app) => {
    try {
      const wm = app.findCollectionByNameOrId('price_watermarks')
      app.delete(wm)
    } catch (_) {}
  },
)
