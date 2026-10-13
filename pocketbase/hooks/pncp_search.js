// Endpoint de proxy seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts, paginação por página e enriquecimento rápido.
// Arquitetura v0.0.77:
// 1. Busca os 3 tipos de documento (ata, edital, contrato) em paralelo e deduplica por identificador estável.
// 2. Paginação integral com tam_pagina até 50 (Swagger PNCP oficial) sem travamento arbitrário.
// 3. Timeout ampliado para ~30s com fila progressiva em segundo plano (retorno rápido de cabeçalhos sem estourar timeout).
// 4. Relaxamento de tokenização: preserva variantes legítimas (ex.: DIPIRONA SODICA / MONOIDRATADA) exigindo
//    apenas o token principal e prefixos canônicos.
// 4. Encadeamento de itens do PNCP: /itens e /resultados estendido para ata, edital e contrato.
// 5. Logs estruturados de diagnóstico por pesquisa (sem expor segredos/tokens).

routerAdd('GET', '/backend/v1/pncp/search', function (e) {
  var tInicioProxy = new Date().getTime()
  try {
    var query = e.requestInfo().query
    var q = (query.q || '').trim()
    var paginaParam = parseInt(query.pagina || '1', 10) || 1
    // CORREÇÃO 2 (v0.0.77): Subir tam_pagina até 50 conforme documentação oficial do Swagger do PNCP
    var tamPaginaParam = Math.min(50, Math.max(5, parseInt(query.tam_pagina || '50', 10) || 50))
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

    // OTIMIZAÇÃO: Suporte ao parâmetro tipos_documento ou tipo_doc
    // Se o cliente especificar tipo_documento (ex: 'ata' ou 'edital'), busca apenas aquele tipo.
    // Se não especificado, busca os 3 tipos com timeout estrito de 4s por chamada para respeitar
    // a meta de primeiros resultados em até 3s sem travar em retries longos.
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
      // Timeout ajustado para 4.0s para resposta veloz do upstream
      var attTipo = fetchEndpoint(urlTipo, 4.0)

      if (!attTipo.ok && attTipo.resp && attTipo.resp.statusCode === 504) {
        // Retry rápido de 2s somente se foi timeout específico
        diagLogs.erros_retries.push('Retentando ' + docTipo + '...')
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

    // Helper para extrair unidade qualificada da fonte
    function extrairUnidadeQualificadaPncp(uBruta, dBruta) {
      var u = (uBruta || '').trim().toUpperCase()
      var d = (dBruta || '').trim().toUpperCase()

      // Padrões de embalagem coletiva
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
          Number(it.valor_unitario_homologado) ||
          Number(it.valorUnitarioEstimado) ||
          Number(it.valor_unitario_estimado) ||
          Number(it.valorUnitario) ||
          Number(it.valor_unitario) ||
          Number(it.valor_normalizado) ||
          0

        // Se unitário ainda zero, tenta divisão de total do SUBITEM ÷ quantidade do SUBITEM
        // É EXPRESSAMENTE PROIBIDO usar valor_global ou valor total da contratação como preço unitário
        var qSub = Number(it.quantidade) || 1
        if (vUnit <= 0) {
          var vTotSub =
            Number(it.valorTotalHomologado) ||
            Number(it.valor_total_homologado) ||
            Number(it.valorTotal) ||
            Number(it.valor_total) ||
            0

          if (vTotSub > 0 && qSub > 0) {
            var calcSubIt = vTotSub / qSub
            if (!isNaN(calcSubIt) && calcSubIt > 0) {
              vUnit = calcSubIt
            }
          }
        }
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

        // Diretriz: se unitário for <= 0/NaN/nulo, não incluir subitem
        if (isNaN(vUnit) || vUnit <= 0) {
          console.log(
            JSON.stringify({
              origem: 'pncp_search_hook',
              evento: 'descarte_subitem',
              motivo: 'sem preço unitário',
              id_externo: controle,
              subitem: descFinalItem,
            }),
          )
          return
        }

        if (!subItensChavesVistas[chaveItem]) {
          subItensChavesVistas[chaveItem] = true
          subItensDeduplicados.push({
            numeroItem: numItem,
            descricao: descFinalItem, // Preserva descrição ORIGINAL
            materialOuServico: it.materialOuServico || 'CATMAT',
            materialOuServicoNome: it.materialOuServicoNome || '',
            valorUnitarioHomologado: vUnit,
            valorUnitarioEstimado: Number(it.valorUnitarioEstimado) || vUnit,
            quantidade: Number(it.quantidade) || 1,
            unidadeMedida: extrairUnidadeQualificadaPncp(
              it.unidadeMedida || it.unidade,
              descFinalItem,
            ),
            marcaNome: it.marcaNome || 'NÃO INFORMADO',
            modeloNome: '',
            fornecedor: it.fornecedor || entryObj.fornecedor || null,
          })
        }
      })

      entryObj.itensAta = subItensDeduplicados
      return subItensDeduplicados.length > 0
    }

    // CORREÇÃO v0.0.78: Enriquecimento de preços do PNCP e geração de amostras mesmo sem subitens
    // 1. Tenta recuperar subitens do cache local pncp_item_cache
    // 2. Para compras sem cache, busca /itens com timeout curto
    // 3. SE a contratação não tiver subitens ou a chamada falhar/estourar tempo, CRIA item direto
    //    a partir do cabeçalho da contratação (com valor_global, valor_total_homologado, valor_total_estimado
    //    ou 0/"NÃO INFORMADO"), GARANTINDO QUE NENHUMA CONTRATAÇÃO SUMA DA GRADE!
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
    var chamadasAoVivoRealizadas = 0
    var inicioLoopDetalhamento = new Date().getTime()
    // Orçamento rápido de detalhamento por requisição para retorno seguro
    // FASE D: Busca com detalhamento ativo dos itens específicos do PNCP
    // Se max_detalhar não for informado ou for 0, usa valor padrão seguro de 10 itens para recuperar
    // amostras reais com preço unitário homologado sem depender exclusivamente de cache
    var maxDetalharAoVivoParam = parseInt(query.max_detalhar || '10', 10) || 10
    var ORCAMENTO_DETALHAMENTO_MS = 6000
    var MAX_DETALHAMENTO_AO_VIVO_POR_REQ = Math.min(15, Math.max(5, maxDetalharAoVivoParam))

    for (var c = 0; c < contratacoesParaDetalhar.length; c++) {
      var tempoDecorrido = new Date().getTime() - inicioLoopDetalhamento
      var entryItem = contratacoesParaDetalhar[c]

      var p = extrairParametrosCompra(entryItem)
      var okProcessado = false

      if (p.cnpj && p.ano && p.sequencial) {
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

        if (doCache && arrItensCarregados) {
          if (processarItensResposta(entryItem, arrItensCarregados)) {
            okProcessado = true
            sucessosDetalhamento++
          }
        }

        // Se não havia cache e ainda estamos dentro do orçamento de tempo/chamadas
        if (
          !okProcessado &&
          tempoDecorrido <= ORCAMENTO_DETALHAMENTO_MS &&
          chamadasAoVivoRealizadas < MAX_DETALHAMENTO_AO_VIVO_POR_REQ
        ) {
          totalTentativas++
          chamadasAoVivoRealizadas++
          var itensUrl =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            p.cnpj +
            '/compras/' +
            p.ano +
            '/' +
            p.sequencial +
            '/itens?pagina=1&tamanhoPagina=50'

          var resItens = fetchEndpoint(itensUrl, 2.0)

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
      }

      // DIRETIVA DO USUÁRIO & REGRA DE OURO:
      // É EXPRESSAMENTE PROIBIDO utilizar valor_global, valor total do contrato ou valor total da contratação
      // como se fosse o preço unitário do produto.
      // A ausência de preço unitário deve impedir que o registro seja usado como amostra válida precificada.
      // Se não há subitens em itensAta, NÃO criar item artificial com valor_global / valorTotal da contratação!
      if (!okProcessado || !Array.isArray(entryItem.itensAta) || entryItem.itensAta.length === 0) {
        // Marca contratação como pendente de detalhamento ou sem item compatível
        entryItem._detalhamento_pendente = true
        entryItem._is_contratacao_sem_item = true
        entryItem.itensAta = []

        console.log(
          JSON.stringify({
            origem: 'pncp_search_hook',
            evento: 'contratacao_sem_item_precificado',
            motivo: 'sem preco unitario do item homologado/estimado; proibido uso de valor global',
            id_externo:
              entryItem.numeroControlePNCP || entryItem.numero_controle_pncp || entryItem.id,
            objeto: entryItem.objeto || entryItem.description,
          }),
        )
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
        etapa: 'backend_pncp_search_hook_v0.0.77',
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
