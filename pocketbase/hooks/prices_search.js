// Hook PocketBase: Endpoint próprio de pesquisa sobre a base indexada e persistente
// POST /backend/v1/prices/search
// Modelo inspirado no contrato de referência do Cesta de Preços:
// - took: tempo real de execução medido no backend
// - hits.total: total real de amostras que satisfazem os filtros (não limitado à página)
// - hits.hits: array somente da página solicitada com _source e sort
// - sort: valor numérico da ordenação (ex.: [valor_unitario])
// - aggregations: preco_minimo, preco_maximo, preco_medio, preco_mediana, unidades, estados, municipios
//   calculadas sobre o conjunto filtrado COMPLETO (não apenas sobre a página atual)
// - pagination: paginaAtual, tamanhoPagina, totalPaginas

routerAdd('POST', '/backend/v1/prices/search', function (e) {
  var tInicio = new Date().getTime()
  try {
    var body = {}
    try {
      body = e.requestInfo().body || {}
      if (typeof body === 'string') body = JSON.parse(body)
    } catch (_) {
      body = {}
    }

    var termo = (body.palavra_chave || body.termo || body.q || '').trim()
    var palavraExata = Boolean(body.palavra_exata)
    var cnpj = (body.cnpj || body.orgao_cnpj || body.fornecedor_cnpj || '').replace(/\D/g, '')
    var ordenar = (body.ordenar || 'valor_unitario:asc').trim().toLowerCase()
    var periodo = (body.periodo || '').trim().toUpperCase() // ex: 'MESES_12', 'MESES_6', etc.
    var periodoMeses =
      parseInt(
        body.periodo_meses ||
          (periodo === 'MESES_12'
            ? '12'
            : periodo === 'MESES_6'
              ? '6'
              : periodo === 'MESES_24'
                ? '24'
                : '0'),
        10,
      ) || 0
    var dataInicio = (body.data_inicio || '').trim()
    var dataFim = (body.data_fim || '').trim()
    var fonte = (body.fonte || 'todas').trim()
    var uf = (body.uf || '').trim().toUpperCase()
    var unidade = (body.unidade || '').trim().toUpperCase()
    var marca = (body.marca || '').trim().toUpperCase()
    var porte = (body.porte || '').trim()
    var precoMin =
      typeof body.preco_min === 'number' ? body.preco_min : parseFloat(body.preco_min) || 0
    var precoMax =
      typeof body.preco_max === 'number' ? body.preco_max : parseFloat(body.preco_max) || 0

    var pagina = Math.max(1, parseInt(body.pagina || '1', 10) || 1)
    var tamanhoPagina = Math.min(100, Math.max(5, parseInt(body.tamanho_pagina || '50', 10) || 50))

    if (!termo && !cnpj) {
      return e.json(400, {
        error: 'INVALID_PARAMETERS',
        message: 'O parâmetro "palavra_chave" ou "cnpj" é obrigatório para pesquisar no índice.',
      })
    }

    // Normalização canônica do termo
    function canonicalNorm(s) {
      if (!s) return ''
      return String(s)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    var termoNorm = canonicalNorm(termo)
    var tokensTermo = termoNorm.split(/\s+/).filter(function (t) {
      return t.length >= 2
    })

    // Montar SQL sobre price_samples_index
    // Usamos raw query para ordenação global pré-paginação e agregações sobre o conjunto completo
    var sqlConditions = ['1=1']
    var sqlParams = {}

    // Filtro por termo na descrição normalizada
    if (termoNorm) {
      if (palavraExata) {
        sqlConditions.push('descricao_normalizada LIKE {:termoExato}')
        sqlParams.termoExato = '%' + termoNorm + '%'
      } else {
        for (var tIdx = 0; tIdx < tokensTermo.length; tIdx++) {
          var pName = 'tok_' + tIdx
          sqlConditions.push('descricao_normalizada LIKE {:' + pName + '}')
          sqlParams[pName] = '%' + tokensTermo[tIdx] + '%'
        }
      }
    }

    // Filtro por CNPJ (órgão ou fornecedor)
    if (cnpj) {
      sqlConditions.push('(orgao_cnpj LIKE {:cnpj} OR fornecedor_cnpj LIKE {:cnpj})')
      sqlParams.cnpj = '%' + cnpj + '%'
    }

    // Filtro por fonte (PNCP, Compras.gov.br)
    if (fonte && fonte !== 'todas' && fonte !== 'ambas') {
      var fLower = fonte.toLowerCase()
      if (fLower.includes('pncp')) {
        sqlConditions.push("source = 'PNCP'")
      } else if (fLower.includes('compras')) {
        sqlConditions.push("source = 'Compras.gov.br'")
      }
    }

    // Filtro por UF
    if (uf) {
      sqlConditions.push('uf = {:uf}')
      sqlParams.uf = uf
    }

    // Filtro por Unidade
    if (unidade) {
      sqlConditions.push('UPPER(unidade) LIKE {:unidade}')
      sqlParams.unidade = '%' + unidade + '%'
    }

    // Filtro por Marca
    if (marca) {
      sqlConditions.push('UPPER(marca) LIKE {:marca}')
      sqlParams.marca = '%' + marca + '%'
    }

    // Filtro por Porte
    if (porte === 'ME_EPP') {
      sqlConditions.push("fornecedor_porte = 'ME_EPP'")
    }

    // Filtro por faixa de preço unitário
    if (precoMin > 0) {
      sqlConditions.push('valor_unitario >= {:precoMin}')
      sqlParams.precoMin = precoMin
    }
    if (precoMax > 0) {
      sqlConditions.push('valor_unitario <= {:precoMax}')
      sqlParams.precoMax = precoMax
    }

    // Filtro por data de referência / período
    if (dataInicio) {
      sqlConditions.push('data_referencia >= {:dataInicio}')
      sqlParams.dataInicio = dataInicio
    }
    if (dataFim) {
      sqlConditions.push('data_referencia <= {:dataFim}')
      sqlParams.dataFim = dataFim + 'T23:59:59'
    } else if (periodoMeses > 0 && !dataInicio) {
      var dLim = new Date()
      dLim.setMonth(dLim.getMonth() - periodoMeses)
      var isoLimite = dLim.toISOString()
      sqlConditions.push('data_referencia >= {:dataLimite}')
      sqlParams.dataLimite = isoLimite
    }

    // Exclui preços zero ou negativos
    sqlConditions.push('valor_unitario > 0')

    var whereClause = sqlConditions.join(' AND ')

    // 1. Agregações e Estatísticas sobre o conjunto filtrado COMPLETO
    var queryStatsSql =
      'SELECT ' +
      '  COUNT(*) AS total_count, ' +
      '  MIN(valor_unitario) AS min_val, ' +
      '  MAX(valor_unitario) AS max_val, ' +
      '  AVG(valor_unitario) AS avg_val ' +
      'FROM price_samples_index WHERE ' +
      whereClause

    var statsQuery = $app.db().newQuery(queryStatsSql)
    for (var k in sqlParams) {
      statsQuery.bind(k, sqlParams[k])
    }

    var statsRows = []
    try {
      statsRows = statsQuery.all()
    } catch (errStats) {
      console.log('[PRICES-SEARCH-HOOK] Erro em statsQuery:', errStats.message)
    }

    var totalHits = 0
    var precoMinimo = 0
    var precoMaximo = 0
    var precoMedio = 0
    if (statsRows && statsRows.length > 0) {
      var sRow = statsRows[0]
      totalHits = Number(sRow.total_count) || 0
      precoMinimo = Number(sRow.min_val) || 0
      precoMaximo = Number(sRow.max_val) || 0
      precoMedio = Number(sRow.avg_val) || 0
    }

    // 2. Cálculo da mediana sobre o conjunto completo (se houver amostras)
    var precoMediana = 0
    if (totalHits > 0) {
      var offsetMid = Math.floor(totalHits / 2)
      var queryMedianaSql =
        'SELECT valor_unitario FROM price_samples_index WHERE ' +
        whereClause +
        ' ORDER BY valor_unitario ASC LIMIT 2 OFFSET ' +
        Math.max(0, totalHits % 2 === 0 ? offsetMid - 1 : offsetMid)

      var medQuery = $app.db().newQuery(queryMedianaSql)
      for (var km in sqlParams) {
        medQuery.bind(km, sqlParams[km])
      }
      try {
        var medRows = medQuery.all()
        if (medRows && medRows.length > 0) {
          if (totalHits % 2 === 0 && medRows.length >= 2) {
            precoMediana =
              (Number(medRows[0].valor_unitario) + Number(medRows[1].valor_unitario)) / 2
          } else {
            precoMediana = Number(medRows[0].valor_unitario) || 0
          }
        }
      } catch (_) {}
    }

    // 3. Agregações categóricas (unidades, estados, municípios)
    var unidadesMap = {}
    var estadosMap = {}
    var municipiosMap = {}

    if (totalHits > 0) {
      var queryAggsSql =
        'SELECT unidade, uf, municipio, COUNT(*) as cnt ' +
        'FROM price_samples_index WHERE ' +
        whereClause +
        ' GROUP BY unidade, uf, municipio ORDER BY cnt DESC LIMIT 50'
      var aggsQuery = $app.db().newQuery(queryAggsSql)
      for (var ka in sqlParams) {
        aggsQuery.bind(ka, sqlParams[ka])
      }
      try {
        var aggsRows = aggsQuery.all()
        for (var aI = 0; aI < aggsRows.length; aI++) {
          var aRow = aggsRows[aI]
          var uKey = (aRow.unidade || 'UN').toUpperCase()
          var ufKey = (aRow.uf || 'BR').toUpperCase()
          var munKey = aRow.municipio || ''
          var count = Number(aRow.cnt) || 1

          unidadesMap[uKey] = (unidadesMap[uKey] || 0) + count
          estadosMap[ufKey] = (estadosMap[ufKey] || 0) + count
          if (munKey) municipiosMap[munKey] = (municipiosMap[munKey] || 0) + count
        }
      } catch (_) {}
    }

    // 4. Determinação da Ordenação numérica global ANTES da paginação
    var orderByClause = 'valor_unitario ASC'
    if (ordenar === 'valor_unitario:desc' || ordenar === 'maior_preco') {
      orderByClause = 'valor_unitario DESC'
    } else if (ordenar === 'data:desc' || ordenar === 'data_recente') {
      orderByClause = 'data_referencia DESC, valor_unitario ASC'
    } else {
      orderByClause = 'valor_unitario ASC'
    }

    var offsetPage = (pagina - 1) * tamanhoPagina
    var totalPaginas = Math.max(1, Math.ceil(totalHits / tamanhoPagina))

    // 5. Seleção da página solicitada
    var queryHitsSql =
      'SELECT * FROM price_samples_index WHERE ' +
      whereClause +
      ' ORDER BY ' +
      orderByClause +
      ' LIMIT ' +
      tamanhoPagina +
      ' OFFSET ' +
      offsetPage

    var hitsQuery = $app.db().newQuery(queryHitsSql)
    for (var kh in sqlParams) {
      hitsQuery.bind(kh, sqlParams[kh])
    }

    var hitsRows = []
    try {
      hitsRows = hitsQuery.all()
    } catch (errHits) {
      console.log('[PRICES-SEARCH-HOOK] Erro em hitsQuery:', errHits.message)
    }

    var hitsFormatted = []
    for (var hIdx = 0; hIdx < hitsRows.length; hIdx++) {
      var row = hitsRows[hIdx]
      var rawParsed = null
      if (row.raw_payload) {
        try {
          rawParsed =
            typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload
        } catch (_) {}
      }

      hitsFormatted.push({
        _index: 'price_samples_index',
        _id: row.id || row.sample_key,
        _score: 1.0,
        _source: {
          id: row.id,
          sample_key: row.sample_key,
          compra_id: row.purchase_id || row.source_record_id,
          item_id: row.item_id,
          descricao: row.descricao,
          descricao_texto: row.descricao,
          descricao_normalizada: row.descricao_normalizada,
          fonte: row.source,
          orgao: row.orgao,
          orgao_cnpj: row.orgao_cnpj,
          for_nome: row.fornecedor_nome,
          for_cnpj: row.fornecedor_cnpj,
          for_porte: row.fornecedor_porte,
          unidade: row.unidade || 'UN',
          quantidade: Number(row.quantidade) || 1,
          valor_unitario: Number(row.valor_unitario) || 0,
          valor_total:
            Number(row.valor_total) || Number(row.valor_unitario) * (Number(row.quantidade) || 1),
          natureza_preco: row.natureza_preco || 'homologado',
          data: row.data_referencia,
          homologacao: row.data_referencia,
          identificador: row.source_record_id || row.purchase_id,
          link_oficial: row.url_original,
          uf: row.uf,
          municipio: row.municipio,
          numero: row.numero_processo || row.numero_ata,
          marca: row.marca,
          codigo_item: row.codigo_item,
          raw_payload: rawParsed,
        },
        sort: [Number(row.valor_unitario) || 0],
      })
    }

    var tFim = new Date().getTime()
    var tookMs = tFim - tInicio

    // Resposta com contrato de referência
    return e.json(200, {
      took: tookMs,
      timed_out: false,
      hits: {
        total: totalHits,
        max_score: 1.0,
        hits: hitsFormatted,
      },
      aggregations: {
        preco_minimo: precoMinimo,
        preco_maximo: precoMaximo,
        preco_medio: Number(precoMedio.toFixed(4)),
        preco_mediana: Number(precoMediana.toFixed(4)),
        unidades: unidadesMap,
        estados: estadosMap,
        municipios: municipiosMap,
      },
      pagination: {
        paginaAtual: pagina,
        tamanhoPagina: tamanhoPagina,
        totalPaginas: totalPaginas,
        totalRegistros: totalHits,
      },
    })
  } catch (errGlobal) {
    console.log('[PRICES-SEARCH-HOOK] Erro global:', errGlobal.message)
    return e.json(500, {
      error: 'SEARCH_INDEX_ERROR',
      message: 'Falha ao consultar a base indexada de preços: ' + errGlobal.message,
    })
  }
})
