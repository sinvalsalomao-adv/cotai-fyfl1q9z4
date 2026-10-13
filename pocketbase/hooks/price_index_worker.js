// Worker/Processador de Tarefas da Fila price_index_tasks
// Executado periodicamente via cronAdd ("*/1 * * * *") no PocketBase e acionável via POST /backend/v1/tasks/process
// Processa tarefas pendentes/interrompidas de forma ATÔMICA e IDEMPOTENTE.
// Consulta EXCLUSIVAMENTE as APIs oficiais do PNCP e do Compras.gov.br.
// Salva amostras válidas na coleção 'price_samples_index'.

cronAdd('price_index_worker_cron', '*/1 * * * *', function () {
  console.log('[PRICE-WORKER-CRON] Tick do cron disparado. Verificando tarefas pendentes...')

  function canonicalNormText(s) {
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

  function extractWorkerTokens(s) {
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
    var norm = canonicalNormText(s)
    if (!norm) return []
    return norm.split(/\s+/).filter(function (t) {
      return t.length >= 2 && !STOPWORDS[t]
    })
  }

  function stemWorkerToken(t) {
    if (!t || t.length <= 3) return t
    if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
    if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
    return t
  }

  function extrairUnidadeQualificadaWorker(uBruta, dBruta) {
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
    if (u && u !== 'UN' && u !== 'UND' && u !== 'UNIDADE') return u
    if (/\b(?:FRASCO|FR)\b/i.test(d)) return 'FRASCO'
    if (/\b(?:AMPOLA|AMP)\b/i.test(d)) return 'AMPOLA'
    if (/\b(?:ENVELOPE|ENV)\b/i.test(d)) return 'ENVELOPE'
    if (/\b(?:BLISTER|BLIST)\b/i.test(d)) return 'BLISTER'
    if (/\b(?:COMPRIMIDO|COMP)\b/i.test(d)) return 'COMPRIMIDO'
    if (/\b(?:CAIXA|CX)\b/i.test(d)) return 'CX'
    return u || 'UN'
  }

  function parseJsonSafe(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  function sendHttpWithRetry(url, timeoutSec, maxRetries) {
    var retries = maxRetries || 2
    var tentativa = 0
    var userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 COTAI/Worker-0.0.92'
    while (tentativa <= retries) {
      tentativa++
      try {
        var res = $http.send({
          url: url,
          method: 'GET',
          headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgent },
          timeout: timeoutSec || 4,
        })
        if (res && res.statusCode >= 200 && res.statusCode < 300) {
          return { ok: true, resp: res }
        }
        if (res && (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 504))) {
          if (tentativa <= retries) {
            var waitMs = tentativa * 300
            var dStart = new Date().getTime()
            while (new Date().getTime() - dStart < waitMs) {}
            continue
          }
        }
        return { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
      } catch (err) {
        if (tentativa <= retries) {
          var waitMs2 = tentativa * 300
          var dStart2 = new Date().getTime()
          while (new Date().getTime() - dStart2 < waitMs2) {}
          continue
        }
        return { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
      }
    }
    return { ok: false, resp: null, error: 'Retries esgotados' }
  }

  function gerarSampleKey(amostra) {
    var f = (amostra.source || 'PNCP').toUpperCase().replace(/[^A-Z0-9]/g, '')
    var idExt = String(amostra.source_record_id || amostra.purchase_id || '').replace(
      /[^A-Z0-9_-]/gi,
      '',
    )
    var itemNum = String(amostra.item_id || '1')
    var cnpj = String(amostra.orgao_cnpj || amostra.fornecedor_cnpj || '').replace(/\D/g, '')
    var v = Number(amostra.valor_unitario).toFixed(4).replace('.', '_')
    return f + '#' + idExt + '#' + itemNum + '#' + cnpj + '#' + v
  }

  function persistirLoteAmostras(amostras) {
    if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
    var inseridas = 0
    var atualizadas = 0
    var agora = new Date().toISOString()
    var col = $app.findCollectionByNameOrId('price_samples_index')

    for (var i = 0; i < amostras.length; i++) {
      var a = amostras[i]
      var vUnit = Number(a.valor_unitario)
      if (isNaN(vUnit) || vUnit <= 0) continue

      var key = a.sample_key || gerarSampleKey(a)
      var descNorm = a.descricao_normalizada || canonicalNormText(a.descricao)

      try {
        var existente = null
        try {
          existente = $app.findFirstRecordByData('price_samples_index', 'sample_key', key)
        } catch (_) {
          existente = null
        }

        if (existente) {
          existente.set('valor_unitario', vUnit)
          existente.set('valor_total', Number(a.valor_total) || vUnit * (Number(a.quantidade) || 1))
          existente.set('last_validated_at', agora)
          if (a.raw_payload) {
            existente.set(
              'raw_payload',
              typeof a.raw_payload === 'string' ? a.raw_payload : JSON.stringify(a.raw_payload),
            )
          }
          $app.save(existente)
          atualizadas++
        } else {
          var rec = new Record(col)
          rec.set('sample_key', key)
          rec.set('source', a.source || 'PNCP')
          rec.set('source_record_id', a.source_record_id || a.purchase_id || 'NÃO INFORMADO')
          rec.set('purchase_id', a.purchase_id || a.source_record_id || 'NÃO INFORMADO')
          rec.set('item_id', String(a.item_id || '1'))
          rec.set('descricao', (a.descricao || '').trim())
          rec.set('descricao_normalizada', descNorm)
          rec.set('orgao', a.orgao || 'Órgão Público')
          rec.set('orgao_cnpj', a.orgao_cnpj || 'NÃO INFORMADO')
          rec.set('fornecedor_nome', a.fornecedor_nome || 'NÃO INFORMADO')
          rec.set('fornecedor_cnpj', a.fornecedor_cnpj || 'NÃO INFORMADO')
          rec.set('fornecedor_porte', a.fornecedor_porte || 'DEMAIS')
          rec.set('uf', a.uf || '')
          rec.set('municipio', a.municipio || '')
          rec.set('unidade', a.unidade || 'UN')
          rec.set('quantidade', Number(a.quantidade) || 1)
          rec.set('valor_unitario', vUnit)
          rec.set('valor_total', Number(a.valor_total) || vUnit * (Number(a.quantidade) || 1))
          rec.set('natureza_preco', a.natureza_preco || 'homologado')
          rec.set('data_referencia', a.data_referencia || agora)
          rec.set('numero_processo', a.numero_processo || '')
          rec.set('numero_ata', a.numero_ata || '')
          rec.set('modalidade', a.modalidade || 'Pregão Eletrônico')
          rec.set('marca', a.marca || 'NÃO INFORMADO')
          rec.set('codigo_item', a.codigo_item || '')
          rec.set('url_original', a.url_original || '')
          rec.set(
            'raw_payload',
            a.raw_payload
              ? typeof a.raw_payload === 'string'
                ? a.raw_payload
                : JSON.stringify(a.raw_payload)
              : '{}',
          )
          rec.set('indexed_at', agora)
          rec.set('source_updated_at', agora)
          rec.set('last_validated_at', agora)
          $app.save(rec)
          inseridas++
        }
      } catch (errRec) {
        console.log('[PRICE-WORKER] Erro ao gravar registro:', errRec.message)
      }
    }
    return { inseridas: inseridas, atualizadas: atualizadas }
  }

  // 1. Tentar adquirir uma tarefa com status 'pending' de forma segura
  var tarefaAdquirida = null
  try {
    var tarefas = $app.findRecordsByFilter(
      'price_index_tasks',
      "status = 'pending'",
      '+created',
      1,
      0,
    )
    if (tarefas && tarefas.length > 0) {
      var tRec = tarefas[0]
      var agoraIso = new Date().toISOString()
      var tenta = (parseInt(tRec.get('tentativas'), 10) || 0) + 1
      tRec.set('status', 'running')
      tRec.set('started_at', agoraIso)
      tRec.set('tentativas', tenta)
      $app.save(tRec)

      tarefaAdquirida = {
        id: tRec.id,
        task_key: tRec.get('task_key'),
        source: tRec.get('source') || 'AMBAS',
        termo: tRec.get('termo') || '',
        uf: tRec.get('uf') || '',
        tentativas: tenta,
        paginas_consultadas: Number(tRec.get('paginas_consultadas')) || 0,
        itens_processados: Number(tRec.get('itens_processados')) || 0,
        amostras_inseridas: Number(tRec.get('amostras_inseridas')) || 0,
        amostras_atualizadas: Number(tRec.get('amostras_atualizadas')) || 0,
      }
    }
  } catch (errFind) {
    console.log('[PRICE-WORKER-CRON] Erro ao buscar tarefa na fila:', errFind.message)
    return
  }

  if (!tarefaAdquirida) {
    console.log('[PRICE-WORKER-CRON] Nenhuma tarefa pendente na fila.')
    return
  }

  console.log('[PRICE-WORKER-CRON] Tarefa adquirida:', tarefaAdquirida.id, tarefaAdquirida.termo)
  var termo = tarefaAdquirida.termo
  var uf = tarefaAdquirida.uf
  var source = tarefaAdquirida.source.toUpperCase()
  var todasAmostras = []
  var paginasTotal = tarefaAdquirida.paginas_consultadas
  var itensTotal = tarefaAdquirida.itens_processados
  var amostrasInseridasTotal = tarefaAdquirida.amostras_inseridas
  var amostrasAtualizadasTotal = tarefaAdquirida.amostras_atualizadas
  var errosAcumulados = []

  // Executa PNCP se solicitado
  if (source === 'AMBAS' || source.indexOf('PNCP') !== -1) {
    var tokens = extractWorkerTokens(termo)
    var tokenPrincipal = tokens.length > 0 ? tokens[0] : ''
    var tokenStem = stemWorkerToken(tokenPrincipal)

    function itemEhCompativelWorker(desc) {
      if (!desc) return false
      if (!tokenPrincipal) return true
      var n = canonicalNormText(desc)
      if (n.indexOf(tokenPrincipal) !== -1 || n.indexOf(tokenStem) !== -1) return true
      var dToks = extractWorkerTokens(desc)
      for (var idx = 0; idx < dToks.length; idx++) {
        var dt = dToks[idx]
        var dtStem = stemWorkerToken(dt)
        if (
          dt.indexOf(tokenPrincipal) === 0 ||
          tokenPrincipal.indexOf(dt) === 0 ||
          dtStem.indexOf(tokenStem) === 0 ||
          tokenStem.indexOf(dtStem) === 0
        )
          return true
      }
      return false
    }

    var tiposDoc = ['ata', 'edital', 'contrato']
    var contratacoesUnicas = []
    var seenIds = {}

    for (var td = 0; td < tiposDoc.length; td++) {
      var tipo = tiposDoc[td]
      var urlBusca =
        'https://pncp.gov.br/api/search/?q=' +
        encodeURIComponent(termo) +
        '&tipos_documento=' +
        encodeURIComponent(tipo) +
        '&pagina=1&tam_pagina=50'
      if (uf) urlBusca += '&ufs=' + encodeURIComponent(uf)

      paginasTotal++
      var resBusca = sendHttpWithRetry(urlBusca, 4.0, 2)
      if (resBusca.ok && resBusca.resp) {
        var body = parseJsonSafe(resBusca.resp.json || resBusca.resp.raw)
        var items = body
          ? Array.isArray(body)
            ? body
            : body.items || body.data || body.resultado || []
          : []
        for (var k = 0; k < items.length; k++) {
          var it = items[k]
          var idComp =
            it.numeroControlePNCP ||
            it.numero_controle_pncp ||
            it.id ||
            (it.cnpj && it.ano && it.numero_sequencial
              ? it.cnpj + '_' + it.ano + '_' + it.numero_sequencial
              : null)
          if (idComp && !seenIds[idComp]) {
            seenIds[idComp] = true
            it._tipoDoc = tipo
            contratacoesUnicas.push(it)
          }
        }
      } else {
        errosAcumulados.push('PNCP busca ' + tipo + ': ' + (resBusca.error || 'sem resposta'))
      }
    }

    for (var c = 0; c < contratacoesUnicas.length; c++) {
      var entry = contratacoesUnicas[c]
      var rawCnpj = (
        (entry.orgaoEntidade && entry.orgaoEntidade.cnpj) ||
        (entry.orgaoSubRogado && entry.orgaoSubRogado.cnpj) ||
        entry.orgao_cnpj ||
        entry.cnpj ||
        ''
      ).replace(/\D/g, '')
      var ano =
        entry.anoCompra || entry.ano || entry.anoAta || entry.anoContrato || entry.anoEdital || 0
      var sequencial =
        entry.numero_sequencial_compra_ata ||
        entry.numeroSequencialCompraAta ||
        entry.sequencialCompra ||
        entry.numeroSequencialCompra ||
        entry.numeroSequencialEdital ||
        entry.numeroSequencialContrato ||
        entry.numero_sequencial ||
        0

      if ((!rawCnpj || !ano || !sequencial) && entry.numeroControlePNCP) {
        var parts = entry.numeroControlePNCP.split('/')
        if (parts.length >= 2) {
          var pre = parts[0].split('-')
          if (!rawCnpj && pre[0]) rawCnpj = pre[0].replace(/\D/g, '')
          if (pre.length >= 3 && !sequencial) sequencial = parseInt(pre[2], 10) || 0
          var pos = parts[1].split('-')
          if (!ano && pos[0]) ano = parseInt(pos[0], 10) || 0
        }
      }
      if (!rawCnpj || !ano || !sequencial) continue

      var itensArr = null
      var cacheKey = rawCnpj + '_' + ano + '_' + sequencial
      try {
        var cacheRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
        if (cacheRec) {
          itensArr = parseJsonSafe(cacheRec.get('raw_itens'))
        }
      } catch (_) {}

      if (!itensArr || !Array.isArray(itensArr) || itensArr.length === 0) {
        var urlItens =
          'https://pncp.gov.br/api/pncp/v1/orgaos/' +
          rawCnpj +
          '/compras/' +
          ano +
          '/' +
          sequencial +
          '/itens?pagina=1&tamanhoPagina=50'
        var resItens = sendHttpWithRetry(urlItens, 3.5, 1)
        if (resItens.ok && resItens.resp) {
          var bodyItens = parseJsonSafe(resItens.resp.json || resItens.resp.raw)
          itensArr = bodyItens
            ? Array.isArray(bodyItens)
              ? bodyItens
              : bodyItens.items || bodyItens.data || bodyItens.resultado || []
            : []
          if (itensArr && itensArr.length > 0) {
            try {
              var colCache = $app.findCollectionByNameOrId('pncp_item_cache')
              var rCache = new Record(colCache)
              rCache.set('cache_key', cacheKey)
              rCache.set('cnpj', rawCnpj)
              rCache.set('ano', parseInt(ano, 10))
              rCache.set('sequencial', parseInt(sequencial, 10))
              rCache.set('raw_itens', JSON.stringify(itensArr))
              rCache.set('total_itens', itensArr.length)
              $app.save(rCache)
            } catch (_) {}
          }
        }
      }

      if (!itensArr || !Array.isArray(itensArr) || itensArr.length === 0) continue
      itensTotal += itensArr.length

      for (var m = 0; m < itensArr.length; m++) {
        var itm = itensArr[m]
        var descItem = itm.descricao || itm.materialOuServicoNome || ''
        if (!itemEhCompativelWorker(descItem)) continue

        var numItemInt = parseInt(itm.numeroItem || itm.numero_item || m + 1, 10) || 1
        var vHomologado =
          Number(itm.valorUnitarioHomologado) || Number(itm.valor_unitario_homologado) || 0
        var vEstimado =
          Number(itm.valorUnitarioEstimado) ||
          Number(itm.valor_unitario_estimado) ||
          Number(itm.valorUnitario) ||
          Number(itm.valor_unitario) ||
          0
        var vFinal = vHomologado > 0 ? vHomologado : vEstimado
        var natPreco = vHomologado > 0 ? 'homologado' : vEstimado > 0 ? 'estimado' : ''
        var forNome =
          (itm.fornecedor &&
            (itm.fornecedor.nomeRazaoSocialFornecedor || itm.fornecedor.nomeRazaoSocial)) ||
          (entry.fornecedor &&
            (entry.fornecedor.nomeRazaoSocialFornecedor || entry.fornecedor.nomeRazaoSocial)) ||
          'NÃO INFORMADO'
        var forCnpj =
          (itm.fornecedor && (itm.fornecedor.niFornecedor || itm.fornecedor.cnpj)) ||
          (entry.fornecedor && (entry.fornecedor.niFornecedor || entry.fornecedor.cnpj)) ||
          'NÃO INFORMADO'

        if (vFinal <= 0 && rawCnpj && ano && sequencial) {
          var urlRes =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            rawCnpj +
            '/compras/' +
            ano +
            '/' +
            sequencial +
            '/itens/' +
            numItemInt +
            '/resultados'
          var resResult = sendHttpWithRetry(urlRes, 3.0, 1)
          if (resResult.ok && resResult.resp) {
            var bodyRes = parseJsonSafe(resResult.resp.json || resResult.resp.raw)
            var arrRes = bodyRes
              ? Array.isArray(bodyRes)
                ? bodyRes
                : bodyRes.items || bodyRes.data || bodyRes.resultado || []
              : []
            for (var r = 0; r < arrRes.length; r++) {
              var rObj = arrRes[r]
              var vRes =
                Number(rObj.valorUnitarioHomologado) ||
                Number(rObj.valor_unitario_homologado) ||
                Number(rObj.valorUnitario) ||
                0
              if (vRes > 0) {
                vFinal = vRes
                natPreco = 'homologado'
                forNome =
                  rObj.nomeRazaoSocialFornecedor ||
                  rObj.nomeFornecedor ||
                  forNome ||
                  'NÃO INFORMADO'
                forCnpj = rObj.niFornecedor || rObj.cnpj || forCnpj || 'NÃO INFORMADO'
                break
              }
            }
          }
        }

        var qItem = Number(itm.quantidade) || 1
        if (vFinal <= 0) {
          var vTotItem =
            Number(itm.valorTotalHomologado) ||
            Number(itm.valor_total_homologado) ||
            Number(itm.valorTotal) ||
            0
          if (vTotItem > 0 && qItem > 0) {
            var calc = vTotItem / qItem
            if (!isNaN(calc) && calc > 0) {
              vFinal = calc
              natPreco = natPreco || 'homologado'
            }
          }
        }

        if (isNaN(vFinal) || vFinal <= 0) continue

        var orgaoNome =
          (entry.orgaoEntidade && entry.orgaoEntidade.razaoSocial) ||
          entry.orgao_nome ||
          'Órgão Público PNCP'
        var dataRef =
          entry.dataPublicacaoPncp ||
          entry.dataAssinatura ||
          entry.data_contratacao ||
          new Date().toISOString()
        var numControlePncp =
          entry.numeroControlePNCP ||
          entry.numero_controle_pncp ||
          rawCnpj + '-' + ano + '-' + sequencial
        var urlOrig =
          entry.itemUrl || entry.url || 'https://pncp.gov.br/app/editais/' + numControlePncp

        var amostraObj = {
          source: 'PNCP',
          source_record_id: numControlePncp,
          purchase_id: numControlePncp,
          item_id: String(numItemInt),
          descricao: descItem,
          descricao_normalizada: canonicalNormText(descItem),
          orgao: orgaoNome,
          orgao_cnpj: rawCnpj,
          fornecedor_nome: forNome,
          fornecedor_cnpj: forCnpj,
          fornecedor_porte:
            forNome.indexOf('ME') !== -1 || forNome.indexOf('EPP') !== -1 ? 'ME_EPP' : 'DEMAIS',
          uf: entry.uf || (entry.municipio_uf ? entry.municipio_uf.split('-')[1] : '') || '',
          municipio: entry.municipio_nome || entry.municipio || '',
          unidade: extrairUnidadeQualificadaWorker(itm.unidadeMedida || itm.unidade, descItem),
          quantidade: qItem,
          valor_unitario: Number(vFinal.toFixed(4)),
          valor_total: Number((vFinal * qItem).toFixed(4)),
          natureza_preco: natPreco || 'homologado',
          data_referencia: dataRef,
          numero_processo: entry.processo_origem || numControlePncp,
          numero_ata: entry.numeroAta || '',
          modalidade: entry.modalidade_licitacao || 'Pregão Eletrônico',
          marca: itm.marcaNome || 'NÃO INFORMADO',
          codigo_item: itm.codigoItem || itm.codigoMaterialOuServico || 'CATMAT',
          url_original: urlOrig,
          raw_payload: {
            numeroControlePNCP: numControlePncp,
            numeroItem: numItemInt,
            tipo_documento: entry._tipoDoc || 'ata',
          },
        }
        amostraObj.sample_key = gerarSampleKey(amostraObj)
        todasAmostras.push(amostraObj)
      }
    }
  }

  // Executa Compras.gov.br se solicitado
  if (source === 'AMBAS' || source.indexOf('COMPRAS') !== -1) {
    var codigosCatalogo = []
    var termoLower = (termo || '').toLowerCase()
    if (termoLower.indexOf('dipirona') !== -1) {
      codigosCatalogo = ['267203', '268252', '267205']
    } else if (termoLower.indexOf('paracetamol') !== -1) {
      codigosCatalogo = ['271501']
    } else if (termoLower.indexOf('picole') !== -1 || termoLower.indexOf('sorvete') !== -1) {
      codigosCatalogo = ['462776', '462772']
    }

    if (codigosCatalogo.length === 0) {
      var urlCat =
        'https://dadosabertos.compras.gov.br/modulo-material/4_consultarItemMaterial?descricaoItem=' +
        encodeURIComponent(termo) +
        '&pagina=1&tamanhoPagina=5'
      paginasTotal++
      var resCat = sendHttpWithRetry(urlCat, 4.0, 1)
      if (resCat.ok && resCat.resp) {
        var bodyCat = parseJsonSafe(resCat.resp.json || resCat.resp.raw)
        var arrCat = bodyCat
          ? Array.isArray(bodyCat)
            ? bodyCat
            : bodyCat.resultado || bodyCat.items || []
          : []
        for (var ci = 0; ci < arrCat.length; ci++) {
          var cod = String(arrCat[ci].codigoItem || arrCat[ci].codigo || '').replace(/\D/g, '')
          if (cod && codigosCatalogo.indexOf(cod) === -1) codigosCatalogo.push(cod)
        }
      }
    }

    for (var c2 = 0; c2 < Math.min(3, codigosCatalogo.length); c2++) {
      var cat = codigosCatalogo[c2]
      var urlPreco =
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
        encodeURIComponent(cat) +
        '&pagina=1&tamanhoPagina=50'
      if (uf) urlPreco += '&uf=' + encodeURIComponent(uf)
      paginasTotal++
      var resPreco = sendHttpWithRetry(urlPreco, 4.0, 2)
      if (resPreco.ok && resPreco.resp) {
        var bodyPreco = parseJsonSafe(resPreco.resp.json || resPreco.resp.raw)
        var itemsPreco = bodyPreco
          ? Array.isArray(bodyPreco)
            ? bodyPreco
            : bodyPreco.resultado || bodyPreco.items || bodyPreco.data || []
          : []
        itensTotal += itemsPreco.length

        for (var k2 = 0; k2 < itemsPreco.length; k2++) {
          var it2 = itemsPreco[k2]
          var vUnit2 =
            Number(it2.precoUnitarioHomologado) ||
            Number(it2.valorUnitario) ||
            Number(it2.precoUnitario) ||
            Number(it2.precoPraticado) ||
            0
          if (isNaN(vUnit2) || vUnit2 <= 0) continue

          var desc2 = it2.descricaoItem || it2.descricao || termo
          var idCompra2 = String(it2.id || it2.codigoItem || 'CGOV-' + k2)
          var orgaoNome2 = it2.orgaoComprador || it2.nomeOrgao || 'Órgão Federal Compras.gov.br'
          var cnpjOrgao2 = it2.cnpjOrgao || it2.cnpj || 'NÃO INFORMADO'
          var forNome2 = it2.nomeFornecedor || it2.fornecedor || 'NÃO INFORMADO'
          var forCnpj2 = it2.cnpjFornecedor || it2.cpfCnpjFornecedor || 'NÃO INFORMADO'
          var qItem2 = Number(it2.quantidade) || 1
          var dataRef2 = it2.dataCompra || it2.dataResultado || new Date().toISOString()

          var aObj2 = {
            source: 'Compras.gov.br',
            source_record_id: idCompra2,
            purchase_id: idCompra2,
            item_id: String(it2.numeroItem || it2.item || '1'),
            descricao: desc2,
            descricao_normalizada: canonicalNormText(desc2),
            orgao: orgaoNome2,
            orgao_cnpj: cnpjOrgao2,
            fornecedor_nome: forNome2,
            fornecedor_cnpj: forCnpj2,
            fornecedor_porte:
              forNome2.indexOf('ME') !== -1 || forNome2.indexOf('EPP') !== -1 ? 'ME_EPP' : 'DEMAIS',
            uf: it2.uf || uf || '',
            municipio: it2.municipio || '',
            unidade: extrairUnidadeQualificadaWorker(it2.unidadeMedida || it2.unidade, desc2),
            quantidade: qItem2,
            valor_unitario: Number(vUnit2.toFixed(4)),
            valor_total: Number((vUnit2 * qItem2).toFixed(4)),
            natureza_preco: 'homologado',
            data_referencia: dataRef2,
            numero_processo: it2.numeroProcesso || idCompra2,
            numero_ata: '',
            modalidade: it2.modalidadeCompra || 'Pregão Eletrônico',
            marca: it2.marca || 'NÃO INFORMADO',
            codigo_item: cat ? 'CATMAT ' + cat : 'CATMAT',
            url_original:
              it2.linkEditalOuCompra ||
              'https://catalogo.compras.gov.br/item-material/' + (cat || '267203'),
            raw_payload: it2,
          }
          aObj2.sample_key = gerarSampleKey(aObj2)
          todasAmostras.push(aObj2)
        }
      } else {
        errosAcumulados.push(
          'Compras.gov.br CATMAT ' + cat + ': ' + (resPreco.error || 'sem resposta'),
        )
      }
    }
  }

  // Persistir amostras
  var resGrav = persistirLoteAmostras(todasAmostras)
  amostrasInseridasTotal += resGrav.inseridas
  amostrasAtualizadasTotal += resGrav.atualizadas

  var agoraFinal = new Date().toISOString()
  var statusFinal = 'completed'
  if (todasAmostras.length === 0 && errosAcumulados.length > 0) {
    statusFinal = tarefaAdquirida.tentativas >= 3 ? 'failed' : 'pending'
  }

  try {
    var taskRecFinal = $app.findRecordById('price_index_tasks', tarefaAdquirida.id)
    taskRecFinal.set('status', statusFinal)
    taskRecFinal.set('paginas_consultadas', paginasTotal)
    taskRecFinal.set('itens_processados', itensTotal)
    taskRecFinal.set('amostras_inseridas', amostrasInseridasTotal)
    taskRecFinal.set('amostras_atualizadas', amostrasAtualizadasTotal)
    taskRecFinal.set('erros', JSON.stringify(errosAcumulados))
    taskRecFinal.set('ultimo_erro', errosAcumulados.join('; ').slice(0, 500))
    taskRecFinal.set('finished_at', agoraFinal)
    $app.save(taskRecFinal)
    console.log(
      '[PRICE-WORKER-CRON] Tarefa concluída:',
      tarefaAdquirida.id,
      'Amostras inseridas:',
      amostrasInseridasTotal,
    )
  } catch (errSaveFinal) {
    console.log('[PRICE-WORKER-CRON] Erro ao atualizar tarefa:', errSaveFinal.message)
  }
})

// Endpoint HTTP de trigger para o trabalhador da fila: POST /backend/v1/tasks/process
routerAdd('POST', '/backend/v1/tasks/process', function (e) {
  var t0 = new Date().getTime()

  function canonicalNormText(s) {
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

  function extractWorkerTokens(s) {
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
    var norm = canonicalNormText(s)
    if (!norm) return []
    return norm.split(/\s+/).filter(function (t) {
      return t.length >= 2 && !STOPWORDS[t]
    })
  }

  function stemWorkerToken(t) {
    if (!t || t.length <= 3) return t
    if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
    if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
    return t
  }

  function extrairUnidadeQualificadaWorker(uBruta, dBruta) {
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
    if (u && u !== 'UN' && u !== 'UND' && u !== 'UNIDADE') return u
    if (/\b(?:FRASCO|FR)\b/i.test(d)) return 'FRASCO'
    if (/\b(?:AMPOLA|AMP)\b/i.test(d)) return 'AMPOLA'
    if (/\b(?:ENVELOPE|ENV)\b/i.test(d)) return 'ENVELOPE'
    if (/\b(?:BLISTER|BLIST)\b/i.test(d)) return 'BLISTER'
    if (/\b(?:COMPRIMIDO|COMP)\b/i.test(d)) return 'COMPRIMIDO'
    if (/\b(?:CAIXA|CX)\b/i.test(d)) return 'CX'
    return u || 'UN'
  }

  function parseJsonSafe(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  function sendHttpWithRetry(url, timeoutSec, maxRetries) {
    var retries = maxRetries || 2
    var tentativa = 0
    var userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 COTAI/Worker-0.0.92'
    while (tentativa <= retries) {
      tentativa++
      try {
        var res = $http.send({
          url: url,
          method: 'GET',
          headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgent },
          timeout: timeoutSec || 4,
        })
        if (res && res.statusCode >= 200 && res.statusCode < 300) {
          return { ok: true, resp: res }
        }
        if (res && (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 504))) {
          if (tentativa <= retries) {
            var waitMs = tentativa * 300
            var dStart = new Date().getTime()
            while (new Date().getTime() - dStart < waitMs) {}
            continue
          }
        }
        return { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
      } catch (err) {
        if (tentativa <= retries) {
          var waitMs2 = tentativa * 300
          var dStart2 = new Date().getTime()
          while (new Date().getTime() - dStart2 < waitMs2) {}
          continue
        }
        return { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
      }
    }
    return { ok: false, resp: null, error: 'Retries esgotados' }
  }

  function gerarSampleKey(amostra) {
    var f = (amostra.source || 'PNCP').toUpperCase().replace(/[^A-Z0-9]/g, '')
    var idExt = String(amostra.source_record_id || amostra.purchase_id || '').replace(
      /[^A-Z0-9_-]/gi,
      '',
    )
    var itemNum = String(amostra.item_id || '1')
    var cnpj = String(amostra.orgao_cnpj || amostra.fornecedor_cnpj || '').replace(/\D/g, '')
    var v = Number(amostra.valor_unitario).toFixed(4).replace('.', '_')
    return f + '#' + idExt + '#' + itemNum + '#' + cnpj + '#' + v
  }

  function persistirLoteAmostras(amostras) {
    if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
    var inseridas = 0
    var atualizadas = 0
    var agora = new Date().toISOString()
    var col = $app.findCollectionByNameOrId('price_samples_index')

    for (var i = 0; i < amostras.length; i++) {
      var a = amostras[i]
      var vUnit = Number(a.valor_unitario)
      if (isNaN(vUnit) || vUnit <= 0) continue

      var key = a.sample_key || gerarSampleKey(a)
      var descNorm = a.descricao_normalizada || canonicalNormText(a.descricao)

      try {
        var existente = null
        try {
          existente = $app.findFirstRecordByData('price_samples_index', 'sample_key', key)
        } catch (_) {
          existente = null
        }

        if (existente) {
          existente.set('valor_unitario', vUnit)
          existente.set('valor_total', Number(a.valor_total) || vUnit * (Number(a.quantidade) || 1))
          existente.set('last_validated_at', agora)
          if (a.raw_payload) {
            existente.set(
              'raw_payload',
              typeof a.raw_payload === 'string' ? a.raw_payload : JSON.stringify(a.raw_payload),
            )
          }
          $app.save(existente)
          atualizadas++
        } else {
          var rec = new Record(col)
          rec.set('sample_key', key)
          rec.set('source', a.source || 'PNCP')
          rec.set('source_record_id', a.source_record_id || a.purchase_id || 'NÃO INFORMADO')
          rec.set('purchase_id', a.purchase_id || a.source_record_id || 'NÃO INFORMADO')
          rec.set('item_id', String(a.item_id || '1'))
          rec.set('descricao', (a.descricao || '').trim())
          rec.set('descricao_normalizada', descNorm)
          rec.set('orgao', a.orgao || 'Órgão Público')
          rec.set('orgao_cnpj', a.orgao_cnpj || 'NÃO INFORMADO')
          rec.set('fornecedor_nome', a.fornecedor_nome || 'NÃO INFORMADO')
          rec.set('fornecedor_cnpj', a.fornecedor_cnpj || 'NÃO INFORMADO')
          rec.set('fornecedor_porte', a.fornecedor_porte || 'DEMAIS')
          rec.set('uf', a.uf || '')
          rec.set('municipio', a.municipio || '')
          rec.set('unidade', a.unidade || 'UN')
          rec.set('quantidade', Number(a.quantidade) || 1)
          rec.set('valor_unitario', vUnit)
          rec.set('valor_total', Number(a.valor_total) || vUnit * (Number(a.quantidade) || 1))
          rec.set('natureza_preco', a.natureza_preco || 'homologado')
          rec.set('data_referencia', a.data_referencia || agora)
          rec.set('numero_processo', a.numero_processo || '')
          rec.set('numero_ata', a.numero_ata || '')
          rec.set('modalidade', a.modalidade || 'Pregão Eletrônico')
          rec.set('marca', a.marca || 'NÃO INFORMADO')
          rec.set('codigo_item', a.codigo_item || '')
          rec.set('url_original', a.url_original || '')
          rec.set(
            'raw_payload',
            a.raw_payload
              ? typeof a.raw_payload === 'string'
                ? a.raw_payload
                : JSON.stringify(a.raw_payload)
              : '{}',
          )
          rec.set('indexed_at', agora)
          rec.set('source_updated_at', agora)
          rec.set('last_validated_at', agora)
          $app.save(rec)
          inseridas++
        }
      } catch (errRec) {
        console.log('[PRICE-WORKER] Erro ao gravar registro individual:', errRec.message)
      }
    }
    return { inseridas: inseridas, atualizadas: atualizadas }
  }

  var tarefaAdquirida = null
  try {
    var tarefasH = $app.findRecordsByFilter(
      'price_index_tasks',
      "status = 'pending'",
      '+created',
      1,
      0,
    )
    if (tarefasH && tarefasH.length > 0) {
      var tRecH = tarefasH[0]
      var agoraIsoH = new Date().toISOString()
      var tentaH = (parseInt(tRecH.get('tentativas'), 10) || 0) + 1
      tRecH.set('status', 'running')
      tRecH.set('started_at', agoraIsoH)
      tRecH.set('tentativas', tentaH)
      $app.save(tRecH)

      tarefaAdquirida = {
        id: tRecH.id,
        task_key: tRecH.get('task_key'),
        source: tRecH.get('source') || 'AMBAS',
        termo: tRecH.get('termo') || '',
        uf: tRecH.get('uf') || '',
        tentativas: tentaH,
        paginas_consultadas: Number(tRecH.get('paginas_consultadas')) || 0,
        itens_processados: Number(tRecH.get('itens_processados')) || 0,
        amostras_inseridas: Number(tRecH.get('amostras_inseridas')) || 0,
        amostras_atualizadas: Number(tRecH.get('amostras_atualizadas')) || 0,
      }
    }
  } catch (errHttpFind) {
    return e.json(500, {
      sucesso: false,
      error: 'Falha na aquisição da tarefa: ' + errHttpFind.message,
    })
  }

  if (!tarefaAdquirida) {
    return e.json(200, {
      sucesso: true,
      processadas: 0,
      status: 'IDLE',
      message: 'Nenhuma tarefa pendente na fila.',
    })
  }

  var termo = tarefaAdquirida.termo
  var uf = tarefaAdquirida.uf
  var source = tarefaAdquirida.source.toUpperCase()
  var todasAmostras = []
  var paginasTotal = tarefaAdquirida.paginas_consultadas
  var itensTotal = tarefaAdquirida.itens_processados
  var amostrasInseridasTotal = tarefaAdquirida.amostras_inseridas
  var amostrasAtualizadasTotal = tarefaAdquirida.amostras_atualizadas
  var errosAcumulados = []

  // PNCP
  if (source === 'AMBAS' || source.indexOf('PNCP') !== -1) {
    var tokens = extractWorkerTokens(termo)
    var tokenPrincipal = tokens.length > 0 ? tokens[0] : ''
    var tokenStem = stemWorkerToken(tokenPrincipal)

    function itemEhCompativelWorker(desc) {
      if (!desc) return false
      if (!tokenPrincipal) return true
      var n = canonicalNormText(desc)
      if (n.indexOf(tokenPrincipal) !== -1 || n.indexOf(tokenStem) !== -1) return true
      var dToks = extractWorkerTokens(desc)
      for (var idx = 0; idx < dToks.length; idx++) {
        var dt = dToks[idx]
        var dtStem = stemWorkerToken(dt)
        if (
          dt.indexOf(tokenPrincipal) === 0 ||
          tokenPrincipal.indexOf(dt) === 0 ||
          dtStem.indexOf(tokenStem) === 0 ||
          tokenStem.indexOf(dtStem) === 0
        )
          return true
      }
      return false
    }

    var tiposDoc = ['ata', 'edital', 'contrato']
    var contratacoesUnicas = []
    var seenIds = {}

    for (var td = 0; td < tiposDoc.length; td++) {
      var tipo = tiposDoc[td]
      var urlBusca =
        'https://pncp.gov.br/api/search/?q=' +
        encodeURIComponent(termo) +
        '&tipos_documento=' +
        encodeURIComponent(tipo) +
        '&pagina=1&tam_pagina=50'
      if (uf) urlBusca += '&ufs=' + encodeURIComponent(uf)

      paginasTotal++
      var resBusca = sendHttpWithRetry(urlBusca, 4.0, 2)
      if (resBusca.ok && resBusca.resp) {
        var body = parseJsonSafe(resBusca.resp.json || resBusca.resp.raw)
        var items = body
          ? Array.isArray(body)
            ? body
            : body.items || body.data || body.resultado || []
          : []
        for (var k = 0; k < items.length; k++) {
          var it = items[k]
          var idComp =
            it.numeroControlePNCP ||
            it.numero_controle_pncp ||
            it.id ||
            (it.cnpj && it.ano && it.numero_sequencial
              ? it.cnpj + '_' + it.ano + '_' + it.numero_sequencial
              : null)
          if (idComp && !seenIds[idComp]) {
            seenIds[idComp] = true
            it._tipoDoc = tipo
            contratacoesUnicas.push(it)
          }
        }
      } else {
        errosAcumulados.push('PNCP busca ' + tipo + ': ' + (resBusca.error || 'sem resposta'))
      }
    }

    for (var c = 0; c < contratacoesUnicas.length; c++) {
      var entry = contratacoesUnicas[c]
      var rawCnpj = (
        (entry.orgaoEntidade && entry.orgaoEntidade.cnpj) ||
        (entry.orgaoSubRogado && entry.orgaoSubRogado.cnpj) ||
        entry.orgao_cnpj ||
        entry.cnpj ||
        ''
      ).replace(/\D/g, '')
      var ano =
        entry.anoCompra || entry.ano || entry.anoAta || entry.anoContrato || entry.anoEdital || 0
      var sequencial =
        entry.numero_sequencial_compra_ata ||
        entry.numeroSequencialCompraAta ||
        entry.sequencialCompra ||
        entry.numeroSequencialCompra ||
        entry.numeroSequencialEdital ||
        entry.numeroSequencialContrato ||
        entry.numero_sequencial ||
        0

      if ((!rawCnpj || !ano || !sequencial) && entry.numeroControlePNCP) {
        var parts = entry.numeroControlePNCP.split('/')
        if (parts.length >= 2) {
          var pre = parts[0].split('-')
          if (!rawCnpj && pre[0]) rawCnpj = pre[0].replace(/\D/g, '')
          if (pre.length >= 3 && !sequencial) sequencial = parseInt(pre[2], 10) || 0
          var pos = parts[1].split('-')
          if (!ano && pos[0]) ano = parseInt(pos[0], 10) || 0
        }
      }
      if (!rawCnpj || !ano || !sequencial) continue

      var itensArr = null
      var cacheKey = rawCnpj + '_' + ano + '_' + sequencial
      try {
        var cacheRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
        if (cacheRec) {
          itensArr = parseJsonSafe(cacheRec.get('raw_itens'))
        }
      } catch (_) {}

      if (!itensArr || !Array.isArray(itensArr) || itensArr.length === 0) {
        var urlItens =
          'https://pncp.gov.br/api/pncp/v1/orgaos/' +
          rawCnpj +
          '/compras/' +
          ano +
          '/' +
          sequencial +
          '/itens?pagina=1&tamanhoPagina=50'
        var resItens = sendHttpWithRetry(urlItens, 3.5, 1)
        if (resItens.ok && resItens.resp) {
          var bodyItens = parseJsonSafe(resItens.resp.json || resItens.resp.raw)
          itensArr = bodyItens
            ? Array.isArray(bodyItens)
              ? bodyItens
              : bodyItens.items || bodyItens.data || bodyItens.resultado || []
            : []
          if (itensArr && itensArr.length > 0) {
            try {
              var colCache = $app.findCollectionByNameOrId('pncp_item_cache')
              var rCache = new Record(colCache)
              rCache.set('cache_key', cacheKey)
              rCache.set('cnpj', rawCnpj)
              rCache.set('ano', parseInt(ano, 10))
              rCache.set('sequencial', parseInt(sequencial, 10))
              rCache.set('raw_itens', JSON.stringify(itensArr))
              rCache.set('total_itens', itensArr.length)
              $app.save(rCache)
            } catch (_) {}
          }
        }
      }

      if (!itensArr || !Array.isArray(itensArr) || itensArr.length === 0) continue
      itensTotal += itensArr.length

      for (var m = 0; m < itensArr.length; m++) {
        var itm = itensArr[m]
        var descItem = itm.descricao || itm.materialOuServicoNome || ''
        if (!itemEhCompativelWorker(descItem)) continue

        var numItemInt = parseInt(itm.numeroItem || itm.numero_item || m + 1, 10) || 1
        var vHomologado =
          Number(itm.valorUnitarioHomologado) || Number(itm.valor_unitario_homologado) || 0
        var vEstimado =
          Number(itm.valorUnitarioEstimado) ||
          Number(itm.valor_unitario_estimado) ||
          Number(itm.valorUnitario) ||
          Number(itm.valor_unitario) ||
          0
        var vFinal = vHomologado > 0 ? vHomologado : vEstimado
        var natPreco = vHomologado > 0 ? 'homologado' : vEstimado > 0 ? 'estimado' : ''
        var forNome =
          (itm.fornecedor &&
            (itm.fornecedor.nomeRazaoSocialFornecedor || itm.fornecedor.nomeRazaoSocial)) ||
          (entry.fornecedor &&
            (entry.fornecedor.nomeRazaoSocialFornecedor || entry.fornecedor.nomeRazaoSocial)) ||
          'NÃO INFORMADO'
        var forCnpj =
          (itm.fornecedor && (itm.fornecedor.niFornecedor || itm.fornecedor.cnpj)) ||
          (entry.fornecedor && (entry.fornecedor.niFornecedor || entry.fornecedor.cnpj)) ||
          'NÃO INFORMADO'

        if (vFinal <= 0 && rawCnpj && ano && sequencial) {
          var urlRes =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            rawCnpj +
            '/compras/' +
            ano +
            '/' +
            sequencial +
            '/itens/' +
            numItemInt +
            '/resultados'
          var resResult = sendHttpWithRetry(urlRes, 3.0, 1)
          if (resResult.ok && resResult.resp) {
            var bodyRes = parseJsonSafe(resResult.resp.json || resResult.resp.raw)
            var arrRes = bodyRes
              ? Array.isArray(bodyRes)
                ? bodyRes
                : bodyRes.items || bodyRes.data || bodyRes.resultado || []
              : []
            for (var r = 0; r < arrRes.length; r++) {
              var rObj = arrRes[r]
              var vRes =
                Number(rObj.valorUnitarioHomologado) ||
                Number(rObj.valor_unitario_homologado) ||
                Number(rObj.valorUnitario) ||
                0
              if (vRes > 0) {
                vFinal = vRes
                natPreco = 'homologado'
                forNome =
                  rObj.nomeRazaoSocialFornecedor ||
                  rObj.nomeFornecedor ||
                  forNome ||
                  'NÃO INFORMADO'
                forCnpj = rObj.niFornecedor || rObj.cnpj || forCnpj || 'NÃO INFORMADO'
                break
              }
            }
          }
        }

        var qItem = Number(itm.quantidade) || 1
        if (vFinal <= 0) {
          var vTotItem =
            Number(itm.valorTotalHomologado) ||
            Number(itm.valor_total_homologado) ||
            Number(itm.valorTotal) ||
            0
          if (vTotItem > 0 && qItem > 0) {
            var calc = vTotItem / qItem
            if (!isNaN(calc) && calc > 0) {
              vFinal = calc
              natPreco = natPreco || 'homologado'
            }
          }
        }

        if (isNaN(vFinal) || vFinal <= 0) continue

        var orgaoNome =
          (entry.orgaoEntidade && entry.orgaoEntidade.razaoSocial) ||
          entry.orgao_nome ||
          'Órgão Público PNCP'
        var dataRef =
          entry.dataPublicacaoPncp ||
          entry.dataAssinatura ||
          entry.data_contratacao ||
          new Date().toISOString()
        var numControlePncp =
          entry.numeroControlePNCP ||
          entry.numero_controle_pncp ||
          rawCnpj + '-' + ano + '-' + sequencial
        var urlOrig =
          entry.itemUrl || entry.url || 'https://pncp.gov.br/app/editais/' + numControlePncp

        var amostraObj = {
          source: 'PNCP',
          source_record_id: numControlePncp,
          purchase_id: numControlePncp,
          item_id: String(numItemInt),
          descricao: descItem,
          descricao_normalizada: canonicalNormText(descItem),
          orgao: orgaoNome,
          orgao_cnpj: rawCnpj,
          fornecedor_nome: forNome,
          fornecedor_cnpj: forCnpj,
          fornecedor_porte:
            forNome.indexOf('ME') !== -1 || forNome.indexOf('EPP') !== -1 ? 'ME_EPP' : 'DEMAIS',
          uf: entry.uf || (entry.municipio_uf ? entry.municipio_uf.split('-')[1] : '') || '',
          municipio: entry.municipio_nome || entry.municipio || '',
          unidade: extrairUnidadeQualificadaWorker(itm.unidadeMedida || itm.unidade, descItem),
          quantidade: qItem,
          valor_unitario: Number(vFinal.toFixed(4)),
          valor_total: Number((vFinal * qItem).toFixed(4)),
          natureza_preco: natPreco || 'homologado',
          data_referencia: dataRef,
          numero_processo: entry.processo_origem || numControlePncp,
          numero_ata: entry.numeroAta || '',
          modalidade: entry.modalidade_licitacao || 'Pregão Eletrônico',
          marca: itm.marcaNome || 'NÃO INFORMADO',
          codigo_item: itm.codigoItem || itm.codigoMaterialOuServico || 'CATMAT',
          url_original: urlOrig,
          raw_payload: {
            numeroControlePNCP: numControlePncp,
            numeroItem: numItemInt,
            tipo_documento: entry._tipoDoc || 'ata',
          },
        }
        amostraObj.sample_key = gerarSampleKey(amostraObj)
        todasAmostras.push(amostraObj)
      }
    }
  }

  // Compras.gov.br
  if (source === 'AMBAS' || source.indexOf('COMPRAS') !== -1) {
    var codigosCatalogo = []
    var termoLower = (termo || '').toLowerCase()
    if (termoLower.indexOf('dipirona') !== -1) {
      codigosCatalogo = ['267203', '268252', '267205']
    } else if (termoLower.indexOf('paracetamol') !== -1) {
      codigosCatalogo = ['271501']
    } else if (termoLower.indexOf('picole') !== -1 || termoLower.indexOf('sorvete') !== -1) {
      codigosCatalogo = ['462776', '462772']
    }

    if (codigosCatalogo.length === 0) {
      var urlCat =
        'https://dadosabertos.compras.gov.br/modulo-material/4_consultarItemMaterial?descricaoItem=' +
        encodeURIComponent(termo) +
        '&pagina=1&tamanhoPagina=5'
      paginasTotal++
      var resCat = sendHttpWithRetry(urlCat, 4.0, 1)
      if (resCat.ok && resCat.resp) {
        var bodyCat = parseJsonSafe(resCat.resp.json || resCat.resp.raw)
        var arrCat = bodyCat
          ? Array.isArray(bodyCat)
            ? bodyCat
            : bodyCat.resultado || bodyCat.items || []
          : []
        for (var ci = 0; ci < arrCat.length; ci++) {
          var cod = String(arrCat[ci].codigoItem || arrCat[ci].codigo || '').replace(/\D/g, '')
          if (cod && codigosCatalogo.indexOf(cod) === -1) codigosCatalogo.push(cod)
        }
      }
    }

    for (var c2 = 0; c2 < Math.min(3, codigosCatalogo.length); c2++) {
      var cat = codigosCatalogo[c2]
      var urlPreco =
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
        encodeURIComponent(cat) +
        '&pagina=1&tamanhoPagina=50'
      if (uf) urlPreco += '&uf=' + encodeURIComponent(uf)
      paginasTotal++
      var resPreco = sendHttpWithRetry(urlPreco, 4.0, 2)
      if (resPreco.ok && resPreco.resp) {
        var bodyPreco = parseJsonSafe(resPreco.resp.json || resPreco.resp.raw)
        var itemsPreco = bodyPreco
          ? Array.isArray(bodyPreco)
            ? bodyPreco
            : bodyPreco.resultado || bodyPreco.items || bodyPreco.data || []
          : []
        itensTotal += itemsPreco.length

        for (var k2 = 0; k2 < itemsPreco.length; k2++) {
          var it2 = itemsPreco[k2]
          var vUnit2 =
            Number(it2.precoUnitarioHomologado) ||
            Number(it2.valorUnitario) ||
            Number(it2.precoUnitario) ||
            Number(it2.precoPraticado) ||
            0
          if (isNaN(vUnit2) || vUnit2 <= 0) continue

          var desc2 = it2.descricaoItem || it2.descricao || termo
          var idCompra2 = String(it2.id || it2.codigoItem || 'CGOV-' + k2)
          var orgaoNome2 = it2.orgaoComprador || it2.nomeOrgao || 'Órgão Federal Compras.gov.br'
          var cnpjOrgao2 = it2.cnpjOrgao || it2.cnpj || 'NÃO INFORMADO'
          var forNome2 = it2.nomeFornecedor || it2.fornecedor || 'NÃO INFORMADO'
          var forCnpj2 = it2.cnpjFornecedor || it2.cpfCnpjFornecedor || 'NÃO INFORMADO'
          var qItem2 = Number(it2.quantidade) || 1
          var dataRef2 = it2.dataCompra || it2.dataResultado || new Date().toISOString()

          var aObj2 = {
            source: 'Compras.gov.br',
            source_record_id: idCompra2,
            purchase_id: idCompra2,
            item_id: String(it2.numeroItem || it2.item || '1'),
            descricao: desc2,
            descricao_normalizada: canonicalNormText(desc2),
            orgao: orgaoNome2,
            orgao_cnpj: cnpjOrgao2,
            fornecedor_nome: forNome2,
            fornecedor_cnpj: forCnpj2,
            fornecedor_porte:
              forNome2.indexOf('ME') !== -1 || forNome2.indexOf('EPP') !== -1 ? 'ME_EPP' : 'DEMAIS',
            uf: it2.uf || uf || '',
            municipio: it2.municipio || '',
            unidade: extrairUnidadeQualificadaWorker(it2.unidadeMedida || it2.unidade, desc2),
            quantidade: qItem2,
            valor_unitario: Number(vUnit2.toFixed(4)),
            valor_total: Number((vUnit2 * qItem2).toFixed(4)),
            natureza_preco: 'homologado',
            data_referencia: dataRef2,
            numero_processo: it2.numeroProcesso || idCompra2,
            numero_ata: '',
            modalidade: it2.modalidadeCompra || 'Pregão Eletrônico',
            marca: it2.marca || 'NÃO INFORMADO',
            codigo_item: cat ? 'CATMAT ' + cat : 'CATMAT',
            url_original:
              it2.linkEditalOuCompra ||
              'https://catalogo.compras.gov.br/item-material/' + (cat || '267203'),
            raw_payload: it2,
          }
          aObj2.sample_key = gerarSampleKey(aObj2)
          todasAmostras.push(aObj2)
        }
      } else {
        errosAcumulados.push(
          'Compras.gov.br CATMAT ' + cat + ': ' + (resPreco.error || 'sem resposta'),
        )
      }
    }
  }

  // Persistir amostras
  var resGrav = persistirLoteAmostras(todasAmostras)
  amostrasInseridasTotal += resGrav.inseridas
  amostrasAtualizadasTotal += resGrav.atualizadas

  var agoraFinal = new Date().toISOString()
  var statusFinal = 'completed'
  if (todasAmostras.length === 0 && errosAcumulados.length > 0) {
    statusFinal = tarefaAdquirida.tentativas >= 3 ? 'failed' : 'pending'
  }

  try {
    var taskRecFinal = $app.findRecordById('price_index_tasks', tarefaAdquirida.id)
    taskRecFinal.set('status', statusFinal)
    taskRecFinal.set('paginas_consultadas', paginasTotal)
    taskRecFinal.set('itens_processados', itensTotal)
    taskRecFinal.set('amostras_inseridas', amostrasInseridasTotal)
    taskRecFinal.set('amostras_atualizadas', amostrasAtualizadasTotal)
    taskRecFinal.set('erros', JSON.stringify(errosAcumulados))
    taskRecFinal.set('ultimo_erro', errosAcumulados.join('; ').slice(0, 500))
    taskRecFinal.set('finished_at', agoraFinal)
    $app.save(taskRecFinal)
  } catch (errSaveFinal) {
    console.log('[PRICE-WORKER] Erro ao salvar status final da tarefa:', errSaveFinal.message)
  }

  return e.json(200, {
    sucesso: true,
    took_ms: new Date().getTime() - t0,
    tarefa: {
      id: tarefaAdquirida.id,
      termo: termo,
      status: statusFinal,
      amostras_inseridas: amostrasInseridasTotal,
      amostras_atualizadas: amostrasAtualizadasTotal,
      paginas_consultadas: paginasTotal,
      itens_processados: itensTotal,
      erros: errosAcumulados,
    },
  })
})

// Endpoint HTTP de estatísticas e métricas de observabilidade: GET /backend/v1/tasks/stats
routerAdd('GET', '/backend/v1/tasks/stats', function (e) {
  try {
    var totalTarefas = 0
    var pendentes = 0
    var emExecucao = 0
    var concluidas = 0
    var comFalha = 0

    try {
      var q = $app
        .db()
        .newQuery('SELECT status, COUNT(*) as cnt FROM price_index_tasks GROUP BY status')
      var rows = q.all()
      for (var i = 0; i < rows.length; i++) {
        var st = rows[i].status
        var cnt = Number(rows[i].cnt) || 0
        totalTarefas += cnt
        if (st === 'pending') pendentes = cnt
        else if (st === 'running') emExecucao = cnt
        else if (st === 'completed') concluidas = cnt
        else if (st === 'failed') comFalha = cnt
      }
    } catch (_) {}

    var totalAmostras = 0
    var amostrasPncp = 0
    var amostrasComprasGov = 0
    try {
      var qA = $app
        .db()
        .newQuery('SELECT source, COUNT(*) as cnt FROM price_samples_index GROUP BY source')
      var rowsA = qA.all()
      for (var j = 0; j < rowsA.length; j++) {
        var src = rowsA[j].source
        var cntA = Number(rowsA[j].cnt) || 0
        totalAmostras += cntA
        if (src === 'PNCP') amostrasPncp = cntA
        else if (src === 'Compras.gov.br') amostrasComprasGov = cntA
      }
    } catch (_) {}

    return e.json(200, {
      sucesso: true,
      worker_ativo: true,
      cron_configurado: '*/1 * * * *',
      tarefas: {
        total: totalTarefas,
        pendentes: pendentes,
        em_execucao: emExecucao,
        concluidas: concluidas,
        com_falha: comFalha,
      },
      amostras_indexadas: {
        total: totalAmostras,
        pncp: amostrasPncp,
        compras_gov: amostrasComprasGov,
      },
    })
  } catch (errStats) {
    return e.json(500, {
      sucesso: false,
      error: errStats.message,
    })
  }
})
