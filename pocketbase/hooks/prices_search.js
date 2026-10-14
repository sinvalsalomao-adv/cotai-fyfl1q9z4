// Endpoint de Busca Local Indexada em Alta Performance no PocketBase
// Suporta:
// 1. POST /backend/v1/prices/search (JSON body completo, paginação, filtros, agregações)
// 2. GET /backend/v1/precos/busca (GET com query params, estatísticas completas e frescor)
//
// NOTA DE ARQUITETURA JSVM POCKETBASE:
// Todas as funções auxiliares residem DENTRO do corpo de cada callback de rota para evitar erros de scoping no pool do JSVM.

// 1. Endpoint POST /backend/v1/prices/search
routerAdd('POST', '/backend/v1/prices/search', function (e) {
  function canonicalNormSearchText(s) {
    if (!s) return ''
    return String(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
      .replace(/[^A-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function extractSearchTokens(s) {
    var STOPWORDS = {
      DE: true,
      DA: true,
      DO: true,
      DAS: true,
      DOS: true,
      EM: true,
      PARA: true,
      COM: true,
      SEM: true,
      POR: true,
      AO: true,
      AOS: true,
      ITEM: true,
      LOTE: true,
      AQUISICAO: true,
      FORNECIMENTO: true,
      REGISTRO: true,
      PRECOS: true,
    }
    var norm = canonicalNormSearchText(s)
    if (!norm) return []
    return norm.split(/\s+/).filter(function (t) {
      return t.length >= 2 && !STOPWORDS[t]
    })
  }

  function stemTokenSearch(t) {
    if (!t || t.length <= 3) return t
    if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
    if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
    return t
  }

  function calcularEstatisticasAmostras(valores) {
    if (!valores || valores.length === 0) {
      return {
        n: 0,
        media: 0,
        mediana: 0,
        q1: 0,
        q3: 0,
        minimo: 0,
        maximo: 0,
        desvio_padrao: 0,
        iqr: 0,
        limite_inferior_iqr: 0,
        limite_superior_iqr: 0,
        regra_outlier: 'IQR_1_5_VERSION_1_0',
      }
    }

    var sorted = [...valores].sort(function (a, b) {
      return a - b
    })
    var n = sorted.length
    var soma = 0
    for (var i = 0; i < n; i++) soma += sorted[i]
    var media = soma / n

    var mediana = 0
    if (n % 2 === 1) {
      mediana = sorted[Math.floor(n / 2)]
    } else {
      mediana = (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    }

    function getPercentil(p) {
      var idx = (n - 1) * p
      var b = Math.floor(idx)
      var r = idx - b
      if (sorted[b + 1] !== undefined) {
        return sorted[b] + r * (sorted[b + 1] - sorted[b])
      }
      return sorted[b]
    }

    var q1 = getPercentil(0.25)
    var q3 = getPercentil(0.75)
    var iqr = q3 - q1
    var limiteInferiorIqr = Math.max(0, q1 - 1.5 * iqr)
    var limiteSuperiorIqr = q3 + 1.5 * iqr

    var somaVariancia = 0
    for (var j = 0; j < n; j++) {
      somaVariancia += Math.pow(sorted[j] - media, 2)
    }
    var desvioPadrao = n > 1 ? Math.sqrt(somaVariancia / (n - 1)) : 0

    return {
      n: n,
      media: Number(media.toFixed(4)),
      mediana: Number(mediana.toFixed(4)),
      q1: Number(q1.toFixed(4)),
      q3: Number(q3.toFixed(4)),
      minimo: Number(sorted[0].toFixed(4)),
      maximo: Number(sorted[n - 1].toFixed(4)),
      desvio_padrao: Number(desvioPadrao.toFixed(4)),
      iqr: Number(iqr.toFixed(4)),
      limite_inferior_iqr: Number(limiteInferiorIqr.toFixed(4)),
      limite_superior_iqr: Number(limiteSuperiorIqr.toFixed(4)),
      regra_outlier: 'IQR_1_5_VERSION_1_0',
    }
  }

  try {
    var t0 = new Date().getTime()
    var params = {}
    try {
      params = e.requestInfo().body || {}
    } catch (_) {}

    var termo = (params.termo || params.q || '').trim()
    var page = Math.max(1, parseInt(params.page || 1, 10))
    var limit = Math.min(200, Math.max(1, parseInt(params.limit || 50, 10)))
    var offset = (page - 1) * limit

    var sortParam = (params.sort || 'valor_unitario:asc').trim()
    var orderBySql = 'valor_unitario ASC'
    if (sortParam === 'valor_unitario:desc') orderBySql = 'valor_unitario DESC'
    else if (sortParam === 'data_referencia:desc')
      orderBySql = 'data_referencia DESC, valor_unitario ASC'
    else if (sortParam === 'data_referencia:asc')
      orderBySql = 'data_referencia ASC, valor_unitario ASC'

    var whereClauses = ['valor_unitario > 0']
    var queryParams = {}

    if (termo) {
      if (/^\d{4,8}$/.test(termo.trim())) {
        whereClauses.push(
          '(codigo_item = {:catmatCode} OR descricao_normalizada LIKE {:catmatLike})',
        )
        queryParams['catmatCode'] = termo.trim()
        queryParams['catmatLike'] = '%' + termo.trim() + '%'
      } else {
        var tokens = extractSearchTokens(termo)
        if (tokens.length > 0) {
          var tokenConds = []
          for (var idx = 0; idx < tokens.length; idx++) {
            var tok = tokens[idx]
            var pName = 'tok_' + idx
            var pNameStem = 'tok_stem_' + idx
            var stem = stemTokenSearch(tok)
            queryParams[pName] = '%' + tok + '%'
            queryParams[pNameStem] = '%' + stem + '%'
            tokenConds.push(
              '(descricao_normalizada LIKE {:' +
                pName +
                '} OR descricao_normalizada LIKE {:' +
                pNameStem +
                '})',
            )
          }
          whereClauses.push('(' + tokenConds.join(' AND ') + ')')
        }
      }
    }

    if (params.sources && Array.isArray(params.sources) && params.sources.length > 0) {
      var srcConds = []
      for (var sI = 0; sI < params.sources.length; sI++) {
        var sVal = params.sources[sI]
        var pSrc = 'src_' + sI
        queryParams[pSrc] = sVal
        srcConds.push('source = {:' + pSrc + '}')
      }
      whereClauses.push('(' + srcConds.join(' OR ') + ')')
    } else if (params.fonte) {
      queryParams['source_single'] = params.fonte
      whereClauses.push('source = {:source_single}')
    }

    if (params.uf) {
      var ufUpper = params.uf.trim().toUpperCase()
      if (ufUpper.length === 2) {
        queryParams['uf_filtro'] = ufUpper
        whereClauses.push('uf = {:uf_filtro}')
      }
    }

    var periodoMeses = parseInt(params.periodo || params.periodo_meses || 0, 10)
    if (periodoMeses > 0) {
      var dLimite = new Date(Date.now() - periodoMeses * 30 * 24 * 3600 * 1000).toISOString()
      queryParams['dt_limite'] = dLimite
      whereClauses.push('data_referencia >= {:dt_limite}')
    }

    if (params.modalidade) {
      queryParams['mod_filtro'] = '%' + params.modalidade.trim() + '%'
      whereClauses.push('modalidade LIKE {:mod_filtro}')
    }

    if (params.natureza_preco) {
      queryParams['nat_preco'] = params.natureza_preco
      whereClauses.push('natureza_preco = {:nat_preco}')
    }

    if (params.apenas_me_epp) {
      whereClauses.push("fornecedor_porte = 'ME_EPP'")
    }

    var whereSql = whereClauses.join(' AND ')

    var stepLog = []
    try {
      stepLog.push('1_get_db')
      var db = $app.db()
      stepLog.push('2_newQuery')
      var q = db.newQuery('SELECT 1 as num')
      stepLog.push('3_before_one')
    } catch (e1) {
      stepLog.push('CATCH_1: ' + (e1 ? e1.message || String(e1) : 'null'))
    }

    return e.json(200, {
      checkpoint: 'stepLog_before_one',
      steps: stepLog,
    })

    var todosValores = []
    try {
      var valQ = $app
        .db()
        .newQuery(
          'SELECT valor_unitario FROM price_samples_index WHERE ' +
            whereSql +
            ' ORDER BY valor_unitario ASC',
        )
      valQ.bind(queryParams)
      var valRows = valQ.all()
      for (var vIdx = 0; vIdx < valRows.length; vIdx++) {
        var vNum = Number(valRows[vIdx].valor_unitario)
        if (!isNaN(vNum) && vNum > 0) todosValores.push(vNum)
      }
    } catch (_) {}

    var estatisticas = calcularEstatisticasAmostras(todosValores)

    var porFonte = { PNCP: 0, 'Compras.gov.br': 0 }
    try {
      var aggSrcQ = $app
        .db()
        .newQuery(
          'SELECT source, COUNT(*) as cnt FROM price_samples_index WHERE ' +
            whereSql +
            ' GROUP BY source',
        )
      aggSrcQ.bind(queryParams)
      var aggSrcRows = aggSrcQ.all()
      for (var asI = 0; asI < aggSrcRows.length; asI++) {
        var sName = aggSrcRows[asI].source
        porFonte[sName] = Number(aggSrcRows[asI].cnt) || 0
      }
    } catch (_) {}

    var porUf = {}
    try {
      var aggUfQ = $app
        .db()
        .newQuery(
          'SELECT uf, COUNT(*) as cnt FROM price_samples_index WHERE ' +
            whereSql +
            ' AND uf != "" GROUP BY uf',
        )
      aggUfQ.bind(queryParams)
      var aggUfRows = aggUfQ.all()
      for (var auI = 0; auI < aggUfRows.length; auI++) {
        porUf[aggUfRows[auI].uf] = Number(aggUfRows[auI].cnt) || 0
      }
    } catch (_) {}

    var frescorSincronizacao = {}
    try {
      var wmQ = $app
        .db()
        .newQuery(
          'SELECT fonte, last_watermark_date, status, amostras_coletadas_total, updated FROM price_watermarks',
        )
      var wmRows = wmQ.all()
      for (var wI = 0; wI < wmRows.length; wI++) {
        var r = wmRows[wI]
        frescorSincronizacao[r.fonte] = {
          ultima_data_sincronizada: r.last_watermark_date,
          status: r.status,
          total_coletadas_watermark: Number(r.amostras_coletadas_total) || 0,
          ultima_atualizacao: r.updated,
        }
      }
    } catch (_) {}

    var duracaoMs = new Date().getTime() - t0

    return e.json(200, {
      sucesso: true,
      total: totalHits,
      page: page,
      limit: limit,
      pages: Math.ceil(totalHits / limit) || 1,
      duracao_ms: duracaoMs,
      hits: hits,
      filtros_aplicados: {
        termo: termo,
        sources: params.sources || (params.fonte ? [params.fonte] : []),
        uf: params.uf || '',
        periodo_meses: periodoMeses,
        modalidade: params.modalidade || '',
        natureza_preco: params.natureza_preco || '',
        sort: sortParam,
      },
      aggregations: {
        total: totalHits,
        por_fonte: porFonte,
        por_uf: porUf,
        estatisticas: estatisticas,
      },
      frescor_sincronizacao: frescorSincronizacao,
      metricas_consulta: {
        took_ms: duracaoMs,
        amostras_avaliadas: todosValores.length,
        origem_consulta: 'base_local_indexada',
        chamadas_externas_disparadas: 0,
        protocolo_auditoria: 'LEI_14133_ART_23_PAINEL_PRECOS',
      },
    })
  } catch (errPost) {
    var durErro = new Date().getTime() - t0
    console.error(
      '[SEARCH-ENDPOINT] [POST /backend/v1/prices/search] FALHA CRÍTICA após ' + durErro + 'ms:',
      errPost ? errPost.stack || errPost.message || String(errPost) : 'Erro desconhecido',
    )
    return e.json(500, {
      sucesso: false,
      error: errPost ? errPost.message || String(errPost) : 'Internal Server Error',
      etapa: 'handler_post_prices_search',
      duracao_ms: durErro,
    })
  }
})

// 2. Endpoint GET /backend/v1/precos/busca
routerAdd('GET', '/backend/v1/precos/busca', function (e) {
  function canonicalNormSearchText(s) {
    if (!s) return ''
    return String(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
      .replace(/[^A-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function extractSearchTokens(s) {
    var STOPWORDS = {
      DE: true,
      DA: true,
      DO: true,
      DAS: true,
      DOS: true,
      EM: true,
      PARA: true,
      COM: true,
      SEM: true,
      POR: true,
      AO: true,
      AOS: true,
      ITEM: true,
      LOTE: true,
      AQUISICAO: true,
      FORNECIMENTO: true,
      REGISTRO: true,
      PRECOS: true,
    }
    var norm = canonicalNormSearchText(s)
    if (!norm) return []
    return norm.split(/\s+/).filter(function (t) {
      return t.length >= 2 && !STOPWORDS[t]
    })
  }

  function stemTokenSearch(t) {
    if (!t || t.length <= 3) return t
    if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
    if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
    return t
  }

  function calcularEstatisticasAmostras(valores) {
    if (!valores || valores.length === 0) {
      return {
        n: 0,
        media: 0,
        mediana: 0,
        q1: 0,
        q3: 0,
        minimo: 0,
        maximo: 0,
        desvio_padrao: 0,
        iqr: 0,
        limite_inferior_iqr: 0,
        limite_superior_iqr: 0,
        regra_outlier: 'IQR_1_5_VERSION_1_0',
      }
    }

    var sorted = [...valores].sort(function (a, b) {
      return a - b
    })
    var n = sorted.length
    var soma = 0
    for (var i = 0; i < n; i++) soma += sorted[i]
    var media = soma / n

    var mediana = 0
    if (n % 2 === 1) {
      mediana = sorted[Math.floor(n / 2)]
    } else {
      mediana = (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    }

    function getPercentil(p) {
      var idx = (n - 1) * p
      var b = Math.floor(idx)
      var r = idx - b
      if (sorted[b + 1] !== undefined) {
        return sorted[b] + r * (sorted[b + 1] - sorted[b])
      }
      return sorted[b]
    }

    var q1 = getPercentil(0.25)
    var q3 = getPercentil(0.75)
    var iqr = q3 - q1
    var limiteInferiorIqr = Math.max(0, q1 - 1.5 * iqr)
    var limiteSuperiorIqr = q3 + 1.5 * iqr

    var somaVariancia = 0
    for (var j = 0; j < n; j++) {
      somaVariancia += Math.pow(sorted[j] - media, 2)
    }
    var desvioPadrao = n > 1 ? Math.sqrt(somaVariancia / (n - 1)) : 0

    return {
      n: n,
      media: Number(media.toFixed(4)),
      mediana: Number(mediana.toFixed(4)),
      q1: Number(q1.toFixed(4)),
      q3: Number(q3.toFixed(4)),
      minimo: Number(sorted[0].toFixed(4)),
      maximo: Number(sorted[n - 1].toFixed(4)),
      desvio_padrao: Number(desvioPadrao.toFixed(4)),
      iqr: Number(iqr.toFixed(4)),
      limite_inferior_iqr: Number(limiteInferiorIqr.toFixed(4)),
      limite_superior_iqr: Number(limiteSuperiorIqr.toFixed(4)),
      regra_outlier: 'IQR_1_5_VERSION_1_0',
    }
  }

  try {
    var t0 = new Date().getTime()
    var queryParams = e.request.url.query()
    var termo = (queryParams.get('q') || queryParams.get('termo') || '').trim()
    var page = Math.max(1, parseInt(queryParams.get('page') || '1', 10))
    var limit = Math.min(200, Math.max(1, parseInt(queryParams.get('limit') || '50', 10)))
    var offset = (page - 1) * limit

    var sortParam = (queryParams.get('sort') || 'valor_unitario:asc').trim()
    var orderBySql = 'valor_unitario ASC'
    if (sortParam === 'valor_unitario:desc') orderBySql = 'valor_unitario DESC'
    else if (sortParam === 'data_referencia:desc')
      orderBySql = 'data_referencia DESC, valor_unitario ASC'

    var whereClauses = ['valor_unitario > 0']
    var qBinds = {}

    if (termo) {
      if (/^\d{4,8}$/.test(termo.trim())) {
        whereClauses.push(
          '(codigo_item = {:catmatCode} OR descricao_normalizada LIKE {:catmatLike})',
        )
        qBinds['catmatCode'] = termo.trim()
        qBinds['catmatLike'] = '%' + termo.trim() + '%'
      } else {
        var tokens = extractSearchTokens(termo)
        if (tokens.length > 0) {
          var tokenConds = []
          for (var idx = 0; idx < tokens.length; idx++) {
            var tok = tokens[idx]
            var pName = 'tok_' + idx
            var pNameStem = 'tok_stem_' + idx
            var stem = stemTokenSearch(tok)
            qBinds[pName] = '%' + tok + '%'
            qBinds[pNameStem] = '%' + stem + '%'
            tokenConds.push(
              '(descricao_normalizada LIKE {:' +
                pName +
                '} OR descricao_normalizada LIKE {:' +
                pNameStem +
                '})',
            )
          }
          whereClauses.push('(' + tokenConds.join(' AND ') + ')')
        }
      }
    }

    var fonteFiltro = queryParams.get('fonte')
    if (fonteFiltro) {
      qBinds['src_val'] = fonteFiltro
      whereClauses.push('source = {:src_val}')
    }

    var ufFiltro = queryParams.get('uf')
    if (ufFiltro && ufFiltro.trim().length === 2) {
      qBinds['uf_val'] = ufFiltro.trim().toUpperCase()
      whereClauses.push('uf = {:uf_val}')
    }

    var periodoMeses = parseInt(queryParams.get('periodo') || '0', 10)
    if (periodoMeses > 0) {
      var dLim = new Date(Date.now() - periodoMeses * 30 * 24 * 3600 * 1000).toISOString()
      qBinds['dt_lim'] = dLim
      whereClauses.push('data_referencia >= {:dt_lim}')
    }

    var modalidadeFiltro = queryParams.get('modalidade')
    if (modalidadeFiltro) {
      qBinds['mod_val'] = '%' + modalidadeFiltro.trim() + '%'
      whereClauses.push('modalidade LIKE {:mod_val}')
    }

    var whereSql = whereClauses.join(' AND ')

    var totalHits = 0
    try {
      var countQ = $app
        .db()
        .newQuery('SELECT COUNT(*) as total FROM price_samples_index WHERE ' + whereSql)
      countQ.bind(qBinds)
      var countRow = countQ.one()
      if (countRow && countRow.total !== undefined) {
        totalHits = Number(countRow.total) || 0
      }
    } catch (_) {}

    var hits = []
    try {
      var hitsQ = $app
        .db()
        .newQuery(
          'SELECT id, sample_key, source, source_record_id, purchase_id, item_id, ' +
            'descricao, descricao_normalizada, orgao, orgao_cnpj, fornecedor_nome, fornecedor_cnpj, ' +
            'fornecedor_porte, uf, municipio, unidade, quantidade, valor_unitario, valor_total, ' +
            'natureza_preco, data_referencia, numero_processo, numero_ata, modalidade, situacao_contratacao, ' +
            'marca, modelo, codigo_item, url_original, payload_hash, qualidade_situacao, motivos_rejeicao, ' +
            'matching_score, matching_tipo, indexed_at, source_updated_at, last_validated_at ' +
            'FROM price_samples_index WHERE ' +
            whereSql +
            ' ' +
            'ORDER BY ' +
            orderBySql +
            ' ' +
            'LIMIT ' +
            limit +
            ' OFFSET ' +
            offset,
        )
      hitsQ.bind(qBinds)
      hits = hitsQ.all()
    } catch (_) {}

    var todosValores = []
    try {
      var valQ = $app
        .db()
        .newQuery(
          'SELECT valor_unitario FROM price_samples_index WHERE ' +
            whereSql +
            ' ORDER BY valor_unitario ASC',
        )
      valQ.bind(qBinds)
      var valRows = valQ.all()
      for (var vIdx = 0; vIdx < valRows.length; vIdx++) {
        var vNum = Number(valRows[vIdx].valor_unitario)
        if (!isNaN(vNum) && vNum > 0) todosValores.push(vNum)
      }
    } catch (_) {}

    var estatisticas = calcularEstatisticasAmostras(todosValores)

    var porFonte = { PNCP: 0, 'Compras.gov.br': 0 }
    try {
      var aggSrcQ = $app
        .db()
        .newQuery(
          'SELECT source, COUNT(*) as cnt FROM price_samples_index WHERE ' +
            whereSql +
            ' GROUP BY source',
        )
      aggSrcQ.bind(qBinds)
      var aggSrcRows = aggSrcQ.all()
      for (var asI = 0; asI < aggSrcRows.length; asI++) {
        var sName = aggSrcRows[asI].source
        porFonte[sName] = Number(aggSrcRows[asI].cnt) || 0
      }
    } catch (_) {}

    var porUf = {}
    try {
      var aggUfQ = $app
        .db()
        .newQuery(
          'SELECT uf, COUNT(*) as cnt FROM price_samples_index WHERE ' +
            whereSql +
            ' AND uf != "" GROUP BY uf',
        )
      aggUfQ.bind(qBinds)
      var aggUfRows = aggUfQ.all()
      for (var auI = 0; auI < aggUfRows.length; auI++) {
        porUf[aggUfRows[auI].uf] = Number(aggUfRows[auI].cnt) || 0
      }
    } catch (_) {}

    var frescorSincronizacao = {}
    try {
      var wmQ = $app
        .db()
        .newQuery(
          'SELECT fonte, last_watermark_date, status, amostras_coletadas_total, updated FROM price_watermarks',
        )
      var wmRows = wmQ.all()
      for (var wI = 0; wI < wmRows.length; wI++) {
        var r = wmRows[wI]
        frescorSincronizacao[r.fonte] = {
          ultima_data_sincronizada: r.last_watermark_date,
          status: r.status,
          total_coletadas_watermark: Number(r.amostras_coletadas_total) || 0,
          ultima_atualizacao: r.updated,
        }
      }
    } catch (_) {}

    var duracaoMs = new Date().getTime() - t0

    return e.json(200, {
      sucesso: true,
      total: totalHits,
      page: page,
      limit: limit,
      pages: Math.ceil(totalHits / limit) || 1,
      duracao_ms: duracaoMs,
      hits: hits,
      filtros_aplicados: {
        termo: termo,
        sources: fonteFiltro ? [fonteFiltro] : [],
        uf: ufFiltro || '',
        periodo_meses: periodoMeses,
        modalidade: modalidadeFiltro || '',
        sort: sortParam,
      },
      aggregations: {
        total: totalHits,
        por_fonte: porFonte,
        por_uf: porUf,
        estatisticas: estatisticas,
      },
      frescor_sincronizacao: frescorSincronizacao,
      metricas_consulta: {
        took_ms: duracaoMs,
        amostras_avaliadas: todosValores.length,
        origem_consulta: 'base_local_indexada',
        chamadas_externas_disparadas: 0,
        protocolo_auditoria: 'LEI_14133_ART_23_PAINEL_PRECOS',
      },
    })
  } catch (errGet) {
    var durErroGet = new Date().getTime() - t0
    console.error(
      '[SEARCH-ENDPOINT] [GET /backend/v1/precos/busca] FALHA CRÍTICA após ' + durErroGet + 'ms:',
      errGet ? errGet.stack || errGet.message || String(errGet) : 'Erro desconhecido',
    )
    return e.json(500, {
      sucesso: false,
      error: errGet ? errGet.message || String(errGet) : 'Internal Server Error',
      etapa: 'handler_get_precos_busca',
      duracao_ms: durErroGet,
    })
  }
})
