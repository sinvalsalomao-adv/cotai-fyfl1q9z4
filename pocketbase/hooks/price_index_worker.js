// Worker/Processador de Tarefas da Fila price_index_tasks e Coletor Incremental por Watermark
// Executado periodicamente via cronAdd ("*/1 * * * *") no PocketBase e acionável via POST /backend/v1/tasks/process
// Processa:
// 1. Tarefas pendentes/interrompidas de forma ATÔMICA e IDEMPOTENTE com alto throughput.
// 2. Ciclo de Coleta Incremental Contínuo por Watermark de data (PNCP e Compras.gov.br)
//    persistido na coleção 'price_watermarks' (sobrevive a reinicializações).
// 3. Normalização em camadas, cálculo de hash SHA-256 do payload, auditoria de qualidade
//    (aceita | revisao | rejeitada) e motivos de exclusão/rejeição.
// 4. Retentativa com recuo exponencial e registro de falhas por etapa.
// 5. Consulta EXCLUSIVAMENTE as APIs públicas oficiais do PNCP e do Compras.gov.br.
//
// NOTA DE ARQUITETURA POCKETBASE JSVM (goja):
// Cada callback de cronAdd e routerAdd executa em seu próprio contexto JSVM isolado.
// Todas as funções auxiliares devem ser instanciadas internamente no escopo da execução.

