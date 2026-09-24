// Hook PocketBase para executar o pipeline de Cotação Inteligente com IA
// Endpoint POST: /backend/v1/quotation/cotar-ia
// Recebe: { quotation_id, config?: { fontes, modo, periodo_meses, quantidade_minima, metodo_padrao } }
// Nota Skip Cloud: código auto-contido dentro da callback; sem top-level functions

routerAdd(
  'POST',
  '/backend/v1/quotation/cotar-ia',
  (e) => {
    try {
      const auth = e.auth
      const body = e.requestInfo().body || {}
      const quotationId = body.quotation_id
      if (!quotationId) {
        return e.json(400, { error: 'quotation_id é obrigatório.' })
      }

      // 1. Carregar cotação e itens
      const quotation = $app.findRecordById('quotations', quotationId)
      const tenantId = quotation.getString('tenant_id')
      const items = $app.findRecordsByFilter(
        'quotation_items',
        "quotation_id = '" + quotationId + "'",
        'numero_item',
        100,
        0,
      )

      if (items.length === 0) {
        return e.json(400, { error: 'A cotação não possui itens para cotar.' })
      }

      // 2. Criar ou atualizar job assíncrono
      const jobsCol = $app.findCollectionByNameOrId('quotation_jobs')
      const job = new Record(jobsCol)
      job.set('tenant_id', tenantId)
      job.set('quotation_id', quotationId)
      job.set('tipo_job', 'cotar_todos_itens')
      job.set('status', 'executando')
      job.set('progresso_percentual', 10)
      job.set('itens_processados', 0)
      job.set('itens_total', items.length)
      job.set('resultados_total', 0)
      job.set('erros_count', 0)
      job.set('etapa_atual', 'Iniciando identificação semântica e normalização dos itens')
      job.set('payload_config', body.config || {})
      job.set('iniciado_em', new Date().toISOString())
      $app.save(job)

      // Atualiza status da cotação
      quotation.set('status', 'em_processamento')
      $app.save(quotation)

      // Registrar auditoria
      try {
        const auditCol = $app.findCollectionByNameOrId('auditoria')
        const audit = new Record(auditCol)
        audit.set('organizacao_id', tenantId)
        audit.set('agente_id', auth ? auth.id : '')
        audit.set('evento', 'cotacao_ia_iniciada')
        audit.set('objeto_tipo', 'quotations')
        audit.set('objeto_id', quotationId)
        audit.set(
          'antes_depois',
          JSON.stringify({
            job_id: job.id,
            itens_count: items.length,
            config: body.config,
          }),
        )
        audit.set('correlacao', 'job_' + job.id)
        $app.save(audit)
      } catch (_) {}

      // Retorna imediatamente com o job_id para o cliente fazer polling
      return e.json(200, {
        success: true,
        message: 'Cotação iniciada com sucesso. Acompanhe pelo job_id.',
        job_id: job.id,
        total_itens: items.length,
      })
    } catch (err) {
      return e.json(500, { error: 'Falha ao iniciar cotação: ' + err.message })
    }
  },
  $apis.requireAuth(),
)
