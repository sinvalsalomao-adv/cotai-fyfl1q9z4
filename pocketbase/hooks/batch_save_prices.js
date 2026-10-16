// Endpoint batch-save para salvar amostras de preços em lote em uma única transação
// Previne tempestade de requisições individuais que estouram rate limit (429 Too Many Requests)
// Suporta gravação atômica em budget_price_results e opcionalmente em referencias (pesquisas)

routerAdd('POST', '/backend/v1/price-results/batch-save', (e) => {
  if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
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

    // Resolve ownership on the server, never from the active organization sent by the UI.
    var userOrg = e.auth.getString('organizacao_id')
    var budgetItem
    try {
      if (budgetItemId) {
        budgetItem = $app.findRecordById('budget_items', budgetItemId)
        var budget = $app.findRecordById('budgets', budgetItem.getString('budget_id'))
        if (budget.getString('created_by') !== e.auth.id &&
          (!userOrg || budget.getString('tenant_id') !== userOrg)) {
          return e.json(403, { sucesso: false, error: 'BUDGET_ACCESS_DENIED' })
        }
      }
      if (pesquisaId) {
        var research = $app.findRecordById('pesquisas', pesquisaId)
        var demandItem = $app.findRecordById('demanda_itens', research.getString('demanda_item_id'))
        var demand = $app.findRecordById('demandas', demandItem.getString('demanda_id'))
        if (research.getString('responsavel_id') !== e.auth.id &&
          (!userOrg || demand.getString('organizacao_id') !== userOrg)) {
          return e.json(403, { sucesso: false, error: 'RESEARCH_ACCESS_DENIED' })
        }
      }
    } catch (_) {
      return e.json(403, { sucesso: false, error: 'TARGET_ACCESS_DENIED' })
    }
    if (budgetItemId && amostras.length > 100) {
      return e.json(413, { sucesso: false, error: 'BATCH_TOO_LARGE' })
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
    var reutilizadasCount = 0
    var mapeamentos = []
    var erros = []

    // Compare complete price facts and evidence, not a rounded price/text-only key.
    // Keep the first captured evidence; a later read timestamp is not a price revision.
    function canonical(value, officialRecord, ignoreCapture) {
      if (value === null || typeof value !== 'object') return value
      if (Array.isArray(value)) return value.map(function (entry) { return canonical(entry, officialRecord, ignoreCapture) })
      var result = {}
      var keys = Object.keys(value).sort()
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k]
        if (ignoreCapture && !officialRecord && ['captured_at', 'data_coleta', 'source_capture_date', 'capture_date',
          'indexed_at', 'last_validated_at'].indexOf(key) >= 0) continue
        result[key] = canonical(value[key], officialRecord || key === 'registro_oficial', ignoreCapture)
      }
      return result
    }
    function rawObject(value) {
      if (typeof value === 'string') { try { return JSON.parse(value) } catch (_) {} }
      return value || {}
    }
    function hasOfficialProof(raw) {
      var proof = rawObject(raw).proveniencia_preco
      return proof && proof.status === 'verificada' && proof.registro_oficial && typeof proof.registro_oficial === 'object'
    }
    function participantValue(value, field, record) {
      var aliases = { government_entity: 'orgao_comprador', supplier: 'fornecedor', supplier_document: 'cnpj_fornecedor' }
      var entry = record ? value.get(field) : value[field] || value[aliases[field]]
      return String(entry || 'NÃO INFORMADO')
    }
    var identityFields = ['source', 'source_record_id', 'source_url', 'source_date', 'government_entity',
      'supplier', 'supplier_document', 'description_original', 'unit', 'quantity', 'unit_price', 'raw_data']
    function fingerprint(value, record) {
      var facts = {}
      var raw = rawObject(record ? value.get('raw_data') : value.raw_data)
      var official = hasOfficialProof(raw)
      for (var f = 0; f < identityFields.length; f++) {
        var field = identityFields[f]
        var entry = record ? value.get(field) : value[field]
        if (field === 'raw_data') {
          entry = canonical(raw, false, official)
        } else if (field === 'government_entity' || field === 'supplier' || field === 'supplier_document') {
          entry = participantValue(value, field, record)
        } else if (field === 'unit' && !entry) {
          entry = official ? 'NÃO INFORMADO' : 'UN'
        } else if (field === 'unit_price' || field === 'quantity') {
          entry = Number(entry || 0)
          if (field === 'quantity' && !official) entry = entry || 1
        } else if (field === 'source_date' && entry && isFinite(Date.parse(String(entry)))) {
          entry = new Date(String(entry)).toISOString()
        } else entry = entry == null ? '' : String(entry)
        facts[field] = entry
      }
      return JSON.stringify(facts)
    }
    var candidatesById = Object.create(null)
    var candidatesByFingerprint = Object.create(null)
    function hasExternalIdentity(value, record) {
      var external = record ? value.getString('source_record_id') : value.source_record_id
      var source = record ? value.getString('source') : value.source
      var url = record ? value.getString('source_url') : value.source_url
      return source && external && external !== 'NÃO INFORMADO' && url
    }
    function rememberCandidate(record) {
      var key = fingerprint(record, true)
      candidatesById[record.id] = { record: record, fingerprint: key }
      if (hasExternalIdentity(record, true) && !candidatesByFingerprint[key]) {
        candidatesByFingerprint[key] = record
      }
    }
    function preloadCandidates(txApp) {
      var clauses = [], params = { item: budgetItemId }
      var ids = Object.create(null), externalGroups = Object.create(null)
      for (var i = 0; i < amostras.length; i++) {
        var value = amostras[i]
        var clientId = String(value.client_id || value.id || '')
        if (/^[a-z0-9]{15}$/.test(clientId)) ids[clientId] = true
        if (hasExternalIdentity(value, false)) {
          if (!externalGroups[value.source]) externalGroups[value.source] = Object.create(null)
          externalGroups[value.source][value.source_record_id] = true
        }
      }
      var idKeys = Object.keys(ids)
      for (var n = 0; n < idKeys.length; n++) {
        var idParam = 'id' + n
        params[idParam] = idKeys[n]
        clauses.push('id = {:' + idParam + '}')
      }
      var sources = Object.keys(externalGroups), externalNumber = 0
      for (var s = 0; s < sources.length; s++) {
        var sourceParam = 'source' + s, externalClauses = []
        params[sourceParam] = sources[s]
        var externalKeys = Object.keys(externalGroups[sources[s]])
        for (var k = 0; k < externalKeys.length; k++) {
          var externalParam = 'external' + externalNumber++
          params[externalParam] = externalKeys[k]
          externalClauses.push('source_record_id = {:' + externalParam + '}')
        }
        clauses.push('(source = {:' + sourceParam + '} && (' + externalClauses.join(' || ') + '))')
      }
      if (!clauses.length) return
      var filter = 'budget_item_id = {:item} && (' + clauses.join(' || ') + ')'
      var afterCreated = '', afterId = ''
      for (;;) {
        var pageFilter = filter
        if (afterId) {
          params.afterCreated = afterCreated
          params.afterId = afterId
          pageFilter += ' && (created > {:afterCreated} || (created = {:afterCreated} && id > {:afterId}))'
        }
        var page = txApp.findRecordsByFilter('budget_price_results', pageFilter, '+created,+id', 500, 0, params)
        for (var p = 0; p < page.length; p++) rememberCandidate(page[p])
        if (page.length < 500) break
        var last = page[page.length - 1]
        var nextCreated = last.getString('created'), nextId = String(last.id)
        if (!nextId || (afterId && (nextCreated < afterCreated ||
          (nextCreated === afterCreated && nextId <= afterId)))) {
          throw new Error('Candidate cursor did not advance')
        }
        afterCreated = nextCreated
        afterId = nextId
      }
    }
    function existingSample(value) {
      var wanted = fingerprint(value, false)
      var clientId = String(value.client_id || value.id || '')
      var byId = candidatesById[clientId]
      if (byId && byId.fingerprint === wanted) return byId.record
      // Missing external identity is not permission to collapse unrelated legacy rows.
      return hasExternalIdentity(value, false) ? candidatesByFingerprint[wanted] || null : null
    }

    // Executa em transação atômica única
    $app.runInTransaction((txApp) => {
      // 1. Se fornecido budgetItemId, salvar em budget_price_results
      if (budgetItemId) {
        var colResults = txApp.findCollectionByNameOrId('budget_price_results')
        // One grouped, parameterized read in the common case, before any writes.
        // Keyset pagination keeps all historical revisions without offset drift.
        preloadCandidates(txApp)

        // Atualizar last_search_term no budget_items se fornecido
        if (lastSearchTerm) {
          try {
            var itemRec = txApp.findRecordById('budget_items', budgetItemId)
            if (itemRec && itemRec.getString('last_search_term') !== lastSearchTerm) {
              itemRec.set('last_search_term', lastSearchTerm)
              txApp.save(itemRec)
            }
          } catch (_) {
            // Se falhar atualização do termo, não aborta a transação
          }
        }

        for (var i = 0; i < amostras.length; i++) {
          var p = amostras[i]
          // Any budget-row failure aborts this whole bounded transaction. Never report
          // a partial selection as safe to calculate or retry a partially accepted batch.
          {
            var existing = existingSample(p)
            if (existing) {
              reutilizadasCount++
              mapeamentos.push({ client_id: String(p.client_id || p.id || ''), record_id: existing.id })
              continue
            }
            var rec = new Record(colResults)
            rec.set('budget_item_id', budgetItemId)
            rec.set('source', p.source || 'PNCP')
            rec.set(
              'source_record_id',
              p.source_record_id || p.source_identifier || 'NÃO INFORMADO',
            )
            rec.set('source_url', p.source_url || p.url || '')
            rec.set('source_date', p.source_date || p.data_contratacao || '')
            rec.set('government_entity', participantValue(p, 'government_entity', false))
            rec.set('supplier', participantValue(p, 'supplier', false))
            rec.set('supplier_document', participantValue(p, 'supplier_document', false))
            rec.set('description_original', p.description_original || p.item_externo || '')
            rec.set('description_normalized', p.description_normalized || p.item_externo || '')
            var official = hasOfficialProof(p.raw_data || p.detalhes_tecnicos)
            rec.set('unit', p.unit || p.unidade || (official ? 'NÃO INFORMADO' : 'UN'))
            // Unknown official facts remain unknown; a database validation failure
            // must not be "fixed" by inventing a quantity of one.
            rec.set('quantity', Number(p.quantity) || Number(p.quantidade) || (official ? 0 : 1))

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
            rememberCandidate(rec)
            gravadasCount++
            mapeamentos.push({ client_id: String(p.client_id || p.id || ''), record_id: rec.id })
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

    var divergencia = gravadasCount + reutilizadasCount !== amostras.length

    return e.json(200, {
      sucesso: true,
      gravadas: gravadasCount,
      reutilizadas: reutilizadasCount,
      mapeamentos: mapeamentos,
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
}, $apis.requireAuth(), $apis.bodyLimit(2 * 1024 * 1024))
