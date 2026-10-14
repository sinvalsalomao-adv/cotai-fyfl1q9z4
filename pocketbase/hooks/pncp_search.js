// Endpoint de proxy e detalhamento seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts e extração real de preços unitários.
// DIRETRIZES FUNDAMENTAIS:
// 1. ELIMINADA toda lógica que recorre a valores totais/globais da contratação, divisão genérica ou amostra sintética do cabeçalho.
//    O valor global de uma contratação NÃO é preço unitário de cada item/medicamento.
// 2. Identificação correta de CNPJ do órgão, ano, sequencial e número do item.
// 3. Consulta de itens das contratações com paginação oficial e endpoint de resultados do item (/resultados)
//    para recuperar o valorUnitarioHomologado real e fornecedor vencedor.
// 4. Distinção rigorosa: homologado vs. estimado.
// 5. Preservação de preços baixos legítimos (< R$1,00, R$0,12, centavos).
// 6. Cache no pncp_item_cache e registro de contratações pendentes para detalhamento contínuo.

routerAdd('GET', '/backend/v1/pncp/search', function (e) {
  var tInicioProxy = new Date().getTime()
  try {
    var query = e.requestInfo().query
    var q = (query.q || '').trim()
    var paginaParam = parseInt(query.pagina || '1', 10) || 1
    var tamPaginaParam = Math.min(50, Math.max(5, parseInt(query.tam_pagina || '50', 10) || 50))
    var uf = (query.uf || '').trim().toUpperCase()

    var paginacaoTotal =
      (query.paginacao_total || '').toLowerCase() === 'true' ||
      (query.todas_paginas || '').toLowerCase() === 'true'
    var limitePaginasSolicitado = parseInt(query.limite_paginas || '0', 10) || 0

    if (!q) {
      return e.json(400, {
        error: 'INVALID_PARAMETER',
        message: 'O parâmetro "q" de busca é obrigatório.',
      })
    }

    var userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    var headers = {
      Accept: 'application/json',
      'User-Agent': userAgent,
    }

    var diagLogs = {
      termo: q,
      uf: uf || null,
      pagina_solicitada: paginaParam,
      tam_pagina: tamPaginaParam,
      requisicoes_http: 0,
      paginas_recebidas: 0,
      contratacoes_brutas: 0,
      contratacoes_unicas: 0,
      duplicados_removidos: 0,
      itens_detalhados: 0,
      amostras_validas: 0,
      amostras_abaixo_1_real: 0,
      descartes_sem_preco_unitario: 0,
      erros_retries: [],
      tempo_total_ms: 0,
    }

    function fetchEndpoint(targetUrl, timeoutSec) {
      diagLogs.requisicoes_http++
      try {
        var resp = $http.send({
          url: targetUrl,
          method: 'GET',
          headers: headers,
          timeout: timeoutSec || 4,
        })
        return { ok: true, resp: resp }
      } catch (err) {
        diagLogs.erros_retries.push('fetchEndpoint: ' + (err.message || 'Falha de rede/timeout'))
        return { ok: false, error: err.message || 'Falha de rede/timeout' }
      }
    }

    function buildSearchUrl(docTipo, pNum, pSize) {
      var u =
        'https://pncp.gov.br/api/search/?q=' +
        encodeURIComponent(q) +
        '&tipos_documento=' +
        encodeURIComponent(docTipo) +
        '&pagina=' +
        encodeURIComponent(pNum) +
        '&tam_pagina=' +
        encodeURIComponent(pSize)
      if (uf) {
        u += '&ufs=' + encodeURIComponent(uf)
      }
      return u
    }

    function extractRawItems(body) {
      if (!body) return []
      if (Array.isArray(body)) return body
      if (Array.isArray(body.items)) return body.items
      if (Array.isArray(body.data)) return body.data
      if (Array.isArray(body.resultado)) return body.resultado
      return []
    }

    function canonicalNormalize(s) {
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

    function extractTokens(s) {
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
      var norm = canonicalNormalize(s)
      if (!norm) return []
      return norm.split(/\s+/).filter(function (t) {
        return t.length >= 2 && !STOPWORDS[t]
      })
    }

    function stemToken(t) {
      if (!t || t.length <= 3) return t
      if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
      if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
      return t
    }

    var paramTipoDoc = (query.tipos_documento || query.tipo_documento || query.tipo || '').trim()
    var tiposDocumentos = paramTipoDoc
      ? paramTipoDoc
          .split(',')
          .map(function (s) {
            return s.trim().toLowerCase()
          })
          .filter(Boolean)
      : ['ata', 'edital', 'contrato']
    if (tiposDocumentos.length === 0) tiposDocumentos = ['ata', 'edital', 'contrato']

    var todasContratacoesBrutas = []
    var totalRegistrosPorTipo = {}
    var totalPaginasPorTipo = {}
    var maxTotalRegistros = 0
    var maxTotalPaginas = 1

    for (var tIdx = 0; tIdx < tiposDocumentos.length; tIdx++) {
      var docTipo = tiposDocumentos[tIdx]
      var urlTipo = buildSearchUrl(docTipo, paginaParam, tamPaginaParam)
      var attTipo = fetchEndpoint(urlTipo, 4.0)

      if (!attTipo.ok && attTipo.resp && attTipo.resp.statusCode === 504) {
        attTipo = fetchEndpoint(urlTipo, 2.5)
      }

      if (
        attTipo.ok &&
        attTipo.resp &&
        attTipo.resp.statusCode >= 200 &&
        attTipo.resp.statusCode < 300
      ) {
        try {
          var jsonBody = attTipo.resp.json || JSON.parse(attTipo.resp.raw)
          var itemsDoc = extractRawItems(jsonBody)
          diagLogs.paginas_recebidas++

          var totReg =
            typeof jsonBody.totalRegistros === 'number'
              ? jsonBody.totalRegistros
              : typeof jsonBody.total === 'number'
                ? jsonBody.total
                : typeof jsonBody.total_registros === 'number'
                  ? jsonBody.total_registros
                  : itemsDoc.length

          var totPag =
            typeof jsonBody.totalPaginas === 'number'
              ? jsonBody.totalPaginas
              : Math.max(1, Math.ceil(totReg / tamPaginaParam))

          totalRegistrosPorTipo[docTipo] = totReg
          totalPaginasPorTipo[docTipo] = totPag
          if (totReg > maxTotalRegistros) maxTotalRegistros = totReg
          if (totPag > maxTotalPaginas) maxTotalPaginas = totPag

          for (var k = 0; k < itemsDoc.length; k++) {
            if (!itemsDoc[k].tipo_documento && !itemsDoc[k].document_type) {
              itemsDoc[k].tipo_documento = docTipo
            }
            todasContratacoesBrutas.push(itemsDoc[k])
          }
        } catch (errJson) {
          diagLogs.erros_retries.push('JSON parse erro em ' + docTipo + ': ' + errJson.message)
        }
      }
    }

    diagLogs.contratacoes_brutas = todasContratacoesBrutas.length

    // Paginação complementar se solicitada
    if (paginacaoTotal && maxTotalPaginas > 1 && paginaParam === 1) {
      var paginaFinalAlvo =
        limitePaginasSolicitado > 0
          ? Math.min(maxTotalPaginas, limitePaginasSolicitado)
          : maxTotalPaginas

      var paginaAtualLoop = 2
      var paginaVaziaConsecutiva = 0
      var ultimaQtdAntes = todasContratacoesBrutas.length
      var inicioPaginacaoExtra = new Date().getTime()

      while (
        paginaAtualLoop <= paginaFinalAlvo &&
        paginaVaziaConsecutiva < 2 &&
        new Date().getTime() - inicioPaginacaoExtra < 6000
      ) {
        var itensPaginaTotal = 0
        for (var tIdx2 = 0; tIdx2 < tiposDocumentos.length; tIdx2++) {
          var tDoc = tiposDocumentos[tIdx2]
          if (totalPaginasPorTipo[tDoc] && paginaAtualLoop <= totalPaginasPorTipo[tDoc]) {
            var urlExtra = buildSearchUrl(tDoc, paginaAtualLoop, tamPaginaParam)
            var resExtra = fetchEndpoint(urlExtra, 2.5)
            if (
              resExtra.ok &&
              resExtra.resp &&
              resExtra.resp.statusCode >= 200 &&
              resExtra.resp.statusCode < 300
            ) {
              try {
                var bodyExtra = resExtra.resp.json || JSON.parse(resExtra.resp.raw)
                var itemsExtra = extractRawItems(bodyExtra)
                if (itemsExtra && itemsExtra.length > 0) {
                  itensPaginaTotal += itemsExtra.length
                  for (var m = 0; m < itemsExtra.length; m++) {
                    if (!itemsExtra[m].tipo_documento) itemsExtra[m].tipo_documento = tDoc
                    todasContratacoesBrutas.push(itemsExtra[m])
                  }
                }
              } catch (_) {}
            }
          }
        }

        if (itensPaginaTotal === 0 || todasContratacoesBrutas.length === ultimaQtdAntes) {
          paginaVaziaConsecutiva++
        } else {
          paginaVaziaConsecutiva = 0
          ultimaQtdAntes = todasContratacoesBrutas.length
        }
        paginaAtualLoop++
      }
    }

    if (todasContratacoesBrutas.length === 0) {
      if (diagLogs.requisicoes_http > 0 && diagLogs.paginas_recebidas === 0) {
        return e.json(502, {
          error: 'PNCP_UPSTREAM_UNAVAILABLE',
          message:
            'A API pública do PNCP está temporariamente inacessível ou não respondeu no tempo limite.',
          detail: diagLogs.erros_retries.join('; ') || 'Falha na comunicação inicial com o PNCP',
          diagnostico_fluxo: diagLogs,
        })
      }
      return e.json(200, {
        items: [],
        total: 0,
        totalRegistros: 0,
        totalPaginas: 1,
        paginaAtual: paginaParam,
        tipoDocumento: tiposDocumentos.join(','),
        detalhamento_paralelo: { total_processado: 0, sucessos: 0, fila_retry: 0 },
        diagnostico_fluxo: diagLogs,
      })
    }

    // Deduplicação por identificador estável de contratação (CNPJ + ano + sequencial)
    var seenContratacoes = {}
    var contratacoesUnicas = []

    for (var idx = 0; idx < todasContratacoesBrutas.length; idx++) {
      var itemObj = todasContratacoesBrutas[idx]
      var idEstavel =
        itemObj.numeroControlePNCP ||
        itemObj.numero_controle_pncp ||
        itemObj.id ||
        (itemObj.cnpj && itemObj.ano && itemObj.numero_sequencial
          ? itemObj.cnpj + '_' + itemObj.ano + '_' + itemObj.numero_sequencial
          : null) ||
        itemObj.itemUrl ||
        String(idx)

      if (!seenContratacoes[idEstavel]) {
        seenContratacoes[idEstavel] = true
        contratacoesUnicas.push(itemObj)
      } else {
        diagLogs.duplicados_removidos++
      }
    }

    diagLogs.contratacoes_unicas = contratacoesUnicas.length

    function extrairUnidadeQualificadaPncp(uBruta, dBruta) {
      var u = (uBruta || '').trim().toUpperCase()
      var d = (dBruta || '').trim().toUpperCase()

      var matchCx = d.match(
        /\b(?:CAIXA|CX|PCT|PACOTE|ENVELOPE|BLISTER|FARDO)\s*(?:COM|C\/)?\s*(\d+)/i,
      )
      if (matchCx && matchCx[1]) {
        var qtdNum = parseInt(matchCx[1], 10)
        if (qtdNum > 1) {
          var tipo =
            d.indexOf('ENVELOPE') !== -1
              ? 'ENV'
              : d.indexOf('BLISTER') !== -1
                ? 'BLIST'
                : d.indexOf('FARDO') !== -1
                  ? 'FARDO'
                  : d.indexOf('PACOTE') !== -1 || d.indexOf('PCT') !== -1
                    ? 'PCT'
                    : 'CX'
          return tipo + ' ' + qtdNum + ' UN'
        }
      }

      if (u && u !== 'UN' && u !== 'UND' && u !== 'UNIDADE') {
        return u
      }

      if (/\b(?:FRASCO|FR)\b/i.test(d)) return 'FRASCO'
      if (/\b(?:AMPOLA|AMP)\b/i.test(d)) return 'AMPOLA'
      if (/\b(?:ENVELOPE|ENV)\b/i.test(d)) return 'ENVELOPE'
      if (/\b(?:BLISTER|BLIST)\b/i.test(d)) return 'BLISTER'
      if (/\b(?:COMPRIMIDO|COMP)\b/i.test(d)) return 'COMPRIMIDO'
      if (/\b(?:CAIXA|CX)\b/i.test(d)) return 'CX'

      return u || 'UN'
    }

    function extrairParametrosCompra(entryObj) {
      var rawCnpj = (
        (entryObj.orgaoEntidade && entryObj.orgaoEntidade.cnpj) ||
        (entryObj.orgaoSubRogado && entryObj.orgaoSubRogado.cnpj) ||
        entryObj.orgao_cnpj ||
        entryObj.cnpj ||
        ''
      ).replace(/\D/g, '')

      var ano =
        entryObj.anoCompra ||
        entryObj.ano ||
        entryObj.anoAta ||
        entryObj.anoContrato ||
        entryObj.anoEdital ||
        0

      var sequencial =
        entryObj.numero_sequencial_compra_ata ||
        entryObj.numeroSequencialCompraAta ||
        entryObj.sequencialCompra ||
        entryObj.numeroSequencialCompra ||
        entryObj.numeroSequencialEdital ||
        entryObj.numeroSequencialContrato ||
        entryObj.numero_sequencial ||
        0

      var itemUrl = entryObj.item_url || entryObj.itemUrl || ''
      if (itemUrl) {
        var urlParts = itemUrl.split('/').filter(Boolean)
        for (var pIdx = 0; pIdx < urlParts.length; pIdx++) {
          var part = urlParts[pIdx]
          if ((part === 'atas' || part === 'editais' || part === 'compras') && urlParts[pIdx + 1]) {
            if (!rawCnpj) rawCnpj = (urlParts[pIdx + 1] || '').replace(/\D/g, '')
            if (urlParts[pIdx + 2] && parseInt(urlParts[pIdx + 2], 10) >= 2000) {
              if (!ano) ano = parseInt(urlParts[pIdx + 2], 10)
              if (!sequencial && urlParts[pIdx + 3]) {
                sequencial = parseInt(urlParts[pIdx + 3], 10)
              }
            }
          }
        }
      }

      var numControle =
        entryObj.numeroControlePNCP ||
        entryObj.numero_controle_pncp ||
        entryObj.numeroControlePncpCompra ||
        ''
      if (numControle && numControle.indexOf('/') !== -1) {
        var slashParts = numControle.split('/')
        if (slashParts.length >= 2) {
          var beforeSlash = slashParts[0].split('-')
          if (!rawCnpj && beforeSlash[0]) rawCnpj = beforeSlash[0].replace(/\D/g, '')
          if (beforeSlash.length >= 3 && !sequencial) {
            sequencial = parseInt(beforeSlash[2], 10) || sequencial
          }
          var afterSlash = slashParts[1].split('-')
          if (!ano && afterSlash[0]) ano = parseInt(afterSlash[0], 10) || ano
        }
      }

      var orgaoCnpj = (rawCnpj || '').replace(/\D/g, '')
      if (orgaoCnpj.length > 14) orgaoCnpj = orgaoCnpj.slice(0, 14)

      return {
        cnpj: orgaoCnpj,
        ano: parseInt(ano, 10) || 0,
        sequencial: parseInt(sequencial, 10) || 0,
      }
    }

    var qTokens = extractTokens(q)
    var tokenPrincipal = qTokens.length > 0 ? qTokens[0] : ''
    var tokenPrincipalStem = stemToken(tokenPrincipal)

    // Filtra itens compatíveis com o termo
    function itemEhCompativel(descItem) {
      if (!descItem || !descItem.trim()) return false
      if (!tokenPrincipal) return true
      var descNorm = canonicalNormalize(descItem)
      if (descNorm.indexOf(tokenPrincipal) !== -1 || descNorm.indexOf(tokenPrincipalStem) !== -1) {
        return true
      }
      var descTokens = extractTokens(descItem)
      for (var dtI = 0; dtI < descTokens.length; dtI++) {
        var dt = descTokens[dtI]
        var dtStem = stemToken(dt)
        if (
          dt.indexOf(tokenPrincipal) === 0 ||
          tokenPrincipal.indexOf(dt) === 0 ||
          dtStem.indexOf(tokenPrincipalStem) === 0 ||
          tokenPrincipalStem.indexOf(dtStem) === 0
        ) {
          return true
        }
      }
      return false
    }

    // Processa os itens detalhados de uma contratação.
    // REGRA CRÍTICA: valorUnitario extraído EXCLUSIVAMENTE do item ou do resultado oficial do item.
    // NUNCA usa valor_global ou valor total da contratação como preço unitário!
    function processarItensDaContratacao(entryObj, itensArray, pCompra) {
      if (!itensArray || itensArray.length === 0) return false

      var matchedItens = itensArray.filter(function (it) {
        var d = it.descricao || it.materialOuServicoNome || ''
        return itemEhCompativel(d)
      })

      if (matchedItens.length === 0) {
        entryObj.itensAta = []
        return false
      }

      var subItensValidos = []
      var subItensVistos = {}

      for (var mIdx = 0; mIdx < matchedItens.length; mIdx++) {
        var it = matchedItens[mIdx]
        var numItem = it.numeroItem || it.numero_item || mIdx + 1
        var numItemInt = parseInt(numItem, 10) || 1

        var vHomologado =
          Number(it.valorUnitarioHomologado) || Number(it.valor_unitario_homologado) || 0
        var vEstimado =
          Number(it.valorUnitarioEstimado) ||
          Number(it.valor_unitario_estimado) ||
          Number(it.valorUnitario) ||
          Number(it.valor_unitario) ||
          0

        var vUnit = vHomologado > 0 ? vHomologado : vEstimado
        var natPreco = vHomologado > 0 ? 'homologado' : vEstimado > 0 ? 'estimado' : ''
        var fornecedorFinal = it.fornecedor || null

        // Se ainda não temos preço unitário homologado e temos parâmetros da compra,
        // consulta o endpoint de resultados do item:
        // GET /api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}/itens/{numeroItem}/resultados
        if (vUnit <= 0 && pCompra.cnpj && pCompra.ano && pCompra.sequencial) {
          var urlRes =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            pCompra.cnpj +
            '/compras/' +
            pCompra.ano +
            '/' +
            pCompra.sequencial +
            '/itens/' +
            numItemInt +
            '/resultados'
          var attRes = fetchEndpoint(urlRes, 3.0)
          if (
            attRes.ok &&
            attRes.resp &&
            attRes.resp.statusCode >= 200 &&
            attRes.resp.statusCode < 300
          ) {
            try {
              var bodyRes = attRes.resp.json || JSON.parse(attRes.resp.raw)
              var arrRes = extractRawItems(bodyRes)
              for (var rIdx = 0; rIdx < arrRes.length; rIdx++) {
                var rItem = arrRes[rIdx]
                var vUnitRes =
                  Number(rItem.valorUnitarioHomologado) ||
                  Number(rItem.valor_unitario_homologado) ||
                  Number(rItem.valorUnitario) ||
                  Number(rItem.valor_unitario) ||
                  0
                if (vUnitRes > 0) {
                  vUnit = vUnitRes
                  natPreco = 'homologado'
                  fornecedorFinal = {
                    niFornecedor: rItem.niFornecedor || rItem.cnpj || rItem.cpfCnpjFornecedor,
                    nomeRazaoSocialFornecedor:
                      rItem.nomeRazaoSocialFornecedor || rItem.nomeFornecedor,
                  }
                  break
                }
              }
            } catch (_) {}
          }
        }

        // Se o preço ainda não estiver explícito, divisão APENAS pelo total do próprio item ÷ quantidade do item
        // PROIBIDO usar valor_global da contratação!
        var qItem = Number(it.quantidade) || 1
        if (vUnit <= 0) {
          var vTotItem =
            Number(it.valorTotalHomologado) ||
            Number(it.valor_total_homologado) ||
            Number(it.valorTotal) ||
            Number(it.valor_total) ||
            0
          if (vTotItem > 0 && qItem > 0) {
            var calcIt = vTotItem / qItem
            if (!isNaN(calcIt) && calcIt > 0) {
              vUnit = calcIt
              natPreco = natPreco || 'homologado'
            }
          }
        }

        // Se ainda não temos preço unitário apurado, DESCARTA O SUBITEM
        if (isNaN(vUnit) || vUnit <= 0) {
          diagLogs.descartes_sem_preco_unitario++
          continue
        }

        var descItemTexto = it.descricao || it.materialOuServicoNome || ''
        var controle =
          entryObj.numeroControlePNCP || entryObj.numero_controle_pncp || entryObj.id || ''
        var chaveDedup = controle + '_' + numItemInt + '_' + vUnit.toFixed(4)

        if (!subItensVistos[chaveDedup]) {
          subItensVistos[chaveDedup] = true
          diagLogs.amostras_validas++
          if (vUnit < 1.0) {
            diagLogs.amostras_abaixo_1_real++
          }

          subItensValidos.push({
            numeroItem: numItemInt,
            descricao: descItemTexto,
            materialOuServico: it.materialOuServico || 'CATMAT',
            materialOuServicoNome: it.materialOuServicoNome || '',
            codigoItem: it.codigoItem || it.codigoMaterialOuServico || '',
            valorUnitarioHomologado: vUnit,
            valorUnitarioEstimado: vEstimado > 0 ? vEstimado : vUnit,
            naturezaPreco: natPreco || 'homologado',
            quantidade: qItem,
            unidadeMedida: extrairUnidadeQualificadaPncp(
              it.unidadeMedida || it.unidade,
              descItemTexto,
            ),
            marcaNome: it.marcaNome || 'NÃO INFORMADO',
            fornecedor: fornecedorFinal || entryObj.fornecedor || null,
          })
        }
      }

      entryObj.itensAta = subItensValidos
      return subItensValidos.length > 0
    }

    // Detalhar contratações com cache + chamada oficial à API do PNCP
    var contratacoesParaDetalhar = []
    for (var cIdx = 0; cIdx < contratacoesUnicas.length; cIdx++) {
      var entry = contratacoesUnicas[cIdx]
      contratacoesParaDetalhar.push(entry)
    }

    // FALHA 1 CORRIGIDA: Retirar detalhamento síncrono pesado da requisição do usuário.
    // O endpoint síncrono resolve o que já está em pncp_item_cache e faz leitura rápida.
    // Todas as contratações recebidas sem subitens detalhados são marcadas como _detalhamento_pendente
    // e ENFILEIRADAS AUTOMATICAMENTE em price_index_tasks para o worker drenar em background.
    var sucessosDetalhamento = 0
    var cacheHits = 0
    var contratacoesNaoDetalhasParaFila = []

    function detalharContratacao(entryItem) {
      var p = extrairParametrosCompra(entryItem)
      var ok = false

      if (p.cnpj && p.ano && p.sequencial) {
        var cacheKey = p.cnpj + '_' + p.ano + '_' + p.sequencial
        var arrItens = null

        // Tenta recuperar do cache persistente pncp_item_cache
        try {
          var cacheRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
          if (cacheRec) {
            var rawCache = cacheRec.get('raw_itens')
            if (rawCache) {
              if (typeof rawCache === 'string') {
                try {
                  arrItens = JSON.parse(rawCache)
                } catch (_) {}
              } else if (Array.isArray(rawCache)) {
                arrItens = rawCache
              }
              if (arrItens && arrItens.length > 0) {
                cacheHits++
              }
            }
          }
        } catch (_) {}

        if (arrItens && arrItens.length > 0) {
          diagLogs.itens_detalhados += arrItens.length
          if (processarItensDaContratacao(entryItem, arrItens, p)) {
            ok = true
            sucessosDetalhamento++
          }
        }
      }

      // Se não obteve subitens reais do cache, marca como pendente
      // JAMAIS cria item sintético com valor global!
      if (!ok || !Array.isArray(entryItem.itensAta) || entryItem.itensAta.length === 0) {
        entryItem._detalhamento_pendente = true
        entryItem._is_contratacao_sem_item = true
        entryItem.itensAta = []
        if (p.cnpj && p.ano && p.sequencial) {
          contratacoesNaoDetalhasParaFila.push({
            cnpj: p.cnpj,
            ano: p.ano,
            sequencial: p.sequencial,
            orgao:
              (entryItem.orgaoEntidade && entryItem.orgaoEntidade.razaoSocial) ||
              entryItem.orgao_nome ||
              '',
            uf:
              entryItem.uf ||
              (entryItem.municipio_uf ? entryItem.municipio_uf.split('-')[1] : '') ||
              uf ||
              '',
            municipio: entryItem.municipio_nome || entryItem.municipio || '',
            numeroControlePNCP:
              entryItem.numeroControlePNCP ||
              entryItem.numero_controle_pncp ||
              p.cnpj + '-' + p.ano + '-' + p.sequencial,
          })
        }
      }
    }

    // Processa contratações contra cache (rápido, sem bloqueio de 2.5s)
    for (var d = 0; d < contratacoesParaDetalhar.length; d++) {
      detalharContratacao(contratacoesParaDetalhar[d])
    }

    // Enfileira automaticamente contratações pendentes em price_index_tasks (para o worker processar em background)
    // Armazena payload compacto [cnpj, ano, sequencial, tipoDoc] com limite de segurança para nunca estourar o limite de 1MB do PocketBase
    if (contratacoesNaoDetalhasParaFila.length > 0) {
      try {
        var colTasks = $app.findCollectionByNameOrId('price_index_tasks')
        var taskKeyGeral = 'PNCP_PENDENTES#' + (q || '').toUpperCase().trim() + '#' + (uf || 'BR')
        var taskGeral = null
        try {
          taskGeral = $app.findFirstRecordByData('price_index_tasks', 'task_key', taskKeyGeral)
        } catch (_) {}

        var agoraIso = new Date().toISOString()
        var MAX_PENDENTES_QUEUE = 300 // Mantém tamanho seguro bem abaixo do limite de 1MB

        if (taskGeral) {
          var pendExist = []
          try {
            var rawP = taskGeral.getString('pendentes')
            if (rawP) {
              var parsedP = JSON.parse(rawP)
              if (Array.isArray(parsedP)) pendExist = parsedP
            }
          } catch (_) {}

          var vistosKeys = {}
          for (var v = 0; v < pendExist.length; v++) {
            var pEntry = pendExist[v]
            var kEx =
              (pEntry.c || pEntry.cnpj) +
              '_' +
              (pEntry.a || pEntry.ano) +
              '_' +
              (pEntry.s || pEntry.sequencial)
            vistosKeys[kEx] = true
          }

          for (var n = 0; n < contratacoesNaoDetalhasParaFila.length; n++) {
            if (pendExist.length >= MAX_PENDENTES_QUEUE) break
            var cItem = contratacoesNaoDetalhasParaFila[n]
            var kItem = cItem.cnpj + '_' + cItem.ano + '_' + cItem.sequencial
            if (!vistosKeys[kItem]) {
              vistosKeys[kItem] = true
              pendExist.push({
                c: cItem.cnpj,
                a: cItem.ano,
                s: cItem.sequencial,
                u: cItem.uf || '',
                m: (cItem.municipio || '').slice(0, 40),
                o: (cItem.orgao || '').slice(0, 80),
              })
            }
          }

          taskGeral.set('pendentes', JSON.stringify(pendExist))
          if (
            taskGeral.getString('status') === 'completed' ||
            taskGeral.getString('status') === 'failed'
          ) {
            taskGeral.set('status', 'pending')
            taskGeral.set('tentativas', 0)
          }
          $app.save(taskGeral)
        } else {
          var listaCompacta = []
          for (
            var idxC = 0;
            idxC < Math.min(MAX_PENDENTES_QUEUE, contratacoesNaoDetalhasParaFila.length);
            idxC++
          ) {
            var cInit = contratacoesNaoDetalhasParaFila[idxC]
            listaCompacta.push({
              c: cInit.cnpj,
              a: cInit.ano,
              s: cInit.sequencial,
              u: cInit.uf || '',
              m: (cInit.municipio || '').slice(0, 40),
              o: (cInit.orgao || '').slice(0, 80),
            })
          }

          var novaTask = new Record(colTasks)
          novaTask.set('task_key', taskKeyGeral)
          novaTask.set('source', 'PNCP')
          novaTask.set('termo', q || '')
          novaTask.set('uf', uf || '')
          novaTask.set('status', 'pending')
          novaTask.set('pendentes', JSON.stringify(listaCompacta))
          novaTask.set('paginas_consultadas', 0)
          novaTask.set('itens_processados', 0)
          novaTask.set('amostras_inseridas', 0)
          novaTask.set('amostras_atualizadas', 0)
          novaTask.set('tentativas', 0)
          $app.save(novaTask)
        }
      } catch (errTaskQueue) {
        console.log(
          '[PNCP-PROXY] Aviso ao enfileirar contratações pendentes:',
          errTaskQueue.message,
        )
      }
    }

    var totalAmostrasFinais = 0
    var itensFilaPendente = 0
    for (var f = 0; f < contratacoesUnicas.length; f++) {
      if (Array.isArray(contratacoesUnicas[f].itensAta)) {
        totalAmostrasFinais += contratacoesUnicas[f].itensAta.length
      }
      if (contratacoesUnicas[f]._detalhamento_pendente) {
        itensFilaPendente++
      }
    }

    diagLogs.tempo_total_ms = new Date().getTime() - tInicioProxy

    return e.json(200, {
      sucesso: true,
      items: contratacoesUnicas,
      total: maxTotalRegistros || todasContratacoesBrutas.length,
      totalRegistros: maxTotalRegistros || todasContratacoesBrutas.length,
      totalPaginas: maxTotalPaginas || 1,
      paginaAtual: paginaParam,
      tamPagina: tamPaginaParam,
      tipoDocumento: tiposDocumentos.join(','),
      detalhamento_paralelo: {
        total_encontrado: contratacoesUnicas.length,
        total_detalhado: sucessosDetalhamento,
        itens_fila_pendente: itensFilaPendente,
        cache_hits: cacheHits,
        amostras_extraidas: totalAmostrasFinais,
        amostras_abaixo_1_real: diagLogs.amostras_abaixo_1_real,
      },
      diagnostico_fluxo: {
        api_origem: 'PNCP (pncp.gov.br)',
        registros_informados_api: maxTotalRegistros || todasContratacoesBrutas.length,
        contratacoes_pagina_recebidas: contratacoesUnicas.length,
        amostras_processadas: totalAmostrasFinais,
        itens_fila_pendente: itensFilaPendente,
        detalhes: diagLogs,
      },
    })
  } catch (globalErr) {
    console.log('[PNCP-PROXY] Exceção tratada no hook:', globalErr.message)
    return e.json(502, {
      error: 'PNCP_UPSTREAM_UNAVAILABLE',
      message:
        'A API pública do PNCP está temporariamente inacessível ou ocorreu falha de comunicação.',
      detail: globalErr.message || 'Erro inesperado no proxy',
    })
  }
})
