// Endpoint de proxy e detalhamento seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts e extração real de preços unitários.
// DIRETRIZES FUNDAMENTAIS:
// 1. ELIMINADA toda lógica que recorre a valores totais/globais da contratação, divisão genérica ou amostra sintética do cabeçalho.
//    O valor global de uma contratação NÃO é preço unitário de cada item/medicamento.
// 2. Identificação correta de CNPJ do órgão, ano, sequencial e número do item.
// 3. Reutiliza itens/preços oficiais do cache; o worker consulta itens e /resultados ausentes.
// 4. Distinção rigorosa: homologado vs. estimado.
// 5. Preservação de preços baixos legítimos (< R$1,00, R$0,12, centavos).
// 6. Cache no pncp_item_cache e registro de contratações pendentes para detalhamento contínuo.

routerAdd(
  'GET',
  '/backend/v1/pncp/search',
  function (e) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
    var tInicioProxy = new Date().getTime()
    function consumeSourceRateLimit() {
      var now = new Date()
      var cutoff = new Date(now.getTime() - 60 * 1000).toISOString()
      var rows = arrayOf(new DynamicModel({ request_count: 0 }))
      try {
        $app
          .db()
          .newQuery(
            'INSERT INTO cotai_backend_rate_limits ' +
              '(user_id, route_key, window_started_at, request_count, updated_at) ' +
              "VALUES ({:user}, 'PNCP_SEARCH', {:now}, 1, {:now}) " +
              'ON CONFLICT(user_id, route_key) DO UPDATE SET ' +
              'window_started_at = CASE WHEN julianday(cotai_backend_rate_limits.window_started_at) <= julianday({:cutoff}) THEN excluded.window_started_at ELSE cotai_backend_rate_limits.window_started_at END, ' +
              'request_count = CASE WHEN julianday(cotai_backend_rate_limits.window_started_at) <= julianday({:cutoff}) THEN 1 ELSE cotai_backend_rate_limits.request_count + 1 END, ' +
              'updated_at = excluded.updated_at ' +
              'WHERE julianday(cotai_backend_rate_limits.window_started_at) <= julianday({:cutoff}) OR cotai_backend_rate_limits.request_count < 30 ' +
              'RETURNING request_count',
          )
          .bind({ user: String(e.auth.id), now: now.toISOString(), cutoff: cutoff })
          .all(rows)
        return { available: true, accepted: rows.length === 1 }
      } catch (_) {
        return { available: false, accepted: false }
      }
    }
    try {
      var query = e.requestInfo().query
      var q = (query.q || '').trim()
      var paginaRaw = query.pagina === undefined ? '1' : String(query.pagina)
      var tamPaginaRaw = query.tam_pagina === undefined ? '50' : String(query.tam_pagina)
      var paginaParam = /^\d+$/.test(paginaRaw) ? Number(paginaRaw) : 0
      var tamPaginaParam = /^\d+$/.test(tamPaginaRaw) ? Number(tamPaginaRaw) : 0
      var uf = (query.uf || '').trim().toUpperCase()

      var paginacaoTotal =
        (query.paginacao_total || '').toLowerCase() === 'true' ||
        (query.todas_paginas || '').toLowerCase() === 'true'
      var limiteRaw = query.limite_paginas === undefined ? '20' : String(query.limite_paginas)
      var limitePaginasSolicitado = /^\d+$/.test(limiteRaw) ? Number(limiteRaw) : 0

      var ufsValidas = {
        AC: true,
        AL: true,
        AP: true,
        AM: true,
        BA: true,
        CE: true,
        DF: true,
        ES: true,
        GO: true,
        MA: true,
        MT: true,
        MS: true,
        MG: true,
        PA: true,
        PB: true,
        PR: true,
        PE: true,
        PI: true,
        RJ: true,
        RN: true,
        RS: true,
        RO: true,
        RR: true,
        SC: true,
        SP: true,
        SE: true,
        TO: true,
      }
      if (
        !q ||
        q.length > 160 ||
        !Number.isSafeInteger(paginaParam) ||
        paginaParam < 1 ||
        paginaParam > 10000 ||
        !Number.isSafeInteger(tamPaginaParam) ||
        tamPaginaParam < 5 ||
        tamPaginaParam > 50 ||
        !Number.isSafeInteger(limitePaginasSolicitado) ||
        limitePaginasSolicitado < 1 ||
        limitePaginasSolicitado > 20 ||
        (uf && !ufsValidas[uf])
      ) {
        return e.json(400, {
          error: 'INVALID_PARAMETER',
          message: 'Parâmetros de busca inválidos ou fora dos limites permitidos.',
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

      // Shared envelope contract (duplicated inside each isolated PocketBase JSVM callback).
      // Source items stay untouched; only positive official /resultados evidence is reusable.
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
      // Callback-local by design: PocketBase may isolate every JSVM invocation.
      function issueOfficialReceipt(source, queryMaterial, claims) {
        if (!Array.isArray(claims) || claims.length < 1) return null
        if (claims.length > 500) throw new Error('RECEIPT_CLAIMS_TOO_LARGE')
        if (
          typeof $security === 'undefined' ||
          !$security ||
          typeof $security.sha256 !== 'function' ||
          typeof $security.randomString !== 'function'
        )
          throw new Error('RECEIPT_SECURITY_UNAVAILABLE')
        var now = new Date()
        var expires = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
        var queryHash = $security.sha256(pncpCanonical(queryMaterial)).toLowerCase()
        var token = $security.randomString(64)
        if (!/^[A-Za-z0-9]{32,128}$/.test(token) || !/^[0-9a-f]{64}$/.test(queryHash))
          throw new Error('RECEIPT_SECURITY_UNAVAILABLE')
        // Bounded opportunistic cleanup; never scans the whole private collection.
        try {
          var expired = $app.findRecordsByFilter(
            'official_ingestion_receipts',
            'expires_at <= {:now}',
            'expires_at',
            25,
            0,
            {
              now: now.toISOString().replace('T', ' '),
            },
          )
          for (var ex = 0; ex < expired.length; ex++) {
            var expirationTime = new Date(expired[ex].getString('expires_at')).getTime()
            if (isFinite(expirationTime) && expirationTime <= now.getTime())
              $app.delete(expired[ex])
          }
        } catch (_) {}
        var collection = $app.findCollectionByNameOrId('official_ingestion_receipts')
        var record = new Record(collection)
        record.set('token_hash', $security.sha256(token).toLowerCase())
        record.set('user_id', String(e.auth.id))
        record.set('source', source)
        record.set('query_hash', queryHash)
        record.set('claims', claims)
        record.set('expires_at', expires)
        $app.save(record)
        return {
          token: token,
          query_hash: queryHash,
          expires_at: expires,
          source: source,
          claim_count: claims.length,
        }
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
        var entries = Array.isArray(body)
          ? body
          : body && (body.items || body.data || body.resultado)
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
            if (isFinite(price) && price > 0)
              return { registro: row, campo: fields[f], valor: price }
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
        var entries = Array.isArray(envelope.corpo_oficial)
          ? envelope.corpo_oficial
          : envelope.corpo_oficial &&
            (envelope.corpo_oficial.items ||
              envelope.corpo_oficial.data ||
              envelope.corpo_oficial.resultado)
        if (!Array.isArray(entries)) return null
        var positive = pncpPositive(envelope.corpo_oficial)
        if (positive) {
          if (
            envelope.sem_homologado === true ||
            positive.campo !== envelope.campo_unitario ||
            positive.valor !== envelope.valor_unitario
          )
            return null
        } else if (
          envelope.sem_homologado !== true ||
          envelope.campo_unitario !== '' ||
          Number(envelope.valor_unitario) !== 0
        )
          return null
        for (var resultIndex = 0; resultIndex < entries.length; resultIndex++) {
          var resultEntry = entries[resultIndex]
          if (!resultEntry || typeof resultEntry !== 'object' || Array.isArray(resultEntry))
            continue
          var resultItem = resultEntry.numeroItem || resultEntry.numero_item
          if (resultItem != null && Number(resultItem) !== identity.numeroItem) return null
        }
        return envelope
      }
      function pncpResultEnvelope(identity, item, url, body, captured) {
        var positive = pncpPositive(body)
        var entries = Array.isArray(body)
          ? body
          : body && (body.items || body.data || body.resultado)
        if (!Array.isArray(entries)) return null
        var envelope = {
          versao: 1,
          identidade: identity,
          item_fingerprint: pncpCanonical(item),
          url_resultados: url,
          capturado_em: captured,
          corpo_oficial: body,
          campo_unitario: positive ? positive.campo : '',
          valor_unitario: positive ? positive.valor : 0,
          sem_homologado: !positive,
        }
        return pncpValidResult(envelope, identity, item, url)
      }
      function pncpPersistResults(cacheKey, additions) {
        if (!additions || Object.keys(additions).length === 0) return
        try {
          $app.runInTransaction(function (txApp) {
            var current = txApp.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
            if (current.getString('server_trust_version') !== 'server-v1') return
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
                if (
                  !pncpValidResult(candidate, candidate.identidade, item, candidate.url_resultados)
                )
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

      var paramTipoDoc = String(
        query.tipos_documento || query.tipo_documento || query.tipo || '',
      ).trim()
      if (paramTipoDoc.length > 64) {
        return e.json(400, {
          error: 'INVALID_PARAMETER',
          message: 'Tipos de documento PNCP excedem o limite permitido.',
        })
      }
      var tiposDocumentos = paramTipoDoc
        ? paramTipoDoc
            .split(',')
            .map(function (s) {
              return s.trim().toLowerCase()
            })
            .filter(Boolean)
        : ['ata', 'edital', 'contrato']
      if (tiposDocumentos.length === 0) tiposDocumentos = ['ata', 'edital', 'contrato']
      if (tiposDocumentos.length > 3) {
        return e.json(400, {
          error: 'INVALID_PARAMETER',
          message: 'Informe no máximo três tipos de documento PNCP.',
        })
      }
      var tiposPermitidos = { ata: true, edital: true, contrato: true }
      var tiposUnicos = []
      for (var tipoIndex = 0; tipoIndex < tiposDocumentos.length; tipoIndex++) {
        var tipoAtual = tiposDocumentos[tipoIndex]
        if (!tiposPermitidos[tipoAtual]) {
          return e.json(400, {
            error: 'INVALID_PARAMETER',
            message: 'Tipo de documento PNCP inválido.',
          })
        }
        if (tiposUnicos.indexOf(tipoAtual) < 0) tiposUnicos.push(tipoAtual)
      }
      tiposDocumentos = tiposUnicos

      var sourceRate = consumeSourceRateLimit()
      if (!sourceRate.available)
        return e.json(503, { sucesso: false, error: 'SOURCE_RATE_LIMIT_UNAVAILABLE' })
      if (!sourceRate.accepted)
        return e.json(429, {
          sucesso: false,
          error: 'SOURCE_RATE_LIMITED',
          retry_after_seconds: 60,
        })

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
      var descobertaParcial = diagLogs.paginas_recebidas < tiposDocumentos.length

      // Paginação complementar se solicitada
      if (paginacaoTotal && maxTotalPaginas > 1 && paginaParam === 1) {
        var paginaFinalAlvo = Math.min(maxTotalPaginas, limitePaginasSolicitado)

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
                } catch (_) {
                  descobertaParcial = true
                }
              } else {
                descobertaParcial = true
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
        if (paginaAtualLoop <= paginaFinalAlvo) descobertaParcial = true
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
          detalhamento_paralelo: {
            total_processado: 0,
            sucessos: 0,
            fila_retry: 0,
            cobertura_parcial: descobertaParcial,
            descoberta_parcial: descobertaParcial,
            itens_pendentes: 0,
            itens_fila_pendente: 0,
            fila_persistida: null,
            erro_fila: null,
          },
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
        // Embalagem descrita não substitui a unidade oficial nem preenche sua ausência.
        return typeof uBruta === 'string' && uBruta.trim() ? uBruta : 'NÃO INFORMADO'
      }

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
        var linkedText = '',
          linked = null
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
        var linkedFields = [
          'numeroControlePncpCompra',
          'numeroControlePNCPCompra',
          'numero_contratacao',
        ]
        for (var linkedIndex = 0; linkedIndex < linkedFields.length; linkedIndex++) {
          var linkedValue = it[linkedFields[linkedIndex]]
          if (linkedValue === null || linkedValue === undefined) continue
          var parsedLink = pncpControl(linkedValue, 1)
          if (!parsedLink) {
            reason = 'controle_compra_invalido'
            continue
          }
          if (linked && linked.controle !== parsedLink.controle)
            reason = 'controles_compra_conflitantes'
          else {
            linked = parsedLink
            linkedText = linkedValue
          }
        }
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
        if (it.anoCompra !== null && it.anoCompra !== undefined) {
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
          if (sequenceValue === null || sequenceValue === undefined) continue
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
            else
              buy = pncpControl(pncpControlOf(route[1], Number(route[2]), Number(route[3]), 1), 1)
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
              return pncpControl(r.documentControl, 2) && pncpControl(r.purchaseControl, 1)
                ? r
                : null
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

      function extrairParametrosCompra(entryObj) {
        return pncpResolveDocument(
          entryObj,
          entryObj.tipo_documento,
          'https://pncp.gov.br/api/search/',
        )
      }

      var catmatQueryParam = (query.catmat || '').trim()
      var codigosCatmatValidos = {}
      if (catmatQueryParam) {
        catmatQueryParam.split(',').forEach(function (c) {
          var cClean = c.trim()
          if (cClean) codigosCatmatValidos[cClean] = true
        })
      }
      // Sem listas hardcoded de termos: resolução genérica por tokens e catálogo oficial
      var qNormUpper = canonicalNormalize(q)
      if (/^\d{4,8}$/.test(q.trim())) {
        codigosCatmatValidos[q.trim()] = true
      }

      var qTokens = extractTokens(q)
      var tokenPrincipal = qTokens.length > 0 ? qTokens[0] : ''
      var tokenPrincipalStem = stemToken(tokenPrincipal)

      // Filtra itens compatíveis com o termo - Sem exclusões automáticas por unidade de serviço ou regras restritivas específicas
      function itemEhCompativel(descItem, unidade, codigoItem) {
        if (!descItem || !descItem.trim()) return false

        var descNorm = canonicalNormalize(descItem)

        // Se casou com código oficial de catálogo, aceita
        var codItemLimpo = String(codigoItem || '').replace(/\D/g, '')
        if (codItemLimpo && codigosCatmatValidos[codItemLimpo]) {
          return true
        }

        if (!tokenPrincipal) return true
        // Correspondência textual em qualquer posição
        if (
          descNorm.indexOf(tokenPrincipal) !== -1 ||
          descNorm.indexOf(tokenPrincipalStem) !== -1
        ) {
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
      function processarItensDaContratacao(entryObj, itensArray, pCompra, resultadosPositivos) {
        if (!itensArray || itensArray.length === 0) return false

        function campoPositivo(registro, campos) {
          for (var c = 0; c < campos.length; c++) {
            var valor = Number(registro[campos[c]])
            if (isFinite(valor) && valor > 0) return campos[c]
          }
          return ''
        }

        function valorTextoPncp() {
          for (var valueIndex = 0; valueIndex < arguments.length; valueIndex++) {
            var value = arguments[valueIndex]
            if (value !== null && value !== undefined && String(value).trim())
              return String(value).trim()
          }
          return ''
        }

        function codigoCatalogoPncp(item, parent) {
          function fromOwner(owner) {
            var candidates = [
              owner.codigo_catalogo,
              owner.codigoCatalogo,
              owner.catalogoCodigoItem,
              owner.codigoItem,
              owner.codigoMaterialOuServico,
            ]
            var kind = valorTextoPncp(owner.materialOuServico, owner.tipoCatalogo)
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toUpperCase()
            for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
              var raw = String(candidates[candidateIndex] || '').trim()
              var explicit = /\b(CATMAT|CATSER)\s*[:#-]?\s*(\d{4,8})\b/i.exec(raw)
              if (explicit) return explicit[1].toUpperCase() + ' ' + explicit[2]
              var number = /\b(\d{4,8})\b/.exec(raw)
              if (!number) continue
              if (kind === 'S' || kind.indexOf('SERVIC') !== -1) return 'CATSER ' + number[1]
              if (kind === 'M' || kind.indexOf('MATERIAL') !== -1) return 'CATMAT ' + number[1]
            }
            return ''
          }
          var itemCode = fromOwner(item)
          if (itemCode) return itemCode
          var parentCode = fromOwner(parent)
          if (parentCode) return parentCode
          return ''
        }

        var matchedItens = itensArray.filter(function (it) {
          var d = it.descricao || it.materialOuServicoNome || ''
          var u = it.unidadeMedida || it.unidade || ''
          var cod = it.catalogoCodigoItem || it.codigoItem || it.codigoMaterialOuServico || ''
          return itemEhCompativel(d, u, cod)
        })

        if (matchedItens.length === 0) {
          entryObj.itensAta = []
          return false
        }

        var subItensValidos = []
        var subItensVistos = {}
        var novosResultados = {}

        for (var mIdx = 0; mIdx < matchedItens.length; mIdx++) {
          var it = matchedItens[mIdx]
          var numItem = it.numeroItem || it.numero_item
          var numItemInt = parseInt(numItem, 10) || 0

          var campoFallback = campoPositivo(it, [
            'valorUnitarioHomologado',
            'valor_unitario_homologado',
            'valorUnitarioEstimado',
            'valor_unitario_estimado',
            'valorUnitario',
            'valor_unitario',
          ])
          var valorFallback = campoFallback ? Number(it[campoFallback]) : 0
          var naturezaFallback = /homologado/i.test(campoFallback) ? 'homologado' : 'estimado'
          var urlItem =
            pCompra.cnpj && pCompra.ano && pCompra.sequencial && numItemInt > 0
              ? 'https://pncp.gov.br/api/pncp/v1/orgaos/' +
                pCompra.cnpj +
                '/compras/' +
                pCompra.ano +
                '/' +
                pCompra.sequencial +
                '/itens/' +
                numItemInt
              : ''
          var resultadoCapturadoEm = ''
          var resultadoReutilizado = false
          var resultadosHomologados = []
          var cacheResultado = null

          // O proxy interativo continua cache-only, mas todo item consulta logicamente
          // /resultados. Cache ausente/expirado é trabalho pendente, nunca prova de ausência.
          if (urlItem) {
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
            var identidadeResultado = {
              cnpj: pCompra.cnpj,
              ano: Number(pCompra.ano),
              sequencial: Number(pCompra.sequencial),
              numeroItem: numItemInt,
            }
            var chaveResultado = pncpResultKey(identidadeResultado)
            cacheResultado = pncpValidResult(
              resultadosPositivos && resultadosPositivos[chaveResultado],
              identidadeResultado,
              it,
              urlRes,
            )
            if (!cacheResultado) entryObj._resultados_pendentes = true
            if (cacheResultado) {
              try {
                var bodyRes = cacheResultado.corpo_oficial
                resultadoCapturadoEm = cacheResultado.capturado_em
                resultadoReutilizado = true
                var arrRes = extractRawItems(bodyRes)
                for (var rIdx = 0; rIdx < arrRes.length; rIdx++) {
                  var rItem = arrRes[rIdx]
                  if (!rItem || typeof rItem !== 'object' || Array.isArray(rItem)) continue
                  var campoResultado = campoPositivo(rItem, [
                    'valorUnitarioHomologado',
                    'valor_unitario_homologado',
                    'valorUnitario',
                    'valor_unitario',
                  ])
                  if (!campoResultado) continue
                  var fornecedorResultado = String(
                    rItem.niFornecedor || rItem.cnpj || rItem.cpfCnpjFornecedor || '',
                  ).replace(/\D/g, '')
                  var sequencialResultado = Number(rItem.sequencialResultado)
                  if (
                    !fornecedorResultado ||
                    !isFinite(sequencialResultado) ||
                    sequencialResultado <= 0
                  )
                    continue
                  resultadosHomologados.push({
                    campo: campoResultado,
                    valor: Number(rItem[campoResultado]),
                    registro: rItem,
                    fornecedor: {
                      niFornecedor: fornecedorResultado,
                      nomeRazaoSocialFornecedor:
                        rItem.nomeRazaoSocialFornecedor || rItem.nomeFornecedor,
                    },
                    identidade: sequencialResultado + '_' + fornecedorResultado,
                  })
                }
              } catch (_) {}
            }
          }

          // Ausência de quantidade não autoriza inventar 1 nem calcular um preço unitário.
          var qItem = Number(it.quantidade) > 0 ? Number(it.quantidade) : 0
          var candidatosPreco = []
          if (resultadosHomologados.length > 0) candidatosPreco = resultadosHomologados
          else if (cacheResultado && campoFallback && isFinite(valorFallback) && valorFallback > 0)
            candidatosPreco.push({
              campo: campoFallback,
              valor: valorFallback,
              registro: it,
              fornecedor: it.fornecedor || entryObj.fornecedor || null,
              identidade: 'fallback_' + campoFallback,
              natureza: naturezaFallback,
            })

          // Sem resposta oficial válida de /resultados não se certifica uma estimativa.
          if (candidatosPreco.length === 0) {
            diagLogs.descartes_sem_preco_unitario++
            continue
          }

          var descItemTexto = it.descricao || it.materialOuServicoNome || ''
          var controle = pCompra._pncp_compra.controle
          for (var candidatoIdx = 0; candidatoIdx < candidatosPreco.length; candidatoIdx++) {
            var candidatoPreco = candidatosPreco[candidatoIdx]
            var registroPreco = candidatoPreco.registro
            var campoUnitario = candidatoPreco.campo
            var vUnit = Number(candidatoPreco.valor)
            var natPreco = candidatoPreco.natureza || 'homologado'
            var fornecedorFinal = candidatoPreco.fornecedor
            var urlEvidencia = natPreco === 'homologado' ? urlRes : urlItem
            var chaveDedup = controle + '_' + numItemInt + '_' + candidatoPreco.identidade
            if (subItensVistos[chaveDedup]) continue
            subItensVistos[chaveDedup] = true
            diagLogs.amostras_validas++
            if (vUnit < 1.0) {
              diagLogs.amostras_abaixo_1_real++
            }

            var identidadePreco = {
              cnpj: pCompra.cnpj,
              ano: pCompra.ano,
              sequencial: pCompra.sequencial,
              numeroItem: numItemInt,
            }
            if (natPreco === 'homologado') {
              identidadePreco.sequencialResultado = Number(registroPreco.sequencialResultado)
              identidadePreco.fornecedor = String(
                registroPreco.niFornecedor ||
                  registroPreco.cnpj ||
                  registroPreco.cpfCnpjFornecedor ||
                  '',
              ).replace(/\D/g, '')
            }
            subItensValidos.push({
              numeroItem: numItemInt,
              descricao: descItemTexto,
              materialOuServico: it.materialOuServico || entryObj.materialOuServico || '',
              materialOuServicoNome: it.materialOuServicoNome || '',
              codigoItem:
                it.catalogoCodigoItem || it.codigoItem || it.codigoMaterialOuServico || '',
              codigo_catalogo: codigoCatalogoPncp(it, entryObj),
              numeroControlePNCP: controle,
              orgao_comprador: valorTextoPncp(
                it.orgao_comprador,
                it.orgaoEntidade && it.orgaoEntidade.razaoSocial,
                entryObj.orgao_comprador,
                entryObj.orgaoEntidade && entryObj.orgaoEntidade.razaoSocial,
                entryObj.orgao_nome,
              ),
              orgao_cnpj: String(pCompra.cnpj || '').replace(/\D/g, ''),
              uf: valorTextoPncp(
                it.uf,
                it.unidadeOrgao && it.unidadeOrgao.ufSigla,
                entryObj.uf,
                entryObj.unidadeOrgao && entryObj.unidadeOrgao.ufSigla,
                entryObj.municipio_uf && String(entryObj.municipio_uf).split('-').pop(),
              ).toUpperCase(),
              municipio_nome: valorTextoPncp(
                it.municipio_nome,
                it.municipio,
                it.unidadeOrgao && it.unidadeOrgao.municipioNome,
                entryObj.municipio_nome,
                entryObj.municipio,
                entryObj.unidadeOrgao && entryObj.unidadeOrgao.municipioNome,
              ),
              processo_origem: valorTextoPncp(
                it.processo_origem,
                it.numeroProcesso,
                it.numero_processo,
                it.processo,
                entryObj.processo_origem,
                entryObj.numeroProcesso,
                entryObj.numero_processo,
                entryObj.processo,
                controle,
              ),
              modalidade_licitacao: valorTextoPncp(
                it.modalidade_licitacao,
                it.modalidadeNome,
                entryObj.modalidade_licitacao,
                entryObj.modalidadeNome,
              ),
              valorUnitarioHomologado: natPreco === 'homologado' ? vUnit : 0,
              valorUnitarioEstimado: natPreco === 'estimado' ? vUnit : 0,
              naturezaPreco: natPreco,
              dataResultado: registroPreco.dataResultado || '',
              proveniencia_preco: {
                relacao_documental: pCompra._pncp_compra,
                versao: 1,
                status: urlEvidencia ? 'verificada' : 'nao_verificada',
                fonte: 'PNCP',
                campo_unitario: campoUnitario,
                valor_unitario: vUnit,
                natureza: natPreco,
                url_evidencia: urlEvidencia,
                identidade: identidadePreco,
                registro_oficial: registroPreco,
                data_oficial: registroPreco.dataResultado || '',
                campo_data: registroPreco.dataResultado ? 'dataResultado' : '',
              },
              quantidade: qItem,
              unidadeMedida: extrairUnidadeQualificadaPncp(
                it.unidadeMedida || it.unidade,
                descItemTexto,
              ),
              marcaNome: it.marcaNome || 'NÃO INFORMADO',
              fornecedor: fornecedorFinal || entryObj.fornecedor || null,
            })
            if (resultadoCapturadoEm) {
              var provaResultado = subItensValidos[subItensValidos.length - 1].proveniencia_preco
              provaResultado.resultado_capturado_em = resultadoCapturadoEm
              provaResultado.resultado_reutilizado = resultadoReutilizado
            }
          }
        }

        pncpPersistResults(
          pCompra.cnpj + '_' + pCompra.ano + '_' + pCompra.sequencial,
          novosResultados,
        )
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
        if (p.reason) {
          entryItem._is_contratacao_sem_item = true
          entryItem._detalhamento_pendente = true
          entryItem.itensAta = []
          contratacoesNaoDetalhasParaFila.push(pncpRelationPending(p, entryItem))
          return
        }
        var ok = false
        var cacheCompleto = false

        if (p.cnpj && p.ano && p.sequencial) {
          var cacheKey = p.cnpj + '_' + p.ano + '_' + p.sequencial
          var arrItens = null
          var resultadosPositivos = {}

          // Tenta recuperar do cache persistente pncp_item_cache
          try {
            var cacheRec = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKey)
            if (cacheRec && cacheRec.getString('server_trust_version') !== 'server-v1')
              cacheRec = null
            if (cacheRec) {
              var rawCache = cacheRec.get('raw_itens')
              if (rawCache) {
                if (typeof rawCache === 'string') {
                  try {
                    arrItens = JSON.parse(rawCache)
                  } catch (_) {}
                } else if (typeof rawCache === 'object') {
                  arrItens = rawCache
                }
                if (arrItens && !Array.isArray(arrItens)) {
                  resultadosPositivos = arrItens.resultados_positivos || {}
                  var pagCache = arrItens.paginacao
                  cacheCompleto =
                    Array.isArray(arrItens.items) &&
                    pagCache &&
                    pagCache.versao === 1 &&
                    pagCache.tamanho_pagina === 50 &&
                    pagCache.completa === true
                  arrItens = Array.isArray(arrItens.items) ? arrItens.items : null
                }
                if (arrItens && arrItens.length > 0) {
                  cacheHits++
                }
              }
            }
          } catch (_) {}

          if (arrItens && arrItens.length > 0) {
            diagLogs.itens_detalhados += arrItens.length
            if (processarItensDaContratacao(entryItem, arrItens, p, resultadosPositivos)) {
              ok = true
              sucessosDetalhamento++
            }
          }
        }

        // Ausência de match não significa ausência de cobertura; parcial pode ter preços reais.
        if (!ok || !Array.isArray(entryItem.itensAta) || entryItem.itensAta.length === 0) {
          entryItem._is_contratacao_sem_item = true
          entryItem.itensAta = []
        }
        if (!cacheCompleto || entryItem._resultados_pendentes) {
          entryItem._detalhamento_pendente = true
          if (p.cnpj && p.ano && p.sequencial) {
            contratacoesNaoDetalhasParaFila.push({
              _pncp_compra: p._pncp_compra,
              cnpj: p.cnpj,
              ano: p.ano,
              sequencial: p.sequencial,
              orgao:
                (entryItem.orgaoEntidade && entryItem.orgaoEntidade.razaoSocial) ||
                entryItem.orgao_nome ||
                '',
              uf:
                entryItem.uf ||
                (entryItem.unidadeOrgao && entryItem.unidadeOrgao.ufSigla) ||
                (entryItem.municipio_uf ? entryItem.municipio_uf.split('-')[1] : '') ||
                uf ||
                '',
              municipio:
                entryItem.municipio_nome ||
                entryItem.municipio ||
                (entryItem.unidadeOrgao && entryItem.unidadeOrgao.municipioNome) ||
                '',
              numeroProcesso:
                entryItem.processo_origem ||
                entryItem.numeroProcesso ||
                entryItem.numero_processo ||
                entryItem.processo ||
                '',
              codigoCatalogo: (function () {
                var raw = String(
                  entryItem.codigo_catalogo ||
                    entryItem.codigoCatalogo ||
                    entryItem.catalogoCodigoItem ||
                    entryItem.codigoItem ||
                    entryItem.codigoMaterialOuServico ||
                    '',
                ).trim()
                var explicit = /\b(CATMAT|CATSER)\s*[:#-]?\s*(\d{4,8})\b/i.exec(raw)
                if (explicit) return explicit[1].toUpperCase() + ' ' + explicit[2]
                var numeric = /\b(\d{4,8})\b/.exec(raw)
                var kind = String(entryItem.materialOuServico || entryItem.tipoCatalogo || '')
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '')
                  .toUpperCase()
                if (!numeric) return ''
                if (kind === 'S' || kind.indexOf('SERVIC') !== -1) return 'CATSER ' + numeric[1]
                if (kind === 'M' || kind.indexOf('MATERIAL') !== -1) return 'CATMAT ' + numeric[1]
                return ''
              })(),
              materialOuServico: entryItem.materialOuServico || entryItem.tipoCatalogo || '',
              numeroControlePNCP:
                entryItem.numeroControlePNCP ||
                entryItem.numero_controle_pncp ||
                p.cnpj + '-' + p.ano + '-' + p.sequencial,
              _tipoDoc: entryItem.tipo_documento || entryItem.document_type || 'ata',
            })
          }
        }
      }

      // Processa contratações contra cache (rápido, sem bloqueio de 2.5s)
      for (var d = 0; d < contratacoesParaDetalhar.length; d++) {
        detalharContratacao(contratacoesParaDetalhar[d])
      }

      var filaPersistida = null
      var erroFila = null
      var comprasPersistidas = {}
      // Count only this request's purchases after a successful durable save.
      function registrarFilaPersistida(pendentes) {
        filaPersistida = true
        for (var fp = 0; fp < pendentes.length; fp++) {
          var pendente = pendentes[fp]
          if (!pendente || pendente._pncp_discovery) continue
          comprasPersistidas[
            (pendente.c || pendente.cnpj) +
              '_' +
              (pendente.a || pendente.ano) +
              '_' +
              (pendente.s || pendente.sequencial)
          ] = (Number(pendente.r) || 0) < 4 ? 'pending' : 'frozen'
        }
      }
      // Enfileira automaticamente contratações pendentes em price_index_tasks (para o worker processar em background)
      // Armazena payload compacto [cnpj, ano, sequencial, tipoDoc] com limite de segurança para nunca estourar o limite de 1MB do PocketBase
      if (contratacoesNaoDetalhasParaFila.length > 0) {
        try {
          var colTasks = $app.findCollectionByNameOrId('price_index_tasks')
          // Same task-key normalization as PriceIndexService (not the item matcher).
          var termoLegadoTask = (q || '').toUpperCase().trim()
          var termoNormTask = (q || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/[^A-Z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          var ufNormTask = (uf || '').toUpperCase().trim() || 'ALL'
          var taskKeyBase = 'AMBAS#' + termoNormTask + '#' + ufNormTask
          var sufixoDonoTask = '#OWNER#' + String(e.auth.id)
          var taskKeyGeral = taskKeyBase + sufixoDonoTask
          // Owner-qualified canonical first, then bounded legacy spellings/BR national alias.
          // Foreign and ownerless legacy jobs are skipped, never adopted or disclosed.
          var taskKeysCompativeis = [taskKeyGeral]
          var ufsTask = ufNormTask === 'ALL' ? ['ALL', 'BR'] : [ufNormTask]
          var termosTask = [termoNormTask, termoLegadoTask]
          var prefixosTask = ['AMBAS', 'PNCP', 'PNCP_PENDENTES']
          for (var piTask = 0; piTask < prefixosTask.length; piTask++) {
            for (var uiTask = 0; uiTask < ufsTask.length; uiTask++) {
              for (var tiTask = 0; tiTask < termosTask.length; tiTask++) {
                var chaveCompativel =
                  prefixosTask[piTask] + '#' + termosTask[tiTask] + '#' + ufsTask[uiTask]
                var chaveDonoCompativel = chaveCompativel + sufixoDonoTask
                if (taskKeysCompativeis.indexOf(chaveDonoCompativel) < 0)
                  taskKeysCompativeis.push(chaveDonoCompativel)
                if (taskKeysCompativeis.indexOf(chaveCompativel) < 0)
                  taskKeysCompativeis.push(chaveCompativel)
              }
            }
          }
          var taskGeral = null
          for (var kiTask = 0; kiTask < taskKeysCompativeis.length && !taskGeral; kiTask++) {
            try {
              var candidatoTask = $app.findFirstRecordByData(
                'price_index_tasks',
                'task_key',
                taskKeysCompativeis[kiTask],
              )
              if (
                candidatoTask.getString('server_trust_version') === 'server-v1' &&
                candidatoTask.getString('requested_by') === String(e.auth.id)
              )
                taskGeral = candidatoTask
            } catch (_) {}
          }

          var agoraIso = new Date().toISOString()
          var MAX_PENDENTES_QUEUE = 300 // Mantém tamanho seguro bem abaixo do limite de 1MB

          if (taskGeral) {
            $app.runInTransaction(function (txApp) {
              taskGeral = txApp.findRecordById('price_index_tasks', taskGeral.id)
              var pendExist = []
              var taskTrusted = taskGeral.getString('server_trust_version') === 'server-v1'
              if (taskTrusted && taskGeral.getString('task_key') !== taskKeyGeral) {
                // One-time compatibility migration for a trusted pre-owner key.
                taskGeral.set('task_key', taskKeyGeral)
                taskGeral.set('source', 'AMBAS')
                taskGeral.set('termo', q || '')
                taskGeral.set('uf', uf || '')
              }
              if (!taskTrusted) {
                // Never promote caller-writable legacy queue state. Keep the record id only;
                // every operational field is rebuilt from this authenticated request.
                taskGeral.set('task_key', taskKeyGeral)
                taskGeral.set('source', 'PNCP')
                taskGeral.set('termo', q || '')
                taskGeral.set('uf', uf || '')
                taskGeral.set('status', 'pending')
                taskGeral.set('paginas_consultadas', 0)
                taskGeral.set('itens_processados', 0)
                taskGeral.set('amostras_inseridas', 0)
                taskGeral.set('amostras_atualizadas', 0)
                taskGeral.set('tentativas', 0)
                taskGeral.set('erros', '[]')
                taskGeral.set('started_at', '')
                taskGeral.set('finished_at', '')
                taskGeral.set('ultimo_erro', '')
                taskGeral.set('progress_at', null)
              }
              try {
                var rawP = taskGeral.getString('pendentes')
                if (taskTrusted && rawP) {
                  var parsedP = JSON.parse(rawP)
                  if (Array.isArray(parsedP)) pendExist = parsedP
                }
              } catch (_) {}

              var recibosFila = taskTrusted ? pncpReceiptRecords(taskGeral.getString('erros')) : []
              pendExist = pendExist.filter(function (p) {
                return !pncpSuperseded(p, recibosFila)
              })
              var vistosKeys = {}
              var totalComprasPendentes = 0
              for (var v = 0; v < pendExist.length; v++) {
                var pEntry = pendExist[v]
                if (pEntry && pEntry._pncp_discovery) continue
                totalComprasPendentes++
                var kEx = pncpPendingKey(pEntry)
                vistosKeys[kEx] = true
              }

              for (var n = 0; n < contratacoesNaoDetalhasParaFila.length; n++) {
                if (totalComprasPendentes >= MAX_PENDENTES_QUEUE) break
                var cItem = contratacoesNaoDetalhasParaFila[n]
                var kItem = pncpPendingKey(
                  Object.assign({}, cItem, { t: cItem._tipoDoc || cItem.t }),
                )
                if (
                  !vistosKeys[kItem] &&
                  !pncpAdmittedBefore(
                    Object.assign({}, cItem, { t: cItem._tipoDoc || cItem.t }),
                    recibosFila,
                  ) &&
                  !pncpSuperseded(cItem, recibosFila)
                ) {
                  vistosKeys[kItem] = true
                  totalComprasPendentes++
                  pendExist.push({
                    _pncp_compra: cItem._pncp_compra,
                    _pncp_relacao: cItem._pncp_relacao,
                    numeroControlePNCP: cItem.numeroControlePNCP || '',
                    c: cItem.cnpj || cItem.c,
                    a: cItem.ano || cItem.a,
                    s: cItem.sequencial || cItem.s,
                    u: cItem.uf || '',
                    m: (cItem.municipio || '').slice(0, 40),
                    o: (cItem.orgao || '').slice(0, 80),
                    numeroProcesso: String(cItem.numeroProcesso || '').slice(0, 120),
                    codigoCatalogo: String(cItem.codigoCatalogo || '').slice(0, 32),
                    materialOuServico: String(cItem.materialOuServico || '').slice(0, 32),
                    t: cItem._tipoDoc || cItem.t || 'ata',
                    r: 0,
                  })
                }
              }

              taskGeral.set('pendentes', JSON.stringify(pendExist))
              taskGeral.set('server_trust_version', 'server-v1')
              var possuiTrabalhoAcionavel = pendExist.some(function (p) {
                if (!p) return false
                if (p._pncp_discovery) {
                  var esgotados = p._pncp_discovery.esgotados || {}
                  return !(esgotados.ata && esgotados.edital && esgotados.contrato)
                }
                return pncpActionable(p)
              })
              if (
                (taskGeral.getString('status') === 'completed' ||
                  taskGeral.getString('status') === 'failed') &&
                possuiTrabalhoAcionavel
              ) {
                taskGeral.set('status', 'pending')
              }
              txApp.save(taskGeral)
            })
            registrarFilaPersistida(JSON.parse(taskGeral.getString('pendentes')))
          }
        } catch (errTaskQueue) {
          filaPersistida = false
          erroFila = 'PNCP_QUEUE_SAVE_FAILED'
          comprasPersistidas = {}
          console.log(
            '[PNCP-PROXY] Aviso ao enfileirar contratações pendentes:',
            errTaskQueue.message,
          )
        }
      }

      var totalAmostrasFinais = 0
      var itensFilaPendente = 0
      var itensPendentes = 0
      var itensCongelados = 0
      for (var f = 0; f < contratacoesUnicas.length; f++) {
        if (Array.isArray(contratacoesUnicas[f].itensAta)) {
          totalAmostrasFinais += contratacoesUnicas[f].itensAta.length
        }
        if (contratacoesUnicas[f]._detalhamento_pendente) {
          itensPendentes++
          var paramsFila = extrairParametrosCompra(contratacoesUnicas[f])
          var estadoFila =
            comprasPersistidas[paramsFila.cnpj + '_' + paramsFila.ano + '_' + paramsFila.sequencial]
          if (estadoFila === 'pending') itensFilaPendente++
          else if (estadoFila === 'frozen') itensCongelados++
        }
      }

      diagLogs.tempo_total_ms = new Date().getTime() - tInicioProxy

      function pncpReceiptNormalize(value) {
        if (!value) return ''
        return String(value)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
          .replace(/[^A-Z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      }
      function pncpReceiptSampleKey(sourceRecordId, itemId, orgCnpj, supplierCnpj, price) {
        return (
          'PNCP#' +
          sourceRecordId.replace(/[^A-Z0-9_-]/gi, '') +
          '#' +
          itemId +
          '#' +
          String(orgCnpj || supplierCnpj || '').replace(/\D/g, '') +
          '#' +
          Number(price).toFixed(4).replace('.', '_')
        )
      }
      function pncpReceiptRowContract(row) {
        var names = [
          'sample_key',
          'source',
          'source_record_id',
          'purchase_id',
          'item_id',
          'descricao',
          'descricao_normalizada',
          'orgao',
          'orgao_cnpj',
          'fornecedor_nome',
          'fornecedor_cnpj',
          'fornecedor_porte',
          'uf',
          'municipio',
          'unidade',
          'quantidade',
          'valor_unitario',
          'valor_total',
          'natureza_preco',
          'data_referencia',
          'numero_processo',
          'numero_ata',
          'modalidade',
          'marca',
          'codigo_item',
          'url_original',
          'raw_payload',
        ]
        var contract = {}
        for (var rf = 0; rf < names.length; rf++) {
          var value = row[names[rf]]
          contract[names[rf]] = value == null ? null : value
        }
        return contract
      }
      var pncpReceipt = null
      var pncpReceipts = []
      try {
        var pncpQueryMaterial = {
          route: '/backend/v1/pncp/search',
          q: q,
          pagina: paginaParam,
          tamanho: tamPaginaParam,
          uf: uf,
          catmat: catmatQueryParam,
          tipos_documento: tiposDocumentos,
        }
        var pncpQueryHash = $security.sha256(pncpCanonical(pncpQueryMaterial)).toLowerCase()
        var pncpClaims = []
        for (var pr = 0; pr < contratacoesUnicas.length; pr++) {
          var receiptItems = contratacoesUnicas[pr].itensAta
          if (!Array.isArray(receiptItems)) continue
          for (var pri = 0; pri < receiptItems.length; pri++) {
            var receiptItem = receiptItems[pri]
            var receiptProof = receiptItem && receiptItem.proveniencia_preco
            var receiptRaw = receiptProof && receiptProof.registro_oficial
            var receiptIdentity = receiptProof && receiptProof.identidade
            if (
              !receiptRaw ||
              !receiptIdentity ||
              receiptProof.fonte !== 'PNCP' ||
              !isFinite(Number(receiptProof.valor_unitario)) ||
              Number(receiptProof.valor_unitario) <= 0
            )
              continue
            var receiptSupplier = String(
              receiptRaw.niFornecedor ||
                receiptItem.fornecedor_cnpj ||
                (receiptItem.fornecedor &&
                  (receiptItem.fornecedor.niFornecedor || receiptItem.fornecedor.cnpj)) ||
                '',
            ).replace(/\D/g, '')
            var receiptRecordId =
              String(receiptIdentity.cnpj) +
              '/' +
              Number(receiptIdentity.ano) +
              '/' +
              Number(receiptIdentity.sequencial) +
              '/itens/' +
              Number(receiptIdentity.numeroItem) +
              (receiptRaw.sequencialResultado
                ? '/resultados/' + receiptRaw.sequencialResultado
                : '') +
              (receiptSupplier ? '/fornecedor/' + receiptSupplier : '')
            var receiptUrl =
              'https://pncp.gov.br/app/editais/' +
              receiptIdentity.cnpj +
              '/' +
              Number(receiptIdentity.ano) +
              '/' +
              Number(receiptIdentity.sequencial)
            var receiptRecordHash = $security.sha256(pncpCanonical(receiptRaw)).toLowerCase()
            var receiptKey = $security
              .sha256('PNCP|' + pncpQueryHash + '|' + receiptRecordHash + '|' + pr + '|' + pri)
              .toLowerCase()
            var receiptDescription = String(
              receiptItem.descricao || receiptItem.materialOuServicoNome || '',
            )
              .trim()
              .toUpperCase()
            var receiptOrgName = String(
              receiptItem.orgao_comprador ||
                (receiptItem.orgaoEntidade && receiptItem.orgaoEntidade.razaoSocial) ||
                receiptItem.orgao_nome ||
                'Órgão Público PNCP',
            )
            var receiptSupplierName = String(
              (typeof receiptItem.fornecedor === 'string' ? receiptItem.fornecedor : '') ||
                receiptItem.fornecedor_nome ||
                (receiptItem.fornecedor && receiptItem.fornecedor.nomeRazaoSocialFornecedor) ||
                'NÃO INFORMADO',
            )
            var receiptUnit =
              String(receiptItem.unidade || receiptItem.unidadeMedida || '').trim() ||
              'NÃO INFORMADO'
            var receiptQuantity = Number(receiptItem.quantidade)
            receiptQuantity = isFinite(receiptQuantity) && receiptQuantity > 0 ? receiptQuantity : 0
            var receiptTotal = Number(receiptRaw.valorTotalHomologado || receiptRaw.valorTotal || 0)
            if (!isFinite(receiptTotal) || receiptTotal < 0) receiptTotal = 0
            var receiptDate = ''
            if (
              receiptProof.data_oficial &&
              receiptProof.campo_data &&
              String(
                receiptRaw[receiptProof.campo_data] == null
                  ? ''
                  : receiptRaw[receiptProof.campo_data],
              ) === String(receiptProof.data_oficial) &&
              isFinite(Date.parse(receiptProof.data_oficial))
            )
              receiptDate = String(receiptProof.data_oficial)
            var receiptControle = String(
              receiptItem.numeroControlePNCP ||
                receiptItem.numero_controle_pncp ||
                receiptItem.id_externo ||
                '',
            )
            var receiptNature = receiptProof.natureza === 'estimado' ? 'estimado' : 'homologado'
            var receiptDetails = {
              numeroItem: String(Number(receiptIdentity.numeroItem)),
              numeroControlePNCP: receiptControle,
              proveniencia_preco: receiptProof,
            }
            var receiptRow = {
              source: 'PNCP',
              source_record_id: receiptRecordId,
              purchase_id: receiptRecordId,
              item_id: String(Number(receiptIdentity.numeroItem)),
              descricao: receiptDescription,
              descricao_normalizada: pncpReceiptNormalize(receiptDescription),
              orgao: receiptOrgName,
              orgao_cnpj: String(receiptIdentity.cnpj),
              fornecedor_nome: receiptSupplierName,
              fornecedor_cnpj: receiptSupplier,
              fornecedor_porte:
                receiptSupplierName.indexOf('ME') >= 0 || receiptSupplierName.indexOf('EPP') >= 0
                  ? 'ME_EPP'
                  : 'DEMAIS',
              uf: String(
                receiptItem.uf ||
                  (receiptItem.municipio_uf && String(receiptItem.municipio_uf).split('-')[1]
                    ? String(receiptItem.municipio_uf).split('-')[1].trim()
                    : '') ||
                  '',
              ),
              municipio: String(receiptItem.municipio_nome || receiptItem.municipio || ''),
              unidade: receiptUnit,
              quantidade: receiptQuantity,
              valor_unitario: Number(receiptProof.valor_unitario),
              valor_total: receiptTotal,
              natureza_preco: receiptNature,
              data_referencia: receiptDate,
              numero_processo: String(receiptItem.processo_origem || receiptControle),
              numero_ata: '',
              modalidade: String(receiptItem.modalidade_licitacao || 'Pregão Eletrônico'),
              marca: String(receiptItem.marca_modelo || receiptItem.marcaNome || 'NÃO INFORMADO'),
              codigo_item: String(receiptItem.codigo_catalogo || ''),
              url_original: receiptUrl,
              raw_payload: receiptDetails,
            }
            receiptRow.sample_key = pncpReceiptSampleKey(
              receiptRecordId,
              receiptRow.item_id,
              receiptRow.orgao_cnpj,
              receiptSupplier,
              receiptRow.valor_unitario,
            )
            var receiptRowHash = $security
              .sha256(pncpCanonical(pncpReceiptRowContract(receiptRow)))
              .toLowerCase()
            receiptItem._cotai_ingestion_claim = receiptKey
            receiptItem._cotai_index_row = receiptRow
            receiptItem._cotai_ingestion_receipt_index = Math.floor(pncpClaims.length / 500)
            pncpClaims.push({
              key: receiptKey,
              record_hash: receiptRecordHash,
              row_hash: receiptRowHash,
              source_record_id: receiptRecordId,
              item_id: String(Number(receiptIdentity.numeroItem)),
              description: receiptDescription,
              unit_price: Number(receiptProof.valor_unitario),
              url_original: receiptUrl,
            })
          }
        }
        for (var pChunk = 0; pChunk < pncpClaims.length; pChunk += 500) {
          var pReceipt = issueOfficialReceipt(
            'PNCP',
            pncpQueryMaterial,
            pncpClaims.slice(pChunk, pChunk + 500),
          )
          if (pReceipt) pncpReceipts.push(pReceipt)
        }
        pncpReceipt = pncpReceipts.length ? pncpReceipts[0] : null
      } catch (_) {
        return e.json(503, {
          sucesso: false,
          error: 'RECEIPT_UNAVAILABLE',
          message: 'A prova temporária da página oficial não pôde ser emitida.',
        })
      }

      return e.json(200, {
        sucesso: true,
        ingestion_receipt: pncpReceipt,
        ingestion_receipts: pncpReceipts,
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
          itens_pendentes: itensPendentes,
          itens_nao_enfileirados: itensPendentes - itensFilaPendente - itensCongelados,
          itens_congelados: itensCongelados,
          fila_persistida: filaPersistida,
          erro_fila: erroFila,
          cobertura_parcial: itensPendentes > 0 || erroFila !== null || descobertaParcial,
          descoberta_parcial: descobertaParcial,
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
  },
  $apis.requireAuth(),
)