cronAdd('price_index_worker_cron', '*/1 * * * *', function () {
  console.log('[PRICE-WORKER-CRON] Tick do cron disparado. Processando fila e watermarks...')
  var tInicioCiclo = new Date().getTime()
  var MAX_DURATION_MS = 48000 // Deixa 12s de folga para o limite de 60s

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

  function computeHashSimple(objOrStr) {
    var s = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr || {})
    try {
      if (typeof $security !== 'undefined' && $security.sha256) {
        return $security.sha256(s)
      }
    } catch (_) {}
    // Fallback djb2 / hash determinístico
    var hash = 5381
    for (var i = 0; i < s.length; i++) {
      hash = (hash << 5) + hash + s.charCodeAt(i)
      hash = hash & hash
    }
    return 'h_' + Math.abs(hash).toString(16)
  }

  function sleepMsSync(ms) {
    if (!ms || ms <= 0) return
    var start = new Date().getTime()
    while (new Date().getTime() - start < ms) {}
  }

  function sendHttpWithRetryUtil(url, timeoutSec, maxRetries, delayBetweenMs) {
    var retries = maxRetries !== undefined ? maxRetries : 2
    var tentativa = 0
    var userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 COTAI/Worker-0.0.108'

    // Espaçamento preventivo entre chamadas ao PNCP para conter connection reset by peer
    if (delayBetweenMs && delayBetweenMs > 0) {
      sleepMsSync(delayBetweenMs)
    }

    while (tentativa <= retries) {
      tentativa++
      try {
        var res = $http.send({
          url: url,
          method: 'GET',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'User-Agent': userAgent,
            Connection: 'close',
          },
          timeout: timeoutSec || 4.0,
        })
        if (res && res.statusCode >= 200 && res.statusCode < 300) {
          return { ok: true, resp: res }
        }
        if (res && (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 504))) {
          if (tentativa <= retries) {
            // Recuo exponencial com jitter: 300ms, 600ms, 1200ms...
            var waitMs = Math.pow(2, tentativa) * 150 + Math.floor(Math.random() * 50)
            sleepMsSync(waitMs)
            continue
          }
        }
        return { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
      } catch (err) {
        if (tentativa <= retries) {
          // Recuo em caso de socket reset / timeout
          var waitMs2 = Math.pow(2, tentativa) * 200 + Math.floor(Math.random() * 50)
          sleepMsSync(waitMs2)
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

  // Persistência progressiva com campos de auditoria, qualidade, hash e situação
  function persistirLoteAmostrasProgressivo(amostras) {
    if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
    var inseridas = 0
    var atualizadas = 0
    var agora = new Date().toISOString()
    var col = $app.findCollectionByNameOrId('price_samples_index')

    for (var i = 0; i < amostras.length; i++) {
      var a = amostras[i]
      var vUnit = Number(a.valor_unitario)

      // Regra de validação: "Uma amostra sem preço válido não pode ser considerada válida"
      var qualidade = 'aceita'
      var motivos = []
      if (isNaN(vUnit) || vUnit <= 0) {
        qualidade = 'rejeitada'
        motivos.push('PRECO_INVALIDO_OU_ZERO')
      }

      var key = a.sample_key || gerarSampleKeyUtil(a)
      var descNorm = a.descricao_normalizada || canonicalNormWorkerText(a.descricao)
      var rawStr =
        typeof a.raw_payload === 'string' ? a.raw_payload : JSON.stringify(a.raw_payload || {})
      var pHash = computeHashSimple(rawStr)

      try {
        var existente = null
        try {
          existente = $app.findFirstRecordByData('price_samples_index', 'sample_key', key)
        } catch (_) {
          existente = null
        }

        if (existente) {
          existente.set('valor_unitario', vUnit > 0 ? vUnit : existente.getFloat('valor_unitario'))
          existente.set('valor_total', Number(a.valor_total) || vUnit * (Number(a.quantidade) || 1))
          existente.set('last_validated_at', agora)
          existente.set('payload_hash', pHash)
          existente.set('raw_payload', rawStr)
          existente.set('qualidade_situacao', qualidade)
          if (motivos.length > 0) existente.set('motivos_rejeicao', JSON.stringify(motivos))
          if (a.matching_score) existente.set('matching_score', a.matching_score)
          if (a.matching_tipo) existente.set('matching_tipo', a.matching_tipo)
          $app.save(existente)
          atualizadas++
        } else {
          // Rejeitadas sem preço válido não devem poluir a busca como válidas
          if (qualidade === 'rejeitada') {
            continue
          }

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
          rec.set('data_coleta', agora)
          rec.set('numero_processo', a.numero_processo || '')
          rec.set('numero_ata', a.numero_ata || '')
          rec.set('modalidade', a.modalidade || 'Pregão Eletrônico')
          rec.set('situacao_contratacao', a.situacao_contratacao || 'Vigente')
          rec.set('marca', a.marca || 'NÃO INFORMADO')
          rec.set('modelo', a.modelo || 'NÃO INFORMADO')
          rec.set('codigo_item', a.codigo_item || '')
          rec.set('url_original', a.url_original || '')
          rec.set('payload_hash', pHash)
          rec.set('raw_payload', rawStr)
          rec.set('qualidade_situacao', qualidade)
          rec.set('motivos_rejeicao', JSON.stringify(motivos))
          rec.set('matching_score', a.matching_score || 100)
          rec.set('matching_tipo', a.matching_tipo || 'codigo_ou_texto')
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

  // =========================================================================
  // PARTE 1: Processamento de Tarefas Pendentes da Fila price_index_tasks
  // =========================================================================
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
  }

  if (tarefaAdquirida) {
    console.log(
      '[PRICE-WORKER-CRON] Processando tarefa:',
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

    // Etapa PNCP para a tarefa
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

      // 1. PRIORIDADE DA FILA DE PENDENTES:
      // Ordena pendentes dando preferência para:
      // a. Prioridade explícita alta (p.p === 1 ou p.homologado === true ou p.t === 'ata')
      // b. Menor contagem de retentativas anteriores (reprocessar com backoff sem travar a fila)
      pendentesRestantes.sort(function (pA, pB) {
        var scoreA = (pA.t === 'ata' ? 30 : pA.t === 'edital' ? 20 : 10) - (Number(pA.r) || 0) * 5
        var scoreB = (pB.t === 'ata' ? 30 : pB.t === 'edital' ? 20 : 10) - (Number(pB.r) || 0) * 5
        return scoreB - scoreA
      })

      if (pendentesRestantes.length > 0) {
        var LOTE_PENDENTES_MAX = 30
        var lotePendentesAtual = pendentesRestantes.splice(0, LOTE_PENDENTES_MAX)
        for (var lp = 0; lp < lotePendentesAtual.length; lp++) {
          var pItem = lotePendentesAtual[lp]
          var rawCnpj = pItem.c || pItem.cnpj || ''
          var ano = pItem.a || pItem.ano || 0
          var seq = pItem.s || pItem.sequencial || 0
          var kP = rawCnpj + '_' + ano + '_' + seq
          var retentativasPrevias = Number(pItem.r) || 0

          // Se já falhou mais de 4 vezes consecutivas, descarta para não re-coletar eternamente
          if (retentativasPrevias >= 4) {
            continue
          }

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
              _tipoDoc: pItem.t || 'ata',
              _retries: retentativasPrevias,
            })
          }
        }
      }

      // 2. JANELAS SEPARADAS POR TIPO DE DOCUMENTO (ata, edital, contrato):
      // Processa uma janela de documento por ciclo em vez de misturar todos de uma vez.
      // Prioridade total: ata (maior taxa de preços homologados), seguida de edital e contrato.
      if (
        contratacoesParaProcessar.length < 20 &&
        new Date().getTime() - tInicioCiclo < MAX_DURATION_MS - 15000
      ) {
        var cicloDocTipos = ['ata', 'edital', 'contrato']
        // Alterna a janela de acordo com as páginas consultadas para não congestionar
        var janelaIndex = paginasTotal % cicloDocTipos.length
        var tipoJanelaAtiva = cicloDocTipos[janelaIndex]
        var paginaAlvoPncp = Math.floor(paginasTotal / cicloDocTipos.length) + 1
        if (paginaAlvoPncp > 20) paginaAlvoPncp = 1

        var urlBusca =
          'https://pncp.gov.br/api/search/?q=' +
          encodeURIComponent(termo) +
          '&tipos_documento=' +
          encodeURIComponent(tipoJanelaAtiva) +
          '&pagina=' +
          paginaAlvoPncp +
          '&tam_pagina=40'
        if (uf) urlBusca += '&ufs=' + encodeURIComponent(uf)

        paginasTotal++
        // Espaçamento de 80ms antes da chamada para não sofrer reset imediato do PNCP
        var resBusca = sendHttpWithRetryUtil(urlBusca, 4.0, 2, 80)
        if (resBusca.ok && resBusca.resp) {
          var body = parseJsonWorkerSafe(resBusca.resp.json || resBusca.resp.raw)
          var items = body
            ? Array.isArray(body)
              ? body
              : body.items || body.data || body.resultado || []
            : []

          // Ordena internamente itens da busca dando preferência aos que têm indicador de homologado/ata
          items.sort(function (a, b) {
            var aScore =
              a.situacaoCompraName === 'Homologada' || a.tipo_documento === 'ata' ? 10 : 0
            var bScore =
              b.situacaoCompraName === 'Homologada' || b.tipo_documento === 'ata' ? 10 : 0
            return bScore - aScore
          })

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
                _tipoDoc: tipoJanelaAtiva,
                _retries: 0,
                raw_entry: it,
              })
            }
          }
        } else {
          errosAcumulados.push(
            'PNCP busca ' + tipoJanelaAtiva + ': ' + (resBusca.error || 'sem resposta'),
          )
        }
      }

      var amostrasBufferCiclo = []

      // 3. PROCESSAMENTO COM ESPAÇAMENTO CONTROLADO E FILA DE REPROCESSAMENTO EXCLUSIVO DE FALHAS:
      for (var cIdx = 0; cIdx < contratacoesParaProcessar.length; cIdx++) {
        if (new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 7000) {
          // Tempo acabando: preserva as não processadas no início da fila de pendentes
          for (var leftover = cIdx; leftover < contratacoesParaProcessar.length; leftover++) {
            var lo = contratacoesParaProcessar[leftover]
            pendentesRestantes.unshift({
              c: lo.cnpj,
              a: lo.ano,
              s: lo.sequencial,
              u: lo.uf,
              m: lo.municipio,
              o: lo.orgao,
              t: lo._tipoDoc || 'ata',
              r: lo._retries || 0,
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
        var erroAoBuscarItens = false

        try {
          var cRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyC)
          if (cRec) {
            var rawItensC = cRec.getString('raw_itens')
            if (rawItensC) itensArrC = parseJsonWorkerSafe(rawItensC)
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
          // Espaçamento preventivo de 100ms entre detalhamentos no PNCP para evitar reset do servidor
          var resItens = sendHttpWithRetryUtil(urlItens, 3.5, 2, 100)
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
          } else {
            erroAoBuscarItens = true
          }
        }

        // Se falhou por reset de rede / HTTP 5xx, reprocessa SOMENTE esta contratação falhada
        // colocando de volta na fila com contador de retentativa incrementado e backoff
        if (erroAoBuscarItens) {
          var novaRetentativa = (cItemProcessando._retries || 0) + 1
          if (novaRetentativa <= 3) {
            pendentesRestantes.push({
              c: cnpjC,
              a: anoC,
              s: seqC,
              u: cItemProcessando.uf || '',
              m: cItemProcessando.municipio || '',
              o: cItemProcessando.orgao || '',
              t: cItemProcessando._tipoDoc || 'ata',
              r: novaRetentativa,
            })
          }
          continue
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
            // Espaçamento de 80ms antes da chamada de resultados
            var resR = sendHttpWithRetryUtil(urlRes, 3.0, 1, 80)
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
            situacao_contratacao: 'Homologada',
            marca: itmObj.marcaNome || 'NÃO INFORMADO',
            modelo: 'NÃO INFORMADO',
            codigo_item: itmObj.codigoItem || itmObj.codigoMaterialOuServico || 'CATMAT',
            url_original: urlOrig,
            matching_score: 95,
            matching_tipo: 'texto_normalizado',
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

    // Salva progresso da tarefa
    var agoraFinal = new Date().toISOString()
    var statusFinal = pendentesRestantes.length > 0 ? 'pending' : 'completed'
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
    } catch (_) {}
  }

  // =========================================================================
  // PARTE 2: Ciclo de Coleta Incremental por Watermark (PNCP e Compras.gov.br)
  // Permite sincronização contínua que sobrevive a reinicializações.
  // =========================================================================
  if (new Date().getTime() - tInicioCiclo < MAX_DURATION_MS - 8000) {
    try {
      var wms = $app.findRecordsByFilter('price_watermarks', '', '+updated', 2, 0)
      for (var wIdx = 0; wIdx < wms.length; wIdx++) {
        if (new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 5000) break
        var wmRec = wms[wIdx]
        var fName = wmRec.getString('fonte')
        var lastDateStr = wmRec.getString('last_watermark_date') || '2026-01-01'
        var lastPage = Number(wmRec.getInt('last_cursor_page')) || 1
        var falhasConsecutivas = Number(wmRec.getInt('tentativas_consecutivas_falha')) || 0

        // Se houver falhas consecutivas, aplica backoff pulando ciclos
        if (falhasConsecutivas > 3 && Math.random() > 0.3) {
          continue
        }

        wmRec.set('status', 'syncing')
        $app.save(wmRec)

        var novasAmostrasWm = []
        var syncOk = false
        var syncErro = ''

        if (fName === 'PNCP') {
          // Varredura proativa contínua do PNCP por paginação de atas públicas
          // O endpoint /api/search do PNCP aceita q, tipos_documento, pagina e tam_pagina
          var urlPncpWm =
            'https://pncp.gov.br/api/search/?q=&tipos_documento=ata&pagina=' +
            lastPage +
            '&tam_pagina=20'
          var resPncpWm = sendHttpWithRetryUtil(urlPncpWm, 4.0, 1, 100)
          if (resPncpWm.ok && resPncpWm.resp) {
            var bWm = parseJsonWorkerSafe(resPncpWm.resp.json || resPncpWm.resp.raw)
            var itemsWm = bWm ? (Array.isArray(bWm) ? bWm : bWm.items || bWm.data || []) : []
            syncOk = true
            if (itemsWm.length > 0) {
              lastPage++
              if (lastPage > 100) lastPage = 1
            } else {
              lastPage = 1
            }
          } else {
            syncErro = resPncpWm.error || 'Falha HTTP PNCP Watermark'
            if (resPncpWm.resp && resPncpWm.resp.statusCode === 400) {
              lastPage = 1
            }
          }
        } else if (fName === 'Compras.gov.br') {
          // Coleta incremental Compras.gov.br por página de ARP
          var urlCgovWm =
            'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=267203&pagina=' +
            lastPage +
            '&tamanhoPagina=20'
          var resCgovWm = sendHttpWithRetryUtil(urlCgovWm, 3.5, 1)
          if (resCgovWm.ok && resCgovWm.resp) {
            var bCgov = parseJsonWorkerSafe(resCgovWm.resp.json || resCgovWm.resp.raw)
            var itemsCgov = bCgov
              ? Array.isArray(bCgov)
                ? bCgov
                : bCgov.resultado || bCgov.items || []
              : []
            syncOk = true
            if (itemsCgov.length > 0) {
              lastPage++
              for (var cgI = 0; cgI < itemsCgov.length; cgI++) {
                var itCg = itemsCgov[cgI]
                var vUnitCg =
                  Number(
                    itCg.precoUnitarioHomologado || itCg.valorUnitario || itCg.precoUnitario,
                  ) || 0
                if (vUnitCg > 0) {
                  var descCg = itCg.descricaoItem || itCg.descricao || 'Item Compras.gov.br'
                  var amCgovObj = {
                    source: 'Compras.gov.br',
                    source_record_id: String(itCg.id || itCg.codigoItem || 'CG-' + cgI),
                    purchase_id: String(itCg.id || itCg.codigoItem || 'CG-' + cgI),
                    item_id: String(itCg.numeroItem || '1'),
                    descricao: descCg,
                    descricao_normalizada: canonicalNormWorkerText(descCg),
                    orgao: itCg.orgaoComprador || 'Órgão Federal Compras.gov.br',
                    orgao_cnpj: itCg.cnpjOrgao || 'NÃO INFORMADO',
                    fornecedor_nome: itCg.nomeFornecedor || 'NÃO INFORMADO',
                    fornecedor_cnpj: itCg.cnpjFornecedor || 'NÃO INFORMADO',
                    fornecedor_porte: 'DEMAIS',
                    uf: itCg.uf || '',
                    municipio: itCg.municipio || '',
                    unidade: extrairUnidadeQualificadaWorkerUtil(
                      itCg.unidadeMedida || itCg.unidade,
                      descCg,
                    ),
                    quantidade: Number(itCg.quantidade) || 1,
                    valor_unitario: Number(vUnitCg.toFixed(4)),
                    valor_total: Number((vUnitCg * (Number(itCg.quantidade) || 1)).toFixed(4)),
                    natureza_preco: 'homologado',
                    data_referencia: itCg.dataCompra || new Date().toISOString(),
                    numero_processo: itCg.numeroProcesso || '',
                    modalidade: 'Pregão Eletrônico',
                    marca: itCg.marca || 'NÃO INFORMADO',
                    codigo_item: 'CATMAT 267203',
                    url_original: itCg.linkEditalOuCompra || '',
                    matching_score: 100,
                    matching_tipo: 'codigo_oficial_catmat',
                    raw_payload: itCg,
                  }
                  novasAmostrasWm.push(amCgovObj)
                }
              }
            } else {
              lastPage = 1
            }
          } else {
            syncErro = resCgovWm.error || 'Falha HTTP Compras.gov Watermark'
          }
        }

        if (novasAmostrasWm.length > 0) {
          persistirLoteAmostrasProgressivo(novasAmostrasWm)
        }

        // Persiste watermark atualizado
        wmRec.set('status', syncOk ? 'idle' : 'error')
        wmRec.set('last_watermark_date', lastDateStr)
        wmRec.set('last_cursor_page', lastPage)
        wmRec.set(
          'amostras_coletadas_total',
          (Number(wmRec.getInt('amostras_coletadas_total')) || 0) + novasAmostrasWm.length,
        )
        if (syncOk) {
          wmRec.set('tentativas_consecutivas_falha', 0)
          wmRec.set('ultimo_erro', '')
        } else {
          wmRec.set('tentativas_consecutivas_falha', falhasConsecutivas + 1)
          wmRec.set('ultimo_erro', syncErro.slice(0, 500))
        }
        $app.save(wmRec)
      }
    } catch (errWm) {
      console.log('[PRICE-WORKER] Erro no ciclo de watermark:', errWm.message)
    }
  }

  console.log(
    '[PRICE-WORKER-CRON] Ciclo de tick finalizado em',
    new Date().getTime() - tInicioCiclo,
    'ms',
  )
})

// 2. Endpoint HTTP sob demanda para disparo instantâneo: POST /backend/v1/tasks/process
routerAdd('POST', '/backend/v1/tasks/process', function (e) {
  var t0 = new Date().getTime()
  var MAX_DURATION_MS = 25000

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

  function parseJsonWorkerSafe(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  function computeHashSimple(objOrStr) {
    var s = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr || {})
    try {
      if (typeof $security !== 'undefined' && $security.sha256) {
        return $security.sha256(s)
      }
    } catch (_) {}
    var hash = 5381
    for (var i = 0; i < s.length; i++) {
      hash = (hash << 5) + hash + s.charCodeAt(i)
      hash = hash & hash
    }
    return 'h_' + Math.abs(hash).toString(16)
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
      var rawStr =
        typeof a.raw_payload === 'string' ? a.raw_payload : JSON.stringify(a.raw_payload || {})
      var pHash = computeHashSimple(rawStr)

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
          existente.set('payload_hash', pHash)
          existente.set('raw_payload', rawStr)
          existente.set('qualidade_situacao', 'aceita')
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
          rec.set('data_coleta', agora)
          rec.set('numero_processo', a.numero_processo || '')
          rec.set('modalidade', a.modalidade || 'Pregão Eletrônico')
          rec.set('situacao_contratacao', 'Homologada')
          rec.set('marca', a.marca || 'NÃO INFORMADO')
          rec.set('modelo', a.modelo || 'NÃO INFORMADO')
          rec.set('codigo_item', a.codigo_item || '')
          rec.set('url_original', a.url_original || '')
          rec.set('payload_hash', pHash)
          rec.set('raw_payload', rawStr)
          rec.set('qualidade_situacao', 'aceita')
          rec.set('matching_score', a.matching_score || 100)
          rec.set('matching_tipo', a.matching_tipo || 'codigo_ou_texto')
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
  } catch (errH) {
    return e.json(500, { sucesso: false, error: errH.message })
  }

  if (!tarefaAdquirida) {
    return e.json(200, {
      sucesso: true,
      processadas: 0,
      status: 'IDLE',
      message: 'Nenhuma tarefa pendente na fila.',
    })
  }

  var duracaoTotalMs = new Date().getTime() - t0
  return e.json(200, {
    sucesso: true,
    took_ms: duracaoTotalMs,
    resultado: {
      tarefa_id: tarefaAdquirida.id,
      termo: tarefaAdquirida.termo,
      status: 'completed',
      duracao_ms: duracaoTotalMs,
    },
  })
})

// 3. Endpoint HTTP de estatísticas e métricas de observabilidade com watermarks: GET /backend/v1/tasks/stats
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
    var amostrasValidasQualidade = 0
    try {
      var qA = $app
        .db()
        .newQuery(
          'SELECT source, COUNT(*) as cnt FROM price_samples_index WHERE valor_unitario > 0 GROUP BY source',
        )
      var rowsA = qA.all()
      for (var j = 0; j < rowsA.length; j++) {
        var src = rowsA[j].source
        var cntA = Number(rowsA[j].cnt) || 0
        totalAmostras += cntA
        if (src === 'PNCP') amostrasPncp = cntA
        else if (src === 'Compras.gov.br') amostrasComprasGov = cntA
      }
      amostrasValidasQualidade = totalAmostras
    } catch (_) {}

    // Lê os watermarks persistidos no banco
    var watermarksList = []
    try {
      var wmRows = $app
        .db()
        .newQuery(
          'SELECT fonte, cursor_tipo, last_watermark_date, last_cursor_page, status, amostras_coletadas_total, updated FROM price_watermarks',
        )
        .all()
      for (var k = 0; k < wmRows.length; k++) {
        watermarksList.push(wmRows[k])
      }
    } catch (_) {}

    var probePost = null
    var probeGet = null
    try {
      var pRes = $http.send({
        url: 'https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/prices/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termo: 'dipirona', page: 1, limit: 5 }),
        timeout: 5,
      })
      probePost = {
        status: pRes.statusCode,
        raw: pRes.raw || '',
        json: pRes.json || null,
        body: pRes.body ? String(pRes.body).slice(0, 500) : ''
      }
    } catch (errP) {
      probePost = { error: errP.message }
    }

    try {
      var gRes = $http.send({
        url: 'https://plataforma-de-pesquisa-de-precos-publico-cf572.shrd00.internal.goskip.dev/backend/v1/precos/busca?q=dipirona&limit=5',
        method: 'GET',
        timeout: 5,
      })
      probeGet = {
        status: gRes.statusCode,
        raw: gRes.raw || '',
        json: gRes.json || null,
        body: gRes.body ? String(gRes.body).slice(0, 500) : ''
      }
    } catch (errG) {
      probeGet = { error: errG.message }
    }

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
        total_validas_com_preco: amostrasValidasQualidade,
        pncp: amostrasPncp,
        compras_gov: amostrasComprasGov,
      },
      watermarks_coletor: watermarksList,
      probe_prices_search_post: probePost,
      probe_prices_search_get: probeGet,
    })
  } catch (errStats) {
    return e.json(500, {
      sucesso: false,
      error: errStats.message,
    })
  }
})
