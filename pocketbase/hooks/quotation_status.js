// Endpoint GET: /backend/v1/quotation/job-status?job_id=xxx
// Retorna o status detalhado do job de cotação e dos itens para polling controlado
// Nota Skip Cloud: código auto-contido dentro da callback; sem top-level functions

routerAdd(
  'GET',
  '/backend/v1/quotation/job-status',
  (e) => {
    try {
      const jobId = e.requestInfo().query.job_id
      if (!jobId) {
        return e.json(400, { error: 'job_id é obrigatório.' })
      }

      const job = $app.findRecordById('quotation_jobs', jobId)
      const quotationId = job.getString('quotation_id')
      const quotation = $app.findRecordById('quotations', quotationId)

      const items = $app.findRecordsByFilter(
        'quotation_items',
        "quotation_id = '" + quotationId + "'",
        'numero_item',
        100,
        0,
      )

      const itemsResumo = items.map((it) => {
        return {
          id: it.id,
          numero_item: it.getInt('numero_item'),
          descricao: it.getString('descricao_original'),
          status: it.getString('status'),
          mensagem_status: it.getString('mensagem_status'),
          confidence_score: it.getInt('confidence_score'),
          qtd_encontrados: it.getInt('qtd_encontrados'),
          qtd_validos: it.getInt('qtd_validos'),
          qtd_selecionados: it.getInt('qtd_selecionados'),
          preco_referencia: it.getFloat('preco_referencia'),
        }
      })

      return e.json(200, {
        job_id: job.id,
        quotation_id: quotationId,
        status: job.getString('status'),
        progresso_percentual: job.getInt('progresso_percentual'),
        itens_processados: job.getInt('itens_processados'),
        itens_total: job.getInt('itens_total'),
        resultados_total: job.getInt('resultados_total'),
        erros_count: job.getInt('erros_count'),
        etapa_atual: job.getString('etapa_atual'),
        fontes_consultadas: job.get('fontes_consultadas'),
        fontes_com_erro: job.get('fontes_com_erro'),
        itens: itemsResumo,
        quotation_status: quotation.getString('status'),
      })
    } catch (err) {
      return e.json(404, { error: 'Job não encontrado ou erro ao carregar: ' + err.message })
    }
  },
  $apis.requireAuth(),
)
