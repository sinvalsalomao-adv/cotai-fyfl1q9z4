/**
 * PocketBase Hook: Proxy Seguro para API Pública de Dados Abertos do Compras.gov.br
 * Base: dadosabertos.compras.gov.br (Módulo Pesquisa de Preço / CATMAT / Contratações 14.133)
 *
 * Características e Garantias de Homologação:
 * 1. Rota autenticada: GET /backend/v1/cotai/comprasgov-search (requer token JWT)
 * 2. Suporte à assinatura vigente da API:
 *    - /modulo-pesquisa-preco/1_consultarMaterial exige o par:
 *      tipo=codigoItemCatalogo & codigo=<CATMAT>
 *      (o antigo `codigoItemCatalogo=<int>` ou `descricaoItem` gera 404/rejeição upstream)
 * 3. Mapeamento canônico e resolução de CATMAT a partir do termo com fallback estruturado
 * 4. Paginação e deduplicação defensiva por CNPJ de fornecedor + item
 * 5. NUNCA retorna 502 cru sem estrutura e NUNCA derruba o lote agregado
 * 6. Deep links auditáveis e rastreabilidade com hash SHA/determinístico
 */

routerAdd(
  'GET',
  '/backend/v1/cotai/comprasgov-search',
  function (e) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
    // Diagnostic state is invocation-local: PocketBase isolates callback JSVMs.
    var diagnosticStartedAt = new Date().getTime()
    var diagnosticRequestId = Math.random().toString(36).slice(2, 14)
    var upstream_n = 0
    var write_n = 0
    function tracePhase(phase, startedAt, status, outcome) {
      try {
        var at = new Date().getTime()
        var entry = {
          revision: 'comprasgov-phases-v209',
          route: '/backend/v1/cotai/comprasgov-search',
          method: 'GET',
          request_id: diagnosticRequestId,
          phase: phase,
          at_ms: at,
          elapsed_ms: at - diagnosticStartedAt,
          upstream_n: upstream_n,
          write_n: write_n,
        }
        if (typeof startedAt === 'number' && Number.isFinite(startedAt))
          entry.duration_ms = at - startedAt
        if (typeof status === 'number' && Number.isFinite(status)) entry.status = status
        if (outcome) entry.outcome = outcome // Only fixed local literals reach this argument.
        if (phase === 'entry') entry.native_sleep_available = typeof sleep === 'function'
        console.log('[COMPRASGOV_PHASE] ' + JSON.stringify(entry))
      } catch (_) {} // Formatting or console failure must never affect the request.
    }
    function traceJson(status, body) {
      write_n++
      var startedAt = new Date().getTime()
      tracePhase('write_start', undefined, status)
      try {
        var result = e.json(status, body)
        tracePhase('write_return', startedAt, status)
        return result
      } catch (err) {
        tracePhase('write_throw', startedAt, status)
        throw err
      }
    }
    tracePhase('entry')
    // Callback-local by design: PocketBase may isolate every JSVM invocation.
    function officialReceiptCanonical(value) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return '[' + value.map(officialReceiptCanonical).join(',') + ']'
      return (
        '{' +
        Object.keys(value)
          .sort()
          .map(function (key) {
            return JSON.stringify(key) + ':' + officialReceiptCanonical(value[key])
          })
          .join(',') +
        '}'
      )
    }
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
      var queryHash = $security.sha256(officialReceiptCanonical(queryMaterial)).toLowerCase()
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
          if (isFinite(expirationTime) && expirationTime <= now.getTime()) $app.delete(expired[ex])
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
              "VALUES ({:user}, 'COMPRAS_SEARCH', {:now}, 1, {:now}) " +
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
      // B5: Ler catser e tipo ANTES do guard de parâmetros para que catser-only não dê 400
      var tipoCatalogo = (query.tipo_catalogo || query.tipo || '').toLowerCase() // 'material', 'servico' ou vazio
      var catser = (query.catser || query.codigo_servico || query.codigoServico || '').trim()
      var termo = (query.termo || '').trim()
      var catmat = (query.catmat || '').trim()
      var codigoItem = (query.codigo_item || query.codigoItemCatalogo || query.codigo || '').trim()
      var uf = (query.uf || query.estado || '').trim().toUpperCase()
      var paginaRawGeral = query.pagina === undefined ? '1' : String(query.pagina)
      var tamPaginaRaw = String(
        query.tam_pagina || query.tamanhoPagina || query.tamanho_pagina || '50',
      )
      var paginaParam = /^\d+$/.test(paginaRawGeral) ? Number(paginaRawGeral) : 0
      // The official endpoint accepts 10..500; reject rather than silently expanding work.
      var tamPaginaParam = /^\d+$/.test(tamPaginaRaw) ? Number(tamPaginaRaw) : 0
      var dataInicio = (query.data_inicio || '').trim()
      var dataFim = (query.data_fim || '').trim()
      var paginacaoTotal =
        (query.paginacao_total || '').toLowerCase() === 'true' ||
        (query.todas_paginas || '').toLowerCase() === 'true'
      var limiteRaw = query.limite_paginas === undefined ? '20' : String(query.limite_paginas)
      var limitePaginasMax = /^\d+$/.test(limiteRaw) ? Number(limiteRaw) : 0
      // Presence is deliberate: an empty selector cannot become a textual search.
      var grupoPdm = Object.prototype.hasOwnProperty.call(query, 'codigo_pdm')
      var codigoPdm = grupoPdm ? query.codigo_pdm : undefined
      var consultaPreco = null
      if (grupoPdm) {
        var aliasesItem = [
          'codigo_item',
          'codigoItemCatalogo',
          'codigo',
          'catmat',
          'catser',
          'codigo_servico',
          'codigoServico',
        ]
        var ambiguo = aliasesItem.some(function (key) {
          return Object.prototype.hasOwnProperty.call(query, key)
        })
        var paginaBruta = query.pagina === undefined ? '1' : query.pagina
        function dataIsoValida(value) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
          var date = new Date(value + 'T00:00:00.000Z')
          return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
        }
        if (
          typeof codigoPdm !== 'string' ||
          !/^\d{1,12}$/.test(codigoPdm) ||
          Number(codigoPdm) <= 0 ||
          (tipoCatalogo && tipoCatalogo !== 'material') ||
          ambiguo ||
          paginacaoTotal ||
          !/^\d+$/.test(paginaBruta) ||
          !Number.isSafeInteger(Number(paginaBruta)) ||
          Number(paginaBruta) < 1 ||
          (query.data_inicio !== undefined && !dataIsoValida(query.data_inicio)) ||
          (query.data_fim !== undefined && !dataIsoValida(query.data_fim))
        ) {
          return traceJson(400, {
            sucesso: false,
            error: 'INVALID_PARAMETERS',
            message:
              'Informe um único codigo_pdm de material, uma página positiva e datas ISO válidas.',
          })
        }
        paginaParam = Number(paginaBruta)
      }

      if (!grupoPdm && !termo && !catmat && !codigoItem && !catser && !tipoCatalogo) {
        return traceJson(400, {
          error: 'INVALID_PARAMETERS',
          message:
            'O parâmetro "termo", "catmat", "catser" ou "codigo_item" é obrigatório para consultar o Compras.gov.br.',
        })
      }
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
      function dataIsoGeralValida(value) {
        if (!value) return true
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
        var parsed = new Date(value + 'T00:00:00.000Z')
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
      }
      var codigosValidos = [catmat, catser, codigoItem].every(function (codigo) {
        return !codigo || (codigo.length <= 64 && /^[A-Za-z0-9 _./-]+$/.test(codigo))
      })
      if (
        termo.length > 160 ||
        !Number.isSafeInteger(paginaParam) ||
        paginaParam < 1 ||
        paginaParam > 10000 ||
        !Number.isSafeInteger(tamPaginaParam) ||
        tamPaginaParam < 10 ||
        tamPaginaParam > 500 ||
        !Number.isSafeInteger(limitePaginasMax) ||
        limitePaginasMax < 1 ||
        limitePaginasMax > 20 ||
        (uf && !ufsValidas[uf]) ||
        (tipoCatalogo && tipoCatalogo !== 'material' && tipoCatalogo !== 'servico') ||
        !codigosValidos ||
        !dataIsoGeralValida(dataInicio) ||
        !dataIsoGeralValida(dataFim)
      ) {
        return traceJson(400, {
          sucesso: false,
          error: 'INVALID_PARAMETERS',
          message: 'Parâmetros de busca inválidos ou fora dos limites permitidos.',
        })
      }

      var sourceRate = consumeSourceRateLimit()
      if (!sourceRate.available)
        return traceJson(503, { sucesso: false, error: 'SOURCE_RATE_LIMIT_UNAVAILABLE' })
      if (!sourceRate.accepted)
        return traceJson(429, {
          sucesso: false,
          error: 'SOURCE_RATE_LIMITED',
          retry_after_seconds: 60,
        })

      // Sanitização canônica do termo
      var termoSanitizado = (termo || catmat)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      var termoLower = termoSanitizado.toLowerCase()

      var upstreamThrottle = null
      function retryAfterHeader(headers) {
        if (!headers || typeof headers !== 'object') return undefined
        var names = Object.keys(headers)
        for (var h = 0; h < names.length; h++) {
          if (names[h].toLowerCase() !== 'retry-after') continue
          var value = headers[names[h]]
          if (Array.isArray(value) && value.length === 1) value = value[0]
          if (typeof value !== 'string' || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))
            return undefined
          value = value.trim()
          if (/^\d{1,10}$/.test(value)) return value
          if (
            /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
              value,
            ) &&
            Number.isFinite(Date.parse(value)) &&
            new Date(Date.parse(value)).toUTCString() === value
          )
            return value
          return undefined
        }
        return undefined
      }
      function withThrottle(body) {
        if (upstreamThrottle) body.upstream_throttle = upstreamThrottle
        if (consultaPreco && body.sucesso === true) body.consultaPreco = consultaPreco
        return body
      }
      function fetchEndpoint(url, timeoutSec) {
        upstream_n++
        var startedAt = new Date().getTime()
        var sendReturned = false
        tracePhase('upstream_start')
        try {
          var res = $http.send({
            url: url,
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Accept: 'application/json, text/plain, */*',
            },
            timeout: timeoutSec || 4,
          })
          sendReturned = true
          // Guard status access too: diagnostics must not change the attempt result.
          try {
            tracePhase('upstream_end', startedAt, res && res.statusCode)
          } catch (_) {}
          if (
            res &&
            (res.statusCode === 429 || (grupoPdm && res.statusCode === 503)) &&
            !upstreamThrottle
          ) {
            upstreamThrottle = { status: res.statusCode }
            var retryAfter = retryAfterHeader(res.headers)
            if (retryAfter !== undefined) upstreamThrottle.retry_after = retryAfter
          }
          return { ok: true, resp: res }
        } catch (err) {
          if (!sendReturned) tracePhase('upstream_throw', startedAt)
          return { ok: false, error: err.message, resp: null }
        }
      }

      // Only official identity fields are textualized. Money, quantities and counts
      // keep JSON number semantics. Callback-local: PocketBase isolates JSVM hooks.
      var identityFields = [
        'idCompra',
        'codigoCompra',
        'idItemCompra',
        'idCompraItem',
        'numeroItemCompra',
        'numeroItem',
        'id',
        'codigoItemCatalogo',
        'codigoCatmat',
        'codigoCatser',
        'cnpjFornecedor',
        'cpfCnpjFornecedor',
        'niFornecedor',
        'cnpjOrgao',
        'cnpj',
        'codigoUasg',
        'codigoPdm',
        'codigoPDM',
      ]
      var maxBodyBytes = 8 * 1024 * 1024
      function exactJson(source) {
        if (typeof source !== 'string' || source.length > maxBodyBytes) throw new Error('JSON_SIZE')
        // Native token scanning skips complete descriptions without a JS loop per
        // character. Only identity integers receive quotes; the final JSON.parse
        // still validates the complete original grammar, escapes and separators.
        var identityTokens = Object.create(null)
        for (var f = 0; f < identityFields.length; f++) {
          identityTokens['"' + identityFields[f] + '"'] = true
        }
        var tokens =
          /"(?:[^"\\]*\\[\s\S])*[^"\\]*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[^\x20\t\r\n]/g
        var match,
          depth = 0,
          previousString = null,
          identityValue = false,
          copiedUntil = 0,
          parts = []
        while ((match = tokens.exec(source)) !== null) {
          var token = match[0]
          var first = token.charAt(0)
          if (token === '{' || token === '[') {
            if (depth > 64) throw new Error('JSON_DEPTH')
            depth++
            previousString = null
            identityValue = false
            continue
          }
          if (token === '}' || token === ']') {
            depth--
            if (depth < 0) throw new Error('JSON_DEPTH')
            previousString = null
            identityValue = false
            continue
          }
          if (token === ':') {
            // Escaped field names retain their decoded identity. Plain repeated
            // keys never need their own JSON.parse invocation.
            identityValue =
              previousString !== null &&
              (previousString.indexOf('\\') < 0
                ? identityTokens[previousString] === true
                : identityFields.indexOf(JSON.parse(previousString)) >= 0)
            previousString = null
            continue
          }
          if (token === ',') {
            previousString = null
            identityValue = false
            continue
          }
          if (depth > 64) throw new Error('JSON_DEPTH')
          if (first === '"') {
            previousString = token
            identityValue = false
            continue
          }
          if (first === '-' || (first >= '0' && first <= '9')) {
            if (identityValue) {
              if (!/^-?(?:0|[1-9]\d*)$/.test(token)) throw new Error('JSON_ID_INTEGER')
              parts.push(source.slice(copiedUntil, match.index), '"', token, '"')
              copiedUntil = match.index + token.length
            }
          } else if (token !== 'true' && token !== 'false' && token !== 'null') {
            throw new Error('JSON_VALUE')
          }
          previousString = null
          identityValue = false
        }
        parts.push(source.slice(copiedUntil))
        return JSON.parse(parts.join(''))
      }
      function parsedIdentitySafe(value, depth, budget) {
        if (depth > 64 || --budget.remaining < 0) return false
        if (!value || typeof value !== 'object') return true
        var keys = Object.keys(value)
        for (var i = 0; i < keys.length; i++) {
          var child = value[keys[i]]
          if (
            identityFields.indexOf(keys[i]) >= 0 &&
            typeof child === 'number' &&
            !Number.isSafeInteger(child)
          )
            return false
          if (!parsedIdentitySafe(child, depth + 1, budget)) return false
        }
        return true
      }
      function parseJsonBody(attempt) {
        var startedAt = new Date().getTime()
        var outcome = 'threw'
        tracePhase('parse_start')
        try {
          if (!attempt.ok || !attempt.resp) {
            outcome = 'skipped'
            return null
          }
          if (attempt.resp.statusCode < 200 || attempt.resp.statusCode >= 300) {
            outcome = 'skipped'
            return null
          }
          try {
            var response = attempt.resp
            if (response.body != null) {
              if (typeof response.body.length !== 'number' || response.body.length > maxBodyBytes) {
                outcome = 'rejected'
                return null
              }
              var parsedBody = exactJson(toString(response.body))
              outcome = 'parsed'
              return parsedBody
            }
            if (typeof response.raw === 'string') {
              var parsedRaw = exactJson(response.raw)
              outcome = 'parsed'
              return parsedRaw
            }
            if (parsedIdentitySafe(response.json, 0, { remaining: 250000 })) {
              var parsed = response.json
              outcome = 'parsed'
              return parsed
            }
            outcome = 'rejected'
            return null
          } catch (_) {
            outcome = 'threw'
            return null
          }
        } finally {
          tracePhase(
            outcome === 'threw' ? 'parse_throw' : 'parse_end',
            startedAt,
            undefined,
            outcome,
          )
        }
      }

      function extractItems(body) {
        if (!body) return []
        if (Array.isArray(body)) return body
        if (Array.isArray(body.resultado)) return body.resultado
        if (Array.isArray(body.items)) return body.items
        if (Array.isArray(body.data)) return body.data
        return []
      }

      function respostaPrecoValida(body) {
        if (!body || typeof body !== 'object' || body.sucesso === false) return false
        var items = Array.isArray(body)
          ? body
          : Array.isArray(body.resultado)
            ? body.resultado
            : Array.isArray(body.items)
              ? body.items
              : Array.isArray(body.data)
                ? body.data
                : null
        if (!items) return false
        for (var r = 0; r < items.length; r++) {
          if (!items[r] || typeof items[r] !== 'object' || Array.isArray(items[r])) return false
        }
        var countFields = ['totalRegistros', 'total', 'totalPaginas']
        for (var c = 0; c < countFields.length; c++) {
          var count = body[countFields[c]]
          if (
            count !== undefined &&
            (typeof count !== 'number' ||
              !isFinite(count) ||
              count < 0 ||
              Math.floor(count) !== count)
          )
            return false
        }
        return true
      }

      // 1. Identificar códigos de catálogo: CATMAT (materiais) e CATSER (serviços)
      var codigosCatmatIdentificados = []
      var codigosCatserIdentificados = []
      var codigoExplicitoInformado = grupoPdm

      var paramCatBruto = String(codigoItem || catmat || '').trim()
      if (paramCatBruto) {
        var partesCat = paramCatBruto.split(',')
        for (var pI = 0; pI < partesCat.length; pI++) {
          var cL = partesCat[pI].replace(/\D/g, '')
          if (cL && cL.length >= 3 && codigosCatmatIdentificados.indexOf(cL) === -1) {
            codigosCatmatIdentificados.push(cL)
            codigoExplicitoInformado = true
          }
        }
      }

      if (catser) {
        var partesCatser = catser.split(',')
        for (var csI = 0; csI < partesCatser.length; csI++) {
          var csL = partesCatser[csI].replace(/\D/g, '')
          if (csL && csL.length >= 3 && codigosCatserIdentificados.indexOf(csL) === -1) {
            codigosCatserIdentificados.push(csL)
            codigoExplicitoInformado = true
          }
        }
      }

      // Sem listas hardcoded de termos: resolução puramente dinâmica via catálogo oficial

      // Se ainda não temos código CATMAT nem CATSER e não for explicitamente serviço, tentar catálogo de material
      if (
        !grupoPdm &&
        codigosCatmatIdentificados.length === 0 &&
        codigosCatserIdentificados.length === 0 &&
        tipoCatalogo !== 'servico' &&
        termoSanitizado
      ) {
        var urlCatmat =
          'https://dadosabertos.compras.gov.br/modulo-material/4_consultarItemMaterial?descricaoItem=' +
          encodeURIComponent(termoSanitizado) +
          '&pagina=1&tamanhoPagina=5'
        var attCatmat = fetchEndpoint(urlCatmat, 5)
        var bodyCatmat = parseJsonBody(attCatmat)
        var itensCatmat = extractItems(bodyCatmat)
        if (itensCatmat && itensCatmat.length > 0) {
          for (var c = 0; c < itensCatmat.length; c++) {
            var cod =
              itensCatmat[c].codigoItem ||
              itensCatmat[c].codigoItemMaterial ||
              itensCatmat[c].codigo ||
              itensCatmat[c].id
            var codStr = String(cod || '').replace(/\D/g, '')
            if (codStr && codigosCatmatIdentificados.indexOf(codStr) === -1) {
              codigosCatmatIdentificados.push(codStr)
            }
          }
        }
      }

      var codigosCatalogoIdentificados = codigosCatmatIdentificados.concat(
        codigosCatserIdentificados,
      )

      var todosRegistros = []
      var endpointUtilizado = 'modulo-pesquisa-preco/1_consultarMaterial'
      var totalRegistrosGeral = 0
      var totalPaginasGeral = 0
      var endpointSucesso = null

      // B1/B3: Material: tipo=codigoItemCatalogo&codigo={CATMAT}&pagina={p}&tamanhoPagina={tam}&estado={UF}
      // B3: UF interna vira &estado={UF} no upstream (&uf é ignorado pelo Compras.gov.br)
      function montarQueryParams(p, tam, cod) {
        var q =
          'tipo=codigoItemCatalogo&codigo=' +
          encodeURIComponent(cod) +
          '&pagina=' +
          p +
          '&tamanhoPagina=' +
          tam
        if (uf) q += '&estado=' + encodeURIComponent(uf)
        if (dataInicio) q += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
        if (dataFim) q += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
        return q
      }

      // B2/B3: Serviço: GET /modulo-pesquisa-preco/3_consultarServico?codigoItemCatalogo={CATSER}&pagina={p}&tamanhoPagina={tam}&estado={UF}
      function montarQueryParamsServico(p, tam, cod) {
        var q =
          'codigoItemCatalogo=' + encodeURIComponent(cod) + '&pagina=' + p + '&tamanhoPagina=' + tam
        if (uf) q += '&estado=' + encodeURIComponent(uf)
        if (dataInicio) q += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
        if (dataFim) q += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
        return q
      }

      // B6/B7: Resposta HTTP 200 com 0, 1 ou 2 linhas é completamente válida.
      // B6: Não disparar módulos secundários (ARP/14133/legado) quando a rota oficial de catálogo respondeu HTTP 200 com parser válido.
      // Falha HTTP (4xx/5xx) ou erro de parser continuam sendo ERRO (B9).
      var rotaCatalogoConsultadaComSucesso = false
      var falhaHttpOcorrida = false
      var mensagemErroHttp = ''

      // One explicit official group page, validated atomically before row admission.
      if (grupoPdm) {
        var urlPdm =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
          'tipo=codigoPdm&codigo=' +
          encodeURIComponent(codigoPdm) +
          '&pagina=' +
          paginaParam +
          '&tamanhoPagina=' +
          tamPaginaParam
        if (uf) urlPdm += '&estado=' + encodeURIComponent(uf)
        if (dataInicio) urlPdm += '&dataCompraInicio=' + encodeURIComponent(dataInicio)
        if (dataFim) urlPdm += '&dataCompraFim=' + encodeURIComponent(dataFim)
        var attPdm = fetchEndpoint(urlPdm, 4.0)
        var bodyPdm =
          attPdm.ok && attPdm.resp && attPdm.resp.statusCode >= 200 && attPdm.resp.statusCode < 300
            ? parseJsonBody(attPdm)
            : null
        var grupoValido =
          respostaPrecoValida(bodyPdm) &&
          typeof bodyPdm.totalRegistros === 'number' &&
          typeof bodyPdm.totalPaginas === 'number' &&
          (bodyPdm.paginaAtual === undefined || bodyPdm.paginaAtual === paginaParam) &&
          (bodyPdm.tamanhoPagina === undefined || bodyPdm.tamanhoPagina === tamPaginaParam)
        var itensPdm = grupoValido ? extractItems(bodyPdm) : []
        function identidadePositiva(value) {
          return (
            (typeof value === 'string' ||
              (typeof value === 'number' && Number.isSafeInteger(value))) &&
            /^\d+$/.test(String(value)) &&
            /[1-9]/.test(String(value))
          )
        }
        for (var gp = 0; gp < itensPdm.length && grupoValido; gp++) {
          var registroPdm = itensPdm[gp]
          grupoValido =
            identidadePositiva(registroPdm.codigoItemCatalogo) &&
            (registroPdm.codigoCatmat === undefined ||
              (identidadePositiva(registroPdm.codigoCatmat) &&
                String(registroPdm.codigoCatmat) === String(registroPdm.codigoItemCatalogo))) &&
            (registroPdm.codigoPdm === undefined || String(registroPdm.codigoPdm) === codigoPdm) &&
            (registroPdm.codigoPDM === undefined || String(registroPdm.codigoPDM) === codigoPdm)
        }
        if (!grupoValido) {
          return traceJson(
            upstreamThrottle ? upstreamThrottle.status : 502,
            withThrottle({
              fonte: 'compras_gov',
              endpoint: endpointUtilizado,
              sucesso: false,
              error: 'UPSTREAM_PDM_ERROR',
              message: 'Resposta oficial do PDM incompatível ou indisponível.',
              codigosCatalogoTentados: [],
            }),
          )
        }
        for (var gm = 0; gm < itensPdm.length; gm++) {
          itensPdm[gm].tipoItem = 'MATERIAL'
          itensPdm[gm].codigoCatmat = String(itensPdm[gm].codigoItemCatalogo)
          todosRegistros.push(itensPdm[gm])
        }
        totalRegistrosGeral = bodyPdm.totalRegistros
        totalPaginasGeral = bodyPdm.totalPaginas
        rotaCatalogoConsultadaComSucesso = true
        consultaPreco = {
          tipo: 'material',
          seletor: 'codigoPdm',
          codigo: codigoPdm,
          pagina: paginaParam,
          tamanhoPagina: tamPaginaParam,
          urlOficial: urlPdm,
        }
      }

      // 2.A Executar consultas para SERVIÇOS (CATSER) via endpoint oficial /modulo-pesquisa-preco/3_consultarServico
      if (codigosCatserIdentificados.length > 0 || tipoCatalogo === 'servico') {
        for (var csIdx = 0; csIdx < codigosCatserIdentificados.length; csIdx++) {
          var codSerAtual = codigosCatserIdentificados[csIdx]
          var urlServico =
            'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?' +
            montarQueryParamsServico(paginaParam, tamPaginaParam, codSerAtual)

          var attServ = fetchEndpoint(urlServico, 4.0)
          if (!attServ.ok || (attServ.resp && attServ.resp.statusCode >= 400)) {
            falhaHttpOcorrida = true
            mensagemErroHttp =
              attServ.error || 'HTTP ' + (attServ.resp ? attServ.resp.statusCode : 'erro')
            continue
          }
          var bodyServ = parseJsonBody(attServ)
          if (!respostaPrecoValida(bodyServ)) {
            falhaHttpOcorrida = true
            mensagemErroHttp = 'JSON ou schema incompatível na resposta oficial de serviços.'
            continue
          }
          if (bodyServ !== null) {
            rotaCatalogoConsultadaComSucesso = true
            var itensServ = extractItems(bodyServ)
            for (var sIdx = 0; sIdx < itensServ.length; sIdx++) {
              var itServ = itensServ[sIdx]
              itServ.tipoItem = 'SERVICO'
              itServ.codigoCatser = codSerAtual
              itServ.origemModulo = 'modulo-pesquisa-preco/3_consultarServico'
              todosRegistros.push(itServ)
            }
            endpointUtilizado =
              'modulo-pesquisa-preco/3_consultarServico (codigoItemCatalogo=' + codSerAtual + ')'
            var totS =
              typeof bodyServ.totalRegistros === 'number'
                ? bodyServ.totalRegistros
                : typeof bodyServ.total === 'number'
                  ? bodyServ.total
                  : itensServ.length
            totalRegistrosGeral += totS
            totalPaginasGeral = Math.max(
              totalPaginasGeral,
              typeof bodyServ.totalPaginas === 'number'
                ? bodyServ.totalPaginas
                : Math.ceil(totS / tamPaginaParam),
            )
            if (!endpointSucesso) {
              endpointSucesso = {
                cod: codSerAtual,
                urlBase:
                  'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?',
                nome: endpointUtilizado,
                isServico: true,
              }
            }
          }
        }
      }

      // 2.B Executar consultas para MATERIAIS (CATMAT) usando /modulo-pesquisa-preco/1_consultarMaterial
      // B10: Código de serviço nunca vai para rota de material
      if (codigosCatmatIdentificados.length > 0 && tipoCatalogo !== 'servico') {
        for (var ci = 0; ci < codigosCatmatIdentificados.length; ci++) {
          var codAtual = codigosCatmatIdentificados[ci]
          var urlAssinaturaNova =
            'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
            montarQueryParams(paginaParam, tamPaginaParam, codAtual)

          var attNova = fetchEndpoint(urlAssinaturaNova, 4.0)
          if (!attNova.ok || (attNova.resp && attNova.resp.statusCode >= 400)) {
            falhaHttpOcorrida = true
            mensagemErroHttp =
              attNova.error || 'HTTP ' + (attNova.resp ? attNova.resp.statusCode : 'erro')
            continue
          }
          var bodyNova = parseJsonBody(attNova)
          if (!respostaPrecoValida(bodyNova)) {
            falhaHttpOcorrida = true
            mensagemErroHttp = 'JSON ou schema incompatível na resposta oficial de materiais.'
            continue
          }
          if (bodyNova !== null) {
            rotaCatalogoConsultadaComSucesso = true
            var itensNovos = extractItems(bodyNova)
            for (var mIdx = 0; mIdx < itensNovos.length; mIdx++) {
              var itMat = itensNovos[mIdx]
              itMat.tipoItem = 'MATERIAL'
              itMat.codigoCatmat = codAtual
              todosRegistros.push(itMat)
            }
            endpointUtilizado =
              'modulo-pesquisa-preco/1_consultarMaterial (tipo=codigoItemCatalogo&codigo=' +
              codAtual +
              ')'
            var tot =
              typeof bodyNova.totalRegistros === 'number'
                ? bodyNova.totalRegistros
                : typeof bodyNova.total === 'number'
                  ? bodyNova.total
                  : itensNovos.length
            totalRegistrosGeral += tot
            totalPaginasGeral = Math.max(
              totalPaginasGeral,
              typeof bodyNova.totalPaginas === 'number'
                ? bodyNova.totalPaginas
                : Math.ceil(tot / tamPaginaParam),
            )
            if (!endpointSucesso) {
              endpointSucesso = {
                cod: codAtual,
                urlBase:
                  'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?',
                nome: endpointUtilizado,
                isServico: false,
              }
            }
          }
        }
      }

      // B6: Se a rota de catálogo respondeu HTTP 200 válido (mesmo com 0 ou 2 registros),
      // NÃO disparar módulos secundários ARP/14133/legado.
      // Só consulta módulos secundários se NENHUMA rota oficial de catálogo (CATMAT/CATSER) foi consultada com sucesso.
      if (!rotaCatalogoConsultadaComSucesso && !codigoExplicitoInformado) {
        // 3. Módulo de ARP (Atas de Registro de Preço)
        if (codigosCatmatIdentificados.length > 0 && tipoCatalogo !== 'servico') {
          for (var ca = 0; ca < Math.min(2, codigosCatmatIdentificados.length); ca++) {
            var codArp = codigosCatmatIdentificados[ca]
            var urlArp =
              'https://dadosabertos.compras.gov.br/modulo-arp/1_consultarItemArp?codigoItemCatalogo=' +
              encodeURIComponent(codArp) +
              '&pagina=' +
              paginaParam +
              '&tamanhoPagina=' +
              tamPaginaParam +
              (uf ? '&estado=' + encodeURIComponent(uf) : '')

            var attArp = fetchEndpoint(urlArp, 2.5)
            var bodyArp = parseJsonBody(attArp)
            if (bodyArp) {
              var itensArp = extractItems(bodyArp)
              if (itensArp && itensArp.length > 0) {
                for (var aIdx = 0; aIdx < itensArp.length; aIdx++) {
                  var itArp = itensArp[aIdx]
                  itArp.modalidadeCompra =
                    itArp.modalidadeCompra || 'Ata de Registro de Preços (ARP)'
                  itArp.origemModulo = 'modulo-arp'
                  todosRegistros.push(itArp)
                }
                totalRegistrosGeral += bodyArp.totalRegistros || itensArp.length
                totalPaginasGeral = Math.max(totalPaginasGeral, bodyArp.totalPaginas || 1)
                break
              }
            }
          }
        }

        // 4. Estratégia Híbrida: Busca textual por descrição apenas se não temos código de catálogo
        if (
          todosRegistros.length === 0 &&
          termoSanitizado &&
          tipoCatalogo !== 'servico' &&
          !codigoExplicitoInformado
        ) {
          var urlTexto =
            'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
            encodeURIComponent(termoSanitizado) +
            '&pagina=' +
            paginaParam +
            '&tamanhoPagina=' +
            tamPaginaParam +
            (uf ? '&estado=' + encodeURIComponent(uf) : '')

          var attTexto = fetchEndpoint(urlTexto, 4.0)
          var bodyTexto = parseJsonBody(attTexto)
          if (bodyTexto) {
            var itensTexto = extractItems(bodyTexto)
            if (itensTexto && itensTexto.length > 0) {
              todosRegistros = todosRegistros.concat(itensTexto)
              endpointUtilizado =
                'modulo-pesquisa-preco/1_consultarMaterial (descricaoItem=' + termoSanitizado + ')'
              totalRegistrosGeral += bodyTexto.totalRegistros || itensTexto.length
              totalPaginasGeral = Math.max(totalPaginasGeral, bodyTexto.totalPaginas || 1)
            }
          }
        }

        // 5. Integração com Contratações Lei 14.133
        if (todosRegistros.length === 0 && termoSanitizado && !codigoExplicitoInformado) {
          var url14133 =
            'https://dadosabertos.compras.gov.br/modulo-contratacoes-14133/1_consultarContratacoesItem?descricaoItem=' +
            encodeURIComponent(termoSanitizado) +
            '&pagina=' +
            paginaParam +
            '&tamanhoPagina=' +
            tamPaginaParam +
            (uf ? '&estado=' + encodeURIComponent(uf) : '')

          var att14133 = fetchEndpoint(url14133, 4.0)
          var body14133 = parseJsonBody(att14133)
          if (body14133) {
            var itens14133 = extractItems(body14133)
            if (itens14133 && itens14133.length > 0) {
              for (var idx14 = 0; idx14 < itens14133.length; idx14++) {
                var it14 = itens14133[idx14]
                it14.modalidadeCompra = it14.modalidadeCompra || 'Contratação Lei 14.133/2021'
                it14.origemModulo = 'modulo-contratacoes-14133'
                todosRegistros.push(it14)
              }
              totalRegistrosGeral += body14133.totalRegistros || itens14133.length
            }
          }
        }
      }

      // 4. Paginação complementar se solicitada e se encontrou endpoint funcional
      // Processa até todas as páginas disponíveis ou o limite solicitado pelo chamador
      if (paginacaoTotal && endpointSucesso && totalPaginasGeral > 1 && paginaParam === 1) {
        var maxPags = Math.min(totalPaginasGeral, limitePaginasMax)
        var inicioPaginacaoExtra = new Date().getTime()
        for (var p = 2; p <= maxPags && new Date().getTime() - inicioPaginacaoExtra < 6000; p++) {
          var urlProx = endpointSucesso.isServico
            ? 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?' +
              montarQueryParamsServico(p, tamPaginaParam, endpointSucesso.cod)
            : 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
              montarQueryParams(p, tamPaginaParam, endpointSucesso.cod)
          var attProx = fetchEndpoint(urlProx, 4)
          var bodyProx = parseJsonBody(attProx)
          var itensProx = extractItems(bodyProx)
          if (itensProx && itensProx.length > 0) {
            for (var ipIdx = 0; ipIdx < itensProx.length; ipIdx++) {
              var itP = itensProx[ipIdx]
              if (endpointSucesso.isServico) {
                itP.tipoItem = 'SERVICO'
                itP.codigoCatser = endpointSucesso.cod
              } else {
                itP.tipoItem = 'MATERIAL'
                itP.codigoCatmat = endpointSucesso.cod
              }
              todosRegistros.push(itP)
            }
          }
        }
      }

      // B8: Somente campos oficiais de unidade; descrição não comprova a unidade de fornecimento.
      // Unidade ausente permanece ausente; nunca inventar quantidade 1.
      function obterUnidadeOficialCgov(it) {
        var oficial =
          (it.siglaUnidadeFornecimento || '').trim() ||
          (it.nomeUnidadeFornecimento || '').trim() ||
          (it.unidadeFornecimento || '').trim() ||
          (it.siglaUnidadeMedida || '').trim() ||
          (it.nomeUnidadeMedida || '').trim() ||
          (it.unidadeMedida || '').trim() ||
          (it.unidade || '').trim()

        if (oficial) {
          // Preserve the official supply-unit label (including HR/H/MÊS).
          return oficial
        }

        return ''
      }

      // 5. Deduplicação defensiva e propagação de metadados (B9)
      // Chave única: fornecedor (CNPJ ou nome) + uasg + item/id + valor
      var seenKeys = {}
      var registrosUnicos = []
      for (var k = 0; k < todosRegistros.length; k++) {
        var it = todosRegistros[k]
        var cnpjForn =
          it.cnpjFornecedor || it.cpfCnpjFornecedor || it.niFornecedor || it.nomeFornecedor || ''
        var precoUn =
          it.precoUnitarioHomologado ??
          it.valorUnitario ??
          it.precoUnitario ??
          it.precoPraticado ??
          ''
        var seqIt = it.numeroItem ?? it.numeroItemCompra ?? it.item ?? it.codigoItem ?? k
        var uasgCod = it.codigoUasg || it.uasg || ''

        var idCompraOficial = it.idCompra || it.codigoCompra || ''
        var idItemOficial = it.idItemCompra || ''
        var chaveDedup =
          idCompraOficial || idItemOficial
            ? JSON.stringify([
                it.tipoItem || '',
                idCompraOficial,
                idItemOficial || seqIt,
                it.dataResultado || it.dataHomologacao || it.dataCompra || '',
                cnpjForn,
              ])
            : JSON.stringify(['legacy', cnpjForn, uasgCod, seqIt, precoUn])

        if (!seenKeys[chaveDedup]) {
          seenKeys[chaveDedup] = true

          // B8: Unidade oficial sem coerção indevida para UN
          var uFinal = obterUnidadeOficialCgov(it)
          if (uFinal) {
            it.unidadeMedida = uFinal
            it.unidade = uFinal
          }

          // B9: Propagar identidade/localidade sem renomear a natureza das datas oficiais.
          if (it.estado && !it.uf) {
            it.uf = String(it.estado).toUpperCase()
          }
          if (!it.idCompra && it.codigoCompra) {
            it.idCompra = it.codigoCompra
          }
          if (!it.numeroItemCompra && it.numeroItem) {
            it.numeroItemCompra = it.numeroItem
          }
          registrosUnicos.push(it)
        }
      }

      function comprasReceiptOfficialUrl(value) {
        if (typeof value !== 'string' || /[\s\\]/.test(value) || value.indexOf('#') >= 0) return ''
        var match = value.match(/^https:\/\/([a-z0-9.-]+)(\/[^#]*)?$/i)
        if (!match) return ''
        var host = match[1].toLowerCase()
        if (!/\.gov\.br$/.test(host) || host === 'catalogo.compras.gov.br') return ''
        var labels = host.split('.')
        for (var h = 0; h < labels.length; h++) {
          if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(labels[h])) return ''
        }
        return value
      }
      function comprasReceiptNormalize(value) {
        if (!value) return ''
        return String(value)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
          .replace(/[^A-Z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      }
      function comprasReceiptSampleKey(sourceRecordId, itemId, orgCnpj, supplierCnpj, price) {
        return (
          'COMPRASGOVBR#' +
          sourceRecordId.replace(/[^A-Z0-9_-]/gi, '') +
          '#' +
          itemId +
          '#' +
          String(orgCnpj || supplierCnpj || '').replace(/\D/g, '') +
          '#' +
          Number(price).toFixed(4).replace('.', '_')
        )
      }
      function comprasReceiptRowContract(row) {
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
      function comprasReceiptClaim(it, index, queryHash) {
        var fields = ['precoUnitarioHomologado', 'valorUnitario', 'precoUnitario', 'precoPraticado']
        var unitField = ''
        for (var pf = 0; pf < fields.length; pf++) {
          if (isFinite(Number(it[fields[pf]])) && Number(it[fields[pf]]) > 0) {
            unitField = fields[pf]
            break
          }
        }
        if (!unitField) return null
        var service = it.tipoItem === 'SERVICO' || !!it.codigoCatser
        var namespace = service ? 'CATSER' : 'CATMAT'
        var code = String(
          it.codigoItemCatalogo || (service ? it.codigoCatser : it.codigoCatmat) || '',
        )
        var purchase = String(it.idCompra != null ? it.idCompra : it.codigoCompra || it.id || '')
        var item = String(
          it.idItemCompra != null
            ? it.idItemCompra
            : it.numeroItemCompra != null
              ? it.numeroItemCompra
              : it.numeroItem != null
                ? it.numeroItem
                : it.id || '',
        )
        var dateFields = [
          'dataResultado',
          'dataHomologacao',
          'dataCompra',
          'dataAssinatura',
          'data_resultado',
          'data_compra',
        ]
        var date = ''
        var dateField = ''
        for (var df = 0; df < dateFields.length; df++) {
          if (it[dateFields[df]] != null) {
            date = String(it[dateFields[df]])
            dateField = dateFields[df]
            break
          }
        }
        var supplier = String(
          it.cnpjFornecedor ||
            it.cpfCnpjFornecedor ||
            it.niFornecedor ||
            it.nomeFornecedor ||
            it.razaoSocial ||
            '',
        )
        if (!code || !purchase || !item || !date || !supplier) return null
        var sourceRecordId = [namespace, purchase, item, date, supplier]
          .map(encodeURIComponent)
          .join('#')
        var itemId = String(
          (it.numeroItemCompra != null ? it.numeroItemCompra : it.numeroItem) || 1,
        )
        var description = String(
          it.descricaoItem || it.descricao || it.item || 'NÃO INFORMADO',
        ).trim()
        var detailedDescription = it.descricaoDetalhadaItem
        if (typeof detailedDescription === 'string' && detailedDescription.trim()) {
          var basicDescription = String(it.descricaoItem || it.descricao || it.item || '')
          // Compare whitespace only; keep official spelling, units and both distinct texts.
          description =
            !basicDescription.trim() ||
            basicDescription.trim().replace(/\s+/g, ' ') ===
              detailedDescription.trim().replace(/\s+/g, ' ')
              ? detailedDescription
              : basicDescription + '\n' + detailedDescription
        }
        var evidence = ''
        var links = [it.linkEditalOuCompra, it.link_resultado, it.url]
        for (var li = 0; li < links.length && !evidence; li++)
          evidence = comprasReceiptOfficialUrl(links[li])
        if (!evidence && grupoPdm && consultaPreco) evidence = consultaPreco.urlOficial
        if (!evidence) {
          evidence = service
            ? 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?codigoItemCatalogo=' +
              encodeURIComponent(code)
            : 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
              encodeURIComponent(code)
          evidence += '&pagina=' + paginaParam + '&tamanhoPagina=' + tamPaginaParam
          if (uf) evidence += '&estado=' + encodeURIComponent(uf)
          if (dataInicio)
            evidence += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
          if (dataFim) evidence += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
        }
        var official = Object.assign({}, it)
        delete official._cotai_ingestion_claim
        delete official._cotai_index_row
        var recordHash = $security.sha256(officialReceiptCanonical(official)).toLowerCase()
        var key = $security
          .sha256('Compras.gov.br|' + queryHash + '|' + recordHash + '|' + index)
          .toLowerCase()
        var quantityRaw = Number(
          it.quantidade != null
            ? it.quantidade
            : it.quantidadeItem != null
              ? it.quantidadeItem
              : it.quantidadeTotal != null
                ? it.quantidadeTotal
                : it.quantidadeHomologada,
        )
        var quantity = isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 0
        var totalRaw = Number(it.valorTotal != null ? it.valorTotal : it.precoTotal)
        var total =
          isFinite(totalRaw) && totalRaw > 0
            ? totalRaw
            : quantity > 0
              ? Number(it[unitField]) * quantity
              : null
        var unit =
          String(
            it.unidadeMedida ||
              it.siglaUnidadeFornecimento ||
              it.siglaUnidadeMedida ||
              it.unidadeFornecimento ||
              it.nomeUnidadeFornecimento ||
              it.unidade ||
              '',
          ).trim() || 'NÃO INFORMADO'
        var supplierCnpj = String(
          it.cnpjFornecedor || it.cpfCnpjFornecedor || it.niFornecedor || '',
        )
        var orgCnpj = String(it.cnpjOrgao || it.cnpj || '')
        var context = {
          tipo: service ? 'servico' : 'material',
          codigo: code,
          pagina: paginaParam,
          tamanhoPagina: tamPaginaParam,
        }
        if (uf) context.estado = uf
        if (grupoPdm) {
          context.seletor = 'codigoPdm'
          context.codigoPdm = codigoPdm
          context.urlConsultaOficial = consultaPreco.urlOficial
          if (dataInicio) context.dataCompraInicio = dataInicio
          if (dataFim) context.dataCompraFim = dataFim
        } else {
          if (dataInicio) context.dataInicial = dataInicio.replace(/-/g, '')
          if (dataFim) context.dataFinal = dataFim.replace(/-/g, '')
        }
        var proof = {
          versao: 1,
          status: 'verificada',
          fonte: 'Compras.gov.br',
          campo_unitario: unitField,
          valor_unitario: Number(it[unitField]),
          natureza: it.precoUnitarioHomologado != null ? 'homologado' : 'contratado',
          url_evidencia: evidence,
          identidade: {
            tipo: service ? 'servico' : 'material',
            codigoCatalogo: code,
            idCompra: it.idCompra != null ? it.idCompra : it.codigoCompra,
            // Keep absent optional identities stable when the receipt crosses JSON.
            idItemCompra: it.idItemCompra != null ? it.idItemCompra : null,
            numeroItemCompra:
              it.numeroItemCompra != null
                ? it.numeroItemCompra
                : it.numeroItem != null
                  ? it.numeroItem
                  : null,
            fornecedor: supplier,
          },
          registro_oficial: official,
          data_oficial: date || null,
          campo_data: dateField || null,
          contexto_consulta: context,
        }
        var details = {
          numeroItem: itemId,
          codigo_item: code,
          tipoCatalogo: namespace,
          proveniencia_preco: proof,
        }
        var row = {
          source: 'Compras.gov.br',
          source_record_id: sourceRecordId,
          purchase_id: sourceRecordId,
          item_id: itemId,
          descricao: description,
          descricao_normalizada: comprasReceiptNormalize(description),
          orgao: String(it.orgaoComprador || it.nomeOrgao || it.nomeUasg || 'NÃO INFORMADO'),
          orgao_cnpj: orgCnpj,
          fornecedor_nome: String(
            it.nomeFornecedor ||
              it.razaoSocial ||
              (typeof it.fornecedor === 'string' ? it.fornecedor : '') ||
              'NÃO INFORMADO',
          ),
          fornecedor_cnpj: supplierCnpj,
          fornecedor_porte: String(it.porteFornecedor || 'NÃO INFORMADO'),
          uf: String(it.uf || it.estado || it.siglaUf || ''),
          municipio: String(it.municipio || ''),
          unidade: unit,
          quantidade: quantity,
          valor_unitario: Number(it[unitField]),
          valor_total: total,
          natureza_preco: 'homologado',
          data_referencia: date,
          numero_processo: String(it.numeroProcesso || purchase),
          numero_ata: '',
          modalidade: String(it.modalidadeCompra || it.modalidade || ''),
          marca: String(it.marca || 'NÃO INFORMADO'),
          codigo_item: namespace + ' ' + code,
          url_original: evidence,
          raw_payload: details,
        }
        row.sample_key = comprasReceiptSampleKey(
          sourceRecordId,
          itemId,
          orgCnpj,
          supplierCnpj,
          Number(it[unitField]),
        )
        var rowHash = $security
          .sha256(officialReceiptCanonical(comprasReceiptRowContract(row)))
          .toLowerCase()
        it._cotai_ingestion_claim = key
        it._cotai_index_row = row
        return {
          key: key,
          record_hash: recordHash,
          row_hash: rowHash,
          source_record_id: sourceRecordId,
          item_id: itemId,
          description: description,
          unit_price: Number(it[unitField]),
          url_original: evidence,
        }
      }

      // B9: Se não encontrou registros e houve falha HTTP (ex: 404, 500, timeout na API upstream), retornar erro estruturado, não sucesso com 0
      if (registrosUnicos.length === 0 && falhaHttpOcorrida && !rotaCatalogoConsultadaComSucesso) {
        return traceJson(
          upstreamThrottle ? 429 : 502,
          withThrottle({
            fonte: 'compras_gov',
            endpoint: endpointUtilizado,
            sucesso: false,
            error: 'UPSTREAM_HTTP_ERROR',
            message: upstreamThrottle
              ? 'A API oficial do Compras.gov.br limitou temporariamente as consultas.'
              : 'A API oficial do Compras.gov.br retornou erro na consulta: ' + mensagemErroHttp,
            codigosCatalogoTentados: codigosCatalogoIdentificados,
          }),
        )
      }

      // 6. Resposta estruturada limpa (B6: 200 com 0, 1 ou 2 registros preserva total/página/tamanho)
      if (registrosUnicos.length === 0) {
        return traceJson(
          200,
          withThrottle({
            fonte: 'compras_gov',
            endpoint: endpointUtilizado,
            sucesso: true,
            totalEncontrados: totalRegistrosGeral,
            totalPaginas: totalPaginasGeral,
            paginaAtual: paginaParam,
            tamPagina: tamPaginaParam,
            codigosCatalogoTentados: codigosCatalogoIdentificados,
            dados: {
              resultado: [],
              totalRegistros: totalRegistrosGeral,
              totalPaginas: totalPaginasGeral,
            },
            aviso:
              'Nenhuma contratação homologada foi localizada no Compras.gov.br para o item de catálogo (' +
              (grupoPdm
                ? 'PDM ' + codigoPdm
                : codigosCatserIdentificados.length > 0
                  ? 'CATSER ' + codigosCatserIdentificados.join(', ')
                  : 'CATMAT ' + codigosCatmatIdentificados.join(', ')) +
              ').',
          }),
        )
      }

      var comprasReceipt = null
      var comprasReceipts = []
      try {
        var comprasQueryMaterial = {
          route: '/backend/v1/cotai/comprasgov-search',
          termo: termoSanitizado,
          tipo: tipoCatalogo,
          catmat: catmat,
          catser: catser,
          codigo_item: codigoItem,
          codigo_pdm: grupoPdm ? codigoPdm : '',
          uf: uf,
          pagina: paginaParam,
          tamanho: tamPaginaParam,
          data_inicio: dataInicio,
          data_fim: dataFim,
        }
        var comprasQueryHash = $security
          .sha256(officialReceiptCanonical(comprasQueryMaterial))
          .toLowerCase()
        var comprasClaims = []
        for (var cr = 0; cr < registrosUnicos.length; cr++) {
          var comprasClaim = comprasReceiptClaim(registrosUnicos[cr], cr, comprasQueryHash)
          if (comprasClaim) {
            registrosUnicos[cr]._cotai_ingestion_receipt_index = Math.floor(
              comprasClaims.length / 500,
            )
            comprasClaims.push(comprasClaim)
          }
        }
        for (var cChunk = 0; cChunk < comprasClaims.length; cChunk += 500) {
          var cReceipt = issueOfficialReceipt(
            'Compras.gov.br',
            comprasQueryMaterial,
            comprasClaims.slice(cChunk, cChunk + 500),
          )
          if (cReceipt) comprasReceipts.push(cReceipt)
        }
        comprasReceipt = comprasReceipts.length ? comprasReceipts[0] : null
      } catch (_) {
        return traceJson(503, {
          sucesso: false,
          error: 'RECEIPT_UNAVAILABLE',
          message: 'A prova temporária da página oficial não pôde ser emitida.',
        })
      }

      return traceJson(
        200,
        withThrottle({
          fonte: 'compras_gov',
          endpoint: endpointUtilizado,
          sucesso: true,
          totalEncontrados: grupoPdm
            ? totalRegistrosGeral
            : Math.max(totalRegistrosGeral, registrosUnicos.length),
          totalPaginas: totalPaginasGeral,
          paginaAtual: paginaParam,
          tamPagina: tamPaginaParam,
          codigosCatalogoTentados: codigosCatalogoIdentificados,
          ingestion_receipt: comprasReceipt,
          ingestion_receipts: comprasReceipts,
          dados: {
            resultado: registrosUnicos,
            totalRegistros: grupoPdm
              ? totalRegistrosGeral
              : Math.max(totalRegistrosGeral, registrosUnicos.length),
            totalPaginas: totalPaginasGeral,
          },
          diagnostico_fluxo: {
            api_origem: 'Compras.gov.br (dadosabertos.compras.gov.br)',
            registros_informados_api: totalRegistrosGeral,
            paginas_informadas_api: totalPaginasGeral,
            registros_brutos_recebidos: todosRegistros.length,
            amostras_processadas_unicas: registrosUnicos.length,
            etapa: 'backend_comprasgov_search_hook',
          },
        }),
      )
    } catch (globalErr) {
      tracePhase('handler_catch')
      // Resposta defensiva estruturada: nunca derruba lote nem desloga usuário
      return traceJson(200, {
        fonte: 'compras_gov',
        endpoint: 'modulo-pesquisa-preco/1_consultarMaterial',
        sucesso: false,
        totalEncontrados: 0,
        totalPaginas: 0,
        paginaAtual: 1,
        tamPagina: 25,
        dados: {
          resultado: [],
          totalRegistros: 0,
          totalPaginas: 0,
        },
        aviso:
          'A API pública do Compras.gov.br (dadosabertos.compras.gov.br) retornou indisponibilidade temporária. A busca das outras fontes permaneceu ativa.',
        erro: globalErr ? globalErr.message : 'Erro na chamada ao Compras.gov.br',
      })
    } finally {
      tracePhase('handler_exit')
    }
  },
  $apis.requireAuth(),
)
