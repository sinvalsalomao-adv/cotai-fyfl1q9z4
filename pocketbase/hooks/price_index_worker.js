// Worker/Processador de Tarefas da Fila price_index_tasks
// Executado periodicamente via cronAdd ("*/1 * * * *") no PocketBase e acionável via POST /backend/v1/tasks/process
// Processa tarefas pendentes/interrompidas de forma ATÔMICA e IDEMPOTENTE com alto throughput.
// Consulta EXCLUSIVAMENTE as APIs oficiais do PNCP e do Compras.gov.br.
// Salva amostras válidas progressivamente na coleção 'price_samples_index'.
//
// NOTA DE ARQUITETURA POCKETBASE JSVM:
// Cada callback de cronAdd e routerAdd executa em seu próprio contexto JSVM isolado.
// Todas as funções auxiliares devem ser instanciadas internamente no escopo da execução.

cronAdd('price_index_worker_cron', '*/1 * * * *', function () {
  console.log('[PRICE-WORKER-CRON] Tick do cron disparado. Processando fila...')
  var tInicioCiclo = new Date().getTime()
  var MAX_DURATION_MS = 48000

  function canonicalNormWorkerText(s) {
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

  function extractWorkerTokensUtil(s) {
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
    var norm = canonicalNormWorkerText(s)
    if (!norm) return []
    return norm.split(/\s+/).filter(function (t) {
      return t.length >= 2 && !STOPWORDS[t]
    })
  }

  function stemWorkerTokenUtil(t) {
    if (!t || t.length <= 3) return t
    if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
    if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
    return t
  }

  function extrairUnidadeQualificadaWorkerUtil(uBruta, dBruta) {
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

  function parseJsonWorkerSafe(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  function sendHttpWithRetryUtil(url, timeoutSec, maxRetries) {
    var retries = maxRetries !== undefined ? maxRetries : 1
    var tentativa = 0
    var userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 COTAI/Worker-0.0.106'
    while (tentativa <= retries) {
      tentativa++
      try {
        var res = $http.send({
          url: url,
          method: 'GET',
          headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgent },
          timeout: timeoutSec || 3.5,
        })
        if (res && res.statusCode >= 200 && res.statusCode < 300) {
          return { ok: true, resp: res }
        }
        if (res && (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 504))) {
          if (tentativa <= retries) {
            var waitMs = tentativa * 150
            var dStart = new Date().getTime()
            while (new Date().getTime() - dStart < waitMs) {}
            continue
          }
        }
        return { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
      } catch (err) {
        if (tentativa <= retries) {
          var waitMs2 = tentativa * 150
          var dStart2 = new Date().getTime()
          while (new Date().getTime() - dStart2 < waitMs2) {}
          continue
        }
        return { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
      }
    }
    return { ok: false, resp: null, error: 'Retries esgotados' }
  }

  function gerarSampleKeyUtil(amostra) {
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

  function persistirLoteAmostrasProgressivo(amostras) {
    if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
    var inseridas = 0
    var atualizadas = 0
    var agora = new Date().toISOString()
    var col = $app.findCollectionByNameOrId('price_samples_index')

    for (var i = 0; i < amostras.length; i++) {
      var a = amostras[i]
      var vUnit = Number(a.valor_unitario)
      if (isNaN(vUnit) || vUnit <= 0) continue

      var key = a.sample_key || gerarSampleKeyUtil(a)
      var descNorm = a.descricao_normalizada || canonicalNormWorkerText(a.descricao)

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

  // 1. Aquisição atômica da tarefa mais antiga pendente ou stale reclaim (> 2 min em running)
  var tarefaAdquirida = null
  try {
    var tarefas = $app.findRecordsByFilter(
      'price_index_tasks',
      "status = 'pending'",
      '+created',
      1,
      0,
    )

    if (!tarefas || tarefas.length === 0) {
      try {
        var doisMinAtrasIso = new Date(new Date().getTime() - 2 * 60 * 1000).toISOString()
        var estagnadas = $app.findRecordsByFilter(
          'price_index_tasks',
          "status = 'running' && updated < '" + doisMinAtrasIso + "'",
          '+updated',
          1,
          0,
        )
        if (estagnadas && estagnadas.length > 0) {
          tarefas = estagnadas
          console.log(
            '[PRICE-WORKER] Tarefa em running recuperada por stale reclaim:',
            estagnadas[0].id,
          )
        }
      } catch (_) {}
    }

    if (tarefas && tarefas.length > 0) {
      var tRec = tarefas[0]
      var agoraIso = new Date().toISOString()
      var tenta = (parseInt(tRec.getString('tentativas'), 10) || 0) + 1
      tRec.set('status', 'running')
      tRec.set('started_at', agoraIso)
      tRec.set('tentativas', tenta)
      $app.save(tRec)

      var rawPendentes = tRec.getString('pendentes')
      var parsedPendentes = []
      if (rawPendentes) {
        try {
          var pJson = JSON.parse(rawPendentes)
          if (Array.isArray(pJson)) parsedPendentes = pJson
        } catch (_) {}
      }

      tarefaAdquirida = {
        id: tRec.id,
        task_key: tRec.getString('task_key'),
        source: tRec.getString('source') || 'AMBAS',
        termo: tRec.getString('termo') || '',
        uf: tRec.getString('uf') || '',
        tentativas: tenta,
        pendentes: parsedPendentes,
        paginas_consultadas: Number(tRec.getInt('paginas_consultadas')) || 0,
        itens_processados: Number(tRec.getInt('itens_processados')) || 0,
        amostras_inseridas: Number(tRec.getInt('amostras_inseridas')) || 0,
        amostras_atualizadas: Number(tRec.getInt('amostras_atualizadas')) || 0,
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

  console.log(
    '[PRICE-WORKER-CRON] Iniciando ciclo para tarefa:',
    tarefaAdquirida.id,
    'Termo:',
    tarefaAdquirida.termo,
    'Pendentes:',
    tarefaAdquirida.pendentes.length,
  )

  var termo = tarefaAdquirida.termo
  var uf = tarefaAdquirida.uf
  var source = tarefaAdquirida.source.toUpperCase()
  var paginasTotal = tarefaAdquirida.paginas_consultadas
  var itensTotal = tarefaAdquirida.itens_processados
  var amostrasInseridasTotal = tarefaAdquirida.amostras_inseridas
  var amostrasAtualizadasTotal = tarefaAdquirida.amostras_atualizadas
  var errosAcumulados = []
  var pendentesRestantes = tarefaAdquirida.pendentes ? [...tarefaAdquirida.pendentes] : []
  var contratacoesProcessadasNesteCiclo = 0

  // -------------------------------------------------------------
  // ETAPA 1: Processamento PNCP (Detalhamento com Alto Throughput)
  // -------------------------------------------------------------
  if (source === 'AMBAS' || source.indexOf('PNCP') !== -1) {
    var tokens = extractWorkerTokensUtil(termo)
    var tokenPrincipal = tokens.length > 0 ? tokens[0] : ''
    var tokenStem = stemWorkerTokenUtil(tokenPrincipal)

    function itemEhCompativelWorker(desc) {
      if (!desc) return false
      if (!tokenPrincipal) return true
      var n = canonicalNormWorkerText(desc)
      if (n.indexOf(tokenPrincipal) !== -1 || n.indexOf(tokenStem) !== -1) return true
      var dToks = extractWorkerTokensUtil(desc)
      for (var idx = 0; idx < dToks.length; idx++) {
        var dt = dToks[idx]
        var dtStem = stemWorkerTokenUtil(dt)
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

    var contratacoesParaProcessar = []
    var seenCnpjKeys = {}

    // A) Primeiro drena as contratações pendentes acumuladas na fila
    if (pendentesRestantes.length > 0) {
      var LOTE_PENDENTES_MAX = 40 // Processa até 40 contratações por ciclo
      var lotePendentesAtual = pendentesRestantes.splice(0, LOTE_PENDENTES_MAX)
      for (var lp = 0; lp < lotePendentesAtual.length; lp++) {
        var pItem = lotePendentesAtual[lp]
        var rawCnpj = pItem.c || pItem.cnpj || ''
        var ano = pItem.a || pItem.ano || 0
        var seq = pItem.s || pItem.sequencial || 0
        var kP = rawCnpj + '_' + ano + '_' + seq
        if (rawCnpj && ano && seq && !seenCnpjKeys[kP]) {
          seenCnpjKeys[kP] = true
          contratacoesParaProcessar.push({
            cnpj: rawCnpj,
            ano: parseInt(ano, 10),
            sequencial: parseInt(seq, 10),
            numeroControlePNCP: pItem.numeroControlePNCP || rawCnpj + '-' + ano + '-' + seq,
            orgao: pItem.o || pItem.orgao || 'Órgão PNCP',
            uf: pItem.u || pItem.uf || uf || '',
            municipio: pItem.m || pItem.municipio || '',
            _tipoDoc: 'ata',
          })
        }
      }
    }

    // B) Se não havia pendentes na tarefa ou se restou capacidade, consulta páginas de busca do PNCP com avanço de cursor
    if (contratacoesParaProcessar.length < 25) {
      var tiposDoc = ['ata', 'edital', 'contrato']
      var paginaAlvoPncp = Math.floor(paginasTotal / tiposDoc.length) + 1
      if (paginaAlvoPncp > 20) paginaAlvoPncp = 1

      for (var td = 0; td < tiposDoc.length; td++) {
        if (new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000) break
        var tipo = tiposDoc[td]
        var urlBusca =
          'https://pncp.gov.br/api/search/?q=' +
          encodeURIComponent(termo) +
          '&tipos_documento=' +
          encodeURIComponent(tipo) +
          '&pagina=' +
          paginaAlvoPncp +
          '&tam_pagina=50'
        if (uf) urlBusca += '&ufs=' + encodeURIComponent(uf)

        paginasTotal++
        var resBusca = sendHttpWithRetryUtil(urlBusca, 3.5, 1)
        if (resBusca.ok && resBusca.resp) {
          var body = parseJsonWorkerSafe(resBusca.resp.json || resBusca.resp.raw)
          var items = body
            ? Array.isArray(body)
              ? body
              : body.items || body.data || body.resultado || []
            : []
          for (var k = 0; k < items.length; k++) {
            var it = items[k]
            var rawCnpjB = (
              (it.orgaoEntidade && it.orgaoEntidade.cnpj) ||
              (it.orgaoSubRogado && it.orgaoSubRogado.cnpj) ||
              it.orgao_cnpj ||
              it.cnpj ||
              ''
            ).replace(/\D/g, '')
            var anoB = it.anoCompra || it.ano || it.anoAta || it.anoContrato || it.anoEdital || 0
            var seqB =
              it.numero_sequencial_compra_ata ||
              it.numeroSequencialCompraAta ||
              it.sequencialCompra ||
              it.numeroSequencialCompra ||
              it.numeroSequencialEdital ||
              it.numeroSequencialContrato ||
              it.numero_sequencial ||
              0

            if ((!rawCnpjB || !anoB || !seqB) && it.numeroControlePNCP) {
              var parts = it.numeroControlePNCP.split('/')
              if (parts.length >= 2) {
                var pre = parts[0].split('-')
                if (!rawCnpjB && pre[0]) rawCnpjB = pre[0].replace(/\D/g, '')
                if (pre.length >= 3 && !seqB) seqB = parseInt(pre[2], 10) || 0
                var pos = parts[1].split('-')
                if (!anoB && pos[0]) anoB = parseInt(pos[0], 10) || 0
              }
            }

            var kPB = rawCnpjB + '_' + anoB + '_' + seqB
            if (rawCnpjB && anoB && seqB && !seenCnpjKeys[kPB]) {
              seenCnpjKeys[kPB] = true
              contratacoesParaProcessar.push({
                cnpj: rawCnpjB,
                ano: parseInt(anoB, 10),
                sequencial: parseInt(seqB, 10),
                numeroControlePNCP:
                  it.numeroControlePNCP ||
                  it.numero_controle_pncp ||
                  rawCnpjB + '-' + anoB + '-' + seqB,
                orgao:
                  (it.orgaoEntidade && it.orgaoEntidade.razaoSocial) ||
                  it.orgao_nome ||
                  'Órgão Público PNCP',
                uf: it.uf || (it.municipio_uf ? it.municipio_uf.split('-')[1] : '') || uf || '',
                municipio: it.municipio_nome || it.municipio || '',
                _tipoDoc: tipo,
                raw_entry: it,
              })
            }
          }
        } else {
          errosAcumulados.push('PNCP busca ' + tipo + ': ' + (resBusca.error || 'sem resposta'))
        }
      }
    }

    console.log(
      '[PRICE-WORKER-CRON] Total de contratações candidatas a detalhar neste ciclo:',
      contratacoesParaProcessar.length,
    )

    var amostrasBufferCiclo = []

    for (var cIdx = 0; cIdx < contratacoesParaProcessar.length; cIdx++) {
      if (new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 5000) {
        console.log(
          '[PRICE-WORKER-CRON] Limite de tempo do tick atingido (' +
            (new Date().getTime() - tInicioCiclo) +
            'ms). Persistindo lote e reagendando próximo tick.',
        )
        for (var leftover = cIdx; leftover < contratacoesParaProcessar.length; leftover++) {
          var lo = contratacoesParaProcessar[leftover]
          pendentesRestantes.unshift({
            c: lo.cnpj,
            a: lo.ano,
            s: lo.sequencial,
            u: lo.uf,
            m: lo.municipio,
            o: lo.orgao,
          })
        }
        break
      }

      var cItemProcessando = contratacoesParaProcessar[cIdx]
      var cnpjC = cItemProcessando.cnpj
      var anoC = cItemProcessando.ano
      var seqC = cItemProcessando.sequencial
      var cacheKeyC = cnpjC + '_' + anoC + '_' + seqC
      var itensArrC = null

      try {
        var cRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyC)
        if (cRec) {
          var rawItensC = cRec.getString('raw_itens')
          if (rawItensC) {
            itensArrC = parseJsonWorkerSafe(rawItensC)
          }
        }
      } catch (_) {}

      if (!itensArrC || !Array.isArray(itensArrC) || itensArrC.length === 0) {
        var urlItens =
          'https://pncp.gov.br/api/pncp/v1/orgaos/' +
          cnpjC +
          '/compras/' +
          anoC +
          '/' +
          seqC +
          '/itens?pagina=1&tamanhoPagina=50'
        var resItens = sendHttpWithRetryUtil(urlItens, 3.0, 1)
        if (resItens.ok && resItens.resp) {
          var bItens = parseJsonWorkerSafe(resItens.resp.json || resItens.resp.raw)
          itensArrC = bItens
            ? Array.isArray(bItens)
              ? bItens
              : bItens.items || bItens.data || bItens.resultado || []
            : []
          if (itensArrC && itensArrC.length > 0) {
            try {
              var colC = $app.findCollectionByNameOrId('pncp_item_cache')
              var rC = new Record(colC)
              rC.set('cache_key', cacheKeyC)
              rC.set('cnpj', cnpjC)
              rC.set('ano', parseInt(anoC, 10))
              rC.set('sequencial', parseInt(seqC, 10))
              rC.set('raw_itens', JSON.stringify(itensArrC))
              rC.set('total_itens', itensArrC.length)
              $app.save(rC)
            } catch (_) {}
          }
        }
      }

      if (!itensArrC || !Array.isArray(itensArrC) || itensArrC.length === 0) {
        contratacoesProcessadasNesteCiclo++
        continue
      }

      contratacoesProcessadasNesteCiclo++
      itensTotal += itensArrC.length

      for (var subI = 0; subI < itensArrC.length; subI++) {
        var itmObj = itensArrC[subI]
        var dItem = itmObj.descricao || itmObj.materialOuServicoNome || ''
        if (!itemEhCompativelWorker(dItem)) continue

        var numItemInt = parseInt(itmObj.numeroItem || itmObj.numero_item || subI + 1, 10) || 1
        var vHom =
          Number(itmObj.valorUnitarioHomologado) || Number(itmObj.valor_unitario_homologado) || 0
        var vEst =
          Number(itmObj.valorUnitarioEstimado) ||
          Number(itmObj.valor_unitario_estimado) ||
          Number(itmObj.valorUnitario) ||
          Number(itmObj.valor_unitario) ||
          0
        var vUnitFinal = vHom > 0 ? vHom : vEst
        var nat = vHom > 0 ? 'homologado' : vEst > 0 ? 'estimado' : ''
        var forNome =
          (itmObj.fornecedor &&
            (itmObj.fornecedor.nomeRazaoSocialFornecedor || itmObj.fornecedor.nomeRazaoSocial)) ||
          'NÃO INFORMADO'
        var forCnpj =
          (itmObj.fornecedor && (itmObj.fornecedor.niFornecedor || itmObj.fornecedor.cnpj)) ||
          'NÃO INFORMADO'

        if (vUnitFinal <= 0) {
          var urlRes =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            cnpjC +
            '/compras/' +
            anoC +
            '/' +
            seqC +
            '/itens/' +
            numItemInt +
            '/resultados'
          var resR = sendHttpWithRetryUtil(urlRes, 2.5, 1)
          if (resR.ok && resR.resp) {
            var bRes = parseJsonWorkerSafe(resR.resp.json || resR.resp.raw)
            var aRes = bRes
              ? Array.isArray(bRes)
                ? bRes
                : bRes.items || bRes.data || bRes.resultado || []
              : []
            for (var rIdx = 0; rIdx < aRes.length; rIdx++) {
              var resIt = aRes[rIdx]
              var vR =
                Number(resIt.valorUnitarioHomologado) ||
                Number(resIt.valor_unitario_homologado) ||
                Number(resIt.valorUnitario) ||
                0
              if (vR > 0) {
                vUnitFinal = vR
                nat = 'homologado'
                forNome =
                  resIt.nomeRazaoSocialFornecedor ||
                  resIt.nomeFornecedor ||
                  forNome ||
                  'NÃO INFORMADO'
                forCnpj = resIt.niFornecedor || resIt.cnpj || forCnpj || 'NÃO INFORMADO'
                break
              }
            }
          }
        }

        var qItem = Number(itmObj.quantidade) || 1
        if (vUnitFinal <= 0) {
          var vTotItem =
            Number(itmObj.valorTotalHomologado) ||
            Number(itmObj.valor_total_homologado) ||
            Number(itmObj.valorTotal) ||
            0
          if (vTotItem > 0 && qItem > 0) {
            var calc = vTotItem / qItem
            if (!isNaN(calc) && calc > 0) {
              vUnitFinal = calc
              nat = nat || 'homologado'
            }
          }
        }

        if (isNaN(vUnitFinal) || vUnitFinal <= 0) continue

        var numControlePncp = cItemProcessando.numeroControlePNCP
        var urlOrig = 'https://pncp.gov.br/app/editais/' + numControlePncp

        var amPncp = {
          source: 'PNCP',
          source_record_id: numControlePncp,
          purchase_id: numControlePncp,
          item_id: String(numItemInt),
          descricao: dItem,
          descricao_normalizada: canonicalNormWorkerText(dItem),
          orgao: cItemProcessando.orgao,
          orgao_cnpj: cnpjC,
          fornecedor_nome: forNome,
          fornecedor_cnpj: forCnpj,
          fornecedor_porte:
            forNome.indexOf('ME') !== -1 || forNome.indexOf('EPP') !== -1 ? 'ME_EPP' : 'DEMAIS',
          uf: cItemProcessando.uf || '',
          municipio: cItemProcessando.municipio || '',
          unidade: extrairUnidadeQualificadaWorkerUtil(
            itmObj.unidadeMedida || itmObj.unidade,
            dItem,
          ),
          quantidade: qItem,
          valor_unitario: Number(vUnitFinal.toFixed(4)),
          valor_total: Number((vUnitFinal * qItem).toFixed(4)),
          natureza_preco: nat || 'homologado',
          data_referencia: new Date().toISOString(),
          numero_processo: numControlePncp,
          numero_ata: '',
          modalidade: 'Pregão Eletrônico',
          marca: itmObj.marcaNome || 'NÃO INFORMADO',
          codigo_item: itmObj.codigoItem || itmObj.codigoMaterialOuServico || 'CATMAT',
          url_original: urlOrig,
          raw_payload: {
            numeroControlePNCP: numControlePncp,
            numeroItem: numItemInt,
            tipo_documento: cItemProcessando._tipoDoc || 'ata',
          },
        }
        amPncp.sample_key = gerarSampleKeyUtil(amPncp)
        amostrasBufferCiclo.push(amPncp)
      }

      if (amostrasBufferCiclo.length >= 15) {
        var rBatch = persistirLoteAmostrasProgressivo(amostrasBufferCiclo)
        amostrasInseridasTotal += rBatch.inseridas
        amostrasAtualizadasTotal += rBatch.atualizadas
        amostrasBufferCiclo = []
      }
    }

    if (amostrasBufferCiclo.length > 0) {
      var rBatchFinal = persistirLoteAmostrasProgressivo(amostrasBufferCiclo)
      amostrasInseridasTotal += rBatchFinal.inseridas
      amostrasAtualizadasTotal += rBatchFinal.atualizadas
      amostrasBufferCiclo = []
    }
  }

  // -------------------------------------------------------------------
  // ETAPA 2: Compras.gov.br (se solicitado e houver tempo disponível)
  // -------------------------------------------------------------------
  if (
    (source === 'AMBAS' || source.indexOf('COMPRAS') !== -1) &&
    new Date().getTime() - tInicioCiclo < MAX_DURATION_MS - 10000
  ) {
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
      var resCat = sendHttpWithRetryUtil(urlCat, 3.5, 1)
      if (resCat.ok && resCat.resp) {
        var bodyCat = parseJsonWorkerSafe(resCat.resp.json || resCat.resp.raw)
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

    var amostrasComprasGov = []
    for (var c2 = 0; c2 < Math.min(3, codigosCatalogo.length); c2++) {
      if (new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 5000) break
      var cat = codigosCatalogo[c2]
      var urlPreco =
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
        encodeURIComponent(cat) +
        '&pagina=1&tamanhoPagina=50'
      if (uf) urlPreco += '&uf=' + encodeURIComponent(uf)
      paginasTotal++
      var resPreco = sendHttpWithRetryUtil(urlPreco, 3.5, 1)
      if (resPreco.ok && resPreco.resp) {
        var bodyPreco = parseJsonWorkerSafe(resPreco.resp.json || resPreco.resp.raw)
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
            descricao_normalizada: canonicalNormWorkerText(desc2),
            orgao: orgaoNome2,
            orgao_cnpj: cnpjOrgao2,
            fornecedor_nome: forNome2,
            fornecedor_cnpj: forCnpj2,
            fornecedor_porte:
              forNome2.indexOf('ME') !== -1 || forNome2.indexOf('EPP') !== -1 ? 'ME_EPP' : 'DEMAIS',
            uf: it2.uf || uf || '',
            municipio: it2.municipio || '',
            unidade: extrairUnidadeQualificadaWorkerUtil(it2.unidadeMedida || it2.unidade, desc2),
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
          aObj2.sample_key = gerarSampleKeyUtil(aObj2)
          amostrasComprasGov.push(aObj2)
        }
      }
    }

    if (amostrasComprasGov.length > 0) {
      var rBatchCgov = persistirLoteAmostrasProgressivo(amostrasComprasGov)
      amostrasInseridasTotal += rBatchCgov.inseridas
      amostrasAtualizadasTotal += rBatchCgov.atualizadas
    }
  }

  // -------------------------------------------------------------
  // ETAPA 3: Atualização final da tarefa com avanço de cursor
  // -------------------------------------------------------------
  var agoraFinal = new Date().toISOString()
  var statusFinal = pendentesRestantes.length > 0 ? 'pending' : 'completed'
  var duracaoTotalMs = new Date().getTime() - tInicioCiclo

  try {
    var taskRecFinal = $app.findRecordById('price_index_tasks', tarefaAdquirida.id)
    taskRecFinal.set('status', statusFinal)
    taskRecFinal.set('pendentes', JSON.stringify(pendentesRestantes))
    taskRecFinal.set('paginas_consultadas', paginasTotal)
    taskRecFinal.set('itens_processados', itensTotal)
    taskRecFinal.set('amostras_inseridas', amostrasInseridasTotal)
    taskRecFinal.set('amostras_atualizadas', amostrasAtualizadasTotal)
    taskRecFinal.set('erros', JSON.stringify(errosAcumulados))
    taskRecFinal.set('ultimo_erro', errosAcumulados.join('; ').slice(0, 500))
    taskRecFinal.set('finished_at', agoraFinal)
    $app.save(taskRecFinal)

    console.log(
      '[PRICE-WORKER-CRON] Ciclo concluído com sucesso. Tarefa:',
      tarefaAdquirida.id,
      'Contratações processadas:',
      contratacoesProcessadasNesteCiclo,
      'Pendentes restantes:',
      pendentesRestantes.length,
      'Amostras inseridas total:',
      amostrasInseridasTotal,
      'Status final:',
      statusFinal,
      'Duração:',
      duracaoTotalMs + 'ms',
    )
  } catch (errSaveFinal) {
    console.log('[PRICE-WORKER-CRON] Erro ao atualizar tarefa:', errSaveFinal.message)
  }
})

// 2. Endpoint HTTP sob demanda para disparo instantâneo: POST /backend/v1/tasks/process
routerAdd('POST', '/backend/v1/tasks/process', function (e) {
  var t0 = new Date().getTime()

  // Reutiliza a lógica sob demanda de processamento imediato
  var MAX_DURATION_MS = 25000 // Menor para não travar a resposta HTTP

  function canonicalNormWorkerText(s) {
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

  function extractWorkerTokensUtil(s) {
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
    var norm = canonicalNormWorkerText(s)
    if (!norm) return []
    return norm.split(/\s+/).filter(function (t) {
      return t.length >= 2 && !STOPWORDS[t]
    })
  }

  function stemWorkerTokenUtil(t) {
    if (!t || t.length <= 3) return t
    if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
    if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
    return t
  }

  function extrairUnidadeQualificadaWorkerUtil(uBruta, dBruta) {
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

  function parseJsonWorkerSafe(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  function sendHttpWithRetryUtil(url, timeoutSec, maxRetries) {
    var retries = maxRetries !== undefined ? maxRetries : 1
    var tentativa = 0
    var userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 COTAI/Worker-0.0.106'
    while (tentativa <= retries) {
      tentativa++
      try {
        var res = $http.send({
          url: url,
          method: 'GET',
          headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgent },
          timeout: timeoutSec || 3.5,
        })
        if (res && res.statusCode >= 200 && res.statusCode < 300) {
          return { ok: true, resp: res }
        }
        if (res && (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 504))) {
          if (tentativa <= retries) {
            var waitMs = tentativa * 150
            var dStart = new Date().getTime()
            while (new Date().getTime() - dStart < waitMs) {}
            continue
          }
        }
        return { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
      } catch (err) {
        if (tentativa <= retries) {
          var waitMs2 = tentativa * 150
          var dStart2 = new Date().getTime()
          while (new Date().getTime() - dStart2 < waitMs2) {}
          continue
        }
        return { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
      }
    }
    return { ok: false, resp: null, error: 'Retries esgotados' }
  }

  function gerarSampleKeyUtil(amostra) {
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

  function persistirLoteAmostrasProgressivo(amostras) {
    if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
    var inseridas = 0
    var atualizadas = 0
    var agora = new Date().toISOString()
    var col = $app.findCollectionByNameOrId('price_samples_index')

    for (var i = 0; i < amostras.length; i++) {
      var a = amostras[i]
      var vUnit = Number(a.valor_unitario)
      if (isNaN(vUnit) || vUnit <= 0) continue

      var key = a.sample_key || gerarSampleKeyUtil(a)
      var descNorm = a.descricao_normalizada || canonicalNormWorkerText(a.descricao)

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

    if (!tarefasH || tarefasH.length === 0) {
      try {
        var doisMinAtrasIsoH = new Date(new Date().getTime() - 2 * 60 * 1000).toISOString()
        var estagnadasH = $app.findRecordsByFilter(
          'price_index_tasks',
          "status = 'running' && updated < '" + doisMinAtrasIsoH + "'",
          '+updated',
          1,
          0,
        )
        if (estagnadasH && estagnadasH.length > 0) {
          tarefasH = estagnadasH
        }
      } catch (_) {}
    }

    if (tarefasH && tarefasH.length > 0) {
      var tRecH = tarefasH[0]
      var agoraIsoH = new Date().toISOString()
      var tentaH = (parseInt(tRecH.getString('tentativas'), 10) || 0) + 1
      tRecH.set('status', 'running')
      tRecH.set('started_at', agoraIsoH)
      tRecH.set('tentativas', tentaH)
      $app.save(tRecH)

      var rawPendH = tRecH.getString('pendentes')
      var parsedPendH = []
      if (rawPendH) {
        try {
          var pJsonH = JSON.parse(rawPendH)
          if (Array.isArray(pJsonH)) parsedPendH = pJsonH
        } catch (_) {}
      }

      tarefaAdquirida = {
        id: tRecH.id,
        task_key: tRecH.getString('task_key'),
        source: tRecH.getString('source') || 'AMBAS',
        termo: tRecH.getString('termo') || '',
        uf: tRecH.getString('uf') || '',
        tentativas: tentaH,
        pendentes: parsedPendH,
        paginas_consultadas: Number(tRecH.getInt('paginas_consultadas')) || 0,
        itens_processados: Number(tRecH.getInt('itens_processados')) || 0,
        amostras_inseridas: Number(tRecH.getInt('amostras_inseridas')) || 0,
        amostras_atualizadas: Number(tRecH.getInt('amostras_atualizadas')) || 0,
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
  var paginasTotal = tarefaAdquirida.paginas_consultadas
  var itensTotal = tarefaAdquirida.itens_processados
  var amostrasInseridasTotal = tarefaAdquirida.amostras_inseridas
  var amostrasAtualizadasTotal = tarefaAdquirida.amostras_atualizadas
  var errosAcumulados = []
  var pendentesRestantes = tarefaAdquirida.pendentes ? [...tarefaAdquirida.pendentes] : []
  var contratacoesProcessadasNesteCiclo = 0

  if (source === 'AMBAS' || source.indexOf('PNCP') !== -1) {
    var tokens = extractWorkerTokensUtil(termo)
    var tokenPrincipal = tokens.length > 0 ? tokens[0] : ''
    var tokenStem = stemWorkerTokenUtil(tokenPrincipal)

    function itemEhCompativelWorker(desc) {
      if (!desc) return false
      if (!tokenPrincipal) return true
      var n = canonicalNormWorkerText(desc)
      if (n.indexOf(tokenPrincipal) !== -1 || n.indexOf(tokenStem) !== -1) return true
      var dToks = extractWorkerTokensUtil(desc)
      for (var idx = 0; idx < dToks.length; idx++) {
        var dt = dToks[idx]
        var dtStem = stemWorkerTokenUtil(dt)
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

    var contratacoesParaProcessar = []
    var seenCnpjKeys = {}

    if (pendentesRestantes.length > 0) {
      var LOTE_PENDENTES_MAX = 30
      var lotePendentesAtual = pendentesRestantes.splice(0, LOTE_PENDENTES_MAX)
      for (var lp = 0; lp < lotePendentesAtual.length; lp++) {
        var pItem = lotePendentesAtual[lp]
        var rawCnpj = pItem.c || pItem.cnpj || ''
        var ano = pItem.a || pItem.ano || 0
        var seq = pItem.s || pItem.sequencial || 0
        var kP = rawCnpj + '_' + ano + '_' + seq
        if (rawCnpj && ano && seq && !seenCnpjKeys[kP]) {
          seenCnpjKeys[kP] = true
          contratacoesParaProcessar.push({
            cnpj: rawCnpj,
            ano: parseInt(ano, 10),
            sequencial: parseInt(seq, 10),
            numeroControlePNCP: pItem.numeroControlePNCP || rawCnpj + '-' + ano + '-' + seq,
            orgao: pItem.o || pItem.orgao || 'Órgão PNCP',
            uf: pItem.u || pItem.uf || uf || '',
            municipio: pItem.m || pItem.municipio || '',
            _tipoDoc: 'ata',
          })
        }
      }
    }

    if (contratacoesParaProcessar.length < 20) {
      var tiposDoc = ['ata', 'edital', 'contrato']
      var paginaAlvoPncp = Math.floor(paginasTotal / tiposDoc.length) + 1
      if (paginaAlvoPncp > 20) paginaAlvoPncp = 1

      for (var td = 0; td < tiposDoc.length; td++) {
        if (new Date().getTime() - t0 > MAX_DURATION_MS - 8000) break
        var tipo = tiposDoc[td]
        var urlBusca =
          'https://pncp.gov.br/api/search/?q=' +
          encodeURIComponent(termo) +
          '&tipos_documento=' +
          encodeURIComponent(tipo) +
          '&pagina=' +
          paginaAlvoPncp +
          '&tam_pagina=50'
        if (uf) urlBusca += '&ufs=' + encodeURIComponent(uf)

        paginasTotal++
        var resBusca = sendHttpWithRetryUtil(urlBusca, 3.5, 1)
        if (resBusca.ok && resBusca.resp) {
          var body = parseJsonWorkerSafe(resBusca.resp.json || resBusca.resp.raw)
          var items = body
            ? Array.isArray(body)
              ? body
              : body.items || body.data || body.resultado || []
            : []
          for (var k = 0; k < items.length; k++) {
            var it = items[k]
            var rawCnpjB = (
              (it.orgaoEntidade && it.orgaoEntidade.cnpj) ||
              (it.orgaoSubRogado && it.orgaoSubRogado.cnpj) ||
              it.orgao_cnpj ||
              it.cnpj ||
              ''
            ).replace(/\D/g, '')
            var anoB = it.anoCompra || it.ano || it.anoAta || it.anoContrato || it.anoEdital || 0
            var seqB =
              it.numero_sequencial_compra_ata ||
              it.numeroSequencialCompraAta ||
              it.sequencialCompra ||
              it.numeroSequencialCompra ||
              it.numeroSequencialEdital ||
              it.numeroSequencialContrato ||
              it.numero_sequencial ||
              0

            if ((!rawCnpjB || !anoB || !seqB) && it.numeroControlePNCP) {
              var parts = it.numeroControlePNCP.split('/')
              if (parts.length >= 2) {
                var pre = parts[0].split('-')
                if (!rawCnpjB && pre[0]) rawCnpjB = pre[0].replace(/\D/g, '')
                if (pre.length >= 3 && !seqB) seqB = parseInt(pre[2], 10) || 0
                var pos = parts[1].split('-')
                if (!anoB && pos[0]) anoB = parseInt(pos[0], 10) || 0
              }
            }

            var kPB = rawCnpjB + '_' + anoB + '_' + seqB
            if (rawCnpjB && anoB && seqB && !seenCnpjKeys[kPB]) {
              seenCnpjKeys[kPB] = true
              contratacoesParaProcessar.push({
                cnpj: rawCnpjB,
                ano: parseInt(anoB, 10),
                sequencial: parseInt(seqB, 10),
                numeroControlePNCP:
                  it.numeroControlePNCP ||
                  it.numero_controle_pncp ||
                  rawCnpjB + '-' + anoB + '-' + seqB,
                orgao:
                  (it.orgaoEntidade && it.orgaoEntidade.razaoSocial) ||
                  it.orgao_nome ||
                  'Órgão Público PNCP',
                uf: it.uf || (it.municipio_uf ? it.municipio_uf.split('-')[1] : '') || uf || '',
                municipio: it.municipio_nome || it.municipio || '',
                _tipoDoc: tipo,
                raw_entry: it,
              })
            }
          }
        }
      }
    }

    var amostrasBufferCiclo = []
    for (var cIdx = 0; cIdx < contratacoesParaProcessar.length; cIdx++) {
      if (new Date().getTime() - t0 > MAX_DURATION_MS - 4000) {
        for (var leftover = cIdx; leftover < contratacoesParaProcessar.length; leftover++) {
          var lo = contratacoesParaProcessar[leftover]
          pendentesRestantes.unshift({
            c: lo.cnpj,
            a: lo.ano,
            s: lo.sequencial,
            u: lo.uf,
            m: lo.municipio,
            o: lo.orgao,
          })
        }
        break
      }

      var cItemProcessando = contratacoesParaProcessar[cIdx]
      var cnpjC = cItemProcessando.cnpj
      var anoC = cItemProcessando.ano
      var seqC = cItemProcessando.sequencial
      var cacheKeyC = cnpjC + '_' + anoC + '_' + seqC
      var itensArrC = null

      try {
        var cRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyC)
        if (cRec) {
          var rawItensC = cRec.getString('raw_itens')
          if (rawItensC) {
            itensArrC = parseJsonWorkerSafe(rawItensC)
          }
        }
      } catch (_) {}

      if (!itensArrC || !Array.isArray(itensArrC) || itensArrC.length === 0) {
        var urlItens =
          'https://pncp.gov.br/api/pncp/v1/orgaos/' +
          cnpjC +
          '/compras/' +
          anoC +
          '/' +
          seqC +
          '/itens?pagina=1&tamanhoPagina=50'
        var resItens = sendHttpWithRetryUtil(urlItens, 2.5, 1)
        if (resItens.ok && resItens.resp) {
          var bItens = parseJsonWorkerSafe(resItens.resp.json || resItens.resp.raw)
          itensArrC = bItens
            ? Array.isArray(bItens)
              ? bItens
              : bItens.items || bItens.data || bItens.resultado || []
            : []
          if (itensArrC && itensArrC.length > 0) {
            try {
              var colC = $app.findCollectionByNameOrId('pncp_item_cache')
              var rC = new Record(colC)
              rC.set('cache_key', cacheKeyC)
              rC.set('cnpj', cnpjC)
              rC.set('ano', parseInt(anoC, 10))
              rC.set('sequencial', parseInt(seqC, 10))
              rC.set('raw_itens', JSON.stringify(itensArrC))
              rC.set('total_itens', itensArrC.length)
              $app.save(rC)
            } catch (_) {}
          }
        }
      }

      if (!itensArrC || !Array.isArray(itensArrC) || itensArrC.length === 0) {
        contratacoesProcessadasNesteCiclo++
        continue
      }

      contratacoesProcessadasNesteCiclo++
      itensTotal += itensArrC.length

      for (var subI = 0; subI < itensArrC.length; subI++) {
        var itmObj = itensArrC[subI]
        var dItem = itmObj.descricao || itmObj.materialOuServicoNome || ''
        if (!itemEhCompativelWorker(dItem)) continue

        var numItemInt = parseInt(itmObj.numeroItem || itmObj.numero_item || subI + 1, 10) || 1
        var vHom =
          Number(itmObj.valorUnitarioHomologado) || Number(itmObj.valor_unitario_homologado) || 0
        var vEst =
          Number(itmObj.valorUnitarioEstimado) ||
          Number(itmObj.valor_unitario_estimado) ||
          Number(itmObj.valorUnitario) ||
          Number(itmObj.valor_unitario) ||
          0
        var vUnitFinal = vHom > 0 ? vHom : vEst
        var nat = vHom > 0 ? 'homologado' : vEst > 0 ? 'estimado' : ''
        var forNome =
          (itmObj.fornecedor &&
            (itmObj.fornecedor.nomeRazaoSocialFornecedor || itmObj.fornecedor.nomeRazaoSocial)) ||
          'NÃO INFORMADO'
        var forCnpj =
          (itmObj.fornecedor && (itmObj.fornecedor.niFornecedor || itmObj.fornecedor.cnpj)) ||
          'NÃO INFORMADO'

        if (vUnitFinal <= 0) {
          var urlRes =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            cnpjC +
            '/compras/' +
            anoC +
            '/' +
            seqC +
            '/itens/' +
            numItemInt +
            '/resultados'
          var resR = sendHttpWithRetryUtil(urlRes, 2.0, 1)
          if (resR.ok && resR.resp) {
            var bRes = parseJsonWorkerSafe(resR.resp.json || resR.resp.raw)
            var aRes = bRes
              ? Array.isArray(bRes)
                ? bRes
                : bRes.items || bRes.data || bRes.resultado || []
              : []
            for (var rIdx = 0; rIdx < aRes.length; rIdx++) {
              var resIt = aRes[rIdx]
              var vR =
                Number(resIt.valorUnitarioHomologado) ||
                Number(resIt.valor_unitario_homologado) ||
                Number(resIt.valorUnitario) ||
                0
              if (vR > 0) {
                vUnitFinal = vR
                nat = 'homologado'
                forNome =
                  resIt.nomeRazaoSocialFornecedor ||
                  resIt.nomeFornecedor ||
                  forNome ||
                  'NÃO INFORMADO'
                forCnpj = resIt.niFornecedor || resIt.cnpj || forCnpj || 'NÃO INFORMADO'
                break
              }
            }
          }
        }

        var qItem = Number(itmObj.quantidade) || 1
        if (vUnitFinal <= 0) {
          var vTotItem =
            Number(itmObj.valorTotalHomologado) ||
            Number(itmObj.valor_total_homologado) ||
            Number(itmObj.valorTotal) ||
            0
          if (vTotItem > 0 && qItem > 0) {
            var calc = vTotItem / qItem
            if (!isNaN(calc) && calc > 0) {
              vUnitFinal = calc
              nat = nat || 'homologado'
            }
          }
        }

        if (isNaN(vUnitFinal) || vUnitFinal <= 0) continue

        var numControlePncp = cItemProcessando.numeroControlePNCP
        var urlOrig = 'https://pncp.gov.br/app/editais/' + numControlePncp

        var amPncp = {
          source: 'PNCP',
          source_record_id: numControlePncp,
          purchase_id: numControlePncp,
          item_id: String(numItemInt),
          descricao: dItem,
          descricao_normalizada: canonicalNormWorkerText(dItem),
          orgao: cItemProcessando.orgao,
          orgao_cnpj: cnpjC,
          fornecedor_nome: forNome,
          fornecedor_cnpj: forCnpj,
          fornecedor_porte:
            forNome.indexOf('ME') !== -1 || forNome.indexOf('EPP') !== -1 ? 'ME_EPP' : 'DEMAIS',
          uf: cItemProcessando.uf || '',
          municipio: cItemProcessando.municipio || '',
          unidade: extrairUnidadeQualificadaWorkerUtil(
            itmObj.unidadeMedida || itmObj.unidade,
            dItem,
          ),
          quantidade: qItem,
          valor_unitario: Number(vUnitFinal.toFixed(4)),
          valor_total: Number((vUnitFinal * qItem).toFixed(4)),
          natureza_preco: nat || 'homologado',
          data_referencia: new Date().toISOString(),
          numero_processo: numControlePncp,
          numero_ata: '',
          modalidade: 'Pregão Eletrônico',
          marca: itmObj.marcaNome || 'NÃO INFORMADO',
          codigo_item: itmObj.codigoItem || itmObj.codigoMaterialOuServico || 'CATMAT',
          url_original: urlOrig,
          raw_payload: {
            numeroControlePNCP: numControlePncp,
            numeroItem: numItemInt,
            tipo_documento: cItemProcessando._tipoDoc || 'ata',
          },
        }
        amPncp.sample_key = gerarSampleKeyUtil(amPncp)
        amostrasBufferCiclo.push(amPncp)
      }

      if (amostrasBufferCiclo.length >= 10) {
        var rBatch = persistirLoteAmostrasProgressivo(amostrasBufferCiclo)
        amostrasInseridasTotal += rBatch.inseridas
        amostrasAtualizadasTotal += rBatch.atualizadas
        amostrasBufferCiclo = []
      }
    }

    if (amostrasBufferCiclo.length > 0) {
      var rBatchFinal = persistirLoteAmostrasProgressivo(amostrasBufferCiclo)
      amostrasInseridasTotal += rBatchFinal.inseridas
      amostrasAtualizadasTotal += rBatchFinal.atualizadas
      amostrasBufferCiclo = []
    }
  }

  var agoraFinal = new Date().toISOString()
  var statusFinal = pendentesRestantes.length > 0 ? 'pending' : 'completed'
  var duracaoTotalMs = new Date().getTime() - t0

  try {
    var taskRecFinal = $app.findRecordById('price_index_tasks', tarefaAdquirida.id)
    taskRecFinal.set('status', statusFinal)
    taskRecFinal.set('pendentes', JSON.stringify(pendentesRestantes))
    taskRecFinal.set('paginas_consultadas', paginasTotal)
    taskRecFinal.set('itens_processados', itensTotal)
    taskRecFinal.set('amostras_inseridas', amostrasInseridasTotal)
    taskRecFinal.set('amostras_atualizadas', amostrasAtualizadasTotal)
    taskRecFinal.set('erros', JSON.stringify(errosAcumulados))
    taskRecFinal.set('ultimo_erro', errosAcumulados.join('; ').slice(0, 500))
    taskRecFinal.set('finished_at', agoraFinal)
    $app.save(taskRecFinal)
  } catch (errSaveFinal) {
    console.log('[PRICE-WORKER] Erro ao atualizar tarefa via HTTP trigger:', errSaveFinal.message)
  }

  return e.json(200, {
    sucesso: true,
    took_ms: duracaoTotalMs,
    resultado: {
      tarefa_id: tarefaAdquirida.id,
      termo: termo,
      contratacoes_processadas: contratacoesProcessadasNesteCiclo,
      pendentes_restantes: pendentesRestantes.length,
      amostras_inseridas: amostrasInseridasTotal,
      amostras_atualizadas: amostrasAtualizadasTotal,
      status: statusFinal,
      duracao_ms: duracaoTotalMs,
    },
  })
})

// 3. Endpoint HTTP de estatísticas e métricas de observabilidade: GET /backend/v1/tasks/stats
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
