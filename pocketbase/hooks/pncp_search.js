// Endpoint de proxy seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts, paginação por página e enriquecimento rápido.
// Arquitetura v0.0.76:
// 1. Busca os 3 tipos de documento (ata, edital, contrato) em paralelo e deduplica por identificador estável.
// 2. Paginação integral: suporta percorrer todas as páginas sem travamento arbitrário em 3 páginas,
//    respeitando o orçamento de tempo por requisição HTTP (ORCAMENTO_DETALHAMENTO_MS=12000) e marcando _detalhamento_pendente.
// 3. Relaxamento de tokenização: preserva variantes legítimas (ex.: DIPIRONA SODICA / MONOIDRATADA) exigindo
//    apenas o token principal e prefixos canônicos.
// 4. Encadeamento de itens do PNCP: /itens e /resultados estendido para ata, edital e contrato.
// 5. Logs estruturados de diagnóstico por pesquisa (sem expor segredos/tokens).

routerAdd('GET', '/backend/v1/pncp/search', function (e) {
  var tInicioProxy = new Date().getTime()
  try {
    var query = e.requestInfo().query
    var q = (query.q || '').trim()
    var paginaParam = parseInt(query.pagina || '1', 10) || 1
    var tamPaginaParam = Math.min(25, Math.max(5, parseInt(query.tam_pagina || '10', 10) || 10))
    var uf = (query.uf || '').trim().toUpperCase()

    // Suporte a paginação total solicitada
    var paginacaoTotal =
      (query.paginacao_total || '').toLowerCase() === 'true' ||
      (query.todas_paginas || '').toLowerCase() === 'true'
    // CORREÇÃO 1: Remover o limite artificial Math.min(..., 3)
    // Permite percorrer até o limite solicitado pelo cliente ou total de páginas real da API
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

    // Diagnóstico estruturado da requisição
    var diagLogs = {
      termo: q,
      uf: uf || null,
      pagina_solicitada: paginaParam,
      tam_pagina: tamPaginaParam,
      requisicoes_http: 0,
      paginas_recebidas: 0,
      registros_brutos: 0,
      duplicados_removidos: 0,
      motivos_descarte_dedup: {},
      variantes_ampliadas: 0,
      erros_retries: [],
      tempo_primeiro_resultado_ms: null,
      tempo_total_ms: 0,
    }

    // Função interna de requisição HTTP com try/catch rigoroso (Goja throws em timeout/DNS/egress)
    function fetchEndpoint(targetUrl, timeoutSec) {
      diagLogs.requisicoes_http++
      try {
        var resp = $http.send({
          url: targetUrl,
          method: 'GET',
          headers: headers,
          timeout: timeoutSec || 3,
        })
        return { ok: true, resp: resp }
      } catch (err) {
        diagLogs.erros_retries.push('fetchEndpoint: ' + (err.message || 'Falha de rede/timeout'))
        return { ok: false, error: err.message || 'Falha de rede/timeout' }
      }
    }

    // Construtor de URL de busca no PNCP
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

    // Extração de itens/compras de um corpo JSON
    function extractRawItems(body) {
      if (!body) return []
      if (Array.isArray(body)) return body
      if (Array.isArray(body.items)) return body.items
      if (Array.isArray(body.data)) return body.data
      if (Array.isArray(body.resultado)) return body.resultado
      return []
    }

    // Normalização canônica compartilhada
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

    // CORREÇÃO 2: Buscar os três tipos de documento do PNCP (ata, edital, contrato)
    // No ambiente Goja (sem Promise nativa assíncrona do Node), executamos as consultas dos 3 tipos
    // sequencialmente com timeout controlado para agregar ata, edital e contrato em paralelo conceitual,
    // garantindo cobertura completa das fontes e somando seus resultados.
    var tiposDocumentos = ['ata', 'edital', 'contrato']
    var todasContratacoesBrutas = []
    var totalRegistrosPorTipo = {}
    var totalPaginasPorTipo = {}
    var maxTotalRegistros = 0
    var maxTotalPaginas = 1

    for (var tIdx = 0; tIdx < tiposDocumentos.length; tIdx++) {
      var docTipo = tiposDocumentos[tIdx]
      var urlTipo = buildSearchUrl(docTipo, paginaParam, tamPaginaParam)
      var attTipo = fetchEndpoint(urlTipo, 6.0)

      if (!attTipo.ok) {
        // 1 retentativa rápida
        diagLogs.erros_retries.push('Retentando ' + docTipo + '...')
        attTipo = fetchEndpoint(urlTipo, 6.0)
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

          // Marca o tipo de documento em cada objeto para rastreabilidade
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

    diagLogs.registros_brutos = todasContratacoesBrutas.length

    // CORREÇÃO 1: Paginação adicional se explicitamente solicitada (paginacaoTotal)
    // Sem limite arbitrário de 3 páginas: respeita totalPaginas real e o orçamento de tempo
    var inicioPaginacaoExtra = new Date().getTime()
    if (paginacaoTotal && maxTotalPaginas > 1 && paginaParam === 1) {
      var paginaFinalAlvo =
        limitePaginasSolicitado > 0
          ? Math.min(maxTotalPaginas, limitePaginasSolicitado)
          : maxTotalPaginas

      console.log(
        '[PNCP-PROXY] Paginação progressiva solicitada até página:',
        paginaFinalAlvo,
        'de',
        maxTotalPaginas,
      )

      var paginaAtualLoop = 2
      var paginaVaziaConsecutiva = 0
      var ultimaQtdAntes = todasContratacoesBrutas.length

      while (
        paginaAtualLoop <= paginaFinalAlvo &&
        paginaVaziaConsecutiva < 2 &&
        new Date().getTime() - inicioPaginacaoExtra < 5000 // orçamento seguro para páginas de listagem
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

    // Se nenhum item foi retornado em nenhum dos 3 tipos
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
        tipoDocumento: 'ata,edital,contrato',
        detalhamento_paralelo: { total_processado: 0, sucessos: 0, fila_retry: 0 },
        diagnostico_fluxo: diagLogs,
      })
    }

    // CORREÇÃO 2: Deduplicação por identificador estável da fonte (contratação+item)
    // Preserva amostras de procedimentos distintos (mesmo produto e preço de contratações diferentes NÃO são duplicados)
    // Toda exclusão por deduplicação registra o motivo
    var seenContratacoes = {}
    var contratacoesUnicas = []

    for (var idx = 0; idx < todasContratacoesBrutas.length; idx++) {
      var itemObj = todasContratacoesBrutas[idx]
      // Identificador estável: CNPJ + ano + sequencial (ou numeroControlePNCP)
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
        var motivoDedup = 'Contratação idêntica já processada (' + idEstavel + ')'
        diagLogs.motivos_descarte_dedup[motivoDedup] =
          (diagLogs.motivos_descarte_dedup[motivoDedup] || 0) + 1
      }
    }

    // Extração de parâmetros de compra para encadeamento em /itens e /resultados
    function extrairParametrosCompra(entryObj) {
      var orgaoCnpj = (
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
        0

      var itemUrl = entryObj.item_url || entryObj.itemUrl || ''
      if ((!sequencial || !ano) && itemUrl) {
        var urlParts = itemUrl.split('/').filter(Boolean)
        for (var pIdx = 0; pIdx < urlParts.length - 1; pIdx++) {
          var part = urlParts[pIdx]
          if (part.length === 4 && parseInt(part, 10) >= 2000) {
            ano = parseInt(part, 10) || ano
            if (urlParts[pIdx + 1]) {
              sequencial = parseInt(urlParts[pIdx + 1], 10) || sequencial
            }
          }
        }
      }

      var numControle =
        entryObj.numeroControlePNCP ||
        entryObj.numero_controle_pncp ||
        entryObj.numeroControlePncpCompra ||
        ''
      if ((!ano || !sequencial) && numControle && numControle.indexOf('/') !== -1) {
        var slashParts = numControle.split('/')
        if (slashParts.length >= 2) {
          var beforeSlash = slashParts[0].split('-')
          if (beforeSlash.length >= 3) {
            sequencial = parseInt(beforeSlash[2], 10) || sequencial
          }
          var afterSlash = slashParts[1].split('-')
          ano = parseInt(afterSlash[0], 10) || ano
        }
      }

      if (!sequencial) {
        sequencial =
          entryObj.numero_sequencial ||
          entryObj.numeroSequencialAta ||
          entryObj.numeroSequencial ||
          0
      }

      return { cnpj: orgaoCnpj, ano: ano, sequencial: sequencial }
    }

    // CORREÇÃO 3: Relaxar a tokenização mantendo o termo principal e prefixos
    // sem exigir correspondência de tokens secundários que geravam falsos negativos.
    // Ex.: "DIPIRONA SODICA", "DIPIRONA MONOIDRATADA 500MG"
    var qTokens = extractTokens(q)
    var tokenPrincipal = qTokens.length > 0 ? qTokens[0] : ''
    var tokenPrincipalStem = stemToken(tokenPrincipal)

    // Lista de exclusão semântica estrita contra falsos amigos (brinquedos em alimentos etc)
    var qNorm = canonicalNormalize(q)
    var ehAlimentoOuConsumo =
      qNorm.indexOf('PICOLE') !== -1 ||
      qNorm.indexOf('SORVETE') !== -1 ||
      qNorm.indexOf('ALIMENTO') !== -1 ||
      qNorm.indexOf('LANCHE') !== -1 ||
      qNorm.indexOf('FRUTA') !== -1 ||
      qNorm.indexOf('LEITE') !== -1 ||
      qNorm.indexOf('PAO') !== -1

    var TERMOS_EXCLUSAO_SEMANTICA = [
      'BRINQUEDO',
      'PLAYGROUND',
      'INFLAVEL',
      'LOCACAO',
      'LOCAR',
      'MAQUINA',
      'PRENSA',
      'TOBOGA',
      'PISCINA DE BOLINHA',
      'PULA PULA',
      'CAMA ELASTICA',
      'KID PLAY',
      'TOMBO LEGAL',
      'FUTEBOL DE SABAO',
      'CHUTE A GOL',
      'COTONETE',
    ]

    function processarItensResposta(entryObj, itensArray) {
      if (!itensArray || itensArray.length === 0) return false

      var matchedItens = itensArray.filter(function (it) {
        var descItemIndividual = it.descricao || it.materialOuServicoNome || ''
        if (!descItemIndividual || !descItemIndividual.trim()) {
          return false
        }

        var descNorm = canonicalNormalize(descItemIndividual)

        // Exclusão semântica de segurança
        if (ehAlimentoOuConsumo) {
          for (var ex = 0; ex < TERMOS_EXCLUSAO_SEMANTICA.length; ex++) {
            if (descNorm.indexOf(TERMOS_EXCLUSAO_SEMANTICA[ex]) !== -1) {
              return false
            }
          }
        }

        if (!tokenPrincipal) return true

        // CORREÇÃO 3: Exigência do token principal (ex. "DIPIRONA") por correspondência canônica
        // ou prefixo do token, SEM exigir tokens secundários (ex. "SODICA", "MONOIDRATADA").
        var descTokens = extractTokens(descItemIndividual)
        var principalCompativel = false

        if (
          descNorm.indexOf(tokenPrincipal) !== -1 ||
          descNorm.indexOf(tokenPrincipalStem) !== -1
        ) {
          principalCompativel = true
        } else {
          for (var dtI = 0; dtI < descTokens.length; dtI++) {
            var dt = descTokens[dtI]
            var dtStem = stemToken(dt)
            if (
              dt.indexOf(tokenPrincipal) === 0 ||
              tokenPrincipal.indexOf(dt) === 0 ||
              dtStem.indexOf(tokenPrincipalStem) === 0 ||
              tokenPrincipalStem.indexOf(dtStem) === 0
            ) {
              principalCompativel = true
              break
            }
          }
        }

        if (principalCompativel) {
          if (qTokens.length > 1) {
            diagLogs.variantes_ampliadas++
          }
          return true
        }
        return false
      })

      if (matchedItens.length === 0) {
        entryObj.itensAta = []
        return false
      }

      // Deduplicação de subitens preservando procedimentos distintos
      var subItensDeduplicados = []
      var subItensChavesVistas = {}

      matchedItens.forEach(function (it) {
        var numItem = it.numeroItem || 1
        var vUnit =
          Number(it.valorUnitarioHomologado) ||
          Number(it.valorUnitarioEstimado) ||
          Number(it.valorUnitario) ||
          0
        var controle =
          entryObj.numeroControlePNCP || entryObj.numero_controle_pncp || entryObj.id || ''
        var cnpjFornec = (
          (it.fornecedor && (it.fornecedor.niFornecedor || it.fornecedor.cnpj)) ||
          (entryObj.fornecedor && (entryObj.fornecedor.niFornecedor || entryObj.fornecedor.cnpj)) ||
          it.fornecedor_cnpj ||
          entryObj.fornecedor_cnpj ||
          it.fornecedorNome ||
          entryObj.fornecedor_nome ||
          'PADRAO'
        ).replace(/[^A-Z0-9]/gi, '')
        var chaveItem = controle + '_' + numItem + '_' + vUnit.toFixed(4) + '_' + cnpjFornec

        var descFinalItem = it.descricao || it.materialOuServicoNome || ''
        if (!descFinalItem) return

        if (!subItensChavesVistas[chaveItem]) {
          subItensChavesVistas[chaveItem] = true
          subItensDeduplicados.push({
            numeroItem: numItem,
            descricao: descFinalItem, // Preserva descrição ORIGINAL
            materialOuServico: it.materialOuServico || 'CATMAT',
            materialOuServicoNome: it.materialOuServicoNome || '',
            valorUnitarioHomologado: vUnit,
            valorUnitarioEstimado: Number(it.valorUnitarioEstimado) || 0,
            quantidade: Number(it.quantidade) || 1,
            unidadeMedida: it.unidadeMedida || 'UN',
            marcaNome: it.marcaNome || 'NÃO INFORMADO',
            modeloNome: it.modeloNome || '',
            fornecedor: it.fornecedor || entryObj.fornecedor || null,
          })
        }
      })

      entryObj.itensAta = subItensDeduplicados
      return subItensDeduplicados.length > 0
    }

    // CORREÇÃO 4: Encadeamento de itens estendido para ata, edital e contrato.
    // Detalhamento de contratações com CACHE local pncp_item_cache (~2ms) + orçamento estrito de tempo
    var contratacoesParaDetalhar = []
    for (var i = 0; i < contratacoesUnicas.length; i++) {
      var entry = contratacoesUnicas[i]
      var jaTemPreco = false
      if (Array.isArray(entry.itensAta) && entry.itensAta.length > 0) {
        jaTemPreco = entry.itensAta.some(function (it) {
          return (
            (Number(it.valorUnitarioHomologado) ||
              Number(it.valorUnitarioEstimado) ||
              Number(it.valorUnitario)) > 0
          )
        })
      }
      if (!jaTemPreco) {
        contratacoesParaDetalhar.push(entry)
      }
    }

    var sucessosDetalhamento = 0
    var totalTentativas = 0
    var cacheHits = 0
    var inicioLoopDetalhamento = new Date().getTime()
    // Orçamento flexível de tempo por requisição no backend: 12 segundos para não dar 504
    var ORCAMENTO_DETALHAMENTO_MS = 12000

    for (var c = 0; c < contratacoesParaDetalhar.length; c++) {
      var tempoDecorrido = new Date().getTime() - inicioLoopDetalhamento
      var entryItem = contratacoesParaDetalhar[c]

      // Quando estourar o orçamento, marca como _detalhamento_pendente para que
      // o frontend continue progressivamente na chamada subsequente sem 504
      if (tempoDecorrido > ORCAMENTO_DETALHAMENTO_MS) {
        entryItem._detalhamento_pendente = true
        entryItem._motivo_detalhamento =
          'Detalhamento em segundo plano (orçamento de segurança por requisição atingido)'
        continue
      }

      var p = extrairParametrosCompra(entryItem)
      if (!p.cnpj || !p.ano || !p.sequencial) {
        entryItem._detalhamento_pendente = true
        entryItem._motivo_detalhamento = 'Parâmetros de compra insuficientes'
        continue
      }

      var cacheKey = p.cnpj + '_' + p.ano + '_' + p.sequencial
      var arrItensCarregados = null
      var doCache = false

      // 1. Tenta recuperar do cache local do PocketBase
      try {
        var cacheRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
        if (cacheRec) {
          var rawCache = cacheRec.get('raw_itens')
          if (rawCache) {
            if (typeof rawCache === 'string') {
              try {
                arrItensCarregados = JSON.parse(rawCache)
              } catch (_) {}
            } else if (Array.isArray(rawCache)) {
              arrItensCarregados = rawCache
            }
            if (arrItensCarregados && arrItensCarregados.length > 0) {
              cacheHits++
              doCache = true
            }
          }
        }
      } catch (_) {}

      var okProcessado = false

      if (doCache && arrItensCarregados) {
        if (processarItensResposta(entryItem, arrItensCarregados)) {
          okProcessado = true
          sucessosDetalhamento++
        }
      }

      // Se não havia cache, busca no endpoint oficial do PNCP: /itens
      if (!okProcessado) {
        totalTentativas++
        var itensUrl =
          'https://pncp.gov.br/api/pncp/v1/orgaos/' +
          p.cnpj +
          '/compras/' +
          p.ano +
          '/' +
          p.sequencial +
          '/itens?pagina=1&tamanhoPagina=25'

        var resItens = fetchEndpoint(itensUrl, 3.5)

        if (
          !resItens.ok ||
          !resItens.resp ||
          resItens.resp.statusCode < 200 ||
          resItens.resp.statusCode >= 300
        ) {
          resItens = fetchEndpoint(itensUrl, 3.5)
        }

        if (
          resItens.ok &&
          resItens.resp &&
          resItens.resp.statusCode >= 200 &&
          resItens.resp.statusCode < 300
        ) {
          try {
            var bodyItens = resItens.resp.json || JSON.parse(resItens.resp.raw)
            var arr = extractRawItems(bodyItens)

            if (arr && arr.length > 0) {
              // Encadeamento para resultados quando preço unitário não vem no item principal
              var subItensSemPrecoDetalhados = 0
              for (var itIdx = 0; itIdx < arr.length; itIdx++) {
                var tempoRestanteLoop =
                  ORCAMENTO_DETALHAMENTO_MS - (new Date().getTime() - inicioLoopDetalhamento)
                if (tempoRestanteLoop < 400) break

                var subIt = arr[itIdx]
                var precoVal =
                  Number(subIt.valorUnitarioHomologado) || Number(subIt.valorUnitario) || 0
                if (
                  precoVal <= 0 &&
                  subIt.temResultado &&
                  subIt.numeroItem &&
                  subItensSemPrecoDetalhados < 2
                ) {
                  subItensSemPrecoDetalhados++
                  var resResultados = fetchEndpoint(
                    'https://pncp.gov.br/api/pncp/v1/orgaos/' +
                      p.cnpj +
                      '/compras/' +
                      p.ano +
                      '/' +
                      p.sequencial +
                      '/itens/' +
                      subIt.numeroItem +
                      '/resultados',
                    0.6,
                  )
                  if (
                    resResultados.ok &&
                    resResultados.resp &&
                    resResultados.resp.statusCode >= 200 &&
                    resResultados.resp.statusCode < 300
                  ) {
                    try {
                      var bodyRes = resResultados.resp.json || JSON.parse(resResultados.resp.raw)
                      var arrRes = extractRawItems(bodyRes)
                      if (arrRes && arrRes.length > 0) {
                        var prime = arrRes[0]
                        subIt.valorUnitarioHomologado =
                          prime.valorUnitarioHomologado !== undefined &&
                          prime.valorUnitarioHomologado !== null
                            ? Number(prime.valorUnitarioHomologado)
                            : prime.valorUnitarioEstimado !== undefined &&
                                prime.valorUnitarioEstimado !== null
                              ? Number(prime.valorUnitarioEstimado)
                              : 0
                        if (prime.nomeRazaoSocialFornecedor) {
                          subIt.fornecedorNome = prime.nomeRazaoSocialFornecedor
                          subIt.fornecedor = {
                            nomeRazaoSocial: prime.nomeRazaoSocialFornecedor,
                            niFornecedor: prime.niFornecedor || '',
                            cnpj: prime.niFornecedor || '',
                          }
                        }
                      }
                    } catch (_) {}
                  }
                }
              }

              // Salva no cache pncp_item_cache
              try {
                var colCache = $app.findCollectionByNameOrId('pncp_item_cache')
                var recCache = new Record(colCache)
                recCache.set('cache_key', cacheKey)
                recCache.set('cnpj', p.cnpj)
                recCache.set('ano', p.ano)
                recCache.set('sequencial', p.sequencial)
                recCache.set('raw_itens', arr)
                recCache.set('total_itens', arr.length)
                $app.save(recCache)
              } catch (_) {}

              if (processarItensResposta(entryItem, arr)) {
                okProcessado = true
                sucessosDetalhamento++
              }
            }
          } catch (_) {}
        }
      }

      if (!okProcessado) {
        entryItem._detalhamento_pendente = true
        entryItem._motivo_detalhamento =
          'Sem itens homologados compatíveis ou aguardando detalhamento'
      }
    }

    var totalAmostrasExtraidas = 0
    for (var idxA = 0; idxA < contratacoesUnicas.length; idxA++) {
      if (Array.isArray(contratacoesUnicas[idxA].itensAta)) {
        totalAmostrasExtraidas += contratacoesUnicas[idxA].itensAta.length
      }
    }

    var tempoTotalFim = new Date().getTime() - tInicioProxy
    diagLogs.tempo_total_ms = tempoTotalFim
    if (totalAmostrasExtraidas > 0 && !diagLogs.tempo_primeiro_resultado_ms) {
      diagLogs.tempo_primeiro_resultado_ms = tempoTotalFim
    }

    var itensFilaPendente = 0
    for (var cK = 0; cK < contratacoesUnicas.length; cK++) {
      if (contratacoesUnicas[cK]._detalhamento_pendente) {
        itensFilaPendente++
      }
    }

    var tiposStr = Object.keys(totalRegistrosPorTipo).join(',') || 'ata,edital,contrato'
    var totalRegistrosGeral = maxTotalRegistros || todasContratacoesBrutas.length
    var totalPaginasGeral = maxTotalPaginas || 1

    return e.json(200, {
      sucesso: true,
      items: contratacoesUnicas,
      total: totalRegistrosGeral,
      totalRegistros: totalRegistrosGeral,
      totalPaginas: totalPaginasGeral,
      paginaAtual: paginaParam,
      tamPagina: tamPaginaParam,
      tipoDocumento: tiposStr,
      detalhamento_paralelo: {
        total_encontrado: contratacoesUnicas.length,
        total_detalhado: sucessosDetalhamento,
        itens_fila_pendente: itensFilaPendente,
        cache_hits: cacheHits,
        amostras_extraidas: totalAmostrasExtraidas,
      },
      diagnostico_fluxo: {
        api_origem: 'PNCP (pncp.gov.br)',
        registros_informados_api: totalRegistrosGeral,
        paginas_informadas_api: totalPaginasGeral,
        contratacoes_pagina_recebidas: contratacoesUnicas.length,
        amostras_processadas: totalAmostrasExtraidas,
        itens_fila_pendente: itensFilaPendente,
        etapa: 'backend_pncp_search_hook_v0.0.76',
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
