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

// Both registrations receive this value; serialized execution needs no outer binding.

cronAdd('price_index_worker_cron', '*/1 * * * *', function executarTurnoPriceIndex(e) {
  var modoHttp = !!e
  var tarefaIdHttp = ''
  if (modoHttp) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
    var bodyHttp
    try {
      bodyHttp = e.requestInfo().body || {}
    } catch (_) {
      return e.json(400, { sucesso: false, error: 'INVALID_BODY' })
    }
    tarefaIdHttp = typeof bodyHttp.tarefa_id === 'string' ? bodyHttp.tarefa_id.trim() : ''
    if (!tarefaIdHttp) return e.json(400, { sucesso: false, error: 'TASK_ID_REQUIRED' })
    try {
      $app.findRecordById('price_index_tasks', tarefaIdHttp)
    } catch (_) {
      return e.json(404, { sucesso: false, error: 'TASK_NOT_FOUND' })
    }
  }
  var tInicioCiclo = new Date().getTime()
  console.log('[PRICE-WORKER-CRON] Tick do cron disparado. Processando fila e watermarks...')
  var MAX_DURATION_MS = modoHttp ? 20000 : 48000
  var fimTrabalhoRede = tInicioCiclo + MAX_DURATION_MS - (modoHttp ? 5000 : 8000)
  var trabalhoAdiadoPorTempo = false
  var amostrasHttp = []
  var totalAmostrasHttp = 0

  // Shared envelope contract (duplicated inside each isolated PocketBase JSVM callback).
  // Source items stay untouched; only positive official /resultados evidence is reusable.
  function pncpControl(value, namespace) {
    var m = typeof value === 'string' && /^(\d{14})-([123])-(\d{6})\/(20\d{2}|21\d{2})$/.exec(value)
    if (!m || Number(m[3]) < 1 || (namespace && m[2] !== String(namespace))) return null
    return { c: m[1], a: Number(m[4]), s: Number(m[3]), n: m[2], controle: value }
  }
  function pncpControlOf(c, a, s, n) {
    if (!Number.isInteger(Number(s)) || Number(s) < 1 || Number(s) > 999999) return ''
    return String(c) + '-' + n + '-' + ('000000' + s).slice(-6) + '/' + a
  }
  function pncpResolveDocument(it, kind, evidenceUrl) {
    var type = it.tipo_documento || it.document_type || kind || 'edital'
    var ownText = it.numeroControlePNCP || it.numero_controle_pncp || ''
    var own = pncpControl(ownText)
    var linkedText = it.numeroControlePncpCompra || it.numeroControlePNCPCompra || ''
    var linked = pncpControl(linkedText, 1)
    var c = String(
      (it.orgaoEntidade && it.orgaoEntidade.cnpj) ||
        (it.orgaoSubRogado && it.orgaoSubRogado.cnpj) ||
        it.orgao_cnpj ||
        it.cnpj ||
        '',
    ).replace(/\D/g, '')
    var contract = type === 'contrato' || (own && own.n === '2')
    var origin = contract && own && own.n === '2' ? own : null
    var reason = ''
    if (ownText && !own) reason = 'controle_documento_invalido'
    if (
      it.numeroControlePNCP &&
      it.numero_controle_pncp &&
      it.numeroControlePNCP !== it.numero_controle_pncp
    )
      reason = 'controles_documento_conflitantes'
    if (linkedText && !linked) reason = 'controle_compra_invalido'
    if (
      it.numeroControlePncpCompra &&
      it.numeroControlePNCPCompra &&
      it.numeroControlePncpCompra !== it.numeroControlePNCPCompra
    )
      reason = 'controles_compra_conflitantes'
    if (own && c && own.c !== c) reason = 'orgao_documento_conflitante'
    if (contract && own && own.n !== '2') reason = 'namespace_documento_conflitante'
    if (contract && !origin && !ownText) {
      var ay = Number(it.anoContrato || it.ano),
        sq = Number(it.numeroSequencialContrato || it.numero_sequencial)
      origin = pncpControl(pncpControlOf(c, ay, sq, 2), 2)
    }
    if (
      contract &&
      origin &&
      ((it.anoContrato && Number(it.anoContrato) !== origin.a) ||
        (it.numeroSequencialContrato && Number(it.numeroSequencialContrato) !== origin.s))
    )
      reason = 'identidade_contrato_conflitante'
    var buy = linked || (!contract && own && own.n === '1' ? own : null)
    var explicitYear = 0
    if (it.anoCompra !== undefined) {
      var yearValue = it.anoCompra
      if (
        (typeof yearValue !== 'number' && typeof yearValue !== 'string') ||
        !/^\d{4}$/.test(String(yearValue)) ||
        Number(yearValue) < 2000 ||
        Number(yearValue) > 2199
      )
        reason = 'campos_compra_invalidos'
      else explicitYear = Number(yearValue)
    }
    var explicitSeq = 0
    var sequenceFields = [
      'numero_sequencial_compra_ata',
      'numeroSequencialCompraAta',
      'sequencialCompra',
      'numeroSequencialCompra',
      'numeroSequencialEdital',
    ]
    for (var seqFieldIndex = 0; seqFieldIndex < sequenceFields.length; seqFieldIndex++) {
      var sequenceValue = it[sequenceFields[seqFieldIndex]]
      if (sequenceValue === undefined) continue
      if (
        (typeof sequenceValue !== 'number' && typeof sequenceValue !== 'string') ||
        !/^\d{1,6}$/.test(String(sequenceValue)) ||
        Number(sequenceValue) < 1
      ) {
        reason = 'campos_compra_invalidos'
        continue
      }
      if (explicitSeq && explicitSeq !== Number(sequenceValue))
        reason = 'campos_compra_conflitantes'
      else explicitSeq = Number(sequenceValue)
    }
    if (
      buy &&
      ((explicitYear && explicitYear !== buy.a) ||
        (explicitSeq && explicitSeq !== buy.s) ||
        (c && c !== buy.c))
    )
      reason = 'campos_compra_conflitantes'
    if (!contract && own && own.n === '1' && linked && own.controle !== linked.controle)
      reason = 'controles_compra_conflitantes'
    if (!contract && !buy && !reason && (it.item_url || it.itemUrl)) {
      var route =
        /^(?:https:\/\/pncp\.gov\.br)?\/(?:app\/)?(?:atas|editais|compras)\/(\d{14})\/(20\d{2}|21\d{2})\/([1-9]\d{0,5})(?:\/[1-9]\d*)?\/?$/.exec(
          it.item_url || it.itemUrl,
        )
      if (route) {
        if (
          (c && c !== route[1]) ||
          (explicitYear && explicitYear !== Number(route[2])) ||
          (explicitSeq && explicitSeq !== Number(route[3]))
        )
          reason = 'url_compra_conflitante'
        else buy = pncpControl(pncpControlOf(route[1], Number(route[2]), Number(route[3]), 1), 1)
      }
    }
    if (!buy && !contract && !linkedText && !reason) {
      var y = explicitYear || Number(it.ano || it.anoAta || it.anoEdital)
      var s = explicitSeq || Number(it.numeroSequencialEdital || it.numero_sequencial)
      buy = pncpControl(pncpControlOf(c, y, s, 1), 1)
    }
    if (contract && !origin) reason = reason || 'origem_contrato_ambigua'
    if (!buy) reason = reason || (contract ? 'relacao_ausente' : 'compra_invalida')
    if (reason) return { reason: reason, origem: origin, tipo: type }
    var proof = {
      v: 1,
      controle: buy.controle,
      origem: { tipo: type, controle: (origin || own || buy).controle },
      prova: {
        contratoControle: origin ? origin.controle : '',
        compraControle: buy.controle,
        urlOficial: evidenceUrl,
        capturadoEm: new Date().toISOString(),
      },
    }
    return { cnpj: buy.c, ano: buy.a, sequencial: buy.s, _pncp_compra: proof }
  }
  function pncpRelationPending(resolved, entry) {
    var o = resolved.origem
    return {
      c: o ? o.c : '',
      a: o ? o.a : 0,
      s: o ? o.s : 0,
      t: 'contrato',
      r: 0,
      b: 0,
      i: 0,
      numeroControlePNCP: o ? o.controle : '',
      _pncp_relacao: { v: 1, falhas: 0, lastStatus: resolved.reason },
      o: String(
        (entry.orgaoEntidade && entry.orgaoEntidade.razaoSocial) || entry.orgao_nome || '',
      ).slice(0, 80),
    }
  }
  function pncpVerifiedPurchase(p) {
    var direct = p && !p._pncp_compra && pncpControl(p.numeroControlePNCP, 1)
    if (
      direct &&
      direct.c === String(p.c || p.cnpj) &&
      direct.a === Number(p.a || p.ano) &&
      direct.s === Number(p.s || p.sequencial)
    )
      return true
    var v = p && p._pncp_compra,
      buy = v && pncpControl(v.controle, 1)
    if (!buy || v.v !== 1 || !v.prova || v.prova.compraControle !== buy.controle || !v.origem)
      return false
    var origin = pncpControl(v.origem.controle)
    return (
      !!origin &&
      buy.c === String(p.c || p.cnpj) &&
      buy.a === Number(p.a || p.ano) &&
      buy.s === Number(p.s || p.sequencial) &&
      (v.origem.tipo !== 'contrato' ||
        (origin.n === '2' && v.prova.contratoControle === origin.controle))
    )
  }
  function pncpReceiptRecords(raw) {
    var list
    try {
      list = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (_) {
      return []
    }
    if (!Array.isArray(list)) return []
    return list
      .map(function (x) {
        if (typeof x !== 'string' || x.indexOf('PNCP_NAMESPACE_REBOUND_V1 ') !== 0) return null
        try {
          var r = JSON.parse(x.slice('PNCP_NAMESPACE_REBOUND_V1 '.length))
          return pncpControl(r.documentControl, 2) && pncpControl(r.purchaseControl, 1) ? r : null
        } catch (_) {
          return null
        }
      })
      .filter(function (x) {
        return !!x
      })
  }
  function pncpSuperseded(p, receipts) {
    if (
      !p ||
      p.t !== 'contrato' ||
      pncpVerifiedPurchase(p) ||
      p.j !== undefined ||
      Number(p.i || 0) ||
      Number(p.b || 0)
    )
      return false
    var control = pncpControlOf(p.c || p.cnpj, p.a || p.ano, p.s || p.sequencial, 2)
    return receipts.some(function (r) {
      return r.documentControl === control
    })
  }
  function pncpAdmittedBefore(p, receipts) {
    if (p.t === 'contrato' && !pncpVerifiedPurchase(p)) return false
    var control = pncpControlOf(p.c || p.cnpj, p.a || p.ano, p.s || p.sequencial, 1)
    return receipts.some(function (r) {
      return r.purchaseControl === control
    })
  }

  function pncpPendingKey(p) {
    return (
      (p.t === 'contrato' && !pncpVerifiedPurchase(p) ? 'contrato:' : 'compra:') +
      (p.c || p.cnpj || '') +
      '_' +
      (p.a || p.ano || '') +
      '_' +
      (p.s || p.sequencial || '')
    )
  }
  function pncpActionable(p) {
    if (p.t === 'contrato' && !pncpVerifiedPurchase(p))
      return (
        !!p._pncp_relacao &&
        p._pncp_relacao.lastStatus === 'relacao_ausente' &&
        Number(p._pncp_relacao.falhas || 0) < 4
      )
    return (p.c || p.cnpj) && (p.a || p.ano) && (p.s || p.sequencial) && (Number(p.r) || 0) < 4
  }

  function pncpCanonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(pncpCanonical).join(',') + ']'
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(function (key) {
          return JSON.stringify(key) + ':' + pncpCanonical(value[key])
        })
        .join(',') +
      '}'
    )
  }
  function pncpResultKey(identity) {
    return (
      identity.cnpj +
      '/' +
      Number(identity.ano) +
      '/' +
      Number(identity.sequencial) +
      '/itens/' +
      Number(identity.numeroItem)
    )
  }
  function pncpPositive(body) {
    var entries = Array.isArray(body) ? body : body && (body.items || body.data || body.resultado)
    if (!Array.isArray(entries)) return null
    var fields = [
      'valorUnitarioHomologado',
      'valor_unitario_homologado',
      'valorUnitario',
      'valor_unitario',
    ]
    for (var i = 0; i < entries.length; i++) {
      var row = entries[i]
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      for (var f = 0; f < fields.length; f++) {
        var price = Number(row[fields[f]])
        if (isFinite(price) && price > 0) return { registro: row, campo: fields[f], valor: price }
      }
    }
    return null
  }
  function pncpValidResult(envelope, identity, item, url) {
    if (
      !envelope ||
      envelope.versao !== 1 ||
      !envelope.identidade ||
      pncpCanonical(envelope.identidade) !== pncpCanonical(identity) ||
      envelope.url_resultados !== url ||
      envelope.item_fingerprint !== pncpCanonical(item) ||
      typeof envelope.capturado_em !== 'string'
    )
      return null
    var captured = Date.parse(envelope.capturado_em)
    var age = Date.now() - captured
    if (
      !isFinite(captured) ||
      new Date(captured).toISOString() !== envelope.capturado_em ||
      age < 0 ||
      age >= 15 * 60 * 1000
    )
      return null
    var positive = pncpPositive(envelope.corpo_oficial)
    if (
      !positive ||
      positive.campo !== envelope.campo_unitario ||
      positive.valor !== envelope.valor_unitario
    )
      return null
    var resultItem = positive.registro.numeroItem || positive.registro.numero_item
    if (resultItem != null && Number(resultItem) !== identity.numeroItem) return null
    return envelope
  }
  function pncpResultEnvelope(identity, item, url, body, captured) {
    var positive = pncpPositive(body)
    if (!positive) return null
    var envelope = {
      versao: 1,
      identidade: identity,
      item_fingerprint: pncpCanonical(item),
      url_resultados: url,
      capturado_em: captured,
      corpo_oficial: body,
      campo_unitario: positive.campo,
      valor_unitario: positive.valor,
    }
    return pncpValidResult(envelope, identity, item, url)
  }
  function pncpPersistResults(cacheKey, additions) {
    if (!additions || Object.keys(additions).length === 0) return
    try {
      $app.runInTransaction(function (txApp) {
        var current = txApp.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
        var raw = JSON.parse(current.getString('raw_itens'))
        var items = Array.isArray(raw) ? raw : raw && raw.items
        if (!Array.isArray(items)) return
        var merged = Array.isArray(raw) ? { items: raw } : raw
        var existing = merged.resultados_positivos
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {}
        var changed = false
        Object.keys(additions).forEach(function (key) {
          var candidate = additions[key]
          for (var i = 0; i < items.length; i++) {
            var item = items[i]
            if (
              !item ||
              Number(item.numeroItem || item.numero_item) !== candidate.identidade.numeroItem
            )
              continue
            if (!pncpValidResult(candidate, candidate.identidade, item, candidate.url_resultados))
              return
            var prior = pncpValidResult(
              existing[key],
              candidate.identidade,
              item,
              candidate.url_resultados,
            )
            if (prior && Date.parse(prior.capturado_em) >= Date.parse(candidate.capturado_em))
              return
            existing[key] = candidate
            changed = true
            return
          }
        })
        if (!changed) return
        merged.resultados_positivos = existing
        current.set('raw_itens', JSON.stringify(merged))
        txApp.save(current)
      })
    } catch (_) {} // Cache failure never removes the normal official-source fallback.
  }

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

  function calcularDiceScoreWorker(tokensTermo, tokensDesc) {
    if (!tokensTermo || tokensTermo.length === 0 || !tokensDesc || tokensDesc.length === 0) {
      return 0
    }
    var setTermo = {}
    for (var i = 0; i < tokensTermo.length; i++) {
      var tk = tokensTermo[i]
      setTermo[tk] = true
      var st = stemWorkerTokenUtil(tk)
      if (st) setTermo[st] = true
    }
    var setDesc = {}
    var intersecao = 0
    for (var j = 0; j < tokensDesc.length; j++) {
      var dtk = tokensDesc[j]
      var dst = stemWorkerTokenUtil(dtk)
      if (!setDesc[dtk]) {
        setDesc[dtk] = true
        if (setTermo[dtk] || (dst && setTermo[dst])) {
          intersecao++
        }
      }
    }
    var total = tokensTermo.length + Object.keys(setDesc).length
    if (total === 0) return 0
    var dice = (2 * intersecao) / total
    return Math.min(100, Math.max(10, Math.round(dice * 100)))
  }

  function extrairCodigoItemWorker(itmObj) {
    if (!itmObj) return ''
    var raw = String(itmObj.codigoItem || itmObj.codigoMaterialOuServico || '').trim()
    if (!raw) return ''
    var matchCatmat = raw.match(/\b\d{4,8}\b/)
    if (matchCatmat) {
      return 'CATMAT ' + matchCatmat[0]
    }
    if (/^\d+$/.test(raw)) {
      return raw
    }
    return ''
  }

  function extrairUnidadeQualificadaWorkerUtil(uBruta, dBruta) {
    // Embalagem descrita não substitui a unidade oficial nem preenche sua ausência.
    return typeof uBruta === 'string' && uBruta.trim() ? uBruta : 'NÃO INFORMADO'
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
    var pausaAntesTentativa = delayBetweenMs || 0
    var tentativa = 0
    var ultimaFalha = null
    var userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 COTAI/Worker-0.0.108'

    while (tentativa <= retries) {
      // Admit only the next existing attempt and its required pacing/backoff.
      if (
        new Date().getTime() + pausaAntesTentativa + (timeoutSec || 4.0) * 1000 >
        fimTrabalhoRede
      ) {
        trabalhoAdiadoPorTempo = true
        if (ultimaFalha) ultimaFalha.partial_failure = true
        return ultimaFalha || { deferred: true, ok: false }
      }
      if (pausaAntesTentativa > 0) sleepMsSync(pausaAntesTentativa)
      if (new Date().getTime() + (timeoutSec || 4.0) * 1000 > fimTrabalhoRede) {
        trabalhoAdiadoPorTempo = true
        if (ultimaFalha) ultimaFalha.partial_failure = true
        return ultimaFalha || { deferred: true, ok: false }
      }
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
        ultimaFalha = { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
        if (res && (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 504))) {
          if (tentativa <= retries) {
            // Recuo exponencial com jitter: 300ms, 600ms, 1200ms...
            var waitMs = Math.pow(2, tentativa) * 150 + Math.floor(Math.random() * 50)
            pausaAntesTentativa = waitMs
            continue
          }
        }
        return ultimaFalha
      } catch (err) {
        ultimaFalha = { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
        if (tentativa <= retries) {
          // Recuo em caso de socket reset / timeout
          var waitMs2 = Math.pow(2, tentativa) * 200 + Math.floor(Math.random() * 50)
          pausaAntesTentativa = waitMs2
          continue
        }
        return ultimaFalha
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

  // Sinalização de incompatibilidade de natureza no worker
  // AVISO: Não efetua descarte automático de HORA/H/MÊS/DIÁRIA/POSTO nem de itens relacionados;
  // serve apenas para sinalização e juízo crítico humano na interface.
  function ehAmostraIncompativelWorker(desc, unidade) {
    // Preserva todas as unidades e termos sem descarte automático
    return null
  }

  // Persistência progressiva com campos de auditoria, qualidade, hash e situação
  function persistirLoteAmostrasProgressivo(amostras, colecaoAmostras) {
    if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
    var inseridas = 0
    var atualizadas = 0
    var falhou = false
    var agora = new Date().toISOString()
    var col = colecaoAmostras || $app.findCollectionByNameOrId('price_samples_index')

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

      var motivoIncompativel = ehAmostraIncompativelWorker(a.descricao, a.unidade)
      if (motivoIncompativel) {
        qualidade = 'rejeitada'
        motivos.push(motivoIncompativel)
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
          existente.set('valor_total', Number(a.valor_total) || 0)
          existente.set('natureza_preco', a.natureza_preco || '')
          existente.set('data_referencia', a.data_referencia || '')
          existente.set('url_original', a.url_original || '')
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
          rec.set('quantidade', Number(a.quantidade) || 0)
          rec.set('valor_unitario', vUnit)
          rec.set('valor_total', Number(a.valor_total) || 0)
          rec.set('natureza_preco', a.natureza_preco || '')
          rec.set('data_referencia', a.data_referencia || '')
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
        falhou = true
      }
    }
    return { inseridas: inseridas, atualizadas: atualizadas, falhou: falhou }
  }

  // =========================================================================
  // PARTE 1: Processamento de Tarefas Pendentes da Fila price_index_tasks (MULTI-TAREFA)
  // Processa até 3 tarefas por tick, até esgotar orçamento de tempo (MAX_DURATION_MS - 10s)
  // =========================================================================
  var MAX_TAREFAS_POR_TICK = modoHttp ? 1 : 3
  var tarefasProcessadasNesteTick = 0

  function pncpLegacyCandidate(p) {
    if (
      !p ||
      p.t !== 'contrato' ||
      p._pncp_compra ||
      p.j !== undefined ||
      Number(p.b || 0) !== 0 ||
      Number(p.i || 0) !== 0
    )
      return false
    var origin = pncpControl(pncpControlOf(p.c || p.cnpj, p.a || p.ano, p.s || p.sequencial, 2), 2)
    if (!origin || (p.numeroControlePNCP && p.numeroControlePNCP !== origin.controle)) return false
    var allowed = [
      'c',
      'a',
      's',
      't',
      'r',
      'b',
      'i',
      'u',
      'm',
      'o',
      'cnpj',
      'ano',
      'sequencial',
      'uf',
      'municipio',
      'orgao',
      'numeroControlePNCP',
      '_pncp_relacao',
    ]
    if (
      Object.keys(p).some(function (k) {
        return allowed.indexOf(k) < 0
      }) ||
      JSON.stringify(p).length > 2000
    )
      return false
    var op = p._pncp_relacao
    if (
      op &&
      (op.v !== 1 ||
        Number(op.falhas || 0) >= 4 ||
        op.quarentena ||
        (op.claim && Number(op.ate) > new Date().getTime()))
    )
      return false
    if (op && /conflit|invalido|ambigua/.test(op.lastStatus || '')) return false
    return true
  }
  function pncpErrors(raw) {
    var data = parseJsonWorkerSafe(raw)
    return Array.isArray(data) ? data : raw ? [raw] : []
  }
  function pncpReceipts(raw) {
    return pncpErrors(raw)
      .map(function (x) {
        if (typeof x !== 'string' || x.indexOf('PNCP_NAMESPACE_REBOUND_V1 ') !== 0) return null
        var receipt = parseJsonWorkerSafe(x.slice(26))
        return receipt &&
          pncpControl(receipt.documentControl, 2) &&
          pncpControl(receipt.purchaseControl, 1)
          ? receipt
          : null
      })
      .filter(function (x) {
        return !!x
      })
  }
  function pncpHasPriorWork(app, p, deadline) {
    if (new Date().getTime() >= deadline) return true
    var c = String(p.c || p.cnpj),
      a = Number(p.a || p.ano),
      s = Number(p.s || p.sequencial)
    try {
      var rec = app.findFirstRecordByData('pncp_item_cache', 'cache_key', c + '_' + a + '_' + s)
      if (new Date().getTime() >= deadline) return true
      if (rec) {
        var raw = rec.getString('raw_itens'),
          body = parseJsonWorkerSafe(raw)
        if (
          raw &&
          (!body ||
            (Array.isArray(body)
              ? body.length
              : (body.items || []).length || Object.keys(body.resultados_positivos || {}).length))
        )
          return true
      }
    } catch (err) {
      if (!/no rows|not found|absent/i.test(String(err.message || err))) return true
    }
    if (new Date().getTime() >= deadline) return true
    try {
      var prefix = c + '/' + a + '/' + s + '/itens/'
      var prior = app.findRecordsByFilter(
        'price_samples_index',
        'source = "PNCP" && orgao_cnpj = "' +
          c +
          '" && (source_record_id ~ "' +
          prefix +
          '" || purchase_id = "' +
          pncpControlOf(c, a, s, 1) +
          '" || purchase_id = "' +
          pncpControlOf(c, a, s, 2) +
          '")',
        '',
        1,
        0,
      )
      return new Date().getTime() >= deadline || prior.length > 0
    } catch (_) {
      return true
    }
  }
  function pncpRecoverTask(task) {
    var state = task.getString('status'),
      source = (task.getString('source') || '').toUpperCase()
    if (
      (state !== 'pending' && !(modoHttp && state === 'failed')) ||
      (source !== 'PNCP' && source !== 'AMBAS')
    )
      return
    if (new Date().getTime() + 4080 > fimTrabalhoRede) return
    var scanDeadline = Math.min(new Date().getTime() + 1000, fimTrabalhoRede)
    var list = parseJsonWorkerSafe(task.getString('pendentes'))
    if (!Array.isArray(list)) return
    // Optional DB admission slice only; admitted proof retains its existing source budget.
    var index = -1,
      checked = 0
    for (var i = 0; i < list.length; i++) {
      if (new Date().getTime() >= scanDeadline || checked >= 4) break
      if (!pncpLegacyCandidate(list[i])) continue
      checked++
      if (!pncpHasPriorWork($app, list[i], scanDeadline)) {
        index = i
        break
      }
    }
    if (index < 0 || new Date().getTime() + 4080 > fimTrabalhoRede) return
    var old = list[index],
      before = task.getString('pendentes'),
      attempts = task.getInt('tentativas'),
      started = task.getString('started_at'),
      progress = task.getString('progress_at')
    var document = pncpControl(
      pncpControlOf(old.c || old.cnpj, old.a || old.ano, old.s || old.sequencial, 2),
      2,
    )
    var token = new Date().getTime() + ':' + Math.random().toString(36).slice(2),
      reserved = '',
      reservedOp
    var budgetDeferred = new Error('PNCP_PREFLIGHT_BUDGET_DEFERRED')
    if (new Date().getTime() >= fimTrabalhoRede) return
    try {
      $app.runInTransaction(function (tx) {
        if (new Date().getTime() >= fimTrabalhoRede) return
        var current = tx.findRecordById('price_index_tasks', task.id)
        if (new Date().getTime() >= fimTrabalhoRede) return
        if (
          current.getString('status') !== state ||
          current.getString('pendentes') !== before ||
          current.getInt('tentativas') !== attempts ||
          current.getString('started_at') !== started ||
          current.getString('progress_at') !== progress ||
          pncpHasPriorWork(tx, old, fimTrabalhoRede)
        )
          return
        if (new Date().getTime() >= fimTrabalhoRede) return
        reservedOp = {
          v: 1,
          falhas: Number((old._pncp_relacao && old._pncp_relacao.falhas) || 0) + 1,
          claim: token,
          ate: fimTrabalhoRede,
          lastStatus: 'resolvendo',
        }
        list[index] = Object.assign({}, old, { _pncp_relacao: reservedOp })
        reserved = JSON.stringify(list)
        current.set('pendentes', reserved)
        if (new Date().getTime() >= fimTrabalhoRede) return
        tx.save(current)
        if (new Date().getTime() >= fimTrabalhoRede) throw budgetDeferred
      })
    } catch (err) {
      if (err !== budgetDeferred) throw err
      return
    }
    if (!reserved || new Date().getTime() >= fimTrabalhoRede) return
    var relationUrl =
      'https://pncp.gov.br/api/pncp/v1/orgaos/' +
      document.c +
      '/contratos/' +
      document.a +
      '/' +
      document.s
    var absenceUrl =
      'https://pncp.gov.br/api/consulta/v1/orgaos/' +
      document.c +
      '/compras/' +
      document.a +
      '/' +
      document.s
    var absenceProof = null,
      resolved = null,
      category = '',
      status = 0,
      attempted = false,
      quarantine = false
    if (!old.numeroControlePNCP) {
      if (new Date().getTime() >= fimTrabalhoRede) return
      var absence = sendHttpWithRetryUtil(absenceUrl, 4.0, 2, 80)
      if (new Date().getTime() >= fimTrabalhoRede) return
      attempted = !absence.deferred
      status = absence.resp ? Number(absence.resp.statusCode) : 0
      var missing = absence.resp && parseJsonWorkerSafe(absence.resp.json || absence.resp.raw)
      var expectedPath =
        '/pncp-consulta/v1/orgaos/' + document.c + '/compras/' + document.a + '/' + document.s
      if (
        status === 404 &&
        missing &&
        missing.path === expectedPath &&
        String(missing.status) === '404' &&
        missing.error === '404 NOT_FOUND' &&
        missing.message === 'A contratação informada não está cadastrada.'
      ) {
        absenceProof = {
          urlOficial: absenceUrl,
          path: expectedPath,
          status: 404,
          categoria: 'compra_nao_cadastrada',
          capturadoEm: new Date().toISOString(),
        }
      } else {
        category = absence.deferred ? 'adiado' : 'origem_nao_comprovada'
        quarantine = !!absence.ok || status === 301 || (status === 404 && !absenceProof)
      }
    }
    if (old.numeroControlePNCP || absenceProof) {
      if (new Date().getTime() >= fimTrabalhoRede) return
      var response = sendHttpWithRetryUtil(relationUrl, 4.0, 2, 80)
      if (new Date().getTime() >= fimTrabalhoRede) return
      attempted = attempted || !response.deferred
      status = response.resp ? Number(response.resp.statusCode) : 0
      var body = response.resp && parseJsonWorkerSafe(response.resp.json || response.resp.raw)
      if (response.ok && body && body.numeroControlePNCP === document.controle) {
        resolved = pncpResolveDocument(body, 'contrato', relationUrl)
        category = resolved.reason || 'verificada'
        if (resolved.reason) {
          quarantine = /conflit|invalido|ambigua/.test(resolved.reason)
          resolved = null
        }
      } else
        category = response.deferred
          ? 'adiado'
          : response.ok
            ? 'contrato_identidade_invalida'
            : 'contrato_http'
    }
    // A proof that arrived after its source deadline is never admitted.
    if (new Date().getTime() >= fimTrabalhoRede) return
    try {
      $app.runInTransaction(function (tx) {
        if (new Date().getTime() >= fimTrabalhoRede) return
        var current = tx.findRecordById('price_index_tasks', task.id)
        if (new Date().getTime() >= fimTrabalhoRede) return
        if (
          current.getString('status') !== state ||
          current.getString('pendentes') !== reserved ||
          current.getInt('tentativas') !== attempts ||
          current.getString('started_at') !== started ||
          current.getString('progress_at') !== progress
        )
          return
        var entries = parseJsonWorkerSafe(current.getString('pendentes'))
        if (!entries[index]._pncp_relacao || entries[index]._pncp_relacao.claim !== token) return
        if (resolved && pncpHasPriorWork(tx, old, fimTrabalhoRede)) {
          resolved = null
          category = 'trabalho_concorrente'
          quarantine = true
        }
        if (new Date().getTime() >= fimTrabalhoRede) return
        if (!resolved) {
          entries[index] = Object.assign({}, old, {
            _pncp_relacao: {
              v: 1,
              falhas: reservedOp.falhas - (attempted ? 0 : 1),
              lastStatus: category,
              httpStatus: status,
              quarentena: quarantine,
            },
          })
          current.set('pendentes', JSON.stringify(entries))
          if (new Date().getTime() >= fimTrabalhoRede) return
          tx.save(current)
          if (new Date().getTime() >= fimTrabalhoRede) throw budgetDeferred
          return
        }
        var canonical = {
          c: resolved.cnpj,
          a: resolved.ano,
          s: resolved.sequencial,
          t: 'contrato',
          r: 0,
          b: 0,
          i: 0,
          u: old.u || '',
          m: old.m || '',
          o: old.o || '',
          _pncp_compra: resolved._pncp_compra,
        }
        var key = pncpPendingKey(canonical),
          previous = pncpReceipts(current.getString('erros'))
        var already = previous.some(function (x) {
          return (
            x.documentControl === document.controle &&
            x.purchaseControl === resolved._pncp_compra.controle
          )
        })
        entries.splice(index, 1)
        var exists = entries.some(function (p) {
          return pncpPendingKey(p) === key
        })
        var purchaseAdmitted = pncpAdmittedBefore(canonical, previous)
        if (!exists && !purchaseAdmitted) entries.push(canonical)
        if (!already) {
          var receipt = {
            oldPending: old,
            oldLastError: current.getString('ultimo_erro').slice(0, 500),
            oldAttempts: attempts,
            oldCounters: {
              paginas_consultadas: current.getInt('paginas_consultadas'),
              itens_processados: current.getInt('itens_processados'),
              amostras_inseridas: current.getInt('amostras_inseridas'),
              amostras_atualizadas: current.getInt('amostras_atualizadas'),
            },
            documentControl: document.controle,
            purchaseControl: resolved._pncp_compra.controle,
            officialUrl: relationUrl,
            capturedAt: new Date().toISOString(),
            absenceProof: absenceProof,
          }
          var history = pncpErrors(current.getString('erros'))
          history.push('PNCP_NAMESPACE_REBOUND_V1 ' + JSON.stringify(receipt))
          current.set('erros', JSON.stringify(history))
        }
        current.set('pendentes', JSON.stringify(entries))
        current.set(
          'ultimo_erro',
          entries
            .filter(function (p) {
              return !p._pncp_discovery && !pncpActionable(p)
            })
            .map(function (p) {
              return 'PNCP cobertura não resolvida: ' + pncpPendingKey(p)
            })
            .join('; ')
            .slice(0, 500),
        )
        if (
          entries.some(function (p) {
            return pncpPendingKey(p) === key && pncpActionable(p)
          })
        )
          current.set('status', 'pending')
        else if (
          purchaseAdmitted &&
          !entries.some(function (p) {
            if (!p._pncp_discovery) return true
            var exhausted = p._pncp_discovery.esgotados || {}
            return !(exhausted.ata && exhausted.edital && exhausted.contrato)
          })
        ) {
          current.set('status', 'completed')
          current.set('pendentes', '[]')
          current.set('finished_at', new Date().toISOString())
        }
        if (new Date().getTime() >= fimTrabalhoRede) return
        tx.save(current)
        if (new Date().getTime() >= fimTrabalhoRede) throw budgetDeferred
      })
    } catch (err) {
      if (err !== budgetDeferred) throw err
    }
  }

  function buscarClaimEstagnadoWorker(appClaim, taskId, selecionadas) {
    // Stale reclaim: tarefa só é viva se progress_at (ou started_at se recém-iniciada) avança.
    // Threshold de 2 minutos conforme especificação.
    var idadeClaimSql = 'COALESCE(julianday(progress_at), julianday(started_at))'
    var sqlClaim =
      "SELECT id FROM price_index_tasks WHERE status = 'running' AND " +
      idadeClaimSql +
      ' < julianday({:limite})'
    var paramsClaim = { limite: new Date(new Date().getTime() - 2 * 60 * 1000).toISOString() }
    if (taskId) {
      sqlClaim += ' AND id = {:taskId}'
      paramsClaim.taskId = taskId
    }
    for (var seen = 0; selecionadas && seen < selecionadas.length; seen++) {
      sqlClaim += ' AND id <> {:seen' + seen + '}'
      paramsClaim['seen' + seen] = selecionadas[seen]
    }
    sqlClaim += ' ORDER BY ' + idadeClaimSql + ', id LIMIT 1'
    var queryClaim = appClaim.db().newQuery(sqlClaim)
    queryClaim.bind(paramsClaim)
    var claims = arrayOf(new DynamicModel({ id: '' }))
    queryClaim.all(claims)
    return claims.length > 0 ? claims[0].id : ''
  }

  var tarefasSelecionadasNesteTick = []
  for (var taskTurn = 0; taskTurn < MAX_TAREFAS_POR_TICK; taskTurn++) {
    if (trabalhoAdiadoPorTempo || new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000) {
      break
    }

    var tarefaAdquirida = null
    try {
      // One recovery opportunity per tick, even while an older task keeps requeueing.
      // Remaining turns retain pending-first selection and the existing stale fallback.
      var tarefas = modoHttp ? [$app.findRecordById('price_index_tasks', tarefaIdHttp)] : []
      // This turn only implements PNCP, never certification of Compras completion.
      if (modoHttp) {
        var fonteHttp = (tarefas[0].getString('source') || 'AMBAS').toUpperCase()
        if (fonteHttp !== 'AMBAS' && fonteHttp.indexOf('PNCP') === -1) tarefas = []
      }
      if (!modoHttp && taskTurn === 0) {
        try {
          var primeiroClaimEstagnado = buscarClaimEstagnadoWorker(
            $app,
            '',
            tarefasSelecionadasNesteTick,
          )
          if (primeiroClaimEstagnado) {
            tarefas = [$app.findRecordById('price_index_tasks', primeiroClaimEstagnado)]
            console.log(
              '[PRICE-WORKER] Tarefa recuperada no primeiro turno:',
              primeiroClaimEstagnado,
            )
          }
        } catch (_) {}
      }
      if (!modoHttp && tarefas.length === 0) {
        var sqlPendente = "SELECT id FROM price_index_tasks WHERE status = 'pending'"
        var paramsPendente = {}
        for (var seen = 0; seen < tarefasSelecionadasNesteTick.length; seen++) {
          sqlPendente += ' AND id <> {:seen' + seen + '}'
          paramsPendente['seen' + seen] = tarefasSelecionadasNesteTick[seen]
        }
        // Real completed turn, never producer-updated priority; unserved tasks use creation.
        sqlPendente +=
          ' ORDER BY COALESCE(julianday(finished_at), julianday(created), 0), julianday(created), id LIMIT 1'
        var queryPendente = $app.db().newQuery(sqlPendente)
        queryPendente.bind(paramsPendente)
        var pendentesSelecionados = arrayOf(new DynamicModel({ id: '' }))
        queryPendente.all(pendentesSelecionados)
        if (pendentesSelecionados.length > 0)
          tarefas = [$app.findRecordById('price_index_tasks', pendentesSelecionados[0].id)]
      }

      // 2. Stale reclaim: se não achou pendente, recupera running estagnada (> 2 minutos)
      if (!modoHttp && taskTurn !== 0 && (!tarefas || tarefas.length === 0)) {
        try {
          var claimEstagnadoId = buscarClaimEstagnadoWorker($app, '', tarefasSelecionadasNesteTick)
          if (claimEstagnadoId) {
            tarefas = [$app.findRecordById('price_index_tasks', claimEstagnadoId)]
            console.log(
              '[PRICE-WORKER] Tarefa em running recuperada por stale reclaim:',
              claimEstagnadoId,
            )
          }
        } catch (_) {}
      }

      if (tarefas && tarefas.length > 0) {
        // A raced claim consumes only this bounded slot, without selecting it again.
        if (!modoHttp) tarefasSelecionadasNesteTick.push(tarefas[0].id)
        pncpRecoverTask(tarefas[0])
        if (trabalhoAdiadoPorTempo || new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000)
          break
        $app.runInTransaction(function (txApp) {
          var tRec = txApp.findRecordById('price_index_tasks', tarefas[0].id)
          if (new Date().getTime() >= fimTrabalhoRede) return
          if (
            tRec.getString('status') !== 'pending' &&
            !(
              tRec.getString('status') === 'running' &&
              buscarClaimEstagnadoWorker(txApp, tRec.id) === tRec.id
            )
          )
            return
          if (new Date().getTime() >= fimTrabalhoRede) return
          var agoraIso = new Date().toISOString()
          var tenta = (parseInt(tRec.getString('tentativas'), 10) || 0) + 1
          tRec.set('status', 'running')
          tRec.set('started_at', agoraIso)
          tRec.set('progress_at', agoraIso)
          tRec.set('tentativas', tenta)
          txApp.save(tRec)

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
            started_at: agoraIso,
            pendentes: parsedPendentes,
            paginas_consultadas: Number(tRec.getInt('paginas_consultadas')) || 0,
            itens_processados: Number(tRec.getInt('itens_processados')) || 0,
            amostras_inseridas: Number(tRec.getInt('amostras_inseridas')) || 0,
            amostras_atualizadas: Number(tRec.getInt('amostras_atualizadas')) || 0,
          }
        })
      }
    } catch (errFind) {
      console.log('[PRICE-WORKER-CRON] Erro ao buscar tarefa na fila:', errFind.message)
    }

    if (!tarefaAdquirida) {
      if (!modoHttp && tarefas && tarefas.length > 0) continue
      break
    }

    tarefasProcessadasNesteTick++
    console.log(
      '[PRICE-WORKER-CRON] [TAREFA #' + tarefasProcessadasNesteTick + '] Processando:',
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
    var descobertaAvancouWorker = false
    var errosAcumulados = []
    var recibosAdquiridos = pncpReceiptRecords(
      $app.findRecordById('price_index_tasks', tarefaAdquirida.id).getString('erros'),
    )
    var pendentesRestantes = tarefaAdquirida.pendentes ? [...tarefaAdquirida.pendentes] : []
    function possuiClaimWorker(rec) {
      return (
        rec.getString('status') === 'running' &&
        rec.getString('started_at') === tarefaAdquirida.started_at &&
        Number(rec.getInt('tentativas')) === tarefaAdquirida.tentativas
      )
    }
    function chavePendenteWorker(p) {
      return pncpPendingKey(p)
    }
    // Identifica o delta concorrente sem reinserir compras consumidas deste snapshot.
    var pendentesAdquiridosPorChave = {}
    var marcadorAdquirido = ''
    for (var snapI = 0; snapI < pendentesRestantes.length; snapI++) {
      var snapP = pendentesRestantes[snapI]
      if (snapP._pncp_discovery) marcadorAdquirido = JSON.stringify(snapP._pncp_discovery)
      else pendentesAdquiridosPorChave[chavePendenteWorker(snapP)] = JSON.stringify(snapP)
    }
    // Marcador reservado: progresso da descoberta do termo, nunca uma compra/retry.
    var descobertaPncp = { esgotados: {} }
    pendentesRestantes = pendentesRestantes.filter(function (p) {
      if (p && p._pncp_discovery) {
        descobertaPncp = p._pncp_discovery
        return false
      }
      return true
    })
    if (!descobertaPncp.esgotados) descobertaPncp.esgotados = {}
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
        if (
          n.indexOf(tokenPrincipal) !== -1 ||
          (tokenStem && tokenStem.length >= 4 && n.indexOf(tokenStem) !== -1)
        )
          return true
        var dToks = extractWorkerTokensUtil(desc)
        for (var idx = 0; idx < dToks.length; idx++) {
          var dt = dToks[idx]
          var dtStem = stemWorkerTokenUtil(dt)
          if (dt === tokenPrincipal) return true
          if (tokenStem && tokenStem.length >= 4 && dtStem === tokenStem) return true
          if (dt.indexOf(tokenPrincipal) === 0 && Math.abs(dt.length - tokenPrincipal.length) <= 3)
            return true
          if (
            tokenStem &&
            tokenStem.length >= 4 &&
            dtStem.indexOf(tokenStem) === 0 &&
            Math.abs(dtStem.length - tokenStem.length) <= 3
          )
            return true
        }
        return false
      }

      var contratacoesParaProcessar = []
      var seenCnpjKeys = {}
      // Compras esgotadas permanecem como evidência, fora do lote selecionável.
      var pendentesCongelados = []
      pendentesRestantes = pendentesRestantes.filter(function (p) {
        if (p.t === 'contrato' && !pncpVerifiedPurchase(p)) {
          pendentesCongelados.push(p)
          errosAcumulados.push('PNCP relação pendente ou em quarentena')
          return false
        }
        if (Number(p.r) >= 4) {
          pendentesCongelados.push(p)
          var chaveCongelada =
            (p.c || p.cnpj || '') + '_' + (p.a || p.ano || '') + '_' + (p.s || p.sequencial || '')
          seenCnpjKeys[chaveCongelada] = true // Descoberta não pode recriar a compra com r=0.
          errosAcumulados.push(
            'PNCP itens ' +
              chaveCongelada +
              ': limite de retentativas esgotado; cobertura não resolvida',
          )
          return false
        }
        return true
      })

      // 1. PRIORIZAÇÃO CRÍTICA NA FILA DE PENDENTES:
      // a. Atas e contratações homologadas com preço unitário no TOPO (score 40/30)
      // b. Editais (score 10) sem atrasar as homologadas
      // c. Menor contagem de retentativas anteriores
      pendentesRestantes.sort(function (pA, pB) {
        var scoreA = (pA.t === 'ata' ? 40 : pA.t === 'contrato' ? 30 : 10) - (Number(pA.r) || 0) * 5
        var scoreB = (pB.t === 'ata' ? 40 : pB.t === 'contrato' ? 30 : 10) - (Number(pB.r) || 0) * 5
        return scoreB - scoreA
      })

      // Orçamento expandido de detalhamento por ciclo: até 60 contratações por lote
      if (pendentesRestantes.length > 0) {
        var LOTE_PENDENTES_MAX = 60
        var lotePendentesAtual = pendentesRestantes.splice(0, LOTE_PENDENTES_MAX)
        for (var lp = 0; lp < lotePendentesAtual.length; lp++) {
          var pItem = lotePendentesAtual[lp]
          var rawCnpj = pItem.c || pItem.cnpj || ''
          var ano = pItem.a || pItem.ano || 0
          var seq = pItem.s || pItem.sequencial || 0
          var kP = rawCnpj + '_' + ano + '_' + seq
          var retentativasPrevias = Number(pItem.r) || 0

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
              _cacheItemOffset: Math.max(0, parseInt(pItem.i, 10) || 0),
              _pendente: pItem,
            })
          }
        }
      }
      pendentesRestantes = pendentesCongelados.concat(pendentesRestantes)

      // 2. Sem contratação acionável selecionada, repõe descoberta (ata > edital > contrato)
      if (
        contratacoesParaProcessar.length === 0 &&
        !(
          descobertaPncp.esgotados.ata &&
          descobertaPncp.esgotados.edital &&
          descobertaPncp.esgotados.contrato
        ) &&
        new Date().getTime() - tInicioCiclo < MAX_DURATION_MS - 15000
      ) {
        var paginasAntesBusca = paginasTotal
        var cicloDocTipos = ['ata', 'edital', 'contrato']
        // No máximo três avanços locais; não repete página 1 após a página 20.
        for (var docSkip = 0; docSkip < cicloDocTipos.length; docSkip++) {
          if (!descobertaPncp.esgotados[cicloDocTipos[paginasTotal % cicloDocTipos.length]]) break
          paginasTotal++
        }
        var janelaIndex = paginasTotal % cicloDocTipos.length
        var tipoJanelaAtiva = cicloDocTipos[janelaIndex]
        var paginaAlvoPncp = Math.floor(paginasTotal / cicloDocTipos.length) + 1

        var urlBusca =
          'https://pncp.gov.br/api/search/?q=' +
          encodeURIComponent(termo) +
          '&tipos_documento=' +
          encodeURIComponent(tipoJanelaAtiva) +
          '&pagina=' +
          paginaAlvoPncp +
          '&tam_pagina=40'
        if (uf) urlBusca += '&ufs=' + encodeURIComponent(uf)

        var resBusca = sendHttpWithRetryUtil(urlBusca, 4.0, 2, 80)
        if (resBusca.ok && resBusca.resp) {
          var body = parseJsonWorkerSafe(resBusca.resp.json || resBusca.resp.raw)
          var items = body
            ? Array.isArray(body)
              ? body
              : body.items || body.data || body.resultado
            : resBusca.resp.statusCode === 204
              ? []
              : null

          if (
            !Array.isArray(items) ||
            items.some(function (entry) {
              return !entry || typeof entry !== 'object' || Array.isArray(entry)
            })
          ) {
            errosAcumulados.push('PNCP busca ' + tipoJanelaAtiva + ': resposta de itens inválida')
            items = [] // Falha não avança o cursor nem encerra a descoberta.
          } else {
            paginasTotal++
            descobertaAvancouWorker = true
            var totalPaginasBusca = Number(body && body.totalPaginas)
            if (
              items.length === 0 ||
              (totalPaginasBusca > 0 && paginaAlvoPncp >= totalPaginasBusca)
            ) {
              descobertaPncp.esgotados[tipoJanelaAtiva] = true
            }
          }

          items.sort(function (a, b) {
            var aScore =
              a.situacaoCompraName === 'Homologada' || a.tipo_documento === 'ata' ? 10 : 0
            var bScore =
              b.situacaoCompraName === 'Homologada' || b.tipo_documento === 'ata' ? 10 : 0
            return bScore - aScore
          })

          for (var k = 0; k < items.length; k++) {
            var it = items[k]
            var resolvedB = pncpResolveDocument(it, tipoJanelaAtiva, urlBusca)
            if (resolvedB.reason) {
              var relacaoPendenteB = pncpRelationPending(resolvedB, it)
              var chaveRelacaoB = pncpPendingKey(relacaoPendenteB)
              var filaAtualRelacaoB = parseJsonWorkerSafe(
                $app.findRecordById('price_index_tasks', tarefaAdquirida.id).getString('pendentes'),
              )
              if (!Array.isArray(filaAtualRelacaoB)) filaAtualRelacaoB = []
              if (
                !pendentesRestantes.concat(filaAtualRelacaoB).some(function (p) {
                  return pncpPendingKey(p) === chaveRelacaoB
                })
              )
                pendentesRestantes.push(relacaoPendenteB)
              errosAcumulados.push('PNCP relação: ' + resolvedB.reason)
              continue
            }
            var rawCnpjB = resolvedB.cnpj,
              anoB = resolvedB.ano,
              seqB = resolvedB.sequencial

            if (
              pncpAdmittedBefore({ c: rawCnpjB, a: anoB, s: seqB, t: 'edital' }, recibosAdquiridos)
            )
              continue
            var kPB = rawCnpjB + '_' + anoB + '_' + seqB
            if (rawCnpjB && anoB && seqB && !seenCnpjKeys[kPB]) {
              seenCnpjKeys[kPB] = true
              contratacoesParaProcessar.push({
                _pendente: { _pncp_compra: resolvedB._pncp_compra },
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
                _tipoDoc: it.tipo_documento || it.document_type || tipoJanelaAtiva,
                _retries: 0,
                raw_entry: it,
              })
            }
          }
        } else if (resBusca.deferred) {
          paginasTotal = paginasAntesBusca
        } else {
          errosAcumulados.push(
            'PNCP busca ' + tipoJanelaAtiva + ': ' + (resBusca.error || 'sem resposta'),
          )
        }
      }

      var colecaoAmostrasCiclo = null

      // 3. Processamento detalhado com espaçamento seguro (80ms)
      for (var cIdx = 0; cIdx < contratacoesParaProcessar.length; cIdx++) {
        if (trabalhoAdiadoPorTempo || new Date().getTime() >= fimTrabalhoRede) {
          for (var leftover = cIdx; leftover < contratacoesParaProcessar.length; leftover++) {
            var lo = contratacoesParaProcessar[leftover]
            pendentesRestantes.unshift(
              Object.assign({}, lo._pendente || {}, {
                c: lo.cnpj,
                a: lo.ano,
                s: lo.sequencial,
                u: lo.uf,
                m: lo.municipio,
                o: lo.orgao,
                t: lo._tipoDoc || 'ata',
                r: lo._retries || 0,
                i: lo._cacheItemOffset || 0,
              }),
            )
          }
          break
        }

        var cItemProcessando = contratacoesParaProcessar[cIdx]
        if (cItemProcessando._pendente && cItemProcessando._pendente._pncp_compra)
          cItemProcessando.numeroControlePNCP = cItemProcessando._pendente._pncp_compra.controle
        var cnpjC = cItemProcessando.cnpj
        var anoC = cItemProcessando.ano
        var seqC = cItemProcessando.sequencial
        var cacheKeyC = cnpjC + '_' + anoC + '_' + seqC
        var itensArrC = null
        var erroAoBuscarItens = false
        var cacheCompletoC = false
        var proximaPaginaC = 1
        var itensCacheC = []
        var resultadosPositivosC = {}
        var novosResultadosC = {}
        var cRec = null
        var cacheItemOffsetC = cItemProcessando._cacheItemOffset || 0
        // Shared cache pagination is not this query's examined-item boundary.
        var cachePrefixExaminedC = Math.max(
          cacheItemOffsetC,
          parseInt(cItemProcessando._pendente && cItemProcessando._pendente.b, 10) || 0,
        )
        var cacheSliceBaseC = null
        var cacheTodosC = itensCacheC
        var trabalhoPaginaC = cItemProcessando._pendente && cItemProcessando._pendente.j
        var refsTrabalhoC = null
        var erroReferenciaC = ''

        function pendenteAtualC(offset, trabalho) {
          var p = Object.assign({}, cItemProcessando._pendente || {}, {
            c: cnpjC,
            a: anoC,
            s: seqC,
            u: cItemProcessando.uf || '',
            m: cItemProcessando.municipio || '',
            o: cItemProcessando.orgao || '',
            t: cItemProcessando._tipoDoc || 'ata',
            r: cItemProcessando._retries || 0,
          })
          delete p.i
          delete p.j
          if (offset !== null && offset !== undefined) p.i = offset
          if (trabalho) p.j = trabalho
          p.b = cachePrefixExaminedC
          return p
        }

        function referenciasPaginaC(itens, posicoes) {
          return posicoes.map(function (pos) {
            var ref = { pos: pos }
            var numero = itens[pos].numeroItem || itens[pos].numero_item
            if (numero != null) ref.numeroItem = numero
            return ref
          })
        }

        function checkpointPaginaC(txApp) {
          var tarefaCheckpoint = txApp.findRecordById('price_index_tasks', tarefaAdquirida.id)
          if (!possuiClaimWorker(tarefaCheckpoint))
            throw new Error('PNCP claim substituído antes do checkpoint')
          var atuais = parseJsonWorkerSafe(tarefaCheckpoint.getString('pendentes')) || []
          var pendentesAntesCheckpoint = pncpCanonical(atuais)
          var p = pendenteAtualC(null, trabalhoPaginaC)
          var chave = chavePendenteWorker(p)
          var substituiu = false
          for (var cpI = 0; cpI < atuais.length; cpI++) {
            if (atuais[cpI]._pncp_discovery || chavePendenteWorker(atuais[cpI]) !== chave) continue
            p = Object.assign({}, atuais[cpI], p)
            delete p.i
            atuais[cpI] = p
            substituiu = true
            break
          }
          if (!substituiu) atuais.push(p)
          tarefaCheckpoint.set('pendentes', JSON.stringify(atuais))
          if (pncpCanonical(atuais) !== pendentesAntesCheckpoint)
            tarefaCheckpoint.set('progress_at', new Date().toISOString())
          txApp.save(tarefaCheckpoint)
          pendentesAdquiridosPorChave[chave] = JSON.stringify(p)
        }

        function consumirFatiaCacheAtualC(itensAtuais, offset) {
          if (!Array.isArray(itensAtuais)) throw new Error('PNCP cache atual sem itens válidos')
          cacheTodosC = itensAtuais
          cacheSliceBaseC = offset
          itensArrC = itensAtuais.slice(offset, offset + 50)
          refsTrabalhoC = referenciasPaginaC(
            itensAtuais,
            itensArrC.map(function (_, idx) {
              return offset + idx
            }),
          )
          trabalhoPaginaC = { v: 1, pagina: 0, refs: refsTrabalhoC }
          if (offset + itensArrC.length < itensAtuais.length)
            trabalhoPaginaC.proximo_i = offset + itensArrC.length
        }

        try {
          cRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyC)
          if (cRec) {
            var rawItensC = cRec.getString('raw_itens')
            var cacheC = parseJsonWorkerSafe(rawItensC)
            resultadosPositivosC = (cacheC && cacheC.resultados_positivos) || {}
            itensCacheC = Array.isArray(cacheC)
              ? cacheC
              : cacheC && Array.isArray(cacheC.items)
                ? cacheC.items
                : []
            cacheTodosC = itensCacheC
            if (cachePrefixExaminedC > itensCacheC.length) {
              // A shorter authoritative cache is evidenced divergence, not new progress.
              cachePrefixExaminedC = 0
              cacheItemOffsetC = 0
            }
            var pagC = cacheC && !Array.isArray(cacheC) && cacheC.paginacao
            if (pagC && pagC.versao === 1 && pagC.tamanho_pagina === 50) {
              proximaPaginaC = Math.max(1, parseInt(pagC.proxima_pagina, 10) || 1)
              cacheCompletoC = pagC.completa === true
            }
            // i > 0 drains this task's received cache backlog, including a partial cache.
            // Only after its final slice may a partial purchase resume the official next page.
            if (trabalhoPaginaC) {
              itensArrC = []
              if (trabalhoPaginaC.v !== 1 || !Array.isArray(trabalhoPaginaC.refs))
                erroReferenciaC = 'checkpoint de itens inválido'
              else {
                refsTrabalhoC = trabalhoPaginaC.refs.slice()
                for (var refI = 0; refI < refsTrabalhoC.length; refI++) {
                  var refC = refsTrabalhoC[refI]
                  var posRefC = refC && Number(refC.pos)
                  var itemRefC =
                    Number.isInteger(posRefC) && posRefC >= 0 ? itensCacheC[posRefC] : null
                  if (
                    refC &&
                    refC.numeroItem != null &&
                    (!itemRefC ||
                      String(itemRefC.numeroItem || itemRefC.numero_item) !==
                        String(refC.numeroItem))
                  ) {
                    itemRefC = null
                    for (var buscaRef = 0; buscaRef < itensCacheC.length; buscaRef++) {
                      if (
                        String(
                          itensCacheC[buscaRef].numeroItem || itensCacheC[buscaRef].numero_item,
                        ) === String(refC.numeroItem)
                      ) {
                        itemRefC = itensCacheC[buscaRef]
                        break
                      }
                    }
                  }
                  if (!itemRefC) {
                    erroReferenciaC = 'referência de item ausente no cache'
                    break
                  }
                  itensArrC.push(itemRefC)
                }
              }
            } else if (cacheCompletoC || cachePrefixExaminedC < itensCacheC.length)
              consumirFatiaCacheAtualC(itensCacheC, cachePrefixExaminedC)
            else itensArrC = []
          }
        } catch (_) {}

        // Uma página por compra/turno. Arrays legados são úteis, mas sem prova de completude.
        if (trabalhoPaginaC && (!refsTrabalhoC || erroReferenciaC)) {
          errosAcumulados.push(
            'PNCP itens ' + cacheKeyC + ': ' + (erroReferenciaC || 'checkpoint sem cache'),
          )
          pendentesRestantes.push(pendenteAtualC(null, trabalhoPaginaC))
          continue
        }

        if (cacheSliceBaseC !== null && trabalhoPaginaC) {
          try {
            $app.runInTransaction(checkpointPaginaC)
          } catch (_) {
            erroAoBuscarItens = true
          }
        }

        if (!erroAoBuscarItens && !trabalhoPaginaC && !cacheCompletoC) {
          var urlItens =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            cnpjC +
            '/compras/' +
            anoC +
            '/' +
            seqC +
            '/itens?pagina=' +
            proximaPaginaC +
            '&tamanhoPagina=50'
          var resItens = sendHttpWithRetryUtil(urlItens, 3.5, 2, 80)
          if (resItens.ok && resItens.resp) {
            var bItens = parseJsonWorkerSafe(resItens.resp.json || resItens.resp.raw)
            itensArrC = bItens
              ? Array.isArray(bItens)
                ? bItens
                : bItens.items || bItens.data || bItens.resultado
              : resItens.resp.statusCode === 204
                ? []
                : null
            if (
              Array.isArray(itensArrC) &&
              !itensArrC.some(function (entry) {
                return !entry || typeof entry !== 'object' || Array.isArray(entry)
              })
            ) {
              var itensMescladosC = itensCacheC.slice()
              var posicoesC = {}
              for (var oldI = 0; oldI < itensMescladosC.length; oldI++) {
                var oldNum = itensMescladosC[oldI].numeroItem || itensMescladosC[oldI].numero_item
                if (oldNum) posicoesC[String(oldNum)] = oldI
              }
              for (var newI = 0; newI < itensArrC.length; newI++) {
                var novoItemC = itensArrC[newI]
                var novoNumC = novoItemC.numeroItem || novoItemC.numero_item
                var posC = novoNumC ? posicoesC[String(novoNumC)] : undefined
                if (posC !== undefined) {
                  itensMescladosC[posC] = Object.assign({}, itensMescladosC[posC], novoItemC)
                } else {
                  if (novoNumC) posicoesC[String(novoNumC)] = itensMescladosC.length
                  itensMescladosC.push(novoItemC)
                }
              }
              cacheCompletoC = itensArrC.length < 50
              try {
                $app.runInTransaction(function (txApp) {
                  if (
                    !possuiClaimWorker(
                      txApp.findRecordById('price_index_tasks', tarefaAdquirida.id),
                    )
                  )
                    throw new Error('PNCP claim substituído')
                  var rC = null
                  try {
                    rC = txApp.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyC)
                  } catch (_) {}
                  var atualC = rC ? parseJsonWorkerSafe(rC.getString('raw_itens')) : null
                  var pagAtualC = atualC && atualC.paginacao
                  // A completed/newer page fetched concurrently owns the current raw items and cursor.
                  if (
                    pagAtualC &&
                    (Number(pagAtualC.proxima_pagina) > proximaPaginaC ||
                      pagAtualC.completa === true)
                  ) {
                    resultadosPositivosC = atualC.resultados_positivos || {}
                    cacheCompletoC = pagAtualC.completa === true
                    // The other writer may belong to another term. This task must examine
                    // its authoritative items too, without replaying the received HTTP page.
                    cachePrefixExaminedC = 0
                    consumirFatiaCacheAtualC(atualC.items, 0)
                    refsTrabalhoC = referenciasPaginaC(
                      cacheTodosC,
                      itensArrC.map(function (_, idx) {
                        return idx
                      }),
                    )
                    trabalhoPaginaC = { v: 1, pagina: proximaPaginaC, refs: refsTrabalhoC }
                    if (itensArrC.length < cacheTodosC.length)
                      trabalhoPaginaC.proximo_i = itensArrC.length
                    checkpointPaginaC(txApp)
                    return
                  }
                  var atuaisItensC = Array.isArray(atualC) ? atualC : atualC && atualC.items
                  var itensConcorrentesC =
                    Array.isArray(atuaisItensC) &&
                    pncpCanonical(atuaisItensC) !== pncpCanonical(itensCacheC)
                  if (Array.isArray(atuaisItensC)) {
                    // Rebase this page onto the transaction's current items, not the old snapshot.
                    itensMescladosC = atuaisItensC.slice()
                    for (var paginaI = 0; paginaI < itensArrC.length; paginaI++) {
                      var paginaItem = itensArrC[paginaI]
                      var paginaNum = Number(paginaItem.numeroItem || paginaItem.numero_item)
                      var atualPos = -1
                      for (var atualI = 0; atualI < itensMescladosC.length; atualI++) {
                        if (
                          paginaNum &&
                          Number(
                            itensMescladosC[atualI].numeroItem ||
                              itensMescladosC[atualI].numero_item,
                          ) === paginaNum
                        ) {
                          atualPos = atualI
                          break
                        }
                      }
                      if (atualPos < 0) itensMescladosC.push(paginaItem)
                      else {
                        var snapshotItem = null
                        for (var snapshotI = 0; snapshotI < itensCacheC.length; snapshotI++) {
                          if (
                            Number(
                              itensCacheC[snapshotI].numeroItem ||
                                itensCacheC[snapshotI].numero_item,
                            ) === paginaNum
                          ) {
                            snapshotItem = itensCacheC[snapshotI]
                            break
                          }
                        }
                        if (
                          snapshotItem &&
                          pncpCanonical(snapshotItem) === pncpCanonical(itensMescladosC[atualPos])
                        ) {
                          itensMescladosC[atualPos] = Object.assign(
                            {},
                            itensMescladosC[atualPos],
                            paginaItem,
                          )
                        }
                      }
                    }
                  }
                  var colC = txApp.findCollectionByNameOrId('pncp_item_cache')
                  if (!rC) rC = new Record(colC)
                  resultadosPositivosC =
                    (atualC && atualC.resultados_positivos) || resultadosPositivosC
                  rC.set('cache_key', cacheKeyC)
                  rC.set('cnpj', cnpjC)
                  rC.set('ano', parseInt(anoC, 10))
                  rC.set('sequencial', parseInt(seqC, 10))
                  var cacheSalvoC = atualC && !Array.isArray(atualC) ? atualC : {}
                  cacheSalvoC.items = itensMescladosC
                  if (Object.keys(resultadosPositivosC).length > 0)
                    cacheSalvoC.resultados_positivos = resultadosPositivosC
                  cacheSalvoC.paginacao = {
                    versao: 1,
                    tamanho_pagina: 50,
                    proxima_pagina: proximaPaginaC + 1,
                    completa: cacheCompletoC,
                  }
                  rC.set('raw_itens', JSON.stringify(cacheSalvoC))
                  rC.set('total_itens', itensMescladosC.length)
                  txApp.save(rC)
                  if (itensConcorrentesC) {
                    cachePrefixExaminedC = 0
                    consumirFatiaCacheAtualC(itensMescladosC, 0)
                  }
                  cacheTodosC = itensMescladosC
                  var posicoesPaginaC = []
                  for (var refPaginaI = 0; refPaginaI < itensArrC.length; refPaginaI++) {
                    var refPaginaItem = itensArrC[refPaginaI]
                    var refPaginaNum = refPaginaItem.numeroItem || refPaginaItem.numero_item
                    var refPaginaPos = itensMescladosC.indexOf(refPaginaItem)
                    if (refPaginaNum != null) {
                      for (var refBuscaI = 0; refBuscaI < itensMescladosC.length; refBuscaI++) {
                        if (
                          String(
                            itensMescladosC[refBuscaI].numeroItem ||
                              itensMescladosC[refBuscaI].numero_item,
                          ) === String(refPaginaNum)
                        ) {
                          refPaginaPos = refBuscaI
                          break
                        }
                      }
                    }
                    if (refPaginaPos < 0)
                      throw new Error('PNCP página sem referência oficial no cache')
                    if (posicoesPaginaC.indexOf(refPaginaPos) < 0)
                      posicoesPaginaC.push(refPaginaPos)
                  }
                  refsTrabalhoC = referenciasPaginaC(itensMescladosC, posicoesPaginaC)
                  itensArrC = posicoesPaginaC.map(function (pos) {
                    return itensMescladosC[pos]
                  })
                  trabalhoPaginaC = { v: 1, pagina: proximaPaginaC, refs: refsTrabalhoC }
                  if (
                    cacheSliceBaseC !== null &&
                    cacheSliceBaseC + itensArrC.length < cacheTodosC.length
                  )
                    trabalhoPaginaC.proximo_i = cacheSliceBaseC + itensArrC.length
                  checkpointPaginaC(txApp)
                })
              } catch (_) {
                erroAoBuscarItens = true
              }
            } else {
              erroAoBuscarItens = true
            }
          } else if (resItens.deferred) {
            pendentesRestantes.push(pendenteAtualC(cacheItemOffsetC, null))
            continue
          } else {
            erroAoBuscarItens = true
          }
        }

        if (erroAoBuscarItens) {
          var novaRetentativa = (cItemProcessando._retries || 0) + 1
          var pendenteComFalha = pendenteAtualC(cacheItemOffsetC, trabalhoPaginaC)
          pendenteComFalha.r = novaRetentativa
          pendentesRestantes.push(pendenteComFalha)
          if (novaRetentativa > 3) {
            errosAcumulados.push(
              'PNCP itens ' +
                cacheKeyC +
                ': limite de retentativas esgotado; cobertura não resolvida',
            )
          }
          continue
        }

        contratacoesProcessadasNesteCiclo++
        if (!Array.isArray(itensArrC)) itensArrC = []
        var aposentadosC = 0
        function aposentarItemC(item) {
          aposentadosC++
          // Supported cache writers append new identities and merge existing slots.
          // Legacy/reordered refs may safely replay a gap, never certify it examined.
          var ref = refsTrabalhoC && refsTrabalhoC[subI]
          var pos = ref && Number(ref.pos)
          if (!Number.isInteger(pos) || cacheTodosC[pos] !== item) pos = cacheTodosC.indexOf(item)
          if (pos === cachePrefixExaminedC) cachePrefixExaminedC++
        }

        for (var subI = 0; subI < itensArrC.length; subI++) {
          if (new Date().getTime() >= fimTrabalhoRede) {
            trabalhoAdiadoPorTempo = true
            break
          }
          var itmObj = itensArrC[subI]
          var dItem = itmObj.descricao || itmObj.materialOuServicoNome || ''
          if (!itemEhCompativelWorker(dItem)) {
            aposentarItemC(itmObj)
            continue
          }

          var numItemInt = parseInt(itmObj.numeroItem || itmObj.numero_item, 10) || 0
          var registroPreco = itmObj
          var campoUnitario = ''
          var camposUnitarios = [
            'valorUnitarioHomologado',
            'valor_unitario_homologado',
            'valorUnitarioEstimado',
            'valor_unitario_estimado',
            'valorUnitario',
            'valor_unitario',
          ]
          for (var campoIdx = 0; campoIdx < camposUnitarios.length; campoIdx++) {
            var candidato = Number(itmObj[camposUnitarios[campoIdx]])
            if (isFinite(candidato) && candidato > 0) {
              campoUnitario = camposUnitarios[campoIdx]
              break
            }
          }
          var vUnitFinal = campoUnitario ? Number(itmObj[campoUnitario]) : 0
          var nat = /homologado/i.test(campoUnitario) ? 'homologado' : 'estimado'
          var urlItem =
            numItemInt > 0 && cnpjC && anoC && seqC
              ? 'https://pncp.gov.br/api/pncp/v1/orgaos/' +
                cnpjC +
                '/compras/' +
                anoC +
                '/' +
                seqC +
                '/itens/' +
                numItemInt
              : ''
          var urlEvidencia = urlItem
          var resultadoCapturadoEm = ''
          var resultadoReutilizado = false
          var forNome =
            (itmObj.fornecedor &&
              (itmObj.fornecedor.nomeRazaoSocialFornecedor || itmObj.fornecedor.nomeRazaoSocial)) ||
            'NÃO INFORMADO'
          var forCnpj =
            (itmObj.fornecedor && (itmObj.fornecedor.niFornecedor || itmObj.fornecedor.cnpj)) ||
            'NÃO INFORMADO'

          if (vUnitFinal <= 0 && urlItem) {
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
            var identidadeResultado = {
              cnpj: cnpjC,
              ano: Number(anoC),
              sequencial: Number(seqC),
              numeroItem: numItemInt,
            }
            var chaveResultado = pncpResultKey(identidadeResultado)
            var cacheResultado = pncpValidResult(
              typeof resultadosPositivosC !== 'undefined' && resultadosPositivosC[chaveResultado],
              identidadeResultado,
              itmObj,
              urlRes,
            )
            var resR = cacheResultado
              ? { ok: true, resp: { json: cacheResultado.corpo_oficial } }
              : sendHttpWithRetryUtil(urlRes, 3.0, 1, 80)
            if (resR.deferred) break
            // Every unsuccessful result is unresolved, including exhausted retries/404.
            // The existing persistent r=4 ceiling keeps permanent failures bounded.
            if (!resR.ok) {
              cItemProcessando._retries = (cItemProcessando._retries || 0) + 1
              if (cItemProcessando._retries > 3) {
                errosAcumulados.push(
                  'PNCP resultados ' +
                    cacheKeyC +
                    ' item ' +
                    numItemInt +
                    ': limite de retentativas esgotado; cobertura não resolvida',
                )
              }
              break // Preserve the current result reference in the existing page checkpoint.
            }
            if (resR.ok && resR.resp) {
              var bRes = parseJsonWorkerSafe(resR.resp.json || resR.resp.raw)
              var capturadoResultado = cacheResultado
                ? cacheResultado.capturado_em
                : new Date().toISOString()
              var envelopeResultado =
                cacheResultado ||
                pncpResultEnvelope(identidadeResultado, itmObj, urlRes, bRes, capturadoResultado)
              if (envelopeResultado) {
                resultadoCapturadoEm = envelopeResultado.capturado_em
                resultadoReutilizado = !!cacheResultado
                if (!cacheResultado && typeof novosResultadosC !== 'undefined')
                  novosResultadosC[chaveResultado] = envelopeResultado
              }
              var aRes = bRes
                ? Array.isArray(bRes)
                  ? bRes
                  : bRes.items || bRes.data || bRes.resultado || []
                : []
              for (var rIdx = 0; rIdx < aRes.length; rIdx++) {
                var resIt = aRes[rIdx]
                if (!resIt || typeof resIt !== 'object' || Array.isArray(resIt)) continue
                var camposResultado = [
                  'valorUnitarioHomologado',
                  'valor_unitario_homologado',
                  'valorUnitario',
                  'valor_unitario',
                ]
                var campoResultado = ''
                for (var resCampoIdx = 0; resCampoIdx < camposResultado.length; resCampoIdx++) {
                  var valorResultado = Number(resIt[camposResultado[resCampoIdx]])
                  if (isFinite(valorResultado) && valorResultado > 0) {
                    campoResultado = camposResultado[resCampoIdx]
                    break
                  }
                }
                var vR = campoResultado ? Number(resIt[campoResultado]) : 0
                if (vR > 0) {
                  vUnitFinal = vR
                  nat = 'homologado'
                  campoUnitario = campoResultado
                  registroPreco = resIt
                  urlEvidencia = urlRes
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

          var qItem = Number(itmObj.quantidade) > 0 ? Number(itmObj.quantidade) : 0

          if (!isFinite(vUnitFinal) || vUnitFinal <= 0 || numItemInt <= 0) {
            aposentarItemC(itmObj)
            continue
          }

          var numControlePncp = cItemProcessando.numeroControlePNCP
          var urlOrig = 'https://pncp.gov.br/app/editais/' + cnpjC + '/' + anoC + '/' + seqC
          // Mesma identidade canônica do adapter ao vivo; compra isolada não identifica o item.
          var sequencialResultado = registroPreco.sequencialResultado || ''
          var fornecedorIdentidade = String(registroPreco.niFornecedor || forCnpj || '').replace(
            /\D/g,
            '',
          )
          var identidadeItem =
            /^\d{14}$/.test(String(cnpjC)) && Number(anoC) > 0 && Number(seqC) > 0 && numItemInt > 0
              ? cnpjC +
                '/' +
                Number(anoC) +
                '/' +
                Number(seqC) +
                '/itens/' +
                numItemInt +
                (sequencialResultado ? '/resultados/' + sequencialResultado : '') +
                (fornecedorIdentidade ? '/fornecedor/' + fornecedorIdentidade : '')
              : ''

          var amPncp = {
            source: 'PNCP',
            source_record_id: identidadeItem,
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
            valor_unitario: vUnitFinal,
            valor_total: Number(
              registroPreco.valorTotalHomologado || registroPreco.valorTotal || 0,
            ),
            natureza_preco: nat,
            data_referencia: registroPreco.dataResultado || '',
            numero_processo: numControlePncp,
            numero_ata: '',
            modalidade: 'Pregão Eletrônico',
            situacao_contratacao: nat === 'homologado' ? 'Homologada' : '',
            marca: itmObj.marcaNome || 'NÃO INFORMADO',
            modelo: 'NÃO INFORMADO',
            codigo_item: extrairCodigoItemWorker(itmObj),
            url_original: urlOrig,
            matching_score: calcularDiceScoreWorker(tokens, extractWorkerTokensUtil(dItem)),
            matching_tipo: 'texto_normalizado',
            raw_payload: {
              relacao_documental:
                cItemProcessando._pendente && cItemProcessando._pendente._pncp_compra,
              numeroControlePNCP: numControlePncp,
              numeroItem: numItemInt,
              tipo_documento: cItemProcessando._tipoDoc || 'ata',
              quantidade_informada: qItem > 0,
              proveniencia_preco: {
                versao: 1,
                status: urlEvidencia ? 'verificada' : 'nao_verificada',
                fonte: 'PNCP',
                campo_unitario: campoUnitario,
                valor_unitario: vUnitFinal,
                natureza: nat,
                url_evidencia: urlEvidencia,
                identidade: { cnpj: cnpjC, ano: anoC, sequencial: seqC, numeroItem: numItemInt },
                registro_oficial: registroPreco,
                data_oficial: registroPreco.dataResultado || '',
                campo_data: registroPreco.dataResultado ? 'dataResultado' : '',
              },
            },
          }
          if (resultadoCapturadoEm) {
            amPncp.raw_payload.proveniencia_preco.resultado_capturado_em = resultadoCapturadoEm
            amPncp.raw_payload.proveniencia_preco.resultado_reutilizado = resultadoReutilizado
          }
          amPncp.sample_key = gerarSampleKeyUtil(amPncp)
          // The old batch also saved each sample individually. Confirm that same save
          // before retiring this item, with one collection lookup per task.
          if (!colecaoAmostrasCiclo)
            colecaoAmostrasCiclo = $app.findCollectionByNameOrId('price_samples_index')
          var salvoItemC = persistirLoteAmostrasProgressivo([amPncp], colecaoAmostrasCiclo)
          amostrasInseridasTotal += salvoItemC.inseridas
          amostrasAtualizadasTotal += salvoItemC.atualizadas
          if (salvoItemC.falhou) {
            errosAcumulados.push(
              'PNCP amostra ' +
                cacheKeyC +
                '/' +
                numItemInt +
                ': falha ao persistir; item mantido pendente',
            )
            break
          }
          if (modoHttp && salvoItemC.inseridas + salvoItemC.atualizadas > 0) {
            totalAmostrasHttp++
            // Public index source DTO only; no task, claim, auth or arbitrary Record export.
            if (amostrasHttp.length < 50)
              amostrasHttp.push({
                sample_key: amPncp.sample_key,
                fonte: 'PNCP',
                source_record_id: amPncp.source_record_id,
                item_id: amPncp.item_id,
                descricao: amPncp.descricao,
                descricao_normalizada: amPncp.descricao_normalizada,
                orgao: amPncp.orgao,
                orgao_cnpj: amPncp.orgao_cnpj,
                fornecedor_nome: amPncp.fornecedor_nome,
                fornecedor_cnpj: amPncp.fornecedor_cnpj,
                fornecedor_porte: amPncp.fornecedor_porte,
                uf: amPncp.uf,
                municipio: amPncp.municipio,
                unidade: amPncp.unidade,
                quantidade: amPncp.quantidade,
                valor_unitario: amPncp.valor_unitario,
                valor_total: amPncp.valor_total,
                natureza_preco: amPncp.natureza_preco,
                data_referencia: amPncp.data_referencia,
                numero_processo: amPncp.numero_processo,
                modalidade: amPncp.modalidade,
                marca: amPncp.marca,
                codigo_item: amPncp.codigo_item,
                url_original: amPncp.url_original,
                matching_score: amPncp.matching_score,
                matching_tipo: amPncp.matching_tipo,
                raw_payload: amPncp.raw_payload,
              })
          }
          aposentarItemC(itmObj)
        }

        pncpPersistResults(cacheKeyC, novosResultadosC)
        itensTotal += aposentadosC
        if (aposentadosC < itensArrC.length) {
          if (trabalhoPaginaC) {
            trabalhoPaginaC = Object.assign({}, trabalhoPaginaC, {
              refs: refsTrabalhoC.slice(aposentadosC),
            })
            pendentesRestantes.push(pendenteAtualC(null, trabalhoPaginaC))
          } else pendentesRestantes.push(pendenteAtualC(cacheItemOffsetC + aposentadosC, null))
        } else {
          var proximoOffsetC = trabalhoPaginaC
            ? Number(trabalhoPaginaC.proximo_i) || 0
            : cacheSliceBaseC !== null && cacheSliceBaseC + aposentadosC < cacheTodosC.length
              ? cacheSliceBaseC + aposentadosC
              : 0
          if (proximoOffsetC > 0) pendentesRestantes.push(pendenteAtualC(proximoOffsetC, null))
          else if (cachePrefixExaminedC < cacheTodosC.length)
            pendentesRestantes.push(pendenteAtualC(cachePrefixExaminedC, null))
          else if (!cacheCompletoC) pendentesRestantes.push(pendenteAtualC(null, null))
        }
      }
    }

    // Salva progresso da tarefa
    var agoraFinal = new Date().toISOString()
    try {
      $app.runInTransaction(function (txApp) {
        var taskRecFinal = txApp.findRecordById('price_index_tasks', tarefaAdquirida.id)
        if (!possuiClaimWorker(taskRecFinal)) return
        var pendentesAtuais = parseJsonWorkerSafe(taskRecFinal.getString('pendentes'))
        if (!Array.isArray(pendentesAtuais)) pendentesAtuais = []
        var recibosFinal = pncpReceiptRecords(taskRecFinal.getString('erros'))
        pendentesAtuais = pendentesAtuais.filter(function (p) {
          return !pncpSuperseded(p, recibosFinal)
        })
        pendentesRestantes = pendentesRestantes.filter(function (p) {
          return !pncpSuperseded(p, recibosFinal)
        })
        var posicoesPendentes = {}
        pendentesRestantes = pendentesRestantes.filter(function (p) {
          return !p._pncp_discovery
        })
        for (var posI = 0; posI < pendentesRestantes.length; posI++) {
          posicoesPendentes[chavePendenteWorker(pendentesRestantes[posI])] = posI
        }
        for (var atualI = 0; atualI < pendentesAtuais.length; atualI++) {
          var atualP = pendentesAtuais[atualI]
          if (atualP._pncp_discovery) {
            if (JSON.stringify(atualP._pncp_discovery) !== marcadorAdquirido) {
              var esgotadosAtuais = atualP._pncp_discovery.esgotados || {}
              for (var docAtual in esgotadosAtuais) {
                if (esgotadosAtuais[docAtual]) descobertaPncp.esgotados[docAtual] = true
              }
            }
            continue
          }
          var chaveAtual = chavePendenteWorker(atualP)
          if (pendentesAdquiridosPorChave[chaveAtual] === JSON.stringify(atualP)) continue
          var posAtual = posicoesPendentes[chaveAtual]
          if (posAtual === undefined) {
            posicoesPendentes[chaveAtual] = pendentesRestantes.length
            pendentesRestantes.push(atualP)
          } else {
            var localP = pendentesRestantes[posAtual]
            pendentesRestantes[posAtual] = Object.assign({}, atualP, localP, {
              i: Math.max(Number(atualP.i) || 0, Number(localP.i) || 0),
              r: Math.max(Number(atualP.r) || 0, Number(localP.r) || 0),
            })
          }
        }
        var possuiCompraAcionavel = pendentesRestantes.some(function (p) {
          return pncpActionable(p)
        })
        // Preserva descoberta encerrada entre páginas de compras ainda acionáveis.
        if (
          (source === 'AMBAS' || source.indexOf('PNCP') !== -1) &&
          (possuiCompraAcionavel ||
            !(
              descobertaPncp.esgotados.ata &&
              descobertaPncp.esgotados.edital &&
              descobertaPncp.esgotados.contrato
            ))
        ) {
          pendentesRestantes.push({ _pncp_discovery: descobertaPncp })
        }
        var possuiTrabalhoAcionavel = pendentesRestantes.some(function (p) {
          if (p._pncp_discovery) {
            var esgotados = p._pncp_discovery.esgotados || {}
            return !(esgotados.ata && esgotados.edital && esgotados.contrato)
          }
          return pncpActionable(p)
        })
        var statusFinal = possuiTrabalhoAcionavel
          ? 'pending'
          : pendentesRestantes.length > 0
            ? 'failed'
            : 'completed'
        taskRecFinal.set('status', statusFinal)
        taskRecFinal.set('pendentes', JSON.stringify(pendentesRestantes))
        taskRecFinal.set(
          'paginas_consultadas',
          Math.max(paginasTotal, Number(taskRecFinal.getInt('paginas_consultadas')) || 0),
        )
        taskRecFinal.set(
          'itens_processados',
          (Number(taskRecFinal.getInt('itens_processados')) || 0) +
            itensTotal -
            tarefaAdquirida.itens_processados,
        )
        taskRecFinal.set(
          'amostras_inseridas',
          (Number(taskRecFinal.getInt('amostras_inseridas')) || 0) +
            amostrasInseridasTotal -
            tarefaAdquirida.amostras_inseridas,
        )
        taskRecFinal.set(
          'amostras_atualizadas',
          (Number(taskRecFinal.getInt('amostras_atualizadas')) || 0) +
            amostrasAtualizadasTotal -
            tarefaAdquirida.amostras_atualizadas,
        )
        var historyFinal = pncpErrors(taskRecFinal.getString('erros'))
        for (var errI = 0; errI < errosAcumulados.length; errI++)
          if (historyFinal.indexOf(errosAcumulados[errI]) < 0)
            historyFinal.push(errosAcumulados[errI])
        taskRecFinal.set('erros', JSON.stringify(historyFinal))
        taskRecFinal.set('ultimo_erro', errosAcumulados.join('; ').slice(0, 500))
        if (
          descobertaAvancouWorker ||
          itensTotal > tarefaAdquirida.itens_processados ||
          amostrasInseridasTotal > tarefaAdquirida.amostras_inseridas ||
          amostrasAtualizadasTotal > tarefaAdquirida.amostras_atualizadas
        )
          taskRecFinal.set('progress_at', agoraFinal)
        taskRecFinal.set('finished_at', agoraFinal)
        txApp.save(taskRecFinal)
      })
    } catch (errFinalTask) {
      // Do not print the raw exception: DB messages may contain serialized source data.
      var tipoErroFinal = errFinalTask && String(errFinalTask.name || '')
      if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(tipoErroFinal)) tipoErroFinal = 'Error'
      console.log(
        '[PRICE-WORKER] PRICE_WORKER_TASK_FINALIZE_FAILED task=' +
          String(tarefaAdquirida.id).slice(0, 80) +
          ' error=' +
          tipoErroFinal +
          ' detalhe=transacao_final_nao_confirmada',
      )
    }
  }

  // An HTTP request ends here, without watermark or sync-log collection work.
  if (modoHttp) {
    try {
      var persistidaHttp = $app.findRecordById('price_index_tasks', tarefaIdHttp)
      var statusHttp = persistidaHttp.getString('status')
      return e.json(200, {
        sucesso: true,
        took_ms: new Date().getTime() - tInicioCiclo,
        processadas: tarefasProcessadasNesteTick,
        resultado: {
          tarefa_id: persistidaHttp.id,
          termo: persistidaHttp.getString('termo'),
          status: statusHttp,
          fonte_processada: 'PNCP',
          cobertura_fontes: 'nao_certificada',
          cobertura_parcial: statusHttp !== 'completed',
          amostras: amostrasHttp,
          amostras_total_turno: totalAmostrasHttp,
          amostras_retornadas: amostrasHttp.length,
          amostras_resposta_parcial: totalAmostrasHttp > amostrasHttp.length,
          paginas_consultadas: Number(persistidaHttp.getInt('paginas_consultadas')) || 0,
          itens_processados: Number(persistidaHttp.getInt('itens_processados')) || 0,
          amostras_inseridas: Number(persistidaHttp.getInt('amostras_inseridas')) || 0,
          amostras_atualizadas: Number(persistidaHttp.getInt('amostras_atualizadas')) || 0,
          aviso:
            statusHttp === 'pending'
              ? 'Turno PNCP parcial; trabalho restante preservado na fila.'
              : statusHttp === 'running'
                ? 'Tarefa em execução; claim ativo preservado.'
                : 'Estado persistido do trabalho PNCP; não certifica cobertura de Compras.gov.br.',
        },
      })
    } catch (_) {
      return e.json(500, { sucesso: false, error: 'TASK_STATUS_READ_FAILED' })
    }
  }

  // =========================================================================
  // PARTE 2: Ciclo de Coleta Incremental por Watermark (PNCP e Compras.gov.br)
  // Permite sincronização contínua que sobrevive a reinicializações.
  // =========================================================================
  if (!trabalhoAdiadoPorTempo && new Date().getTime() < fimTrabalhoRede) {
    try {
      var wms = $app.findRecordsByFilter('price_watermarks', '', '+updated', 2, 0)
      for (var wIdx = 0; wIdx < wms.length; wIdx++) {
        if (trabalhoAdiadoPorTempo || new Date().getTime() >= fimTrabalhoRede) break
        var wmRec = wms[wIdx]
        var fName = wmRec.getString('fonte')
        var lastDateStr = wmRec.getString('last_watermark_date') || '2026-01-01'
        var lastPage = Number(wmRec.getInt('last_cursor_page')) || 1
        var falhasConsecutivas = Number(wmRec.getInt('tentativas_consecutivas_falha')) || 0

        // Se houver falhas consecutivas, aplica backoff pulando ciclos
        if (falhasConsecutivas > 3 && Math.random() > 0.3) {
          continue
        }

        var novasAmostrasWm = []
        var syncOk = false
        var syncErro = ''

        if (fName === 'PNCP') {
          // Varredura proativa contínua do PNCP por paginação de atas públicas
          // O endpoint /api/search do PNCP aceita q, tipos_documento, pagina e tam_pagina
          var urlPncpWm =
            'https://pncp.gov.br/api/search/?q=*&tipos_documento=ata&pagina=' +
            lastPage +
            '&tam_pagina=20'
          var resPncpWm = sendHttpWithRetryUtil(urlPncpWm, 4.0, 1, 100)
          if (resPncpWm.deferred) break
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
          // Coleta incremental Compras.gov.br guiada pelas tarefas ativas em price_index_tasks
          // JAMAIS por código fixo hardcoded.
          var tarefaAtivaCgov = null
          try {
            var tarefasAtivas = $app.findRecordsByFilter(
              'price_index_tasks',
              "status = 'pending' || status = 'running'",
              '+created',
              1,
              0,
            )
            if (tarefasAtivas && tarefasAtivas.length > 0) {
              tarefaAtivaCgov = tarefasAtivas[0]
            }
          } catch (_) {}

          if (tarefaAtivaCgov) {
            var termoAtivoCgov = (tarefaAtivaCgov.getString('termo') || '').trim()
            var termoNormCgov = canonicalNormWorkerText(termoAtivoCgov)

            // Resolução DINÂMICA de códigos CATMAT/CATSER sem nenhuma lista hardcoded.
            var codigosCatmatAtivos = []
            if (/^\d{4,8}$/.test(termoAtivoCgov)) {
              codigosCatmatAtivos = [termoAtivoCgov]
            } else if (termoNormCgov.length >= 3) {
              try {
                // Consulta dinâmica ao catálogo do Compras.gov.br para materiais
                var urlCatMat =
                  'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
                  encodeURIComponent(termoAtivoCgov) +
                  '&pagina=1&tamanhoPagina=500'
                var resCatMat = sendHttpWithRetryUtil(urlCatMat, 3.5, 1)
                if (resCatMat.ok && resCatMat.resp) {
                  var bCatMat = parseJsonWorkerSafe(resCatMat.resp.json || resCatMat.resp.raw)
                  var itensCatMat = bCatMat
                    ? Array.isArray(bCatMat)
                      ? bCatMat
                      : bCatMat.resultado || bCatMat.items || []
                    : []
                  var seenCodes = {}
                  for (var cmI = 0; cmI < itensCatMat.length; cmI++) {
                    var codM = String(
                      itensCatMat[cmI].codigoItemCatalogo ||
                        itensCatMat[cmI].codigoItem ||
                        itensCatMat[cmI].codigoMaterial ||
                        '',
                    ).trim()
                    if (codM && /^\d+$/.test(codM) && !seenCodes[codM]) {
                      seenCodes[codM] = true
                      codigosCatmatAtivos.push(codM)
                    }
                  }
                }
              } catch (_) {}

              // Se não encontrou materiais ou for potencialmente serviço, consulta serviços (CATSER)
              if (codigosCatmatAtivos.length === 0) {
                try {
                  var urlCatSer =
                    'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?descricaoItem=' +
                    encodeURIComponent(termoAtivoCgov) +
                    '&pagina=1&tamanhoPagina=500'
                  var resCatSer = sendHttpWithRetryUtil(urlCatSer, 3.5, 1)
                  if (resCatSer.ok && resCatSer.resp) {
                    var bCatSer = parseJsonWorkerSafe(resCatSer.resp.json || resCatSer.resp.raw)
                    var itensCatSer = bCatSer
                      ? Array.isArray(bCatSer)
                        ? bCatSer
                        : bCatSer.resultado || bCatSer.items || []
                      : []
                    var seenCodesSer = {}
                    for (var csI = 0; csI < itensCatSer.length; csI++) {
                      var codS = String(
                        itensCatSer[csI].codigoItemCatalogo ||
                          itensCatSer[csI].codigoItem ||
                          itensCatSer[csI].codigoServico ||
                          '',
                      ).trim()
                      if (codS && /^\d+$/.test(codS) && !seenCodesSer[codS]) {
                        seenCodesSer[codS] = true
                        codigosCatmatAtivos.push(codS)
                      }
                    }
                  }
                } catch (_) {}
              }
            }

            var urlCgovWm = ''
            var catmatUsado = ''
            if (codigosCatmatAtivos.length > 0) {
              var catIdx = (lastPage - 1) % codigosCatmatAtivos.length
              catmatUsado = codigosCatmatAtivos[catIdx]
              var paginaCat = Math.floor((lastPage - 1) / codigosCatmatAtivos.length) + 1
              urlCgovWm =
                'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
                catmatUsado +
                '&pagina=' +
                paginaCat +
                '&tamanhoPagina=20'
            } else if (termoNormCgov.length >= 3) {
              urlCgovWm =
                'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
                encodeURIComponent(termoAtivoCgov) +
                '&pagina=' +
                lastPage +
                '&tamanhoPagina=20'
            }

            if (urlCgovWm) {
              var resCgovWm = sendHttpWithRetryUtil(urlCgovWm, 3.5, 1)
              if (resCgovWm.deferred) break
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
                  var tokensTermoAtivo = extractWorkerTokensUtil(termoNormCgov)
                  for (var cgI = 0; cgI < itemsCgov.length; cgI++) {
                    var itCg = itemsCgov[cgI]
                    var vUnitCg =
                      Number(
                        itCg.precoUnitarioHomologado || itCg.valorUnitario || itCg.precoUnitario,
                      ) || 0
                    if (vUnitCg > 0) {
                      var descCg = itCg.descricaoItem || itCg.descricao || 'Item Compras.gov.br'
                      var descNormCg = canonicalNormWorkerText(descCg)
                      var tokensDescCg = extractWorkerTokensUtil(descNormCg)

                      // Validação anti-contaminação no watermark: deve haver coerência textual
                      // ou pertinência ao CATMAT do termo ativo
                      var temAderencia = false
                      if (catmatUsado) {
                        temAderencia = true
                      } else {
                        var diceW = calcularDiceScoreWorker(tokensTermoAtivo, tokensDescCg)
                        temAderencia = diceW > 15
                      }

                      if (!temAderencia) continue

                      var amCgovObj = {
                        source: 'Compras.gov.br',
                        source_record_id: String(itCg.id || itCg.codigoItem || 'CG-' + cgI),
                        purchase_id: String(itCg.id || itCg.codigoItem || 'CG-' + cgI),
                        item_id: String(itCg.numeroItem || '1'),
                        descricao: descCg,
                        descricao_normalizada: descNormCg,
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
                        quantidade: Number(itCg.quantidade) > 0 ? Number(itCg.quantidade) : 0,
                        valor_unitario: Number(vUnitCg.toFixed(4)),
                        valor_total:
                          Number(itCg.quantidade) > 0
                            ? Number((vUnitCg * Number(itCg.quantidade)).toFixed(4))
                            : Number(itCg.valorTotal) > 0
                              ? Number(Number(itCg.valorTotal).toFixed(4))
                              : 0,
                        natureza_preco: 'homologado',
                        data_referencia: itCg.dataCompra || new Date().toISOString(),
                        numero_processo: itCg.numeroProcesso || '',
                        modalidade: 'Pregão Eletrônico',
                        marca: itCg.marca || 'NÃO INFORMADO',
                        codigo_item: catmatUsado
                          ? 'CATMAT ' + catmatUsado
                          : extrairCodigoItemWorker(itCg),
                        url_original: itCg.linkEditalOuCompra || '',
                        matching_score: 100,
                        matching_tipo: catmatUsado ? 'codigo_oficial_catmat' : 'texto_normalizado',
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
            } else {
              // Sem termo/código para a tarefa atual, marca como ok para não gerar falha espúria
              syncOk = true
            }
          } else {
            // Nenhuma tarefa ativa no momento: watermark fica em idle sem consultar código fixo
            syncOk = true
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
  // Diagnóstico local do callback; não é uma avaliação da saúde dos endpoints/fontes.
  try {
    var colSync = $app.findCollectionByNameOrId('sync_logs')
    var recSync = new Record(colSync)
    recSync.set('fonte_id', 'r06he9bmdrb3yus')
    recSync.set('status', 'sucesso')
    recSync.set(
      'detalhes',
      JSON.stringify({
        evento: 'PRICE_WORKER_TICK_LOCAL',
        callback_finalizado: true,
        turnos_tarefa_executados: tarefasProcessadasNesteTick,
        duracao_ms: new Date().getTime() - tInicioCiclo,
        health_endpoints: 'nao_avaliado',
      }),
    )
    $app.save(recSync)
  } catch (errDiagLocal) {
    console.log('[PRICE-WORKER-CRON] Falha ao registrar diagnóstico local:', errDiagLocal.message)
  }
})
routerAdd(
  'POST',
  '/backend/v1/tasks/process',
  function executarTurnoPriceIndex(e) {
    var modoHttp = !!e
    var tarefaIdHttp = ''
    if (modoHttp) {
      if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
      var bodyHttp
      try {
        bodyHttp = e.requestInfo().body || {}
      } catch (_) {
        return e.json(400, { sucesso: false, error: 'INVALID_BODY' })
      }
      tarefaIdHttp = typeof bodyHttp.tarefa_id === 'string' ? bodyHttp.tarefa_id.trim() : ''
      if (!tarefaIdHttp) return e.json(400, { sucesso: false, error: 'TASK_ID_REQUIRED' })
      try {
        $app.findRecordById('price_index_tasks', tarefaIdHttp)
      } catch (_) {
        return e.json(404, { sucesso: false, error: 'TASK_NOT_FOUND' })
      }
    }
    var tInicioCiclo = new Date().getTime()
    console.log('[PRICE-WORKER-CRON] Tick do cron disparado. Processando fila e watermarks...')
    var MAX_DURATION_MS = modoHttp ? 20000 : 48000
    var fimTrabalhoRede = tInicioCiclo + MAX_DURATION_MS - (modoHttp ? 5000 : 8000)
    var trabalhoAdiadoPorTempo = false
    var amostrasHttp = []
    var totalAmostrasHttp = 0

    // Shared envelope contract (duplicated inside each isolated PocketBase JSVM callback).
    // Source items stay untouched; only positive official /resultados evidence is reusable.
    function pncpControl(value, namespace) {
      var m =
        typeof value === 'string' && /^(\d{14})-([123])-(\d{6})\/(20\d{2}|21\d{2})$/.exec(value)
      if (!m || Number(m[3]) < 1 || (namespace && m[2] !== String(namespace))) return null
      return { c: m[1], a: Number(m[4]), s: Number(m[3]), n: m[2], controle: value }
    }
    function pncpControlOf(c, a, s, n) {
      if (!Number.isInteger(Number(s)) || Number(s) < 1 || Number(s) > 999999) return ''
      return String(c) + '-' + n + '-' + ('000000' + s).slice(-6) + '/' + a
    }
    function pncpResolveDocument(it, kind, evidenceUrl) {
      var type = it.tipo_documento || it.document_type || kind || 'edital'
      var ownText = it.numeroControlePNCP || it.numero_controle_pncp || ''
      var own = pncpControl(ownText)
      var linkedText = it.numeroControlePncpCompra || it.numeroControlePNCPCompra || ''
      var linked = pncpControl(linkedText, 1)
      var c = String(
        (it.orgaoEntidade && it.orgaoEntidade.cnpj) ||
          (it.orgaoSubRogado && it.orgaoSubRogado.cnpj) ||
          it.orgao_cnpj ||
          it.cnpj ||
          '',
      ).replace(/\D/g, '')
      var contract = type === 'contrato' || (own && own.n === '2')
      var origin = contract && own && own.n === '2' ? own : null
      var reason = ''
      if (ownText && !own) reason = 'controle_documento_invalido'
      if (
        it.numeroControlePNCP &&
        it.numero_controle_pncp &&
        it.numeroControlePNCP !== it.numero_controle_pncp
      )
        reason = 'controles_documento_conflitantes'
      if (linkedText && !linked) reason = 'controle_compra_invalido'
      if (
        it.numeroControlePncpCompra &&
        it.numeroControlePNCPCompra &&
        it.numeroControlePncpCompra !== it.numeroControlePNCPCompra
      )
        reason = 'controles_compra_conflitantes'
      if (own && c && own.c !== c) reason = 'orgao_documento_conflitante'
      if (contract && own && own.n !== '2') reason = 'namespace_documento_conflitante'
      if (contract && !origin && !ownText) {
        var ay = Number(it.anoContrato || it.ano),
          sq = Number(it.numeroSequencialContrato || it.numero_sequencial)
        origin = pncpControl(pncpControlOf(c, ay, sq, 2), 2)
      }
      if (
        contract &&
        origin &&
        ((it.anoContrato && Number(it.anoContrato) !== origin.a) ||
          (it.numeroSequencialContrato && Number(it.numeroSequencialContrato) !== origin.s))
      )
        reason = 'identidade_contrato_conflitante'
      var buy = linked || (!contract && own && own.n === '1' ? own : null)
      var explicitYear = 0
      if (it.anoCompra !== undefined) {
        var yearValue = it.anoCompra
        if (
          (typeof yearValue !== 'number' && typeof yearValue !== 'string') ||
          !/^\d{4}$/.test(String(yearValue)) ||
          Number(yearValue) < 2000 ||
          Number(yearValue) > 2199
        )
          reason = 'campos_compra_invalidos'
        else explicitYear = Number(yearValue)
      }
      var explicitSeq = 0
      var sequenceFields = [
        'numero_sequencial_compra_ata',
        'numeroSequencialCompraAta',
        'sequencialCompra',
        'numeroSequencialCompra',
        'numeroSequencialEdital',
      ]
      for (var seqFieldIndex = 0; seqFieldIndex < sequenceFields.length; seqFieldIndex++) {
        var sequenceValue = it[sequenceFields[seqFieldIndex]]
        if (sequenceValue === undefined) continue
        if (
          (typeof sequenceValue !== 'number' && typeof sequenceValue !== 'string') ||
          !/^\d{1,6}$/.test(String(sequenceValue)) ||
          Number(sequenceValue) < 1
        ) {
          reason = 'campos_compra_invalidos'
          continue
        }
        if (explicitSeq && explicitSeq !== Number(sequenceValue))
          reason = 'campos_compra_conflitantes'
        else explicitSeq = Number(sequenceValue)
      }
      if (
        buy &&
        ((explicitYear && explicitYear !== buy.a) ||
          (explicitSeq && explicitSeq !== buy.s) ||
          (c && c !== buy.c))
      )
        reason = 'campos_compra_conflitantes'
      if (!contract && own && own.n === '1' && linked && own.controle !== linked.controle)
        reason = 'controles_compra_conflitantes'
      if (!contract && !buy && !reason && (it.item_url || it.itemUrl)) {
        var route =
          /^(?:https:\/\/pncp\.gov\.br)?\/(?:app\/)?(?:atas|editais|compras)\/(\d{14})\/(20\d{2}|21\d{2})\/([1-9]\d{0,5})(?:\/[1-9]\d*)?\/?$/.exec(
            it.item_url || it.itemUrl,
          )
        if (route) {
          if (
            (c && c !== route[1]) ||
            (explicitYear && explicitYear !== Number(route[2])) ||
            (explicitSeq && explicitSeq !== Number(route[3]))
          )
            reason = 'url_compra_conflitante'
          else buy = pncpControl(pncpControlOf(route[1], Number(route[2]), Number(route[3]), 1), 1)
        }
      }
      if (!buy && !contract && !linkedText && !reason) {
        var y = explicitYear || Number(it.ano || it.anoAta || it.anoEdital)
        var s = explicitSeq || Number(it.numeroSequencialEdital || it.numero_sequencial)
        buy = pncpControl(pncpControlOf(c, y, s, 1), 1)
      }
      if (contract && !origin) reason = reason || 'origem_contrato_ambigua'
      if (!buy) reason = reason || (contract ? 'relacao_ausente' : 'compra_invalida')
      if (reason) return { reason: reason, origem: origin, tipo: type }
      var proof = {
        v: 1,
        controle: buy.controle,
        origem: { tipo: type, controle: (origin || own || buy).controle },
        prova: {
          contratoControle: origin ? origin.controle : '',
          compraControle: buy.controle,
          urlOficial: evidenceUrl,
          capturadoEm: new Date().toISOString(),
        },
      }
      return { cnpj: buy.c, ano: buy.a, sequencial: buy.s, _pncp_compra: proof }
    }
    function pncpRelationPending(resolved, entry) {
      var o = resolved.origem
      return {
        c: o ? o.c : '',
        a: o ? o.a : 0,
        s: o ? o.s : 0,
        t: 'contrato',
        r: 0,
        b: 0,
        i: 0,
        numeroControlePNCP: o ? o.controle : '',
        _pncp_relacao: { v: 1, falhas: 0, lastStatus: resolved.reason },
        o: String(
          (entry.orgaoEntidade && entry.orgaoEntidade.razaoSocial) || entry.orgao_nome || '',
        ).slice(0, 80),
      }
    }
    function pncpVerifiedPurchase(p) {
      var direct = p && !p._pncp_compra && pncpControl(p.numeroControlePNCP, 1)
      if (
        direct &&
        direct.c === String(p.c || p.cnpj) &&
        direct.a === Number(p.a || p.ano) &&
        direct.s === Number(p.s || p.sequencial)
      )
        return true
      var v = p && p._pncp_compra,
        buy = v && pncpControl(v.controle, 1)
      if (!buy || v.v !== 1 || !v.prova || v.prova.compraControle !== buy.controle || !v.origem)
        return false
      var origin = pncpControl(v.origem.controle)
      return (
        !!origin &&
        buy.c === String(p.c || p.cnpj) &&
        buy.a === Number(p.a || p.ano) &&
        buy.s === Number(p.s || p.sequencial) &&
        (v.origem.tipo !== 'contrato' ||
          (origin.n === '2' && v.prova.contratoControle === origin.controle))
      )
    }
    function pncpReceiptRecords(raw) {
      var list
      try {
        list = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch (_) {
        return []
      }
      if (!Array.isArray(list)) return []
      return list
        .map(function (x) {
          if (typeof x !== 'string' || x.indexOf('PNCP_NAMESPACE_REBOUND_V1 ') !== 0) return null
          try {
            var r = JSON.parse(x.slice('PNCP_NAMESPACE_REBOUND_V1 '.length))
            return pncpControl(r.documentControl, 2) && pncpControl(r.purchaseControl, 1) ? r : null
          } catch (_) {
            return null
          }
        })
        .filter(function (x) {
          return !!x
        })
    }
    function pncpSuperseded(p, receipts) {
      if (
        !p ||
        p.t !== 'contrato' ||
        pncpVerifiedPurchase(p) ||
        p.j !== undefined ||
        Number(p.i || 0) ||
        Number(p.b || 0)
      )
        return false
      var control = pncpControlOf(p.c || p.cnpj, p.a || p.ano, p.s || p.sequencial, 2)
      return receipts.some(function (r) {
        return r.documentControl === control
      })
    }
    function pncpAdmittedBefore(p, receipts) {
      if (p.t === 'contrato' && !pncpVerifiedPurchase(p)) return false
      var control = pncpControlOf(p.c || p.cnpj, p.a || p.ano, p.s || p.sequencial, 1)
      return receipts.some(function (r) {
        return r.purchaseControl === control
      })
    }

    function pncpPendingKey(p) {
      return (
        (p.t === 'contrato' && !pncpVerifiedPurchase(p) ? 'contrato:' : 'compra:') +
        (p.c || p.cnpj || '') +
        '_' +
        (p.a || p.ano || '') +
        '_' +
        (p.s || p.sequencial || '')
      )
    }
    function pncpActionable(p) {
      if (p.t === 'contrato' && !pncpVerifiedPurchase(p))
        return (
          !!p._pncp_relacao &&
          p._pncp_relacao.lastStatus === 'relacao_ausente' &&
          Number(p._pncp_relacao.falhas || 0) < 4
        )
      return (p.c || p.cnpj) && (p.a || p.ano) && (p.s || p.sequencial) && (Number(p.r) || 0) < 4
    }

    function pncpCanonical(value) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return '[' + value.map(pncpCanonical).join(',') + ']'
      return (
        '{' +
        Object.keys(value)
          .sort()
          .map(function (key) {
            return JSON.stringify(key) + ':' + pncpCanonical(value[key])
          })
          .join(',') +
        '}'
      )
    }
    function pncpResultKey(identity) {
      return (
        identity.cnpj +
        '/' +
        Number(identity.ano) +
        '/' +
        Number(identity.sequencial) +
        '/itens/' +
        Number(identity.numeroItem)
      )
    }
    function pncpPositive(body) {
      var entries = Array.isArray(body) ? body : body && (body.items || body.data || body.resultado)
      if (!Array.isArray(entries)) return null
      var fields = [
        'valorUnitarioHomologado',
        'valor_unitario_homologado',
        'valorUnitario',
        'valor_unitario',
      ]
      for (var i = 0; i < entries.length; i++) {
        var row = entries[i]
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue
        for (var f = 0; f < fields.length; f++) {
          var price = Number(row[fields[f]])
          if (isFinite(price) && price > 0) return { registro: row, campo: fields[f], valor: price }
        }
      }
      return null
    }
    function pncpValidResult(envelope, identity, item, url) {
      if (
        !envelope ||
        envelope.versao !== 1 ||
        !envelope.identidade ||
        pncpCanonical(envelope.identidade) !== pncpCanonical(identity) ||
        envelope.url_resultados !== url ||
        envelope.item_fingerprint !== pncpCanonical(item) ||
        typeof envelope.capturado_em !== 'string'
      )
        return null
      var captured = Date.parse(envelope.capturado_em)
      var age = Date.now() - captured
      if (
        !isFinite(captured) ||
        new Date(captured).toISOString() !== envelope.capturado_em ||
        age < 0 ||
        age >= 15 * 60 * 1000
      )
        return null
      var positive = pncpPositive(envelope.corpo_oficial)
      if (
        !positive ||
        positive.campo !== envelope.campo_unitario ||
        positive.valor !== envelope.valor_unitario
      )
        return null
      var resultItem = positive.registro.numeroItem || positive.registro.numero_item
      if (resultItem != null && Number(resultItem) !== identity.numeroItem) return null
      return envelope
    }
    function pncpResultEnvelope(identity, item, url, body, captured) {
      var positive = pncpPositive(body)
      if (!positive) return null
      var envelope = {
        versao: 1,
        identidade: identity,
        item_fingerprint: pncpCanonical(item),
        url_resultados: url,
        capturado_em: captured,
        corpo_oficial: body,
        campo_unitario: positive.campo,
        valor_unitario: positive.valor,
      }
      return pncpValidResult(envelope, identity, item, url)
    }
    function pncpPersistResults(cacheKey, additions) {
      if (!additions || Object.keys(additions).length === 0) return
      try {
        $app.runInTransaction(function (txApp) {
          var current = txApp.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
          var raw = JSON.parse(current.getString('raw_itens'))
          var items = Array.isArray(raw) ? raw : raw && raw.items
          if (!Array.isArray(items)) return
          var merged = Array.isArray(raw) ? { items: raw } : raw
          var existing = merged.resultados_positivos
          if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {}
          var changed = false
          Object.keys(additions).forEach(function (key) {
            var candidate = additions[key]
            for (var i = 0; i < items.length; i++) {
              var item = items[i]
              if (
                !item ||
                Number(item.numeroItem || item.numero_item) !== candidate.identidade.numeroItem
              )
                continue
              if (!pncpValidResult(candidate, candidate.identidade, item, candidate.url_resultados))
                return
              var prior = pncpValidResult(
                existing[key],
                candidate.identidade,
                item,
                candidate.url_resultados,
              )
              if (prior && Date.parse(prior.capturado_em) >= Date.parse(candidate.capturado_em))
                return
              existing[key] = candidate
              changed = true
              return
            }
          })
          if (!changed) return
          merged.resultados_positivos = existing
          current.set('raw_itens', JSON.stringify(merged))
          txApp.save(current)
        })
      } catch (_) {} // Cache failure never removes the normal official-source fallback.
    }

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

    function calcularDiceScoreWorker(tokensTermo, tokensDesc) {
      if (!tokensTermo || tokensTermo.length === 0 || !tokensDesc || tokensDesc.length === 0) {
        return 0
      }
      var setTermo = {}
      for (var i = 0; i < tokensTermo.length; i++) {
        var tk = tokensTermo[i]
        setTermo[tk] = true
        var st = stemWorkerTokenUtil(tk)
        if (st) setTermo[st] = true
      }
      var setDesc = {}
      var intersecao = 0
      for (var j = 0; j < tokensDesc.length; j++) {
        var dtk = tokensDesc[j]
        var dst = stemWorkerTokenUtil(dtk)
        if (!setDesc[dtk]) {
          setDesc[dtk] = true
          if (setTermo[dtk] || (dst && setTermo[dst])) {
            intersecao++
          }
        }
      }
      var total = tokensTermo.length + Object.keys(setDesc).length
      if (total === 0) return 0
      var dice = (2 * intersecao) / total
      return Math.min(100, Math.max(10, Math.round(dice * 100)))
    }

    function extrairCodigoItemWorker(itmObj) {
      if (!itmObj) return ''
      var raw = String(itmObj.codigoItem || itmObj.codigoMaterialOuServico || '').trim()
      if (!raw) return ''
      var matchCatmat = raw.match(/\b\d{4,8}\b/)
      if (matchCatmat) {
        return 'CATMAT ' + matchCatmat[0]
      }
      if (/^\d+$/.test(raw)) {
        return raw
      }
      return ''
    }

    function extrairUnidadeQualificadaWorkerUtil(uBruta, dBruta) {
      // Embalagem descrita não substitui a unidade oficial nem preenche sua ausência.
      return typeof uBruta === 'string' && uBruta.trim() ? uBruta : 'NÃO INFORMADO'
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
      var pausaAntesTentativa = delayBetweenMs || 0
      var tentativa = 0
      var ultimaFalha = null
      var userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 COTAI/Worker-0.0.108'

      while (tentativa <= retries) {
        // Admit only the next existing attempt and its required pacing/backoff.
        if (
          new Date().getTime() + pausaAntesTentativa + (timeoutSec || 4.0) * 1000 >
          fimTrabalhoRede
        ) {
          trabalhoAdiadoPorTempo = true
          if (ultimaFalha) ultimaFalha.partial_failure = true
          return ultimaFalha || { deferred: true, ok: false }
        }
        if (pausaAntesTentativa > 0) sleepMsSync(pausaAntesTentativa)
        if (new Date().getTime() + (timeoutSec || 4.0) * 1000 > fimTrabalhoRede) {
          trabalhoAdiadoPorTempo = true
          if (ultimaFalha) ultimaFalha.partial_failure = true
          return ultimaFalha || { deferred: true, ok: false }
        }
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
          ultimaFalha = { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
          if (res && (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode <= 504))) {
            if (tentativa <= retries) {
              // Recuo exponencial com jitter: 300ms, 600ms, 1200ms...
              var waitMs = Math.pow(2, tentativa) * 150 + Math.floor(Math.random() * 50)
              pausaAntesTentativa = waitMs
              continue
            }
          }
          return ultimaFalha
        } catch (err) {
          ultimaFalha = { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
          if (tentativa <= retries) {
            // Recuo em caso de socket reset / timeout
            var waitMs2 = Math.pow(2, tentativa) * 200 + Math.floor(Math.random() * 50)
            pausaAntesTentativa = waitMs2
            continue
          }
          return ultimaFalha
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

    // Sinalização de incompatibilidade de natureza no worker
    // AVISO: Não efetua descarte automático de HORA/H/MÊS/DIÁRIA/POSTO nem de itens relacionados;
    // serve apenas para sinalização e juízo crítico humano na interface.
    function ehAmostraIncompativelWorker(desc, unidade) {
      // Preserva todas as unidades e termos sem descarte automático
      return null
    }

    // Persistência progressiva com campos de auditoria, qualidade, hash e situação
    function persistirLoteAmostrasProgressivo(amostras, colecaoAmostras) {
      if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
      var inseridas = 0
      var atualizadas = 0
      var falhou = false
      var agora = new Date().toISOString()
      var col = colecaoAmostras || $app.findCollectionByNameOrId('price_samples_index')

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

        var motivoIncompativel = ehAmostraIncompativelWorker(a.descricao, a.unidade)
        if (motivoIncompativel) {
          qualidade = 'rejeitada'
          motivos.push(motivoIncompativel)
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
            existente.set(
              'valor_unitario',
              vUnit > 0 ? vUnit : existente.getFloat('valor_unitario'),
            )
            existente.set('valor_total', Number(a.valor_total) || 0)
            existente.set('natureza_preco', a.natureza_preco || '')
            existente.set('data_referencia', a.data_referencia || '')
            existente.set('url_original', a.url_original || '')
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
            rec.set('quantidade', Number(a.quantidade) || 0)
            rec.set('valor_unitario', vUnit)
            rec.set('valor_total', Number(a.valor_total) || 0)
            rec.set('natureza_preco', a.natureza_preco || '')
            rec.set('data_referencia', a.data_referencia || '')
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
          falhou = true
        }
      }
      return { inseridas: inseridas, atualizadas: atualizadas, falhou: falhou }
    }

    // =========================================================================
    // PARTE 1: Processamento de Tarefas Pendentes da Fila price_index_tasks (MULTI-TAREFA)
    // Processa até 3 tarefas por tick, até esgotar orçamento de tempo (MAX_DURATION_MS - 10s)
    // =========================================================================
    var MAX_TAREFAS_POR_TICK = modoHttp ? 1 : 3
    var tarefasProcessadasNesteTick = 0

    function pncpLegacyCandidate(p) {
      if (
        !p ||
        p.t !== 'contrato' ||
        p._pncp_compra ||
        p.j !== undefined ||
        Number(p.b || 0) !== 0 ||
        Number(p.i || 0) !== 0
      )
        return false
      var origin = pncpControl(
        pncpControlOf(p.c || p.cnpj, p.a || p.ano, p.s || p.sequencial, 2),
        2,
      )
      if (!origin || (p.numeroControlePNCP && p.numeroControlePNCP !== origin.controle))
        return false
      var allowed = [
        'c',
        'a',
        's',
        't',
        'r',
        'b',
        'i',
        'u',
        'm',
        'o',
        'cnpj',
        'ano',
        'sequencial',
        'uf',
        'municipio',
        'orgao',
        'numeroControlePNCP',
        '_pncp_relacao',
      ]
      if (
        Object.keys(p).some(function (k) {
          return allowed.indexOf(k) < 0
        }) ||
        JSON.stringify(p).length > 2000
      )
        return false
      var op = p._pncp_relacao
      if (
        op &&
        (op.v !== 1 ||
          Number(op.falhas || 0) >= 4 ||
          op.quarentena ||
          (op.claim && Number(op.ate) > new Date().getTime()))
      )
        return false
      if (op && /conflit|invalido|ambigua/.test(op.lastStatus || '')) return false
      return true
    }
    function pncpErrors(raw) {
      var data = parseJsonWorkerSafe(raw)
      return Array.isArray(data) ? data : raw ? [raw] : []
    }
    function pncpReceipts(raw) {
      return pncpErrors(raw)
        .map(function (x) {
          if (typeof x !== 'string' || x.indexOf('PNCP_NAMESPACE_REBOUND_V1 ') !== 0) return null
          var receipt = parseJsonWorkerSafe(x.slice(26))
          return receipt &&
            pncpControl(receipt.documentControl, 2) &&
            pncpControl(receipt.purchaseControl, 1)
            ? receipt
            : null
        })
        .filter(function (x) {
          return !!x
        })
    }
    function pncpHasPriorWork(app, p, deadline) {
      if (new Date().getTime() >= deadline) return true
      var c = String(p.c || p.cnpj),
        a = Number(p.a || p.ano),
        s = Number(p.s || p.sequencial)
      try {
        var rec = app.findFirstRecordByData('pncp_item_cache', 'cache_key', c + '_' + a + '_' + s)
        if (new Date().getTime() >= deadline) return true
        if (rec) {
          var raw = rec.getString('raw_itens'),
            body = parseJsonWorkerSafe(raw)
          if (
            raw &&
            (!body ||
              (Array.isArray(body)
                ? body.length
                : (body.items || []).length || Object.keys(body.resultados_positivos || {}).length))
          )
            return true
        }
      } catch (err) {
        if (!/no rows|not found|absent/i.test(String(err.message || err))) return true
      }
      if (new Date().getTime() >= deadline) return true
      try {
        var prefix = c + '/' + a + '/' + s + '/itens/'
        var prior = app.findRecordsByFilter(
          'price_samples_index',
          'source = "PNCP" && orgao_cnpj = "' +
            c +
            '" && (source_record_id ~ "' +
            prefix +
            '" || purchase_id = "' +
            pncpControlOf(c, a, s, 1) +
            '" || purchase_id = "' +
            pncpControlOf(c, a, s, 2) +
            '")',
          '',
          1,
          0,
        )
        return new Date().getTime() >= deadline || prior.length > 0
      } catch (_) {
        return true
      }
    }
    function pncpRecoverTask(task) {
      var state = task.getString('status'),
        source = (task.getString('source') || '').toUpperCase()
      if (
        (state !== 'pending' && !(modoHttp && state === 'failed')) ||
        (source !== 'PNCP' && source !== 'AMBAS')
      )
        return
      if (new Date().getTime() + 4080 > fimTrabalhoRede) return
      var scanDeadline = Math.min(new Date().getTime() + 1000, fimTrabalhoRede)
      var list = parseJsonWorkerSafe(task.getString('pendentes'))
      if (!Array.isArray(list)) return
      // Optional DB admission slice only; admitted proof retains its existing source budget.
      var index = -1,
        checked = 0
      for (var i = 0; i < list.length; i++) {
        if (new Date().getTime() >= scanDeadline || checked >= 4) break
        if (!pncpLegacyCandidate(list[i])) continue
        checked++
        if (!pncpHasPriorWork($app, list[i], scanDeadline)) {
          index = i
          break
        }
      }
      if (index < 0 || new Date().getTime() + 4080 > fimTrabalhoRede) return
      var old = list[index],
        before = task.getString('pendentes'),
        attempts = task.getInt('tentativas'),
        started = task.getString('started_at'),
        progress = task.getString('progress_at')
      var document = pncpControl(
        pncpControlOf(old.c || old.cnpj, old.a || old.ano, old.s || old.sequencial, 2),
        2,
      )
      var token = new Date().getTime() + ':' + Math.random().toString(36).slice(2),
        reserved = '',
        reservedOp
      var budgetDeferred = new Error('PNCP_PREFLIGHT_BUDGET_DEFERRED')
      if (new Date().getTime() >= fimTrabalhoRede) return
      try {
        $app.runInTransaction(function (tx) {
          if (new Date().getTime() >= fimTrabalhoRede) return
          var current = tx.findRecordById('price_index_tasks', task.id)
          if (new Date().getTime() >= fimTrabalhoRede) return
          if (
            current.getString('status') !== state ||
            current.getString('pendentes') !== before ||
            current.getInt('tentativas') !== attempts ||
            current.getString('started_at') !== started ||
            current.getString('progress_at') !== progress ||
            pncpHasPriorWork(tx, old, fimTrabalhoRede)
          )
            return
          if (new Date().getTime() >= fimTrabalhoRede) return
          reservedOp = {
            v: 1,
            falhas: Number((old._pncp_relacao && old._pncp_relacao.falhas) || 0) + 1,
            claim: token,
            ate: fimTrabalhoRede,
            lastStatus: 'resolvendo',
          }
          list[index] = Object.assign({}, old, { _pncp_relacao: reservedOp })
          reserved = JSON.stringify(list)
          current.set('pendentes', reserved)
          if (new Date().getTime() >= fimTrabalhoRede) return
          tx.save(current)
          if (new Date().getTime() >= fimTrabalhoRede) throw budgetDeferred
        })
      } catch (err) {
        if (err !== budgetDeferred) throw err
        return
      }
      if (!reserved || new Date().getTime() >= fimTrabalhoRede) return
      var relationUrl =
        'https://pncp.gov.br/api/pncp/v1/orgaos/' +
        document.c +
        '/contratos/' +
        document.a +
        '/' +
        document.s
      var absenceUrl =
        'https://pncp.gov.br/api/consulta/v1/orgaos/' +
        document.c +
        '/compras/' +
        document.a +
        '/' +
        document.s
      var absenceProof = null,
        resolved = null,
        category = '',
        status = 0,
        attempted = false,
        quarantine = false
      if (!old.numeroControlePNCP) {
        if (new Date().getTime() >= fimTrabalhoRede) return
        var absence = sendHttpWithRetryUtil(absenceUrl, 4.0, 2, 80)
        if (new Date().getTime() >= fimTrabalhoRede) return
        attempted = !absence.deferred
        status = absence.resp ? Number(absence.resp.statusCode) : 0
        var missing = absence.resp && parseJsonWorkerSafe(absence.resp.json || absence.resp.raw)
        var expectedPath =
          '/pncp-consulta/v1/orgaos/' + document.c + '/compras/' + document.a + '/' + document.s
        if (
          status === 404 &&
          missing &&
          missing.path === expectedPath &&
          String(missing.status) === '404' &&
          missing.error === '404 NOT_FOUND' &&
          missing.message === 'A contratação informada não está cadastrada.'
        ) {
          absenceProof = {
            urlOficial: absenceUrl,
            path: expectedPath,
            status: 404,
            categoria: 'compra_nao_cadastrada',
            capturadoEm: new Date().toISOString(),
          }
        } else {
          category = absence.deferred ? 'adiado' : 'origem_nao_comprovada'
          quarantine = !!absence.ok || status === 301 || (status === 404 && !absenceProof)
        }
      }
      if (old.numeroControlePNCP || absenceProof) {
        if (new Date().getTime() >= fimTrabalhoRede) return
        var response = sendHttpWithRetryUtil(relationUrl, 4.0, 2, 80)
        if (new Date().getTime() >= fimTrabalhoRede) return
        attempted = attempted || !response.deferred
        status = response.resp ? Number(response.resp.statusCode) : 0
        var body = response.resp && parseJsonWorkerSafe(response.resp.json || response.resp.raw)
        if (response.ok && body && body.numeroControlePNCP === document.controle) {
          resolved = pncpResolveDocument(body, 'contrato', relationUrl)
          category = resolved.reason || 'verificada'
          if (resolved.reason) {
            quarantine = /conflit|invalido|ambigua/.test(resolved.reason)
            resolved = null
          }
        } else
          category = response.deferred
            ? 'adiado'
            : response.ok
              ? 'contrato_identidade_invalida'
              : 'contrato_http'
      }
      // A proof that arrived after its source deadline is never admitted.
      if (new Date().getTime() >= fimTrabalhoRede) return
      try {
        $app.runInTransaction(function (tx) {
          if (new Date().getTime() >= fimTrabalhoRede) return
          var current = tx.findRecordById('price_index_tasks', task.id)
          if (new Date().getTime() >= fimTrabalhoRede) return
          if (
            current.getString('status') !== state ||
            current.getString('pendentes') !== reserved ||
            current.getInt('tentativas') !== attempts ||
            current.getString('started_at') !== started ||
            current.getString('progress_at') !== progress
          )
            return
          var entries = parseJsonWorkerSafe(current.getString('pendentes'))
          if (!entries[index]._pncp_relacao || entries[index]._pncp_relacao.claim !== token) return
          if (resolved && pncpHasPriorWork(tx, old, fimTrabalhoRede)) {
            resolved = null
            category = 'trabalho_concorrente'
            quarantine = true
          }
          if (new Date().getTime() >= fimTrabalhoRede) return
          if (!resolved) {
            entries[index] = Object.assign({}, old, {
              _pncp_relacao: {
                v: 1,
                falhas: reservedOp.falhas - (attempted ? 0 : 1),
                lastStatus: category,
                httpStatus: status,
                quarentena: quarantine,
              },
            })
            current.set('pendentes', JSON.stringify(entries))
            if (new Date().getTime() >= fimTrabalhoRede) return
            tx.save(current)
            if (new Date().getTime() >= fimTrabalhoRede) throw budgetDeferred
            return
          }
          var canonical = {
            c: resolved.cnpj,
            a: resolved.ano,
            s: resolved.sequencial,
            t: 'contrato',
            r: 0,
            b: 0,
            i: 0,
            u: old.u || '',
            m: old.m || '',
            o: old.o || '',
            _pncp_compra: resolved._pncp_compra,
          }
          var key = pncpPendingKey(canonical),
            previous = pncpReceipts(current.getString('erros'))
          var already = previous.some(function (x) {
            return (
              x.documentControl === document.controle &&
              x.purchaseControl === resolved._pncp_compra.controle
            )
          })
          entries.splice(index, 1)
          var exists = entries.some(function (p) {
            return pncpPendingKey(p) === key
          })
          var purchaseAdmitted = pncpAdmittedBefore(canonical, previous)
          if (!exists && !purchaseAdmitted) entries.push(canonical)
          if (!already) {
            var receipt = {
              oldPending: old,
              oldLastError: current.getString('ultimo_erro').slice(0, 500),
              oldAttempts: attempts,
              oldCounters: {
                paginas_consultadas: current.getInt('paginas_consultadas'),
                itens_processados: current.getInt('itens_processados'),
                amostras_inseridas: current.getInt('amostras_inseridas'),
                amostras_atualizadas: current.getInt('amostras_atualizadas'),
              },
              documentControl: document.controle,
              purchaseControl: resolved._pncp_compra.controle,
              officialUrl: relationUrl,
              capturedAt: new Date().toISOString(),
              absenceProof: absenceProof,
            }
            var history = pncpErrors(current.getString('erros'))
            history.push('PNCP_NAMESPACE_REBOUND_V1 ' + JSON.stringify(receipt))
            current.set('erros', JSON.stringify(history))
          }
          current.set('pendentes', JSON.stringify(entries))
          current.set(
            'ultimo_erro',
            entries
              .filter(function (p) {
                return !p._pncp_discovery && !pncpActionable(p)
              })
              .map(function (p) {
                return 'PNCP cobertura não resolvida: ' + pncpPendingKey(p)
              })
              .join('; ')
              .slice(0, 500),
          )
          if (
            entries.some(function (p) {
              return pncpPendingKey(p) === key && pncpActionable(p)
            })
          )
            current.set('status', 'pending')
          else if (
            purchaseAdmitted &&
            !entries.some(function (p) {
              if (!p._pncp_discovery) return true
              var exhausted = p._pncp_discovery.esgotados || {}
              return !(exhausted.ata && exhausted.edital && exhausted.contrato)
            })
          ) {
            current.set('status', 'completed')
            current.set('pendentes', '[]')
            current.set('finished_at', new Date().toISOString())
          }
          if (new Date().getTime() >= fimTrabalhoRede) return
          tx.save(current)
          if (new Date().getTime() >= fimTrabalhoRede) throw budgetDeferred
        })
      } catch (err) {
        if (err !== budgetDeferred) throw err
      }
    }

    function buscarClaimEstagnadoWorker(appClaim, taskId, selecionadas) {
      // Stale reclaim: tarefa só é viva se progress_at (ou started_at se recém-iniciada) avança.
      // Threshold de 2 minutos conforme especificação.
      var idadeClaimSql = 'COALESCE(julianday(progress_at), julianday(started_at))'
      var sqlClaim =
        "SELECT id FROM price_index_tasks WHERE status = 'running' AND " +
        idadeClaimSql +
        ' < julianday({:limite})'
      var paramsClaim = { limite: new Date(new Date().getTime() - 2 * 60 * 1000).toISOString() }
      if (taskId) {
        sqlClaim += ' AND id = {:taskId}'
        paramsClaim.taskId = taskId
      }
      for (var seen = 0; selecionadas && seen < selecionadas.length; seen++) {
        sqlClaim += ' AND id <> {:seen' + seen + '}'
        paramsClaim['seen' + seen] = selecionadas[seen]
      }
      sqlClaim += ' ORDER BY ' + idadeClaimSql + ', id LIMIT 1'
      var queryClaim = appClaim.db().newQuery(sqlClaim)
      queryClaim.bind(paramsClaim)
      var claims = arrayOf(new DynamicModel({ id: '' }))
      queryClaim.all(claims)
      return claims.length > 0 ? claims[0].id : ''
    }

    var tarefasSelecionadasNesteTick = []
    for (var taskTurn = 0; taskTurn < MAX_TAREFAS_POR_TICK; taskTurn++) {
      if (trabalhoAdiadoPorTempo || new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000) {
        break
      }

      var tarefaAdquirida = null
      try {
        // One recovery opportunity per tick, even while an older task keeps requeueing.
        // Remaining turns retain pending-first selection and the existing stale fallback.
        var tarefas = modoHttp ? [$app.findRecordById('price_index_tasks', tarefaIdHttp)] : []
        // This turn only implements PNCP, never certification of Compras completion.
        if (modoHttp) {
          var fonteHttp = (tarefas[0].getString('source') || 'AMBAS').toUpperCase()
          if (fonteHttp !== 'AMBAS' && fonteHttp.indexOf('PNCP') === -1) tarefas = []
        }
        if (!modoHttp && taskTurn === 0) {
          try {
            var primeiroClaimEstagnado = buscarClaimEstagnadoWorker(
              $app,
              '',
              tarefasSelecionadasNesteTick,
            )
            if (primeiroClaimEstagnado) {
              tarefas = [$app.findRecordById('price_index_tasks', primeiroClaimEstagnado)]
              console.log(
                '[PRICE-WORKER] Tarefa recuperada no primeiro turno:',
                primeiroClaimEstagnado,
              )
            }
          } catch (_) {}
        }
        if (!modoHttp && tarefas.length === 0) {
          var sqlPendente = "SELECT id FROM price_index_tasks WHERE status = 'pending'"
          var paramsPendente = {}
          for (var seen = 0; seen < tarefasSelecionadasNesteTick.length; seen++) {
            sqlPendente += ' AND id <> {:seen' + seen + '}'
            paramsPendente['seen' + seen] = tarefasSelecionadasNesteTick[seen]
          }
          // Real completed turn, never producer-updated priority; unserved tasks use creation.
          sqlPendente +=
            ' ORDER BY COALESCE(julianday(finished_at), julianday(created), 0), julianday(created), id LIMIT 1'
          var queryPendente = $app.db().newQuery(sqlPendente)
          queryPendente.bind(paramsPendente)
          var pendentesSelecionados = arrayOf(new DynamicModel({ id: '' }))
          queryPendente.all(pendentesSelecionados)
          if (pendentesSelecionados.length > 0)
            tarefas = [$app.findRecordById('price_index_tasks', pendentesSelecionados[0].id)]
        }

        // 2. Stale reclaim: se não achou pendente, recupera running estagnada (> 2 minutos)
        if (!modoHttp && taskTurn !== 0 && (!tarefas || tarefas.length === 0)) {
          try {
            var claimEstagnadoId = buscarClaimEstagnadoWorker(
              $app,
              '',
              tarefasSelecionadasNesteTick,
            )
            if (claimEstagnadoId) {
              tarefas = [$app.findRecordById('price_index_tasks', claimEstagnadoId)]
              console.log(
                '[PRICE-WORKER] Tarefa em running recuperada por stale reclaim:',
                claimEstagnadoId,
              )
            }
          } catch (_) {}
        }

        if (tarefas && tarefas.length > 0) {
          // A raced claim consumes only this bounded slot, without selecting it again.
          if (!modoHttp) tarefasSelecionadasNesteTick.push(tarefas[0].id)
          pncpRecoverTask(tarefas[0])
          if (
            trabalhoAdiadoPorTempo ||
            new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000
          )
            break
          $app.runInTransaction(function (txApp) {
            var tRec = txApp.findRecordById('price_index_tasks', tarefas[0].id)
            if (new Date().getTime() >= fimTrabalhoRede) return
            if (
              tRec.getString('status') !== 'pending' &&
              !(
                tRec.getString('status') === 'running' &&
                buscarClaimEstagnadoWorker(txApp, tRec.id) === tRec.id
              )
            )
              return
            if (new Date().getTime() >= fimTrabalhoRede) return
            var agoraIso = new Date().toISOString()
            var tenta = (parseInt(tRec.getString('tentativas'), 10) || 0) + 1
            tRec.set('status', 'running')
            tRec.set('started_at', agoraIso)
            tRec.set('progress_at', agoraIso)
            tRec.set('tentativas', tenta)
            txApp.save(tRec)

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
              started_at: agoraIso,
              pendentes: parsedPendentes,
              paginas_consultadas: Number(tRec.getInt('paginas_consultadas')) || 0,
              itens_processados: Number(tRec.getInt('itens_processados')) || 0,
              amostras_inseridas: Number(tRec.getInt('amostras_inseridas')) || 0,
              amostras_atualizadas: Number(tRec.getInt('amostras_atualizadas')) || 0,
            }
          })
        }
      } catch (errFind) {
        console.log('[PRICE-WORKER-CRON] Erro ao buscar tarefa na fila:', errFind.message)
      }

      if (!tarefaAdquirida) {
        if (!modoHttp && tarefas && tarefas.length > 0) continue
        break
      }

      tarefasProcessadasNesteTick++
      console.log(
        '[PRICE-WORKER-CRON] [TAREFA #' + tarefasProcessadasNesteTick + '] Processando:',
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
      var descobertaAvancouWorker = false
      var errosAcumulados = []
      var recibosAdquiridos = pncpReceiptRecords(
        $app.findRecordById('price_index_tasks', tarefaAdquirida.id).getString('erros'),
      )
      var pendentesRestantes = tarefaAdquirida.pendentes ? [...tarefaAdquirida.pendentes] : []
      function possuiClaimWorker(rec) {
        return (
          rec.getString('status') === 'running' &&
          rec.getString('started_at') === tarefaAdquirida.started_at &&
          Number(rec.getInt('tentativas')) === tarefaAdquirida.tentativas
        )
      }
      function chavePendenteWorker(p) {
        return pncpPendingKey(p)
      }
      // Identifica o delta concorrente sem reinserir compras consumidas deste snapshot.
      var pendentesAdquiridosPorChave = {}
      var marcadorAdquirido = ''
      for (var snapI = 0; snapI < pendentesRestantes.length; snapI++) {
        var snapP = pendentesRestantes[snapI]
        if (snapP._pncp_discovery) marcadorAdquirido = JSON.stringify(snapP._pncp_discovery)
        else pendentesAdquiridosPorChave[chavePendenteWorker(snapP)] = JSON.stringify(snapP)
      }
      // Marcador reservado: progresso da descoberta do termo, nunca uma compra/retry.
      var descobertaPncp = { esgotados: {} }
      pendentesRestantes = pendentesRestantes.filter(function (p) {
        if (p && p._pncp_discovery) {
          descobertaPncp = p._pncp_discovery
          return false
        }
        return true
      })
      if (!descobertaPncp.esgotados) descobertaPncp.esgotados = {}
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
          if (
            n.indexOf(tokenPrincipal) !== -1 ||
            (tokenStem && tokenStem.length >= 4 && n.indexOf(tokenStem) !== -1)
          )
            return true
          var dToks = extractWorkerTokensUtil(desc)
          for (var idx = 0; idx < dToks.length; idx++) {
            var dt = dToks[idx]
            var dtStem = stemWorkerTokenUtil(dt)
            if (dt === tokenPrincipal) return true
            if (tokenStem && tokenStem.length >= 4 && dtStem === tokenStem) return true
            if (
              dt.indexOf(tokenPrincipal) === 0 &&
              Math.abs(dt.length - tokenPrincipal.length) <= 3
            )
              return true
            if (
              tokenStem &&
              tokenStem.length >= 4 &&
              dtStem.indexOf(tokenStem) === 0 &&
              Math.abs(dtStem.length - tokenStem.length) <= 3
            )
              return true
          }
          return false
        }

        var contratacoesParaProcessar = []
        var seenCnpjKeys = {}
        // Compras esgotadas permanecem como evidência, fora do lote selecionável.
        var pendentesCongelados = []
        pendentesRestantes = pendentesRestantes.filter(function (p) {
          if (p.t === 'contrato' && !pncpVerifiedPurchase(p)) {
            pendentesCongelados.push(p)
            errosAcumulados.push('PNCP relação pendente ou em quarentena')
            return false
          }
          if (Number(p.r) >= 4) {
            pendentesCongelados.push(p)
            var chaveCongelada =
              (p.c || p.cnpj || '') + '_' + (p.a || p.ano || '') + '_' + (p.s || p.sequencial || '')
            seenCnpjKeys[chaveCongelada] = true // Descoberta não pode recriar a compra com r=0.
            errosAcumulados.push(
              'PNCP itens ' +
                chaveCongelada +
                ': limite de retentativas esgotado; cobertura não resolvida',
            )
            return false
          }
          return true
        })

        // 1. PRIORIZAÇÃO CRÍTICA NA FILA DE PENDENTES:
        // a. Atas e contratações homologadas com preço unitário no TOPO (score 40/30)
        // b. Editais (score 10) sem atrasar as homologadas
        // c. Menor contagem de retentativas anteriores
        pendentesRestantes.sort(function (pA, pB) {
          var scoreA =
            (pA.t === 'ata' ? 40 : pA.t === 'contrato' ? 30 : 10) - (Number(pA.r) || 0) * 5
          var scoreB =
            (pB.t === 'ata' ? 40 : pB.t === 'contrato' ? 30 : 10) - (Number(pB.r) || 0) * 5
          return scoreB - scoreA
        })

        // Orçamento expandido de detalhamento por ciclo: até 60 contratações por lote
        if (pendentesRestantes.length > 0) {
          var LOTE_PENDENTES_MAX = 60
          var lotePendentesAtual = pendentesRestantes.splice(0, LOTE_PENDENTES_MAX)
          for (var lp = 0; lp < lotePendentesAtual.length; lp++) {
            var pItem = lotePendentesAtual[lp]
            var rawCnpj = pItem.c || pItem.cnpj || ''
            var ano = pItem.a || pItem.ano || 0
            var seq = pItem.s || pItem.sequencial || 0
            var kP = rawCnpj + '_' + ano + '_' + seq
            var retentativasPrevias = Number(pItem.r) || 0

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
                _cacheItemOffset: Math.max(0, parseInt(pItem.i, 10) || 0),
                _pendente: pItem,
              })
            }
          }
        }
        pendentesRestantes = pendentesCongelados.concat(pendentesRestantes)

        // 2. Sem contratação acionável selecionada, repõe descoberta (ata > edital > contrato)
        if (
          contratacoesParaProcessar.length === 0 &&
          !(
            descobertaPncp.esgotados.ata &&
            descobertaPncp.esgotados.edital &&
            descobertaPncp.esgotados.contrato
          ) &&
          new Date().getTime() - tInicioCiclo < MAX_DURATION_MS - 15000
        ) {
          var paginasAntesBusca = paginasTotal
          var cicloDocTipos = ['ata', 'edital', 'contrato']
          // No máximo três avanços locais; não repete página 1 após a página 20.
          for (var docSkip = 0; docSkip < cicloDocTipos.length; docSkip++) {
            if (!descobertaPncp.esgotados[cicloDocTipos[paginasTotal % cicloDocTipos.length]]) break
            paginasTotal++
          }
          var janelaIndex = paginasTotal % cicloDocTipos.length
          var tipoJanelaAtiva = cicloDocTipos[janelaIndex]
          var paginaAlvoPncp = Math.floor(paginasTotal / cicloDocTipos.length) + 1

          var urlBusca =
            'https://pncp.gov.br/api/search/?q=' +
            encodeURIComponent(termo) +
            '&tipos_documento=' +
            encodeURIComponent(tipoJanelaAtiva) +
            '&pagina=' +
            paginaAlvoPncp +
            '&tam_pagina=40'
          if (uf) urlBusca += '&ufs=' + encodeURIComponent(uf)

          var resBusca = sendHttpWithRetryUtil(urlBusca, 4.0, 2, 80)
          if (resBusca.ok && resBusca.resp) {
            var body = parseJsonWorkerSafe(resBusca.resp.json || resBusca.resp.raw)
            var items = body
              ? Array.isArray(body)
                ? body
                : body.items || body.data || body.resultado
              : resBusca.resp.statusCode === 204
                ? []
                : null

            if (
              !Array.isArray(items) ||
              items.some(function (entry) {
                return !entry || typeof entry !== 'object' || Array.isArray(entry)
              })
            ) {
              errosAcumulados.push('PNCP busca ' + tipoJanelaAtiva + ': resposta de itens inválida')
              items = [] // Falha não avança o cursor nem encerra a descoberta.
            } else {
              paginasTotal++
              descobertaAvancouWorker = true
              var totalPaginasBusca = Number(body && body.totalPaginas)
              if (
                items.length === 0 ||
                (totalPaginasBusca > 0 && paginaAlvoPncp >= totalPaginasBusca)
              ) {
                descobertaPncp.esgotados[tipoJanelaAtiva] = true
              }
            }

            items.sort(function (a, b) {
              var aScore =
                a.situacaoCompraName === 'Homologada' || a.tipo_documento === 'ata' ? 10 : 0
              var bScore =
                b.situacaoCompraName === 'Homologada' || b.tipo_documento === 'ata' ? 10 : 0
              return bScore - aScore
            })

            for (var k = 0; k < items.length; k++) {
              var it = items[k]
              var resolvedB = pncpResolveDocument(it, tipoJanelaAtiva, urlBusca)
              if (resolvedB.reason) {
                var relacaoPendenteB = pncpRelationPending(resolvedB, it)
                var chaveRelacaoB = pncpPendingKey(relacaoPendenteB)
                var filaAtualRelacaoB = parseJsonWorkerSafe(
                  $app
                    .findRecordById('price_index_tasks', tarefaAdquirida.id)
                    .getString('pendentes'),
                )
                if (!Array.isArray(filaAtualRelacaoB)) filaAtualRelacaoB = []
                if (
                  !pendentesRestantes.concat(filaAtualRelacaoB).some(function (p) {
                    return pncpPendingKey(p) === chaveRelacaoB
                  })
                )
                  pendentesRestantes.push(relacaoPendenteB)
                errosAcumulados.push('PNCP relação: ' + resolvedB.reason)
                continue
              }
              var rawCnpjB = resolvedB.cnpj,
                anoB = resolvedB.ano,
                seqB = resolvedB.sequencial

              if (
                pncpAdmittedBefore(
                  { c: rawCnpjB, a: anoB, s: seqB, t: 'edital' },
                  recibosAdquiridos,
                )
              )
                continue
              var kPB = rawCnpjB + '_' + anoB + '_' + seqB
              if (rawCnpjB && anoB && seqB && !seenCnpjKeys[kPB]) {
                seenCnpjKeys[kPB] = true
                contratacoesParaProcessar.push({
                  _pendente: { _pncp_compra: resolvedB._pncp_compra },
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
                  _tipoDoc: it.tipo_documento || it.document_type || tipoJanelaAtiva,
                  _retries: 0,
                  raw_entry: it,
                })
              }
            }
          } else if (resBusca.deferred) {
            paginasTotal = paginasAntesBusca
          } else {
            errosAcumulados.push(
              'PNCP busca ' + tipoJanelaAtiva + ': ' + (resBusca.error || 'sem resposta'),
            )
          }
        }

        var colecaoAmostrasCiclo = null

        // 3. Processamento detalhado com espaçamento seguro (80ms)
        for (var cIdx = 0; cIdx < contratacoesParaProcessar.length; cIdx++) {
          if (trabalhoAdiadoPorTempo || new Date().getTime() >= fimTrabalhoRede) {
            for (var leftover = cIdx; leftover < contratacoesParaProcessar.length; leftover++) {
              var lo = contratacoesParaProcessar[leftover]
              pendentesRestantes.unshift(
                Object.assign({}, lo._pendente || {}, {
                  c: lo.cnpj,
                  a: lo.ano,
                  s: lo.sequencial,
                  u: lo.uf,
                  m: lo.municipio,
                  o: lo.orgao,
                  t: lo._tipoDoc || 'ata',
                  r: lo._retries || 0,
                  i: lo._cacheItemOffset || 0,
                }),
              )
            }
            break
          }

          var cItemProcessando = contratacoesParaProcessar[cIdx]
          if (cItemProcessando._pendente && cItemProcessando._pendente._pncp_compra)
            cItemProcessando.numeroControlePNCP = cItemProcessando._pendente._pncp_compra.controle
          var cnpjC = cItemProcessando.cnpj
          var anoC = cItemProcessando.ano
          var seqC = cItemProcessando.sequencial
          var cacheKeyC = cnpjC + '_' + anoC + '_' + seqC
          var itensArrC = null
          var erroAoBuscarItens = false
          var cacheCompletoC = false
          var proximaPaginaC = 1
          var itensCacheC = []
          var resultadosPositivosC = {}
          var novosResultadosC = {}
          var cRec = null
          var cacheItemOffsetC = cItemProcessando._cacheItemOffset || 0
          // Shared cache pagination is not this query's examined-item boundary.
          var cachePrefixExaminedC = Math.max(
            cacheItemOffsetC,
            parseInt(cItemProcessando._pendente && cItemProcessando._pendente.b, 10) || 0,
          )
          var cacheSliceBaseC = null
          var cacheTodosC = itensCacheC
          var trabalhoPaginaC = cItemProcessando._pendente && cItemProcessando._pendente.j
          var refsTrabalhoC = null
          var erroReferenciaC = ''

          function pendenteAtualC(offset, trabalho) {
            var p = Object.assign({}, cItemProcessando._pendente || {}, {
              c: cnpjC,
              a: anoC,
              s: seqC,
              u: cItemProcessando.uf || '',
              m: cItemProcessando.municipio || '',
              o: cItemProcessando.orgao || '',
              t: cItemProcessando._tipoDoc || 'ata',
              r: cItemProcessando._retries || 0,
            })
            delete p.i
            delete p.j
            if (offset !== null && offset !== undefined) p.i = offset
            if (trabalho) p.j = trabalho
            p.b = cachePrefixExaminedC
            return p
          }

          function referenciasPaginaC(itens, posicoes) {
            return posicoes.map(function (pos) {
              var ref = { pos: pos }
              var numero = itens[pos].numeroItem || itens[pos].numero_item
              if (numero != null) ref.numeroItem = numero
              return ref
            })
          }

          function checkpointPaginaC(txApp) {
            var tarefaCheckpoint = txApp.findRecordById('price_index_tasks', tarefaAdquirida.id)
            if (!possuiClaimWorker(tarefaCheckpoint))
              throw new Error('PNCP claim substituído antes do checkpoint')
            var atuais = parseJsonWorkerSafe(tarefaCheckpoint.getString('pendentes')) || []
            var pendentesAntesCheckpoint = pncpCanonical(atuais)
            var p = pendenteAtualC(null, trabalhoPaginaC)
            var chave = chavePendenteWorker(p)
            var substituiu = false
            for (var cpI = 0; cpI < atuais.length; cpI++) {
              if (atuais[cpI]._pncp_discovery || chavePendenteWorker(atuais[cpI]) !== chave)
                continue
              p = Object.assign({}, atuais[cpI], p)
              delete p.i
              atuais[cpI] = p
              substituiu = true
              break
            }
            if (!substituiu) atuais.push(p)
            tarefaCheckpoint.set('pendentes', JSON.stringify(atuais))
            if (pncpCanonical(atuais) !== pendentesAntesCheckpoint)
              tarefaCheckpoint.set('progress_at', new Date().toISOString())
            txApp.save(tarefaCheckpoint)
            pendentesAdquiridosPorChave[chave] = JSON.stringify(p)
          }

          function consumirFatiaCacheAtualC(itensAtuais, offset) {
            if (!Array.isArray(itensAtuais)) throw new Error('PNCP cache atual sem itens válidos')
            cacheTodosC = itensAtuais
            cacheSliceBaseC = offset
            itensArrC = itensAtuais.slice(offset, offset + 50)
            refsTrabalhoC = referenciasPaginaC(
              itensAtuais,
              itensArrC.map(function (_, idx) {
                return offset + idx
              }),
            )
            trabalhoPaginaC = { v: 1, pagina: 0, refs: refsTrabalhoC }
            if (offset + itensArrC.length < itensAtuais.length)
              trabalhoPaginaC.proximo_i = offset + itensArrC.length
          }

          try {
            cRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyC)
            if (cRec) {
              var rawItensC = cRec.getString('raw_itens')
              var cacheC = parseJsonWorkerSafe(rawItensC)
              resultadosPositivosC = (cacheC && cacheC.resultados_positivos) || {}
              itensCacheC = Array.isArray(cacheC)
                ? cacheC
                : cacheC && Array.isArray(cacheC.items)
                  ? cacheC.items
                  : []
              cacheTodosC = itensCacheC
              if (cachePrefixExaminedC > itensCacheC.length) {
                // A shorter authoritative cache is evidenced divergence, not new progress.
                cachePrefixExaminedC = 0
                cacheItemOffsetC = 0
              }
              var pagC = cacheC && !Array.isArray(cacheC) && cacheC.paginacao
              if (pagC && pagC.versao === 1 && pagC.tamanho_pagina === 50) {
                proximaPaginaC = Math.max(1, parseInt(pagC.proxima_pagina, 10) || 1)
                cacheCompletoC = pagC.completa === true
              }
              // i > 0 drains this task's received cache backlog, including a partial cache.
              // Only after its final slice may a partial purchase resume the official next page.
              if (trabalhoPaginaC) {
                itensArrC = []
                if (trabalhoPaginaC.v !== 1 || !Array.isArray(trabalhoPaginaC.refs))
                  erroReferenciaC = 'checkpoint de itens inválido'
                else {
                  refsTrabalhoC = trabalhoPaginaC.refs.slice()
                  for (var refI = 0; refI < refsTrabalhoC.length; refI++) {
                    var refC = refsTrabalhoC[refI]
                    var posRefC = refC && Number(refC.pos)
                    var itemRefC =
                      Number.isInteger(posRefC) && posRefC >= 0 ? itensCacheC[posRefC] : null
                    if (
                      refC &&
                      refC.numeroItem != null &&
                      (!itemRefC ||
                        String(itemRefC.numeroItem || itemRefC.numero_item) !==
                          String(refC.numeroItem))
                    ) {
                      itemRefC = null
                      for (var buscaRef = 0; buscaRef < itensCacheC.length; buscaRef++) {
                        if (
                          String(
                            itensCacheC[buscaRef].numeroItem || itensCacheC[buscaRef].numero_item,
                          ) === String(refC.numeroItem)
                        ) {
                          itemRefC = itensCacheC[buscaRef]
                          break
                        }
                      }
                    }
                    if (!itemRefC) {
                      erroReferenciaC = 'referência de item ausente no cache'
                      break
                    }
                    itensArrC.push(itemRefC)
                  }
                }
              } else if (cacheCompletoC || cachePrefixExaminedC < itensCacheC.length)
                consumirFatiaCacheAtualC(itensCacheC, cachePrefixExaminedC)
              else itensArrC = []
            }
          } catch (_) {}

          // Uma página por compra/turno. Arrays legados são úteis, mas sem prova de completude.
          if (trabalhoPaginaC && (!refsTrabalhoC || erroReferenciaC)) {
            errosAcumulados.push(
              'PNCP itens ' + cacheKeyC + ': ' + (erroReferenciaC || 'checkpoint sem cache'),
            )
            pendentesRestantes.push(pendenteAtualC(null, trabalhoPaginaC))
            continue
          }

          if (cacheSliceBaseC !== null && trabalhoPaginaC) {
            try {
              $app.runInTransaction(checkpointPaginaC)
            } catch (_) {
              erroAoBuscarItens = true
            }
          }

          if (!erroAoBuscarItens && !trabalhoPaginaC && !cacheCompletoC) {
            var urlItens =
              'https://pncp.gov.br/api/pncp/v1/orgaos/' +
              cnpjC +
              '/compras/' +
              anoC +
              '/' +
              seqC +
              '/itens?pagina=' +
              proximaPaginaC +
              '&tamanhoPagina=50'
            var resItens = sendHttpWithRetryUtil(urlItens, 3.5, 2, 80)
            if (resItens.ok && resItens.resp) {
              var bItens = parseJsonWorkerSafe(resItens.resp.json || resItens.resp.raw)
              itensArrC = bItens
                ? Array.isArray(bItens)
                  ? bItens
                  : bItens.items || bItens.data || bItens.resultado
                : resItens.resp.statusCode === 204
                  ? []
                  : null
              if (
                Array.isArray(itensArrC) &&
                !itensArrC.some(function (entry) {
                  return !entry || typeof entry !== 'object' || Array.isArray(entry)
                })
              ) {
                var itensMescladosC = itensCacheC.slice()
                var posicoesC = {}
                for (var oldI = 0; oldI < itensMescladosC.length; oldI++) {
                  var oldNum = itensMescladosC[oldI].numeroItem || itensMescladosC[oldI].numero_item
                  if (oldNum) posicoesC[String(oldNum)] = oldI
                }
                for (var newI = 0; newI < itensArrC.length; newI++) {
                  var novoItemC = itensArrC[newI]
                  var novoNumC = novoItemC.numeroItem || novoItemC.numero_item
                  var posC = novoNumC ? posicoesC[String(novoNumC)] : undefined
                  if (posC !== undefined) {
                    itensMescladosC[posC] = Object.assign({}, itensMescladosC[posC], novoItemC)
                  } else {
                    if (novoNumC) posicoesC[String(novoNumC)] = itensMescladosC.length
                    itensMescladosC.push(novoItemC)
                  }
                }
                cacheCompletoC = itensArrC.length < 50
                try {
                  $app.runInTransaction(function (txApp) {
                    if (
                      !possuiClaimWorker(
                        txApp.findRecordById('price_index_tasks', tarefaAdquirida.id),
                      )
                    )
                      throw new Error('PNCP claim substituído')
                    var rC = null
                    try {
                      rC = txApp.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyC)
                    } catch (_) {}
                    var atualC = rC ? parseJsonWorkerSafe(rC.getString('raw_itens')) : null
                    var pagAtualC = atualC && atualC.paginacao
                    // A completed/newer page fetched concurrently owns the current raw items and cursor.
                    if (
                      pagAtualC &&
                      (Number(pagAtualC.proxima_pagina) > proximaPaginaC ||
                        pagAtualC.completa === true)
                    ) {
                      resultadosPositivosC = atualC.resultados_positivos || {}
                      cacheCompletoC = pagAtualC.completa === true
                      // The other writer may belong to another term. This task must examine
                      // its authoritative items too, without replaying the received HTTP page.
                      cachePrefixExaminedC = 0
                      consumirFatiaCacheAtualC(atualC.items, 0)
                      refsTrabalhoC = referenciasPaginaC(
                        cacheTodosC,
                        itensArrC.map(function (_, idx) {
                          return idx
                        }),
                      )
                      trabalhoPaginaC = { v: 1, pagina: proximaPaginaC, refs: refsTrabalhoC }
                      if (itensArrC.length < cacheTodosC.length)
                        trabalhoPaginaC.proximo_i = itensArrC.length
                      checkpointPaginaC(txApp)
                      return
                    }
                    var atuaisItensC = Array.isArray(atualC) ? atualC : atualC && atualC.items
                    var itensConcorrentesC =
                      Array.isArray(atuaisItensC) &&
                      pncpCanonical(atuaisItensC) !== pncpCanonical(itensCacheC)
                    if (Array.isArray(atuaisItensC)) {
                      // Rebase this page onto the transaction's current items, not the old snapshot.
                      itensMescladosC = atuaisItensC.slice()
                      for (var paginaI = 0; paginaI < itensArrC.length; paginaI++) {
                        var paginaItem = itensArrC[paginaI]
                        var paginaNum = Number(paginaItem.numeroItem || paginaItem.numero_item)
                        var atualPos = -1
                        for (var atualI = 0; atualI < itensMescladosC.length; atualI++) {
                          if (
                            paginaNum &&
                            Number(
                              itensMescladosC[atualI].numeroItem ||
                                itensMescladosC[atualI].numero_item,
                            ) === paginaNum
                          ) {
                            atualPos = atualI
                            break
                          }
                        }
                        if (atualPos < 0) itensMescladosC.push(paginaItem)
                        else {
                          var snapshotItem = null
                          for (var snapshotI = 0; snapshotI < itensCacheC.length; snapshotI++) {
                            if (
                              Number(
                                itensCacheC[snapshotI].numeroItem ||
                                  itensCacheC[snapshotI].numero_item,
                              ) === paginaNum
                            ) {
                              snapshotItem = itensCacheC[snapshotI]
                              break
                            }
                          }
                          if (
                            snapshotItem &&
                            pncpCanonical(snapshotItem) === pncpCanonical(itensMescladosC[atualPos])
                          ) {
                            itensMescladosC[atualPos] = Object.assign(
                              {},
                              itensMescladosC[atualPos],
                              paginaItem,
                            )
                          }
                        }
                      }
                    }
                    var colC = txApp.findCollectionByNameOrId('pncp_item_cache')
                    if (!rC) rC = new Record(colC)
                    resultadosPositivosC =
                      (atualC && atualC.resultados_positivos) || resultadosPositivosC
                    rC.set('cache_key', cacheKeyC)
                    rC.set('cnpj', cnpjC)
                    rC.set('ano', parseInt(anoC, 10))
                    rC.set('sequencial', parseInt(seqC, 10))
                    var cacheSalvoC = atualC && !Array.isArray(atualC) ? atualC : {}
                    cacheSalvoC.items = itensMescladosC
                    if (Object.keys(resultadosPositivosC).length > 0)
                      cacheSalvoC.resultados_positivos = resultadosPositivosC
                    cacheSalvoC.paginacao = {
                      versao: 1,
                      tamanho_pagina: 50,
                      proxima_pagina: proximaPaginaC + 1,
                      completa: cacheCompletoC,
                    }
                    rC.set('raw_itens', JSON.stringify(cacheSalvoC))
                    rC.set('total_itens', itensMescladosC.length)
                    txApp.save(rC)
                    if (itensConcorrentesC) {
                      cachePrefixExaminedC = 0
                      consumirFatiaCacheAtualC(itensMescladosC, 0)
                    }
                    cacheTodosC = itensMescladosC
                    var posicoesPaginaC = []
                    for (var refPaginaI = 0; refPaginaI < itensArrC.length; refPaginaI++) {
                      var refPaginaItem = itensArrC[refPaginaI]
                      var refPaginaNum = refPaginaItem.numeroItem || refPaginaItem.numero_item
                      var refPaginaPos = itensMescladosC.indexOf(refPaginaItem)
                      if (refPaginaNum != null) {
                        for (var refBuscaI = 0; refBuscaI < itensMescladosC.length; refBuscaI++) {
                          if (
                            String(
                              itensMescladosC[refBuscaI].numeroItem ||
                                itensMescladosC[refBuscaI].numero_item,
                            ) === String(refPaginaNum)
                          ) {
                            refPaginaPos = refBuscaI
                            break
                          }
                        }
                      }
                      if (refPaginaPos < 0)
                        throw new Error('PNCP página sem referência oficial no cache')
                      if (posicoesPaginaC.indexOf(refPaginaPos) < 0)
                        posicoesPaginaC.push(refPaginaPos)
                    }
                    refsTrabalhoC = referenciasPaginaC(itensMescladosC, posicoesPaginaC)
                    itensArrC = posicoesPaginaC.map(function (pos) {
                      return itensMescladosC[pos]
                    })
                    trabalhoPaginaC = { v: 1, pagina: proximaPaginaC, refs: refsTrabalhoC }
                    if (
                      cacheSliceBaseC !== null &&
                      cacheSliceBaseC + itensArrC.length < cacheTodosC.length
                    )
                      trabalhoPaginaC.proximo_i = cacheSliceBaseC + itensArrC.length
                    checkpointPaginaC(txApp)
                  })
                } catch (_) {
                  erroAoBuscarItens = true
                }
              } else {
                erroAoBuscarItens = true
              }
            } else if (resItens.deferred) {
              pendentesRestantes.push(pendenteAtualC(cacheItemOffsetC, null))
              continue
            } else {
              erroAoBuscarItens = true
            }
          }

          if (erroAoBuscarItens) {
            var novaRetentativa = (cItemProcessando._retries || 0) + 1
            var pendenteComFalha = pendenteAtualC(cacheItemOffsetC, trabalhoPaginaC)
            pendenteComFalha.r = novaRetentativa
            pendentesRestantes.push(pendenteComFalha)
            if (novaRetentativa > 3) {
              errosAcumulados.push(
                'PNCP itens ' +
                  cacheKeyC +
                  ': limite de retentativas esgotado; cobertura não resolvida',
              )
            }
            continue
          }

          contratacoesProcessadasNesteCiclo++
          if (!Array.isArray(itensArrC)) itensArrC = []
          var aposentadosC = 0
          function aposentarItemC(item) {
            aposentadosC++
            // Supported cache writers append new identities and merge existing slots.
            // Legacy/reordered refs may safely replay a gap, never certify it examined.
            var ref = refsTrabalhoC && refsTrabalhoC[subI]
            var pos = ref && Number(ref.pos)
            if (!Number.isInteger(pos) || cacheTodosC[pos] !== item) pos = cacheTodosC.indexOf(item)
            if (pos === cachePrefixExaminedC) cachePrefixExaminedC++
          }

          for (var subI = 0; subI < itensArrC.length; subI++) {
            if (new Date().getTime() >= fimTrabalhoRede) {
              trabalhoAdiadoPorTempo = true
              break
            }
            var itmObj = itensArrC[subI]
            var dItem = itmObj.descricao || itmObj.materialOuServicoNome || ''
            if (!itemEhCompativelWorker(dItem)) {
              aposentarItemC(itmObj)
              continue
            }

            var numItemInt = parseInt(itmObj.numeroItem || itmObj.numero_item, 10) || 0
            var registroPreco = itmObj
            var campoUnitario = ''
            var camposUnitarios = [
              'valorUnitarioHomologado',
              'valor_unitario_homologado',
              'valorUnitarioEstimado',
              'valor_unitario_estimado',
              'valorUnitario',
              'valor_unitario',
            ]
            for (var campoIdx = 0; campoIdx < camposUnitarios.length; campoIdx++) {
              var candidato = Number(itmObj[camposUnitarios[campoIdx]])
              if (isFinite(candidato) && candidato > 0) {
                campoUnitario = camposUnitarios[campoIdx]
                break
              }
            }
            var vUnitFinal = campoUnitario ? Number(itmObj[campoUnitario]) : 0
            var nat = /homologado/i.test(campoUnitario) ? 'homologado' : 'estimado'
            var urlItem =
              numItemInt > 0 && cnpjC && anoC && seqC
                ? 'https://pncp.gov.br/api/pncp/v1/orgaos/' +
                  cnpjC +
                  '/compras/' +
                  anoC +
                  '/' +
                  seqC +
                  '/itens/' +
                  numItemInt
                : ''
            var urlEvidencia = urlItem
            var resultadoCapturadoEm = ''
            var resultadoReutilizado = false
            var forNome =
              (itmObj.fornecedor &&
                (itmObj.fornecedor.nomeRazaoSocialFornecedor ||
                  itmObj.fornecedor.nomeRazaoSocial)) ||
              'NÃO INFORMADO'
            var forCnpj =
              (itmObj.fornecedor && (itmObj.fornecedor.niFornecedor || itmObj.fornecedor.cnpj)) ||
              'NÃO INFORMADO'

            if (vUnitFinal <= 0 && urlItem) {
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
              var identidadeResultado = {
                cnpj: cnpjC,
                ano: Number(anoC),
                sequencial: Number(seqC),
                numeroItem: numItemInt,
              }
              var chaveResultado = pncpResultKey(identidadeResultado)
              var cacheResultado = pncpValidResult(
                typeof resultadosPositivosC !== 'undefined' && resultadosPositivosC[chaveResultado],
                identidadeResultado,
                itmObj,
                urlRes,
              )
              var resR = cacheResultado
                ? { ok: true, resp: { json: cacheResultado.corpo_oficial } }
                : sendHttpWithRetryUtil(urlRes, 3.0, 1, 80)
              if (resR.deferred) break
              // Every unsuccessful result is unresolved, including exhausted retries/404.
              // The existing persistent r=4 ceiling keeps permanent failures bounded.
              if (!resR.ok) {
                cItemProcessando._retries = (cItemProcessando._retries || 0) + 1
                if (cItemProcessando._retries > 3) {
                  errosAcumulados.push(
                    'PNCP resultados ' +
                      cacheKeyC +
                      ' item ' +
                      numItemInt +
                      ': limite de retentativas esgotado; cobertura não resolvida',
                  )
                }
                break // Preserve the current result reference in the existing page checkpoint.
              }
              if (resR.ok && resR.resp) {
                var bRes = parseJsonWorkerSafe(resR.resp.json || resR.resp.raw)
                var capturadoResultado = cacheResultado
                  ? cacheResultado.capturado_em
                  : new Date().toISOString()
                var envelopeResultado =
                  cacheResultado ||
                  pncpResultEnvelope(identidadeResultado, itmObj, urlRes, bRes, capturadoResultado)
                if (envelopeResultado) {
                  resultadoCapturadoEm = envelopeResultado.capturado_em
                  resultadoReutilizado = !!cacheResultado
                  if (!cacheResultado && typeof novosResultadosC !== 'undefined')
                    novosResultadosC[chaveResultado] = envelopeResultado
                }
                var aRes = bRes
                  ? Array.isArray(bRes)
                    ? bRes
                    : bRes.items || bRes.data || bRes.resultado || []
                  : []
                for (var rIdx = 0; rIdx < aRes.length; rIdx++) {
                  var resIt = aRes[rIdx]
                  if (!resIt || typeof resIt !== 'object' || Array.isArray(resIt)) continue
                  var camposResultado = [
                    'valorUnitarioHomologado',
                    'valor_unitario_homologado',
                    'valorUnitario',
                    'valor_unitario',
                  ]
                  var campoResultado = ''
                  for (var resCampoIdx = 0; resCampoIdx < camposResultado.length; resCampoIdx++) {
                    var valorResultado = Number(resIt[camposResultado[resCampoIdx]])
                    if (isFinite(valorResultado) && valorResultado > 0) {
                      campoResultado = camposResultado[resCampoIdx]
                      break
                    }
                  }
                  var vR = campoResultado ? Number(resIt[campoResultado]) : 0
                  if (vR > 0) {
                    vUnitFinal = vR
                    nat = 'homologado'
                    campoUnitario = campoResultado
                    registroPreco = resIt
                    urlEvidencia = urlRes
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

            var qItem = Number(itmObj.quantidade) > 0 ? Number(itmObj.quantidade) : 0

            if (!isFinite(vUnitFinal) || vUnitFinal <= 0 || numItemInt <= 0) {
              aposentarItemC(itmObj)
              continue
            }

            var numControlePncp = cItemProcessando.numeroControlePNCP
            var urlOrig = 'https://pncp.gov.br/app/editais/' + cnpjC + '/' + anoC + '/' + seqC
            // Mesma identidade canônica do adapter ao vivo; compra isolada não identifica o item.
            var sequencialResultado = registroPreco.sequencialResultado || ''
            var fornecedorIdentidade = String(registroPreco.niFornecedor || forCnpj || '').replace(
              /\D/g,
              '',
            )
            var identidadeItem =
              /^\d{14}$/.test(String(cnpjC)) &&
              Number(anoC) > 0 &&
              Number(seqC) > 0 &&
              numItemInt > 0
                ? cnpjC +
                  '/' +
                  Number(anoC) +
                  '/' +
                  Number(seqC) +
                  '/itens/' +
                  numItemInt +
                  (sequencialResultado ? '/resultados/' + sequencialResultado : '') +
                  (fornecedorIdentidade ? '/fornecedor/' + fornecedorIdentidade : '')
                : ''

            var amPncp = {
              source: 'PNCP',
              source_record_id: identidadeItem,
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
              valor_unitario: vUnitFinal,
              valor_total: Number(
                registroPreco.valorTotalHomologado || registroPreco.valorTotal || 0,
              ),
              natureza_preco: nat,
              data_referencia: registroPreco.dataResultado || '',
              numero_processo: numControlePncp,
              numero_ata: '',
              modalidade: 'Pregão Eletrônico',
              situacao_contratacao: nat === 'homologado' ? 'Homologada' : '',
              marca: itmObj.marcaNome || 'NÃO INFORMADO',
              modelo: 'NÃO INFORMADO',
              codigo_item: extrairCodigoItemWorker(itmObj),
              url_original: urlOrig,
              matching_score: calcularDiceScoreWorker(tokens, extractWorkerTokensUtil(dItem)),
              matching_tipo: 'texto_normalizado',
              raw_payload: {
                relacao_documental:
                  cItemProcessando._pendente && cItemProcessando._pendente._pncp_compra,
                numeroControlePNCP: numControlePncp,
                numeroItem: numItemInt,
                tipo_documento: cItemProcessando._tipoDoc || 'ata',
                quantidade_informada: qItem > 0,
                proveniencia_preco: {
                  versao: 1,
                  status: urlEvidencia ? 'verificada' : 'nao_verificada',
                  fonte: 'PNCP',
                  campo_unitario: campoUnitario,
                  valor_unitario: vUnitFinal,
                  natureza: nat,
                  url_evidencia: urlEvidencia,
                  identidade: { cnpj: cnpjC, ano: anoC, sequencial: seqC, numeroItem: numItemInt },
                  registro_oficial: registroPreco,
                  data_oficial: registroPreco.dataResultado || '',
                  campo_data: registroPreco.dataResultado ? 'dataResultado' : '',
                },
              },
            }
            if (resultadoCapturadoEm) {
              amPncp.raw_payload.proveniencia_preco.resultado_capturado_em = resultadoCapturadoEm
              amPncp.raw_payload.proveniencia_preco.resultado_reutilizado = resultadoReutilizado
            }
            amPncp.sample_key = gerarSampleKeyUtil(amPncp)
            // The old batch also saved each sample individually. Confirm that same save
            // before retiring this item, with one collection lookup per task.
            if (!colecaoAmostrasCiclo)
              colecaoAmostrasCiclo = $app.findCollectionByNameOrId('price_samples_index')
            var salvoItemC = persistirLoteAmostrasProgressivo([amPncp], colecaoAmostrasCiclo)
            amostrasInseridasTotal += salvoItemC.inseridas
            amostrasAtualizadasTotal += salvoItemC.atualizadas
            if (salvoItemC.falhou) {
              errosAcumulados.push(
                'PNCP amostra ' +
                  cacheKeyC +
                  '/' +
                  numItemInt +
                  ': falha ao persistir; item mantido pendente',
              )
              break
            }
            if (modoHttp && salvoItemC.inseridas + salvoItemC.atualizadas > 0) {
              totalAmostrasHttp++
              // Public index source DTO only; no task, claim, auth or arbitrary Record export.
              if (amostrasHttp.length < 50)
                amostrasHttp.push({
                  sample_key: amPncp.sample_key,
                  fonte: 'PNCP',
                  source_record_id: amPncp.source_record_id,
                  item_id: amPncp.item_id,
                  descricao: amPncp.descricao,
                  descricao_normalizada: amPncp.descricao_normalizada,
                  orgao: amPncp.orgao,
                  orgao_cnpj: amPncp.orgao_cnpj,
                  fornecedor_nome: amPncp.fornecedor_nome,
                  fornecedor_cnpj: amPncp.fornecedor_cnpj,
                  fornecedor_porte: amPncp.fornecedor_porte,
                  uf: amPncp.uf,
                  municipio: amPncp.municipio,
                  unidade: amPncp.unidade,
                  quantidade: amPncp.quantidade,
                  valor_unitario: amPncp.valor_unitario,
                  valor_total: amPncp.valor_total,
                  natureza_preco: amPncp.natureza_preco,
                  data_referencia: amPncp.data_referencia,
                  numero_processo: amPncp.numero_processo,
                  modalidade: amPncp.modalidade,
                  marca: amPncp.marca,
                  codigo_item: amPncp.codigo_item,
                  url_original: amPncp.url_original,
                  matching_score: amPncp.matching_score,
                  matching_tipo: amPncp.matching_tipo,
                  raw_payload: amPncp.raw_payload,
                })
            }
            aposentarItemC(itmObj)
          }

          pncpPersistResults(cacheKeyC, novosResultadosC)
          itensTotal += aposentadosC
          if (aposentadosC < itensArrC.length) {
            if (trabalhoPaginaC) {
              trabalhoPaginaC = Object.assign({}, trabalhoPaginaC, {
                refs: refsTrabalhoC.slice(aposentadosC),
              })
              pendentesRestantes.push(pendenteAtualC(null, trabalhoPaginaC))
            } else pendentesRestantes.push(pendenteAtualC(cacheItemOffsetC + aposentadosC, null))
          } else {
            var proximoOffsetC = trabalhoPaginaC
              ? Number(trabalhoPaginaC.proximo_i) || 0
              : cacheSliceBaseC !== null && cacheSliceBaseC + aposentadosC < cacheTodosC.length
                ? cacheSliceBaseC + aposentadosC
                : 0
            if (proximoOffsetC > 0) pendentesRestantes.push(pendenteAtualC(proximoOffsetC, null))
            else if (cachePrefixExaminedC < cacheTodosC.length)
              pendentesRestantes.push(pendenteAtualC(cachePrefixExaminedC, null))
            else if (!cacheCompletoC) pendentesRestantes.push(pendenteAtualC(null, null))
          }
        }
      }

      // Salva progresso da tarefa
      var agoraFinal = new Date().toISOString()
      try {
        $app.runInTransaction(function (txApp) {
          var taskRecFinal = txApp.findRecordById('price_index_tasks', tarefaAdquirida.id)
          if (!possuiClaimWorker(taskRecFinal)) return
          var pendentesAtuais = parseJsonWorkerSafe(taskRecFinal.getString('pendentes'))
          if (!Array.isArray(pendentesAtuais)) pendentesAtuais = []
          var recibosFinal = pncpReceiptRecords(taskRecFinal.getString('erros'))
          pendentesAtuais = pendentesAtuais.filter(function (p) {
            return !pncpSuperseded(p, recibosFinal)
          })
          pendentesRestantes = pendentesRestantes.filter(function (p) {
            return !pncpSuperseded(p, recibosFinal)
          })
          var posicoesPendentes = {}
          pendentesRestantes = pendentesRestantes.filter(function (p) {
            return !p._pncp_discovery
          })
          for (var posI = 0; posI < pendentesRestantes.length; posI++) {
            posicoesPendentes[chavePendenteWorker(pendentesRestantes[posI])] = posI
          }
          for (var atualI = 0; atualI < pendentesAtuais.length; atualI++) {
            var atualP = pendentesAtuais[atualI]
            if (atualP._pncp_discovery) {
              if (JSON.stringify(atualP._pncp_discovery) !== marcadorAdquirido) {
                var esgotadosAtuais = atualP._pncp_discovery.esgotados || {}
                for (var docAtual in esgotadosAtuais) {
                  if (esgotadosAtuais[docAtual]) descobertaPncp.esgotados[docAtual] = true
                }
              }
              continue
            }
            var chaveAtual = chavePendenteWorker(atualP)
            if (pendentesAdquiridosPorChave[chaveAtual] === JSON.stringify(atualP)) continue
            var posAtual = posicoesPendentes[chaveAtual]
            if (posAtual === undefined) {
              posicoesPendentes[chaveAtual] = pendentesRestantes.length
              pendentesRestantes.push(atualP)
            } else {
              var localP = pendentesRestantes[posAtual]
              pendentesRestantes[posAtual] = Object.assign({}, atualP, localP, {
                i: Math.max(Number(atualP.i) || 0, Number(localP.i) || 0),
                r: Math.max(Number(atualP.r) || 0, Number(localP.r) || 0),
              })
            }
          }
          var possuiCompraAcionavel = pendentesRestantes.some(function (p) {
            return pncpActionable(p)
          })
          // Preserva descoberta encerrada entre páginas de compras ainda acionáveis.
          if (
            (source === 'AMBAS' || source.indexOf('PNCP') !== -1) &&
            (possuiCompraAcionavel ||
              !(
                descobertaPncp.esgotados.ata &&
                descobertaPncp.esgotados.edital &&
                descobertaPncp.esgotados.contrato
              ))
          ) {
            pendentesRestantes.push({ _pncp_discovery: descobertaPncp })
          }
          var possuiTrabalhoAcionavel = pendentesRestantes.some(function (p) {
            if (p._pncp_discovery) {
              var esgotados = p._pncp_discovery.esgotados || {}
              return !(esgotados.ata && esgotados.edital && esgotados.contrato)
            }
            return pncpActionable(p)
          })
          var statusFinal = possuiTrabalhoAcionavel
            ? 'pending'
            : pendentesRestantes.length > 0
              ? 'failed'
              : 'completed'
          taskRecFinal.set('status', statusFinal)
          taskRecFinal.set('pendentes', JSON.stringify(pendentesRestantes))
          taskRecFinal.set(
            'paginas_consultadas',
            Math.max(paginasTotal, Number(taskRecFinal.getInt('paginas_consultadas')) || 0),
          )
          taskRecFinal.set(
            'itens_processados',
            (Number(taskRecFinal.getInt('itens_processados')) || 0) +
              itensTotal -
              tarefaAdquirida.itens_processados,
          )
          taskRecFinal.set(
            'amostras_inseridas',
            (Number(taskRecFinal.getInt('amostras_inseridas')) || 0) +
              amostrasInseridasTotal -
              tarefaAdquirida.amostras_inseridas,
          )
          taskRecFinal.set(
            'amostras_atualizadas',
            (Number(taskRecFinal.getInt('amostras_atualizadas')) || 0) +
              amostrasAtualizadasTotal -
              tarefaAdquirida.amostras_atualizadas,
          )
          var historyFinal = pncpErrors(taskRecFinal.getString('erros'))
          for (var errI = 0; errI < errosAcumulados.length; errI++)
            if (historyFinal.indexOf(errosAcumulados[errI]) < 0)
              historyFinal.push(errosAcumulados[errI])
          taskRecFinal.set('erros', JSON.stringify(historyFinal))
          taskRecFinal.set('ultimo_erro', errosAcumulados.join('; ').slice(0, 500))
          if (
            descobertaAvancouWorker ||
            itensTotal > tarefaAdquirida.itens_processados ||
            amostrasInseridasTotal > tarefaAdquirida.amostras_inseridas ||
            amostrasAtualizadasTotal > tarefaAdquirida.amostras_atualizadas
          )
            taskRecFinal.set('progress_at', agoraFinal)
          taskRecFinal.set('finished_at', agoraFinal)
          txApp.save(taskRecFinal)
        })
      } catch (errFinalTask) {
        // Do not print the raw exception: DB messages may contain serialized source data.
        var tipoErroFinal = errFinalTask && String(errFinalTask.name || '')
        if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(tipoErroFinal)) tipoErroFinal = 'Error'
        console.log(
          '[PRICE-WORKER] PRICE_WORKER_TASK_FINALIZE_FAILED task=' +
            String(tarefaAdquirida.id).slice(0, 80) +
            ' error=' +
            tipoErroFinal +
            ' detalhe=transacao_final_nao_confirmada',
        )
      }
    }

    // An HTTP request ends here, without watermark or sync-log collection work.
    if (modoHttp) {
      try {
        var persistidaHttp = $app.findRecordById('price_index_tasks', tarefaIdHttp)
        var statusHttp = persistidaHttp.getString('status')
        return e.json(200, {
          sucesso: true,
          took_ms: new Date().getTime() - tInicioCiclo,
          processadas: tarefasProcessadasNesteTick,
          resultado: {
            tarefa_id: persistidaHttp.id,
            termo: persistidaHttp.getString('termo'),
            status: statusHttp,
            fonte_processada: 'PNCP',
            cobertura_fontes: 'nao_certificada',
            cobertura_parcial: statusHttp !== 'completed',
            amostras: amostrasHttp,
            amostras_total_turno: totalAmostrasHttp,
            amostras_retornadas: amostrasHttp.length,
            amostras_resposta_parcial: totalAmostrasHttp > amostrasHttp.length,
            paginas_consultadas: Number(persistidaHttp.getInt('paginas_consultadas')) || 0,
            itens_processados: Number(persistidaHttp.getInt('itens_processados')) || 0,
            amostras_inseridas: Number(persistidaHttp.getInt('amostras_inseridas')) || 0,
            amostras_atualizadas: Number(persistidaHttp.getInt('amostras_atualizadas')) || 0,
            aviso:
              statusHttp === 'pending'
                ? 'Turno PNCP parcial; trabalho restante preservado na fila.'
                : statusHttp === 'running'
                  ? 'Tarefa em execução; claim ativo preservado.'
                  : 'Estado persistido do trabalho PNCP; não certifica cobertura de Compras.gov.br.',
          },
        })
      } catch (_) {
        return e.json(500, { sucesso: false, error: 'TASK_STATUS_READ_FAILED' })
      }
    }

    // =========================================================================
    // PARTE 2: Ciclo de Coleta Incremental por Watermark (PNCP e Compras.gov.br)
    // Permite sincronização contínua que sobrevive a reinicializações.
    // =========================================================================
    if (!trabalhoAdiadoPorTempo && new Date().getTime() < fimTrabalhoRede) {
      try {
        var wms = $app.findRecordsByFilter('price_watermarks', '', '+updated', 2, 0)
        for (var wIdx = 0; wIdx < wms.length; wIdx++) {
          if (trabalhoAdiadoPorTempo || new Date().getTime() >= fimTrabalhoRede) break
          var wmRec = wms[wIdx]
          var fName = wmRec.getString('fonte')
          var lastDateStr = wmRec.getString('last_watermark_date') || '2026-01-01'
          var lastPage = Number(wmRec.getInt('last_cursor_page')) || 1
          var falhasConsecutivas = Number(wmRec.getInt('tentativas_consecutivas_falha')) || 0

          // Se houver falhas consecutivas, aplica backoff pulando ciclos
          if (falhasConsecutivas > 3 && Math.random() > 0.3) {
            continue
          }

          var novasAmostrasWm = []
          var syncOk = false
          var syncErro = ''

          if (fName === 'PNCP') {
            // Varredura proativa contínua do PNCP por paginação de atas públicas
            // O endpoint /api/search do PNCP aceita q, tipos_documento, pagina e tam_pagina
            var urlPncpWm =
              'https://pncp.gov.br/api/search/?q=*&tipos_documento=ata&pagina=' +
              lastPage +
              '&tam_pagina=20'
            var resPncpWm = sendHttpWithRetryUtil(urlPncpWm, 4.0, 1, 100)
            if (resPncpWm.deferred) break
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
            // Coleta incremental Compras.gov.br guiada pelas tarefas ativas em price_index_tasks
            // JAMAIS por código fixo hardcoded.
            var tarefaAtivaCgov = null
            try {
              var tarefasAtivas = $app.findRecordsByFilter(
                'price_index_tasks',
                "status = 'pending' || status = 'running'",
                '+created',
                1,
                0,
              )
              if (tarefasAtivas && tarefasAtivas.length > 0) {
                tarefaAtivaCgov = tarefasAtivas[0]
              }
            } catch (_) {}

            if (tarefaAtivaCgov) {
              var termoAtivoCgov = (tarefaAtivaCgov.getString('termo') || '').trim()
              var termoNormCgov = canonicalNormWorkerText(termoAtivoCgov)

              // Resolução DINÂMICA de códigos CATMAT/CATSER sem nenhuma lista hardcoded.
              var codigosCatmatAtivos = []
              if (/^\d{4,8}$/.test(termoAtivoCgov)) {
                codigosCatmatAtivos = [termoAtivoCgov]
              } else if (termoNormCgov.length >= 3) {
                try {
                  // Consulta dinâmica ao catálogo do Compras.gov.br para materiais
                  var urlCatMat =
                    'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
                    encodeURIComponent(termoAtivoCgov) +
                    '&pagina=1&tamanhoPagina=500'
                  var resCatMat = sendHttpWithRetryUtil(urlCatMat, 3.5, 1)
                  if (resCatMat.ok && resCatMat.resp) {
                    var bCatMat = parseJsonWorkerSafe(resCatMat.resp.json || resCatMat.resp.raw)
                    var itensCatMat = bCatMat
                      ? Array.isArray(bCatMat)
                        ? bCatMat
                        : bCatMat.resultado || bCatMat.items || []
                      : []
                    var seenCodes = {}
                    for (var cmI = 0; cmI < itensCatMat.length; cmI++) {
                      var codM = String(
                        itensCatMat[cmI].codigoItemCatalogo ||
                          itensCatMat[cmI].codigoItem ||
                          itensCatMat[cmI].codigoMaterial ||
                          '',
                      ).trim()
                      if (codM && /^\d+$/.test(codM) && !seenCodes[codM]) {
                        seenCodes[codM] = true
                        codigosCatmatAtivos.push(codM)
                      }
                    }
                  }
                } catch (_) {}

                // Se não encontrou materiais ou for potencialmente serviço, consulta serviços (CATSER)
                if (codigosCatmatAtivos.length === 0) {
                  try {
                    var urlCatSer =
                      'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?descricaoItem=' +
                      encodeURIComponent(termoAtivoCgov) +
                      '&pagina=1&tamanhoPagina=500'
                    var resCatSer = sendHttpWithRetryUtil(urlCatSer, 3.5, 1)
                    if (resCatSer.ok && resCatSer.resp) {
                      var bCatSer = parseJsonWorkerSafe(resCatSer.resp.json || resCatSer.resp.raw)
                      var itensCatSer = bCatSer
                        ? Array.isArray(bCatSer)
                          ? bCatSer
                          : bCatSer.resultado || bCatSer.items || []
                        : []
                      var seenCodesSer = {}
                      for (var csI = 0; csI < itensCatSer.length; csI++) {
                        var codS = String(
                          itensCatSer[csI].codigoItemCatalogo ||
                            itensCatSer[csI].codigoItem ||
                            itensCatSer[csI].codigoServico ||
                            '',
                        ).trim()
                        if (codS && /^\d+$/.test(codS) && !seenCodesSer[codS]) {
                          seenCodesSer[codS] = true
                          codigosCatmatAtivos.push(codS)
                        }
                      }
                    }
                  } catch (_) {}
                }
              }

              var urlCgovWm = ''
              var catmatUsado = ''
              if (codigosCatmatAtivos.length > 0) {
                var catIdx = (lastPage - 1) % codigosCatmatAtivos.length
                catmatUsado = codigosCatmatAtivos[catIdx]
                var paginaCat = Math.floor((lastPage - 1) / codigosCatmatAtivos.length) + 1
                urlCgovWm =
                  'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
                  catmatUsado +
                  '&pagina=' +
                  paginaCat +
                  '&tamanhoPagina=20'
              } else if (termoNormCgov.length >= 3) {
                urlCgovWm =
                  'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
                  encodeURIComponent(termoAtivoCgov) +
                  '&pagina=' +
                  lastPage +
                  '&tamanhoPagina=20'
              }

              if (urlCgovWm) {
                var resCgovWm = sendHttpWithRetryUtil(urlCgovWm, 3.5, 1)
                if (resCgovWm.deferred) break
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
                    var tokensTermoAtivo = extractWorkerTokensUtil(termoNormCgov)
                    for (var cgI = 0; cgI < itemsCgov.length; cgI++) {
                      var itCg = itemsCgov[cgI]
                      var vUnitCg =
                        Number(
                          itCg.precoUnitarioHomologado || itCg.valorUnitario || itCg.precoUnitario,
                        ) || 0
                      if (vUnitCg > 0) {
                        var descCg = itCg.descricaoItem || itCg.descricao || 'Item Compras.gov.br'
                        var descNormCg = canonicalNormWorkerText(descCg)
                        var tokensDescCg = extractWorkerTokensUtil(descNormCg)

                        // Validação anti-contaminação no watermark: deve haver coerência textual
                        // ou pertinência ao CATMAT do termo ativo
                        var temAderencia = false
                        if (catmatUsado) {
                          temAderencia = true
                        } else {
                          var diceW = calcularDiceScoreWorker(tokensTermoAtivo, tokensDescCg)
                          temAderencia = diceW > 15
                        }

                        if (!temAderencia) continue

                        var amCgovObj = {
                          source: 'Compras.gov.br',
                          source_record_id: String(itCg.id || itCg.codigoItem || 'CG-' + cgI),
                          purchase_id: String(itCg.id || itCg.codigoItem || 'CG-' + cgI),
                          item_id: String(itCg.numeroItem || '1'),
                          descricao: descCg,
                          descricao_normalizada: descNormCg,
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
                          quantidade: Number(itCg.quantidade) > 0 ? Number(itCg.quantidade) : 0,
                          valor_unitario: Number(vUnitCg.toFixed(4)),
                          valor_total:
                            Number(itCg.quantidade) > 0
                              ? Number((vUnitCg * Number(itCg.quantidade)).toFixed(4))
                              : Number(itCg.valorTotal) > 0
                                ? Number(Number(itCg.valorTotal).toFixed(4))
                                : 0,
                          natureza_preco: 'homologado',
                          data_referencia: itCg.dataCompra || new Date().toISOString(),
                          numero_processo: itCg.numeroProcesso || '',
                          modalidade: 'Pregão Eletrônico',
                          marca: itCg.marca || 'NÃO INFORMADO',
                          codigo_item: catmatUsado
                            ? 'CATMAT ' + catmatUsado
                            : extrairCodigoItemWorker(itCg),
                          url_original: itCg.linkEditalOuCompra || '',
                          matching_score: 100,
                          matching_tipo: catmatUsado
                            ? 'codigo_oficial_catmat'
                            : 'texto_normalizado',
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
              } else {
                // Sem termo/código para a tarefa atual, marca como ok para não gerar falha espúria
                syncOk = true
              }
            } else {
              // Nenhuma tarefa ativa no momento: watermark fica em idle sem consultar código fixo
              syncOk = true
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
    // Diagnóstico local do callback; não é uma avaliação da saúde dos endpoints/fontes.
    try {
      var colSync = $app.findCollectionByNameOrId('sync_logs')
      var recSync = new Record(colSync)
      recSync.set('fonte_id', 'r06he9bmdrb3yus')
      recSync.set('status', 'sucesso')
      recSync.set(
        'detalhes',
        JSON.stringify({
          evento: 'PRICE_WORKER_TICK_LOCAL',
          callback_finalizado: true,
          turnos_tarefa_executados: tarefasProcessadasNesteTick,
          duracao_ms: new Date().getTime() - tInicioCiclo,
          health_endpoints: 'nao_avaliado',
        }),
      )
      $app.save(recSync)
    } catch (errDiagLocal) {
      console.log('[PRICE-WORKER-CRON] Falha ao registrar diagnóstico local:', errDiagLocal.message)
    }
  },
  $apis.requireAuth(),
)

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
    // Campos legados mantidos como null: stats não executa sondagens nem escreve logs.

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
