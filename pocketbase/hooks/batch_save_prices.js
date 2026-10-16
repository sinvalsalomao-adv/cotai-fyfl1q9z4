// Endpoint batch-save para salvar amostras de preços em lote em uma única transação
// Previne tempestade de requisições individuais que estouram rate limit (429 Too Many Requests)
// Suporta gravação atômica em budget_price_results e opcionalmente em referencias (pesquisas)

routerAdd('POST', '/backend/v1/price-results/batch-save', (e) => {
  try {
    var info = e.requestInfo()
    var body = info.body || {}

    // Suporte a body raw se necessário
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      try {
        var rawStr = toString(e.request.body)
        if (rawStr) {
          body = JSON.parse(rawStr)
        }
      } catch (_) {}
    }

    var budgetItemId = body.budget_item_id || ''
    var pesquisaId = body.pesquisa_id || ''
    var amostras = Array.isArray(body.amostras) ? body.amostras : []
    var lastSearchTerm = body.last_search_term || ''

    if (!budgetItemId && !pesquisaId) {
      return e.json(400, {
        error: 'INVALID_PARAMETER',
        message: 'É obrigatório informar budget_item_id ou pesquisa_id.',
      })
    }

    if (amostras.length === 0) {
      return e.json(200, {
        sucesso: true,
        gravadas: 0,
        recebidas: 0,
        divergencia: false,
        message: 'Nenhuma amostra enviada para gravação.',
      })
    }

    console.log(
      '[BATCH-SAVE] Iniciando gravação em lote de',
      amostras.length,
      'amostras. Item:',
      budgetItemId || pesquisaId,
    )

    var gravadasCount = 0
    var erros = []

    // Executa em transação atômica única
    $app.runInTransaction((txApp) => {
      // 1. Se fornecido budgetItemId, salvar em budget_price_results
      if (budgetItemId) {
        var colResults = txApp.findCollectionByNameOrId('budget_price_results')

        // Atualizar last_search_term no budget_items se fornecido
        if (lastSearchTerm) {
          try {
            var itemRec = txApp.findRecordById('budget_items', budgetItemId)
            if (itemRec) {
              itemRec.set('last_search_term', lastSearchTerm)
              txApp.save(itemRec)
            }
          } catch (_) {
            // Se falhar atualização do termo, não aborta a transação
          }
        }

        for (var i = 0; i < amostras.length; i++) {
          var p = amostras[i]
          try {
            var rec = new Record(colResults)
            rec.set('budget_item_id', budgetItemId)
            rec.set('source', p.source || 'PNCP')
            rec.set(
              'source_record_id',
              p.source_record_id || p.source_identifier || 'NÃO INFORMADO',
            )
            rec.set('source_url', p.source_url || p.url || '')
            rec.set('source_date', p.source_date || p.data_contratacao || '')
            rec.set(
              'government_entity',
              p.government_entity || p.orgao_comprador || 'NÃO INFORMADO',
            )
            rec.set('supplier', p.supplier || p.fornecedor || 'NÃO INFORMADO')
            rec.set(
              'supplier_document',
              p.supplier_document || p.cnpj_fornecedor || 'NÃO INFORMADO',
            )
            rec.set('description_original', p.description_original || p.item_externo || '')
            rec.set('description_normalized', p.description_normalized || p.item_externo || '')
            rec.set('unit', p.unit || p.unidade || 'UN')
            rec.set('quantity', Number(p.quantity) || Number(p.quantidade) || 1)

            // Preço unitário estrito: nunca inventar
            var pUnit =
              p.unit_price !== undefined && p.unit_price !== null
                ? Number(p.unit_price)
                : p.valor_normalizado !== undefined && p.valor_normalizado !== null
                  ? Number(p.valor_normalizado)
                  : p.valor_original !== undefined && p.valor_original !== null
                    ? Number(p.valor_original)
                    : null
            rec.set('unit_price', pUnit)

            rec.set('similarity_score', Number(p.similarity_score) || 95)
            rec.set('status', p.status || 'encontrado')
            rec.set('raw_data', p.raw_data || p.detalhes_tecnicos || {})

            txApp.save(rec)
            gravadasCount++
          } catch (errItem) {
            erros.push(errItem.message || 'Erro ao gravar registro individual')
          }
        }
      }

      // 2. Se fornecido pesquisaId (módulo de pesquisas/referencias)
      if (pesquisaId) {
        var colReferencias = txApp.findCollectionByNameOrId('referencias')

        for (var j = 0; j < amostras.length; j++) {
          var reg = amostras[j]
          try {
            var recRef = new Record(colReferencias)
            recRef.set('pesquisa_id', pesquisaId)
            recRef.set('fonte', reg.fonte || 'pncp')
            recRef.set('id_externo', reg.id_externo || '')
            recRef.set('item_externo', reg.item_externo || '')
            recRef.set('natureza_preco', reg.natureza_preco || 'contratado')
            recRef.set('valor_original', Number(reg.valor_original) || 0)
            recRef.set(
              'valor_normalizado',
              Number(reg.valor_normalizado) || Number(reg.valor_original) || 0,
            )
            recRef.set('unidade', reg.unidade || 'UN')
            recRef.set('quantidade', Number(reg.quantidade) || 1)
            recRef.set('data_contratacao', reg.data_contratacao || '')
            recRef.set('fornecedor', reg.fornecedor || 'NÃO INFORMADO')
            recRef.set('cnpj_fornecedor', reg.cnpj_fornecedor || 'NÃO INFORMADO')
            recRef.set('orgao_comprador', reg.orgao_comprador || 'NÃO INFORMADO')
            recRef.set('municipio_uf', reg.municipio_uf || '')
            recRef.set('modalidade_licitacao', reg.modalidade_licitacao || 'Pregão Eletrônico')
            recRef.set('processo_origem', reg.processo_origem || '')
            recRef.set('marca_modelo', reg.marca_modelo || 'NÃO INFORMADO')
            recRef.set('codigo_catalogo', reg.codigo_catalogo || 'CATMAT')
            recRef.set('url', reg.url || '')
            recRef.set('hash', reg.hash || '')
            recRef.set('status_revisao', reg.status_revisao || 'pendente')
            recRef.set('source_identifier', reg.source_identifier || reg.id_externo || '')
            recRef.set('source_capture_date', reg.source_capture_date || new Date().toISOString())
            recRef.set('confidence_score', Number(reg.confidence_score) || 95)
            recRef.set('similarity_score', Number(reg.similarity_score) || 95)
            recRef.set('possivel_duplicata', Boolean(reg.possivel_duplicata))
            recRef.set('detalhes_tecnicos', reg.detalhes_tecnicos || {})

            txApp.save(recRef)
            gravadasCount++
          } catch (errRef) {
            erros.push(errRef.message || 'Erro ao gravar referência individual')
          }
        }
      }
    })

    console.log(
      '[BATCH-SAVE] Concluído:',
      gravadasCount,
      'de',
      amostras.length,
      'gravadas com sucesso.',
    )

    var divergencia = gravadasCount !== amostras.length

    return e.json(200, {
      sucesso: true,
      gravadas: gravadasCount,
      recebidas: amostras.length,
      divergencia: divergencia,
      erros: erros.length > 0 ? erros : undefined,
    })
  } catch (globalErr) {
    console.log('[BATCH-SAVE] Erro crítico na transação:', globalErr.message)
    return e.json(500, {
      error: 'BATCH_SAVE_FAILED',
      message: 'Falha ao processar gravação em lote de amostras.',
      detail: globalErr.message || 'Erro desconhecido na transação',
    })
  }
})
