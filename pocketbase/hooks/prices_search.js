// Busca oficial: índice otimizado, prova unitária, ciclo diário e diagnóstico de capacidade.
//
// Invariantes desta fronteira:
// - somente linhas seladas pelo servidor (v3/server-v1) e com preço positivo;
// - texto sempre passa pela FTS5 (sem LIKE/JSON por linha e sem fallback lento);
// - página, total, agregações e percentis da primeira resposta vêm de uma única
//   instrução SQL e, portanto, do mesmo snapshot SQLite;
// - as rotas não consultam fontes externas e nunca materializam a população em JS.
//
// As funções auxiliares permanecem dentro de cada callback. O pool JSVM do
// PocketBase pode reutilizar callbacks em runtimes distintos e não deve depender
// de closures globais mutáveis.

routerAdd(
  'POST',
  '/backend/v1/prices/search',
  function (e) {
    var startedAt = new Date().getTime()
    if (!e.auth || !e.auth.id)
      return e.json(401, {
        sucesso: false,
        code: 'AUTH_REQUIRED',
        error: 'Autenticação obrigatória.',
      })
    var requestContext = e.request.context()
    var capacityEntryContext = requestContextState()
    var capacityStage = 'not_started'
    var capacityDiagnosticId = null
    var phaseTimes = {
      rate_ms: 0,
      tx_enter_ms: 0,
      summary_ms: 0,
      validate100_ms: 0,
      snapshot_ms: 0,
      tx_commit_ms: 0,
      total_ms: 0,
    }
    var summaryStreamTiming = null

    function logSearchTiming() {
      try {
        phaseTimes.total_ms = Math.max(0, new Date().getTime() - startedAt)
        console.log('[PRICES-SEARCH:TIMING] ' + JSON.stringify(phaseTimes))
        if (summaryStreamTiming)
          console.log('[PRICES-SEARCH:SUMMARY-STREAM] ' + JSON.stringify(summaryStreamTiming))
      } catch (_) {}
    }

    // Split the same summary statement at the documented dbx.Rows boundaries.
    // Unsupported runtimes keep the original all() path; errors never rerun SQL.
    function readSummaryRows(boundQuery, fallbackRows) {
      if (typeof boundQuery.rows !== 'function') {
        boundQuery.all(fallbackRows)
        summaryStreamTiming = { mode: 'unavailable', row_count: fallbackRows.length }
        return fallbackRows
      }
      var timing = {
        mode: 'rows',
        open_ms: 0,
        first_next_ms: 0,
        next_ms: 0,
        scan_ms: 0,
        row_count: 0,
      }
      var result = []
      var openStartedAt = new Date().getTime()
      var cursor = boundQuery.rows()
      try {
        timing.open_ms = Math.max(0, new Date().getTime() - openStartedAt)
        var firstNext = true
        while (true) {
          var nextStartedAt = new Date().getTime()
          var hasNext = cursor.next()
          var nextMs = Math.max(0, new Date().getTime() - nextStartedAt)
          if (firstNext) timing.first_next_ms = nextMs
          firstNext = false
          // Cumulative next time includes the first and the terminal false step.
          timing.next_ms += nextMs
          if (!hasNext) break
          var scanStartedAt = new Date().getTime()
          var row = new DynamicModel(hitShape())
          cursor.scanStruct(row)
          timing.scan_ms += Math.max(0, new Date().getTime() - scanStartedAt)
          result.push(row)
          timing.row_count++
        }
        // Native Go errors throw; also reject an explicit returned error.
        var cursorError = cursor.err()
        if (cursorError != null) throw cursorError
      } finally {
        cursor.close()
      }
      summaryStreamTiming = timing
      return result
    }

    // Planos lentos são registrados sem valores da consulta.
    function logSearchPlan(spec, order, binds) {
      try {
        var planRows = arrayOf(new DynamicModel({ id: 0, parent: 0, notused: 0, detail: '' }))
        query('EXPLAIN QUERY PLAN ' + summarySql(spec, order))
          .bind(binds)
          .all(planRows)
        if (!planRows.length) return
        var prefix = '[PRICES-SEARCH:PLAN] '
        var plan = { steps: [], truncated: planRows.length > 80 }
        for (var i = 0; i < planRows.length && i < 80; i++) {
          var row = planRows[i]
          if (
            !Number.isSafeInteger(row.id) ||
            row.id < 0 ||
            !Number.isSafeInteger(row.parent) ||
            row.parent < 0 ||
            !Number.isSafeInteger(row.notused) ||
            row.notused < 0 ||
            typeof row.detail !== 'string'
          )
            return
          var detail = row.detail.replace(/[^\x20-\x7e]/g, ' ')
          if (detail.length > 512) plan.truncated = true
          plan.steps.push({
            id: row.id,
            parent: row.parent,
            notused: row.notused,
            detail: detail.slice(0, 512),
          })
          if ((prefix + JSON.stringify(plan)).length > 8192) {
            plan.steps.pop()
            plan.truncated = true
            break
          }
        }
        console.log(prefix + JSON.stringify(plan))
      } catch (_) {}
    }

    function requestContextState() {
      var error
      try {
        error = requestContext.err()
      } catch (contextError) {
        error = contextError
      }
      if (error == null) return 'active'
      try {
        var message = String(error && (error.message || error))
        if (/\bcontext deadline exceeded\b/i.test(message)) return 'context_deadline'
        if (/\bcontext (?:canceled|cancelled)\b/i.test(message)) return 'context_canceled'
      } catch (_) {}
      return 'unknown'
    }

    function logSearchFailure(phase, error) {
      try {
        var codes = {
          capacity: 'SEARCH_RATE_LIMIT_UNAVAILABLE',
          snapshot_read: 'SEARCH_SNAPSHOT_UNAVAILABLE',
          snapshot_write: 'SEARCH_SNAPSHOT_UNAVAILABLE',
          fts: 'SEARCH_INDEX_UNAVAILABLE',
          query: 'SEARCH_QUERY_FAILED',
        }
        if (!Object.prototype.hasOwnProperty.call(codes, phase)) return
        var message = String(error && (error.message || error))
        var motivo =
          message === 'snapshot_size_or_population_mismatch'
            ? 'snapshot_size_or_population_mismatch'
            : /\bcontext deadline exceeded\b/i.test(message)
              ? 'context_deadline'
              : /\bcontext (?:canceled|cancelled)\b/i.test(message)
                ? 'context_canceled'
                : 'other'
        var diagnostic = {
          code: codes[phase],
          phase: phase,
          duracao_ms: new Date().getTime() - startedAt,
          motivo: motivo,
        }
        if (phase === 'capacity') {
          diagnostic.diagnostic_id = capacityDiagnosticId
          diagnostic.capacity_stage = capacityStage
          diagnostic.context_entry = capacityEntryContext
          diagnostic.context_failure = requestContextState()
        }
        console.log('[PRICES-SEARCH:FAILURE] ' + JSON.stringify(diagnostic))
      } catch (_) {}
    }

    function query(sql) {
      if (requestContext.err()) throw new Error('context canceled')
      return $app.db().newQuery(sql).withContext(requestContext)
    }

    function normalize(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/(\d+)\s*(MG|ML|MCG|KG|G|L)\b/g, '$1$2')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function meaningfulTokens(value) {
      var ignored = {
        A: true,
        O: true,
        AS: true,
        OS: true,
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
        ITEM: true,
        LOTE: true,
        AQUISICAO: true,
        FORNECIMENTO: true,
        REGISTRO: true,
        PRECOS: true,
      }
      var normalized = normalize(value)
      if (!normalized) return []
      var parts = normalized.split(/\s+/)
      var result = []
      var seen = {}
      for (var i = 0; i < parts.length; i++) {
        var token = parts[i]
        if (token.length < 2 || ignored[token] || seen[token]) continue
        seen[token] = true
        result.push(token)
      }
      return result
    }

    function sourceName(value) {
      var normalized = normalize(value)
      if (normalized === 'PNCP') return 'PNCP'
      if (normalized === 'COMPRAS GOV BR' || normalized === 'COMPRASGOVBR') return 'Compras.gov.br'
      return ''
    }

    function rounded(value) {
      var number = Number(value)
      return isFinite(number) ? Number(number.toFixed(4)) : 0
    }

    function parsedObject(value) {
      if (!value) return {}
      if (typeof value === 'object') return value
      try {
        var parsed = JSON.parse(String(value))
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (_) {
        return {}
      }
    }

    function ftsFailure(error) {
      var message = String(error && (error.message || error))
      return /price_samples_fts|fts5|match|no such table|virtual table/i.test(message)
    }

    function normalizedSql(column) {
      var expression = 'UPPER(COALESCE(' + column + ", ''))"
      var replacements = [
        ['Á', 'A'],
        ['À', 'A'],
        ['Â', 'A'],
        ['Ã', 'A'],
        ['Ä', 'A'],
        ['É', 'E'],
        ['È', 'E'],
        ['Ê', 'E'],
        ['Ë', 'E'],
        ['Í', 'I'],
        ['Ì', 'I'],
        ['Î', 'I'],
        ['Ï', 'I'],
        ['Ó', 'O'],
        ['Ò', 'O'],
        ['Ô', 'O'],
        ['Õ', 'O'],
        ['Ö', 'O'],
        ['Ú', 'U'],
        ['Ù', 'U'],
        ['Û', 'U'],
        ['Ü', 'U'],
        ['Ç', 'C'],
        ['_', ' '],
        ['/', ' '],
        ['-', ' '],
        ['.', ' '],
        [',', ' '],
      ]
      for (var index = 0; index < replacements.length; index++)
        expression =
          'REPLACE(' +
          expression +
          ", '" +
          replacements[index][0] +
          "', '" +
          replacements[index][1] +
          "')"
      var compactUnits = ['MG', 'ML', 'MCG', 'KG', 'G', 'L']
      for (var unitIndex = 0; unitIndex < compactUnits.length; unitIndex++)
        expression =
          'REPLACE(' +
          expression +
          ", ' " +
          compactUnits[unitIndex] +
          "', '" +
          compactUnits[unitIndex] +
          "')"
      for (var whitespacePass = 0; whitespacePass < 3; whitespacePass++)
        expression = 'REPLACE(' + expression + ", '  ', ' ')"
      return expression
    }

    function validateRequest(params) {
      function invalid(code, error) {
        return { ok: false, code: code, error: error }
      }
      try {
        if (JSON.stringify(params).length > 8 * 1024)
          return invalid('SEARCH_INPUT_TOO_LARGE', 'Os parâmetros da busca excedem 8 KiB.')
      } catch (_) {
        return invalid('SEARCH_INPUT_INVALID', 'Parâmetros da busca inválidos.')
      }
      function first(names) {
        for (var index = 0; index < names.length; index++)
          if (params[names[index]] !== undefined && params[names[index]] !== null)
            return params[names[index]]
        return undefined
      }
      function optionalText(name, maxLength) {
        var value = params[name]
        if (value === undefined || value === null || value === '') return { ok: true, value: '' }
        if (typeof value !== 'string' || value.length > maxLength)
          return { ok: false, error: 'Filtro inválido: ' + name + '.' }
        return { ok: true, value: value.trim() }
      }
      function isoDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
        var parsed = new Date(value + 'T00:00:00.000Z')
        return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
      }
      function optionalPrice(name) {
        var value = params[name]
        if (value === undefined || value === null || value === '') return { ok: true, value: null }
        var parsed = Number(value)
        if (!isFinite(parsed) || parsed < 0 || parsed > 1000000000000000)
          return { ok: false, error: 'Faixa de preço inválida.' }
        return { ok: true, value: parsed }
      }
      function boundedInteger(value, fallback, minimum, maximum, label) {
        if (value === undefined || value === null || value === '')
          return { ok: true, value: fallback }
        var parsed = Number(value)
        if (
          !isFinite(parsed) ||
          Math.floor(parsed) !== parsed ||
          parsed < minimum ||
          parsed > maximum
        )
          return { ok: false, error: label + ' inválido.' }
        return { ok: true, value: parsed }
      }
      function optionalBoolean(value, label) {
        if (value === undefined || value === null || value === '') return { ok: true, value: false }
        if (value === true || value === 'true' || value === 1 || value === '1')
          return { ok: true, value: true }
        if (value === false || value === 'false' || value === 0 || value === '0')
          return { ok: true, value: false }
        return { ok: false, error: label + ' inválido.' }
      }

      var rawTerm = first(['termo', 'q', 'palavra_chave', 'termo_pesquisa', 'query'])
      if (typeof rawTerm !== 'string')
        return invalid('SEARCH_TERM_REQUIRED', 'Informe um produto ou serviço para pesquisar.')
      var term = rawTerm.trim()
      if (!term || term.length > 240)
        return invalid(
          term ? 'SEARCH_INPUT_TOO_LARGE' : 'SEARCH_TERM_REQUIRED',
          term
            ? 'O termo de busca excede 240 caracteres.'
            : 'Informe um produto ou serviço para pesquisar.',
        )
      var normalizedTerm = normalize(term)
      var catalog = normalizedTerm.match(/^(?:(CATMAT|CATSER)\s*)?(\d{4,8})$/)
      var tokens = meaningfulTokens(term)
      if (!catalog && !tokens.length)
        return invalid('SEARCH_TERM_INVALID', 'O termo não contém palavra significativa.')
      if (!catalog && tokens.length > 16)
        return invalid('SEARCH_INPUT_TOO_LARGE', 'Use no máximo 16 palavras significativas.')
      var exactPhrase = optionalBoolean(first(['palavra_exata', 'exact_phrase']), 'Modo de busca')
      if (!exactPhrase.ok) return invalid('SEARCH_INPUT_INVALID', exactPhrase.error)
      var rawCnpj = first(['cnpj'])
      var cnpj = ''
      if (rawCnpj !== undefined && rawCnpj !== null && rawCnpj !== '') {
        if (typeof rawCnpj !== 'string' || rawCnpj.length > 24 || !/^[\d.\/\-\s]+$/.test(rawCnpj))
          return invalid('SEARCH_INPUT_INVALID', 'CNPJ inválido.')
        cnpj = rawCnpj.replace(/\D/g, '')
        if (!/^\d{14}$/.test(cnpj)) return invalid('SEARCH_INPUT_INVALID', 'CNPJ inválido.')
      }

      var rawPage = first(['page', 'pagina'])
      var page = boundedInteger(rawPage, 1, 1, 1000, 'Página')
      if (!page.ok) return invalid('SEARCH_INPUT_INVALID', page.error)
      var limit = boundedInteger(first(['limit', 'tamanho_pagina']), 50, 1, 100, 'Limite')
      if (!limit.ok) return invalid('SEARCH_INPUT_INVALID', limit.error)
      var snapshotVersion = first(['snapshot_version'])
      if (snapshotVersion === undefined) snapshotVersion = 1
      if (snapshotVersion !== 1 && snapshotVersion !== 2)
        return invalid('SEARCH_INPUT_INVALID', 'Versão de snapshot inválida.')
      var cursor = first(['cursor'])
      var snapshot = first(['snapshot'])
      var hasCursor = cursor !== undefined && cursor !== null && cursor !== ''
      var hasSnapshot = snapshot !== undefined && snapshot !== null && snapshot !== ''
      if (hasCursor !== hasSnapshot)
        return invalid('SEARCH_CURSOR_INVALID', 'Cursor e snapshot devem ser enviados juntos.')
      if (
        (hasCursor && (typeof cursor !== 'string' || !/^pc[12]_[0-9a-f]{64}$/.test(cursor))) ||
        (hasSnapshot && (typeof snapshot !== 'string' || !/^ps[12]_[0-9a-f]{64}$/.test(snapshot)))
      )
        return invalid('SEARCH_CURSOR_INVALID', 'Cursor ou snapshot inválido.')
      if (
        hasCursor &&
        (cursor.slice(0, 3) !== 'pc' + snapshotVersion ||
          snapshot.slice(0, 3) !== 'ps' + snapshotVersion)
      )
        return invalid('SEARCH_CURSOR_INVALID', 'Versões de cursor e snapshot incompatíveis.')
      if (!hasCursor && page.value !== 1)
        return invalid(
          'SEARCH_CURSOR_REQUIRED',
          'Páginas seguintes exigem o cursor opaco da primeira resposta.',
        )
      if (hasCursor && rawPage !== undefined && rawPage !== null && rawPage !== '')
        return invalid('SEARCH_CURSOR_INVALID', 'Não envie página numérica junto com o cursor.')

      var textFields = [
        ['modalidade', 100],
        ['natureza_preco', 60],
        ['unidade', 100],
        ['marca', 100],
        ['porte', 60],
        ['sort', 40],
        ['ordenar', 40],
      ]
      var texts = {}
      for (var textIndex = 0; textIndex < textFields.length; textIndex++) {
        var checked = optionalText(textFields[textIndex][0], textFields[textIndex][1])
        if (!checked.ok) return invalid('SEARCH_INPUT_INVALID', checked.error)
        texts[textFields[textIndex][0]] = checked.value
      }

      var start = optionalText('data_inicio', 10)
      var end = optionalText('data_fim', 10)
      if (
        !start.ok ||
        !end.ok ||
        (start.value && !isoDate(start.value)) ||
        (end.value && !isoDate(end.value))
      )
        return invalid('SEARCH_INPUT_INVALID', 'Período explícito inválido.')
      if (start.value && end.value && start.value > end.value)
        return invalid(
          'SEARCH_INPUT_INVALID',
          'A data inicial não pode ser posterior à data final.',
        )
      var endExclusive = ''
      if (end.value) {
        var nextDay = new Date(end.value + 'T00:00:00.000Z')
        nextDay.setUTCDate(nextDay.getUTCDate() + 1)
        endExclusive = nextDay.toISOString().slice(0, 10)
      }

      var minimumPrice = optionalPrice('preco_min')
      var maximumPrice = optionalPrice('preco_max')
      if (!minimumPrice.ok || !maximumPrice.ok)
        return invalid('SEARCH_INPUT_INVALID', 'Faixa de preço inválida.')
      if (
        minimumPrice.value !== null &&
        maximumPrice.value !== null &&
        minimumPrice.value > maximumPrice.value
      )
        return invalid('SEARCH_INPUT_INVALID', 'O preço mínimo não pode superar o máximo.')

      var sourceInput = params.sources !== undefined ? params.sources : params.fontes
      if (
        !Array.isArray(sourceInput) &&
        sourceInput !== undefined &&
        sourceInput !== null &&
        sourceInput !== ''
      )
        sourceInput = [sourceInput]
      if (!sourceInput) sourceInput = []
      if (!Array.isArray(sourceInput) || sourceInput.length > 2)
        return invalid('SEARCH_INPUT_INVALID', 'Seleção de fontes inválida.')
      var canonicalSources = []
      var seenSources = {}
      for (var sourceIndex = 0; sourceIndex < sourceInput.length; sourceIndex++) {
        if (typeof sourceInput[sourceIndex] !== 'string' || sourceInput[sourceIndex].length > 32)
          return invalid('SEARCH_INPUT_INVALID', 'Seleção de fontes inválida.')
        var normalizedSource = normalize(sourceInput[sourceIndex])
        if (
          sourceInput.length === 1 &&
          (normalizedSource === 'TODAS' ||
            normalizedSource === 'TODOS' ||
            normalizedSource === 'AMBAS' ||
            normalizedSource === 'ALL')
        )
          continue
        var canonicalSource = sourceName(sourceInput[sourceIndex])
        if (!canonicalSource)
          return invalid('SEARCH_INPUT_INVALID', 'Fonte não permitida nesta pesquisa.')
        if (!seenSources[canonicalSource]) {
          canonicalSources.push(canonicalSource)
          seenSources[canonicalSource] = true
        }
      }
      if (!canonicalSources.length && params.fonte !== undefined && params.fonte !== null) {
        if (typeof params.fonte !== 'string' || params.fonte.length > 32)
          return invalid('SEARCH_INPUT_INVALID', 'Fonte inválida.')
        if (
          normalize(params.fonte) !== 'TODAS' &&
          normalize(params.fonte) !== 'TODOS' &&
          normalize(params.fonte) !== 'AMBAS' &&
          normalize(params.fonte) !== 'ALL'
        ) {
          var singleSource = sourceName(params.fonte)
          if (!singleSource)
            return invalid('SEARCH_INPUT_INVALID', 'Fonte não permitida nesta pesquisa.')
          canonicalSources.push(singleSource)
        }
      }

      var rawUf = first(['uf', 'estado'])
      var canonicalUf = 'ALL'
      if (rawUf !== undefined && rawUf !== null && rawUf !== '') {
        if (typeof rawUf !== 'string') return invalid('SEARCH_INPUT_INVALID', 'UF inválida.')
        var upperUf = rawUf.trim().toUpperCase()
        if (upperUf !== 'TODAS' && upperUf !== 'TODOS' && upperUf !== 'ALL') {
          if (!/^[A-Z]{2}$/.test(upperUf)) return invalid('SEARCH_INPUT_INVALID', 'UF inválida.')
          canonicalUf = upperUf
        }
      }

      var rawPeriod = first(['periodo_meses', 'periodo'])
      var months = 0
      if (
        rawPeriod !== undefined &&
        rawPeriod !== null &&
        rawPeriod !== '' &&
        String(rawPeriod) !== '0'
      ) {
        var normalizedPeriod = normalize(rawPeriod)
        if (normalizedPeriod !== 'TODOS' && normalizedPeriod !== 'TODAS') {
          var periodMatch = normalizedPeriod.match(/^(?:MESES?\s*)?(\d{1,3})$/)
          if (!periodMatch) return invalid('SEARCH_INPUT_INVALID', 'Período relativo inválido.')
          months = parseInt(periodMatch[1], 10)
          if (months < 1 || months > 240)
            return invalid('SEARCH_INPUT_INVALID', 'Período relativo inválido.')
        }
      }

      var onlyMeEpp =
        params.apenas_me_epp === true ||
        String(params.apenas_me_epp || '').toLowerCase() === 'true' ||
        String(params.apenas_me_epp || '') === '1'
      return {
        ok: true,
        term: term,
        normalizedTerm: normalizedTerm,
        catalog: catalog,
        tokens: tokens,
        exactPhrase: exactPhrase.value,
        cnpj: cnpj,
        page: page.value,
        limit: limit.value,
        dataStart: start.value,
        dataEndExclusive: endExclusive,
        minimumPrice: minimumPrice.value,
        maximumPrice: maximumPrice.value,
        sources: canonicalSources,
        canonicalUf: canonicalUf,
        months: months,
        modality: texts.modalidade,
        priceNature: texts.natureza_preco,
        unit: texts.unidade,
        brand: texts.marca,
        supplierSize: texts.porte,
        onlyMeEpp: onlyMeEpp,
        cursor: hasCursor ? cursor : '',
        snapshot: hasSnapshot ? snapshot : '',
        snapshotVersion: snapshotVersion,
      }
    }

    function consumeRateLimit(userId) {
      var accepted = false
      var identityCoverReady = false
      var projectionReady = false
      capacityStage = 'transaction_open'
      try {
        $app.runInTransaction(function (txApp) {
          capacityStage = 'rate_statement'
          var now = new Date()
          var nowIso = now.toISOString()
          var cutoff = new Date(now.getTime() - 60 * 1000).toISOString()
          var rows = arrayOf(
            new DynamicModel({
              request_count: 0,
              window_started_at: '',
              identity_cover_ready: 0,
              projection_ready: 0,
            }),
          )
          txApp
            .db()
            .newQuery(
              'INSERT INTO cotai_price_search_rate_limits (user_id, window_started_at, request_count, updated_at) ' +
                'VALUES ({:user_id}, {:now}, 1, {:now}) ' +
                'ON CONFLICT(user_id) DO UPDATE SET ' +
                'window_started_at = CASE WHEN julianday(cotai_price_search_rate_limits.window_started_at) <= julianday({:cutoff}) THEN excluded.window_started_at ELSE cotai_price_search_rate_limits.window_started_at END, ' +
                'request_count = CASE WHEN julianday(cotai_price_search_rate_limits.window_started_at) <= julianday({:cutoff}) THEN 1 ELSE cotai_price_search_rate_limits.request_count + 1 END, ' +
                'updated_at = excluded.updated_at ' +
                'WHERE julianday(cotai_price_search_rate_limits.window_started_at) <= julianday({:cutoff}) OR cotai_price_search_rate_limits.request_count < {:request_limit} ' +
                'RETURNING request_count, window_started_at, ' +
                // A colliding index name must not force an incompatible partial plan.
                "EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='price_samples_index' AND name='idx_psi_search_identity_cover_v1' " +
                "AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),'')) = 'createindexidx_psi_search_identity_cover_v1onprice_samples_index(id,valor_unitario,source,uf,data_referencia,server_trust_version,search_contract,qualidade_situacao)wheresearch_eligible=1') AS identity_cover_ready, EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_price_search_projection_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtablecotai_price_search_projection_v1(source_rowidintegerprimarykey,idtextunique,valor_unitarionumeric,sourcetext,uftext,data_referenciatext,server_trust_versiontext,search_contracttext,qualidade_situacaotext,search_eligiblenumeric,sample_keytextunique)') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_ai_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtriggercotai_search_projection_ai_v1afterinsertonprice_samples_indexbegininsertorreplaceintocotai_price_search_projection_v1values(new.rowid,new.id,new.valor_unitario,new.source,new.uf,new.data_referencia,new.server_trust_version,new.search_contract,new.qualidade_situacao,new.search_eligible,new.sample_key);end') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_ad_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtriggercotai_search_projection_ad_v1afterdeleteonprice_samples_indexbegindeletefromcotai_price_search_projection_v1wheresource_rowid=old.rowid;end') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_au_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtriggercotai_search_projection_au_v1afterupdateonprice_samples_indexwhennew.rowidisnotold.rowidornew.idisnotold.idornew.valor_unitarioisnotold.valor_unitarioornew.sourceisnotold.sourceornew.ufisnotold.ufornew.data_referenciaisnotold.data_referenciaornew.server_trust_versionisnotold.server_trust_versionornew.search_contractisnotold.search_contractornew.qualidade_situacaoisnotold.qualidade_situacaoornew.search_eligibleisnotold.search_eligibleornew.sample_keyisnotold.sample_keybegindeletefromcotai_price_search_projection_v1wheresource_rowid=old.rowid;insertorreplaceintocotai_price_search_projection_v1values(new.rowid,new.id,new.valor_unitario,new.source,new.uf,new.data_referencia,new.server_trust_version,new.search_contract,new.qualidade_situacao,new.search_eligible,new.sample_key);end') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_ready_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createviewcotai_search_projection_ready_v1asselect1asversion') AS projection_ready",
            )
            .withContext(requestContext)
            .bind({ user_id: String(userId), now: nowIso, cutoff: cutoff, request_limit: 120 })
            .all(rows)
          accepted = rows.length === 1
          identityCoverReady = accepted && Number(rows[0].identity_cover_ready) === 1
          projectionReady = accepted && Number(rows[0].projection_ready) === 1
          capacityStage = 'transaction_commit'
        })
        return {
          available: true,
          accepted: accepted,
          identityCoverReady: identityCoverReady,
          projectionReady: projectionReady,
        }
      } catch (error) {
        // Correlates only this failure with its HTTP response; no identity input.
        // Diagnostics must not turn a failed quota transaction into another error.
        try {
          var randomId = String($security.randomString(20))
          if (/^[A-Za-z0-9]{20}$/.test(randomId)) capacityDiagnosticId = 'psd_' + randomId
        } catch (_) {}
        logSearchFailure('capacity', error)
        return { available: false, accepted: false }
      }
    }

    function hitShape() {
      return {
        total_count: 0,
        minimum_price: -0,
        maximum_price: -0,
        average_price: -0,
        sum_price: -0,
        sum_square_price: -0,
        q1_price: -0,
        median_price: -0,
        q3_price: -0,
        source_counts_json: '{}',
        uf_counts_json: '{}',
        page_rank: 0,
        detail_rowid: 0,
        id: '',
        sample_key: '',
        source: '',
        source_record_id: '',
        purchase_id: '',
        item_id: '',
        descricao: '',
        descricao_normalizada: '',
        orgao: '',
        orgao_cnpj: '',
        fornecedor_nome: '',
        fornecedor_cnpj: '',
        fornecedor_porte: '',
        uf: '',
        municipio: '',
        unidade: '',
        quantidade: -0,
        valor_unitario: -0,
        valor_total: -0,
        natureza_preco: '',
        data_referencia: '',
        numero_processo: '',
        numero_ata: '',
        modalidade: '',
        situacao_contratacao: '',
        marca: '',
        modelo: '',
        codigo_item: '',
        url_original: '',
        payload_hash: '',
        raw_payload: '{}',
        qualidade_situacao: '',
        motivos_rejeicao: '[]',
        matching_score: -0,
        matching_tipo: '',
        indexed_at: '',
        source_updated_at: '',
        last_validated_at: '',
      }
    }

    function detailProjection(alias) {
      return (
        alias +
        '.rowid AS detail_rowid, ' +
        'COALESCE(' +
        alias +
        ".id, '') AS id, " +
        'COALESCE(' +
        alias +
        ".sample_key, '') AS sample_key, " +
        'COALESCE(' +
        alias +
        ".source, '') AS source, " +
        'COALESCE(' +
        alias +
        ".source_record_id, '') AS source_record_id, " +
        'COALESCE(' +
        alias +
        ".purchase_id, '') AS purchase_id, " +
        'COALESCE(' +
        alias +
        ".item_id, '') AS item_id, " +
        'COALESCE(' +
        alias +
        ".descricao, '') AS descricao, " +
        'COALESCE(' +
        alias +
        ".descricao_normalizada, '') AS descricao_normalizada, " +
        'COALESCE(' +
        alias +
        ".orgao, '') AS orgao, " +
        'COALESCE(' +
        alias +
        ".orgao_cnpj, '') AS orgao_cnpj, " +
        'COALESCE(' +
        alias +
        ".fornecedor_nome, '') AS fornecedor_nome, " +
        'COALESCE(' +
        alias +
        ".fornecedor_cnpj, '') AS fornecedor_cnpj, " +
        'COALESCE(' +
        alias +
        ".fornecedor_porte, '') AS fornecedor_porte, " +
        'COALESCE(' +
        alias +
        ".uf, '') AS uf, " +
        'COALESCE(' +
        alias +
        ".municipio, '') AS municipio, " +
        'COALESCE(' +
        alias +
        ".unidade, '') AS unidade, " +
        'COALESCE(' +
        alias +
        '.quantidade, 0) AS quantidade, ' +
        'COALESCE(' +
        alias +
        '.valor_unitario, 0) AS valor_unitario, ' +
        'COALESCE(' +
        alias +
        '.valor_total, 0) AS valor_total, ' +
        'COALESCE(' +
        alias +
        ".natureza_preco, '') AS natureza_preco, " +
        'COALESCE(' +
        alias +
        ".data_referencia, '') AS data_referencia, " +
        'COALESCE(' +
        alias +
        ".numero_processo, '') AS numero_processo, " +
        'COALESCE(' +
        alias +
        ".numero_ata, '') AS numero_ata, " +
        'COALESCE(' +
        alias +
        ".modalidade, '') AS modalidade, " +
        'COALESCE(' +
        alias +
        ".situacao_contratacao, '') AS situacao_contratacao, " +
        'COALESCE(' +
        alias +
        ".marca, '') AS marca, " +
        'COALESCE(' +
        alias +
        ".modelo, '') AS modelo, " +
        'COALESCE(' +
        alias +
        ".codigo_item, '') AS codigo_item, " +
        'COALESCE(' +
        alias +
        ".url_original, '') AS url_original, " +
        'COALESCE(' +
        alias +
        ".payload_hash, '') AS payload_hash, " +
        'COALESCE(CAST(' +
        alias +
        ".raw_payload AS TEXT), '{}') AS raw_payload, " +
        'COALESCE(' +
        alias +
        ".qualidade_situacao, '') AS qualidade_situacao, " +
        'COALESCE(CAST(' +
        alias +
        ".motivos_rejeicao AS TEXT), '[]') AS motivos_rejeicao, " +
        'COALESCE(' +
        alias +
        '.matching_score, 0) AS matching_score, ' +
        'COALESCE(' +
        alias +
        ".matching_tipo, '') AS matching_tipo, " +
        'COALESCE(' +
        alias +
        ".indexed_at, '') AS indexed_at, " +
        'COALESCE(' +
        alias +
        ".source_updated_at, '') AS source_updated_at, " +
        'COALESCE(' +
        alias +
        ".last_validated_at, '') AS last_validated_at"
      )
    }

    var SNAPSHOT_MAX_HIT_BYTES = 32 * 1024
    var SNAPSHOT_MAX_PAGE_BYTES = 4 * 1024 * 1024
    var SNAPSHOT_MAX_TOTAL_BYTES = 32 * 1024 * 1024

    function copyPrimitiveFields(source, fields) {
      var result = {}
      if (!source || typeof source !== 'object' || Array.isArray(source)) return result
      for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
        var field = fields[fieldIndex]
        var value = source[field]
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        )
          result[field] = value
      }
      return result
    }

    function compactRawPayload(value, hit) {
      var raw = value
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw)
        } catch (_) {
          raw = {}
        }
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
      var compact = copyPrimitiveFields(raw, [
        'codigo_item',
        'codigoCatalogo',
        'tipoCatalogo',
        'municipio_uf',
        'marca',
        'processo',
        'hash',
        'natureza',
        'natureza_preco',
        'fornecedorPorte',
        'porte_empresa',
        'detalhamento_pendente',
        'nao_informado',
        'is_demo',
        'isDemo',
      ])
      var proof = raw.proveniencia_preco
      if (proof && typeof proof === 'object' && !Array.isArray(proof)) {
        // The proof is the audit object used by both strict source validators.
        // Keep it byte-for-byte at the JSON value level; only unrelated raw
        // fields are discarded. The per-hit byte limit below bounds this copy.
        compact.proveniencia_preco = proof

        // Compras.gov.br may expose the catalog identity only in its signed
        // provenance. Keep the bare code expected by the strict validator and
        // the CATMAT/CATSER discriminator instead of the display label stored
        // on the indexed row (for example, "CATMAT 151063").
        var identity = proof.identidade
        if (identity && typeof identity === 'object' && !Array.isArray(identity)) {
          var catalogCode = identity.codigoCatalogo
          if (
            (typeof catalogCode === 'string' || typeof catalogCode === 'number') &&
            String(catalogCode)
          ) {
            if (!compact.codigoCatalogo) compact.codigoCatalogo = String(catalogCode)
            if (!compact.codigo_item) compact.codigo_item = String(catalogCode)
          }
          if (!compact.tipoCatalogo) {
            var identityType = String(identity.tipo || '').toLowerCase()
            if (identityType === 'material') compact.tipoCatalogo = 'CATMAT'
            else if (identityType === 'servico') compact.tipoCatalogo = 'CATSER'
          }
        }
      }
      if (!compact.codigo_item && hit.codigo_item) compact.codigo_item = hit.codigo_item
      if (!compact.municipio_uf) {
        var municipality = String(hit.municipio || '').trim()
        var state = String(hit.uf || '').trim()
        if (municipality && state) compact.municipio_uf = municipality + ' - ' + state
        else if (municipality || state) compact.municipio_uf = municipality || state
      }
      return compact
    }

    function utf8ByteLength(value) {
      var text = String(value || '')
      var bytes = 0
      for (var index = 0; index < text.length; index++) {
        var code = text.charCodeAt(index)
        if (code < 0x80) bytes += 1
        else if (code < 0x800) bytes += 2
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
          var next = text.charCodeAt(index + 1)
          if (next >= 0xdc00 && next <= 0xdfff) {
            bytes += 4
            index += 1
          } else bytes += 3
        } else bytes += 3
      }
      return bytes
    }

    // Same admission predicates, bounded to the 100 current rows being returned.
    // No receipt replay or secret lookup: this is not a content digest.
    function validCurrentEvidence(row) {
      function text(value) {
        return value == null ? '' : String(value)
      }
      function first(raw, fields) {
        for (var i = 0; i < fields.length; i++) if (raw[fields[i]] != null) return raw[fields[i]]
        return ''
      }
      function positive(value) {
        return (
          (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
          isFinite(Number(value)) &&
          Number(value) > 0
        )
      }
      function officialUrl(value) {
        if (typeof value !== 'string' || /[\s\\]/.test(value)) return null
        var match = value.match(/^https:\/\/([a-z0-9.-]+)(\/[^#]*)?$/i)
        var host = match && match[1].toLowerCase()
        if (
          !match ||
          host.length > 253 ||
          !/\.gov\.br$/i.test(host) ||
          host === 'catalogo.compras.gov.br'
        )
          return null
        var labels = host.split('.')
        for (var h = 0; h < labels.length; h++) {
          if (
            labels[h].length < 1 ||
            labels[h].length > 63 ||
            !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(labels[h])
          )
            return null
        }
        return { host: host, path: match[2] || '/' }
      }
      function query(url, name) {
        var match = url.match(new RegExp('[?&]' + name + '=([^&#]*)'))
        try {
          return match ? decodeURIComponent(match[1]) : ''
        } catch (_) {
          return ''
        }
      }
      function positiveDigits(value) {
        return (
          (typeof value === 'string' ||
            (typeof value === 'number' && Number.isSafeInteger(value))) &&
          /^\d+$/.test(text(value)) &&
          /[1-9]/.test(text(value))
        )
      }
      function boundedPositive(value, minimum, maximum) {
        if (!positiveDigits(value)) return false
        var numeric = Number(value)
        return (
          Number.isSafeInteger(numeric) &&
          numeric >= minimum &&
          (maximum == null || numeric <= maximum)
        )
      }
      function validIsoDate(value) {
        if (typeof value !== 'string') return false
        var match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        if (!match) return false
        var year = Number(match[1]),
          month = Number(match[2]),
          day = Number(match[3])
        var date = new Date(Date.UTC(year, month - 1, day))
        return (
          date.getUTCFullYear() === year &&
          date.getUTCMonth() === month - 1 &&
          date.getUTCDate() === day
        )
      }
      function exactQuery(url, expected) {
        var separator = url.indexOf('?')
        if (separator < 0 || separator === url.length - 1) return false
        var pieces = url.slice(separator + 1).split('&')
        var seen = Object.create(null)
        var count = 0
        for (var i = 0; i < pieces.length; i++) {
          var pair = pieces[i].split('=')
          if (pair.length !== 2 || !pair[0]) return false
          var name, value
          try {
            name = decodeURIComponent(pair[0].replace(/\+/g, ' '))
            value = decodeURIComponent(pair[1].replace(/\+/g, ' '))
          } catch (_) {
            return false
          }
          if (
            !Object.prototype.hasOwnProperty.call(expected, name) ||
            Object.prototype.hasOwnProperty.call(seen, name) ||
            value !== text(expected[name])
          )
            return false
          seen[name] = true
          count++
        }
        return count === Object.keys(expected).length
      }
      function sampleKey(row) {
        // Exact compatibility with PriceIndexService.gerarSampleKey (including its existing precision).
        return (
          row.source.toUpperCase().replace(/[^A-Z0-9]/g, '') +
          '#' +
          row.source_record_id.replace(/[^A-Z0-9_-]/gi, '') +
          '#' +
          row.item_id +
          '#' +
          text(row.orgao_cnpj || row.fornecedor_cnpj).replace(/\D/g, '') +
          '#' +
          row.valor_unitario.toFixed(4).replace('.', '_')
        )
      }
      function validate(row, legacyPurchase) {
        if (!row || (row.source !== 'PNCP' && row.source !== 'Compras.gov.br'))
          return 'SOURCE_INVALID'
        if (typeof row.valor_unitario !== 'number' || !positive(row.valor_unitario))
          return 'UNIT_PRICE_INVALID'
        if (
          typeof row.source_record_id !== 'string' ||
          !row.source_record_id ||
          row.purchase_id !== row.source_record_id ||
          typeof row.item_id !== 'string' ||
          !row.item_id ||
          typeof row.descricao !== 'string' ||
          !row.descricao.trim() ||
          typeof row.descricao_normalizada !== 'string' ||
          !row.descricao_normalizada.trim()
        )
          return 'IDENTITY_INVALID'
        var details = row.raw_payload
        var proof = details && details.proveniencia_preco
        var raw = proof && proof.registro_oficial
        var id = proof && proof.identidade
        if (
          !proof ||
          proof.versao !== 1 ||
          proof.status !== 'verificada' ||
          proof.fonte !== row.source ||
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          !id ||
          raw.isDemo === true ||
          raw.is_demo === true
        )
          return 'PROOF_INVALID'
        var fields =
          row.source === 'PNCP'
            ? [
                'valorUnitarioHomologado',
                'valor_unitario_homologado',
                'valorUnitarioEstimado',
                'valor_unitario_estimado',
                'valorUnitario',
                'valor_unitario',
              ]
            : ['precoUnitarioHomologado', 'valorUnitario', 'precoUnitario', 'precoPraticado']
        if (
          fields.indexOf(proof.campo_unitario) < 0 ||
          !positive(raw[proof.campo_unitario]) ||
          Number(raw[proof.campo_unitario]) !== row.valor_unitario ||
          !positive(proof.valor_unitario) ||
          Number(proof.valor_unitario) !== row.valor_unitario
        )
          return 'UNIT_PRICE_INVALID'
        var nature = proof.natureza === 'contratado' ? 'homologado' : proof.natureza
        if (['homologado', 'estimado'].indexOf(nature) < 0 || row.natureza_preco !== nature)
          return 'PROOF_INVALID'
        if (/estimado/i.test(proof.campo_unitario) && nature !== 'estimado') return 'PROOF_INVALID'
        if (/homologado/i.test(proof.campo_unitario) && nature !== 'homologado')
          return 'PROOF_INVALID'
        if (row.item_id !== text(details.numeroItem || '1')) return 'IDENTITY_INVALID'
        if (row.sample_key !== sampleKey(row)) return 'KEY_INVALID'
        if (!officialUrl(row.url_original) || !officialUrl(proof.url_evidencia))
          return 'URL_INVALID'

        // Preserve an evidenced date verbatim. Missing dates stay missing; opening is not a price date.
        var dateFields =
          row.source === 'PNCP'
            ? ['dataResultado']
            : [
                'dataResultado',
                'dataHomologacao',
                'dataCompra',
                'dataAssinatura',
                'data_resultado',
                'data_compra',
              ]
        if (proof.data_oficial || proof.campo_data || row.data_referencia) {
          if (
            dateFields.indexOf(proof.campo_data) < 0 ||
            !proof.data_oficial ||
            text(raw[proof.campo_data]) !== text(proof.data_oficial) ||
            text(row.data_referencia) !== text(proof.data_oficial) ||
            !isFinite(Date.parse(proof.data_oficial))
          )
            return 'DATE_INVALID'
        } else if (row.source === 'Compras.gov.br') return 'DATE_INVALID'

        if (row.source === 'PNCP') {
          if (
            !/^\d{14}$/.test(text(id.cnpj)) ||
            !/^\d{4}$/.test(text(id.ano)) ||
            !/^\d+$/.test(text(id.sequencial)) ||
            Number(id.sequencial) <= 0 ||
            !/^\d+$/.test(text(id.numeroItem)) ||
            Number(id.numeroItem) <= 0 ||
            row.item_id !== text(id.numeroItem) ||
            text(row.orgao_cnpj) !== text(id.cnpj)
          )
            return 'IDENTITY_INVALID'
          var purchase = id.cnpj + '/' + id.ano + '/' + id.sequencial
          var evidence =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            id.cnpj +
            '/compras/' +
            id.ano +
            '/' +
            id.sequencial +
            '/itens/' +
            id.numeroItem
          if (
            row.url_original !== 'https://pncp.gov.br/app/editais/' + purchase ||
            (proof.url_evidencia !== evidence && proof.url_evidencia !== evidence + '/resultados')
          )
            return 'URL_INVALID'
          var supplier = text(raw.niFornecedor || row.fornecedor_cnpj).replace(/\D/g, '')
          var expected =
            purchase +
            '/itens/' +
            id.numeroItem +
            (raw.sequencialResultado ? '/resultados/' + raw.sequencialResultado : '') +
            (supplier ? '/fornecedor/' + supplier : '')
          if (
            row.source_record_id !== expected ||
            (raw.numeroItem != null && text(raw.numeroItem) !== row.item_id)
          )
            return 'IDENTITY_INVALID'
        } else {
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
          for (var x = 0; x < identityFields.length; x++) {
            var field = identityFields[x]
            if (
              typeof raw[field] === 'number' &&
              !Number.isSafeInteger(raw[field]) &&
              !(legacyPurchase && (field === 'idCompra' || field === 'codigoCompra'))
            )
              return 'IDENTITY_INVALID'
          }
          var proofKeys = Object.keys(id)
          for (var y = 0; y < proofKeys.length; y++) {
            var proofField = proofKeys[y]
            if (
              typeof id[proofField] === 'number' &&
              !Number.isSafeInteger(id[proofField]) &&
              !(legacyPurchase && proofField === 'idCompra')
            )
              return 'IDENTITY_INVALID'
          }
          var context = proof.contexto_consulta
          var groupedPdm = context && context.seletor === 'codigoPdm'
          var purchaseId = text(first(raw, ['idCompra', 'codigoCompra']))
          var item = text(first(raw, ['idItemCompra', 'numeroItemCompra', 'numeroItem']))
          var supplierId = text(
            first(raw, [
              'cnpjFornecedor',
              'cpfCnpjFornecedor',
              'niFornecedor',
              'nomeFornecedor',
              'razaoSocial',
            ]),
          )
          if (
            !context ||
            (context.seletor != null &&
              context.seletor !== '' &&
              context.seletor !== 'codigoItemCatalogo' &&
              context.seletor !== 'codigoPdm') ||
            ['material', 'servico'].indexOf(id.tipo) < 0 ||
            context.tipo !== id.tipo ||
            !/^\d+$/.test(text(id.codigoCatalogo)) ||
            text(context.codigo) !== text(id.codigoCatalogo) ||
            !purchaseId ||
            !item ||
            !supplierId ||
            text(id.idCompra) !== purchaseId ||
            text(id.idItemCompra) !== text(raw.idItemCompra) ||
            text(id.numeroItemCompra) !== text(first(raw, ['numeroItemCompra', 'numeroItem'])) ||
            text(id.fornecedor) !== supplierId ||
            row.item_id !== text(first(raw, ['numeroItemCompra', 'numeroItem']) || '1')
          )
            return 'IDENTITY_INVALID'
          var rawCode = first(raw, [
            'codigoItemCatalogo',
            id.tipo === 'servico' ? 'codigoCatser' : 'codigoCatmat',
          ])
          if (rawCode && text(rawCode) !== text(id.codigoCatalogo)) return 'IDENTITY_INVALID'
          if (groupedPdm) {
            var pdm = context.codigoPdm
            if (
              id.tipo !== 'material' ||
              context.tipo !== 'material' ||
              typeof pdm !== 'string' ||
              !positiveDigits(pdm) ||
              !boundedPositive(context.pagina, 1) ||
              !boundedPositive(context.tamanhoPagina, 10, 500) ||
              (context.estado != null &&
                text(context.estado) !== '' &&
                !/^[A-Z]{2}$/.test(text(context.estado))) ||
              (context.dataCompraInicio != null &&
                text(context.dataCompraInicio) !== '' &&
                !validIsoDate(context.dataCompraInicio)) ||
              (context.dataCompraFim != null &&
                text(context.dataCompraFim) !== '' &&
                !validIsoDate(context.dataCompraFim)) ||
              (validIsoDate(context.dataCompraInicio) &&
                validIsoDate(context.dataCompraFim) &&
                context.dataCompraInicio > context.dataCompraFim) ||
              !positiveDigits(raw.codigoItemCatalogo) ||
              text(raw.codigoItemCatalogo) !== text(id.codigoCatalogo) ||
              (raw.codigoCatmat != null &&
                (!positiveDigits(raw.codigoCatmat) ||
                  text(raw.codigoCatmat) !== text(id.codigoCatalogo))) ||
              (raw.codigoPdm != null && text(raw.codigoPdm) !== pdm) ||
              (raw.codigoPDM != null && text(raw.codigoPDM) !== pdm) ||
              text(details.codigo_item) !== text(id.codigoCatalogo) ||
              details.tipoCatalogo !== 'CATMAT' ||
              row.codigo_item !== 'CATMAT ' + text(id.codigoCatalogo)
            )
              return 'IDENTITY_INVALID'
          }
          var namespace = id.tipo === 'servico' ? 'CATSER' : 'CATMAT'
          var expectedId = [namespace, purchaseId, item, text(proof.data_oficial), supplierId]
            .map(encodeURIComponent)
            .join('#')
          if (row.source_record_id !== expectedId || row.url_original !== proof.url_evidencia)
            return 'IDENTITY_INVALID'
          var parsed = officialUrl(proof.url_evidencia)
          if (!parsed) return 'URL_INVALID'
          var path =
            id.tipo === 'servico'
              ? '/modulo-pesquisa-preco/3_consultarServico'
              : '/modulo-pesquisa-preco/1_consultarMaterial'
          if (groupedPdm) {
            var officialQuery = officialUrl(context.urlConsultaOficial)
            var expectedQuery = {
              tipo: 'codigoPdm',
              codigo: context.codigoPdm,
              pagina: context.pagina,
              tamanhoPagina: context.tamanhoPagina,
            }
            var groupedFilters = ['estado', 'dataCompraInicio', 'dataCompraFim']
            for (var gf = 0; gf < groupedFilters.length; gf++) {
              var groupedField = groupedFilters[gf]
              if (context[groupedField] != null && text(context[groupedField]) !== '')
                expectedQuery[groupedField] = context[groupedField]
            }
            if (
              !officialQuery ||
              officialQuery.host !== 'dadosabertos.compras.gov.br' ||
              officialQuery.path.split('?')[0] !== '/modulo-pesquisa-preco/1_consultarMaterial' ||
              !exactQuery(context.urlConsultaOficial, expectedQuery) ||
              (proof.url_evidencia !== context.urlConsultaOficial &&
                [raw.linkEditalOuCompra, raw.link_resultado, raw.url].indexOf(proof.url_evidencia) <
                  0)
            )
              return 'URL_INVALID'
          } else if (parsed.host === 'dadosabertos.compras.gov.br') {
            var expectedItemQuery =
              id.tipo === 'servico'
                ? { codigoItemCatalogo: text(id.codigoCatalogo) }
                : { tipo: 'codigoItemCatalogo', codigo: text(id.codigoCatalogo) }
            var itemFilters = ['pagina', 'tamanhoPagina', 'estado', 'dataInicial', 'dataFinal']
            for (var iq = 0; iq < itemFilters.length; iq++) {
              var itemField = itemFilters[iq]
              if (context[itemField] != null && text(context[itemField]) !== '')
                expectedItemQuery[itemField] = context[itemField]
            }
            var exactItemQuery =
              parsed.path.split('?')[0] === path &&
              boundedPositive(context.pagina, 1) &&
              boundedPositive(context.tamanhoPagina, 10, 500) &&
              exactQuery(proof.url_evidencia, expectedItemQuery)
            var boundItemLink =
              [raw.linkEditalOuCompra, raw.link_resultado, raw.url].indexOf(proof.url_evidencia) >=
              0
            if (!exactItemQuery && !boundItemLink) return 'URL_INVALID'
          } else if (
            [raw.linkEditalOuCompra, raw.link_resultado, raw.url].indexOf(proof.url_evidencia) < 0
          )
            return 'URL_INVALID'
        }
        return ''
      }

      try {
        var current = Object.assign({}, row)
        if (typeof current.raw_payload === 'string')
          current.raw_payload = JSON.parse(current.raw_payload)
        var seal =
          current.raw_payload &&
          current.raw_payload.proveniencia_preco &&
          current.raw_payload.proveniencia_preco.validacao_indice
        if (
          !seal ||
          seal.contrato !== 'cotai-official-price-v3' ||
          seal.fonte !== current.source ||
          seal.sample_key !== current.sample_key ||
          seal.source_record_id !== current.source_record_id ||
          typeof current.payload_hash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(current.payload_hash) ||
          seal.assinatura !== current.payload_hash
        )
          return false
        return validate(current, false) === ''
      } catch (_) {
        return false
      }
    }

    function snapshotDrift() {
      return {
        status: 409,
        code: 'SEARCH_SNAPSHOT_DRIFT',
        error: 'Os candidatos desta janela mudaram. Atualize a consulta do índice.',
      }
    }
    function currentPageHits(rows) {
      var hits = [],
        bytes = 0
      for (var index = 0; index < rows.length; index++) {
        var row = rows[index]
        if (!(Number(row.detail_rowid) > 0) || !row.id) continue
        if (!validCurrentEvidence(row)) throw { snapshotDrift: true }
        var hit = hitFromRow(row)
        var size = utf8ByteLength(JSON.stringify(hit))
        bytes += size
        if (size > SNAPSHOT_MAX_HIT_BYTES || bytes > SNAPSHOT_MAX_PAGE_BYTES)
          throw new Error('snapshot_size_or_population_mismatch')
        hits.push(hit)
      }
      return hits
    }

    function validSnapshotHit(hit) {
      if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return false
      if (typeof hit.id !== 'string' || !hit.id || hit.id.length > 512) return false
      if (hit.source !== 'PNCP' && hit.source !== 'Compras.gov.br') return false
      if (!isFinite(Number(hit.valor_unitario)) || Number(hit.valor_unitario) <= 0) return false
      if (typeof hit.raw_payload !== 'string') return false
      try {
        var raw = JSON.parse(hit.raw_payload)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
      } catch (_) {
        return false
      }
      return true
    }

    function hitFromRow(row) {
      var hit = {}
      var fields = [
        'id',
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
        'situacao_contratacao',
        'marca',
        'modelo',
        'codigo_item',
        'url_original',
        'payload_hash',
        'raw_payload',
        'qualidade_situacao',
        'motivos_rejeicao',
        'matching_score',
        'matching_tipo',
        'indexed_at',
        'source_updated_at',
        'last_validated_at',
      ]
      for (var i = 0; i < fields.length; i++) hit[fields[i]] = row[fields[i]]
      hit.raw_payload = JSON.stringify(compactRawPayload(hit.raw_payload, hit))
      return hit
    }

    function safeJsonSql(alias) {
      var raw = 'COALESCE(CAST(' + alias + ".raw_payload AS TEXT), '{}')"
      return 'CASE WHEN json_valid(' + raw + ') THEN ' + raw + " ELSE '{}' END"
    }

    function primitiveJsonSql(rawSql, path) {
      return (
        'CASE WHEN json_type(' +
        rawSql +
        ", '$." +
        path +
        "') IN ('null','text','integer','real','true','false') THEN json_extract(" +
        rawSql +
        ", '$." +
        path +
        "') ELSE NULL END"
      )
    }

    function compactRawPayloadSql(alias) {
      var raw = safeJsonSql(alias)
      var catalogFromIdentity = primitiveJsonSql(
        raw,
        'proveniencia_preco.identidade.codigoCatalogo',
      )
      var catalogCode =
        'COALESCE(' +
        primitiveJsonSql(raw, 'codigo_item') +
        ', ' +
        primitiveJsonSql(raw, 'codigoCatalogo') +
        ', ' +
        catalogFromIdentity +
        ', COALESCE(' +
        alias +
        ".codigo_item, ''))"
      var catalogType =
        'COALESCE(' +
        primitiveJsonSql(raw, 'tipoCatalogo') +
        ', CASE LOWER(CAST(' +
        primitiveJsonSql(raw, 'proveniencia_preco.identidade.tipo') +
        " AS TEXT)) WHEN 'material' THEN 'CATMAT' WHEN 'servico' THEN 'CATSER' ELSE NULL END)"
      var municipality =
        'CASE WHEN COALESCE(' +
        alias +
        ".municipio,'') != '' AND COALESCE(" +
        alias +
        ".uf,'') != '' THEN " +
        alias +
        ".municipio || ' - ' || " +
        alias +
        '.uf ELSE COALESCE(NULLIF(' +
        alias +
        ".municipio,''), " +
        alias +
        ".uf, '') END"
      var municipalityUf =
        'COALESCE(' + primitiveJsonSql(raw, 'municipio_uf') + ', ' + municipality + ')'
      var base =
        "json_object('codigo_item', " +
        catalogCode +
        ", 'codigoCatalogo', " +
        catalogCode +
        ", 'tipoCatalogo', " +
        catalogType +
        ", 'municipio_uf', " +
        municipalityUf +
        ", 'marca', " +
        primitiveJsonSql(raw, 'marca') +
        ", 'processo', " +
        primitiveJsonSql(raw, 'processo') +
        ", 'hash', " +
        primitiveJsonSql(raw, 'hash') +
        ", 'natureza', " +
        primitiveJsonSql(raw, 'natureza') +
        ", 'natureza_preco', " +
        primitiveJsonSql(raw, 'natureza_preco') +
        ", 'fornecedorPorte', " +
        primitiveJsonSql(raw, 'fornecedorPorte') +
        ", 'porte_empresa', " +
        primitiveJsonSql(raw, 'porte_empresa') +
        ", 'detalhamento_pendente', " +
        primitiveJsonSql(raw, 'detalhamento_pendente') +
        ", 'nao_informado', " +
        primitiveJsonSql(raw, 'nao_informado') +
        ", 'is_demo', " +
        primitiveJsonSql(raw, 'is_demo') +
        ", 'isDemo', " +
        primitiveJsonSql(raw, 'isDemo') +
        ')'
      var proof =
        'CASE WHEN json_type(' +
        raw +
        ", '$.proveniencia_preco') = 'object' THEN json_object('proveniencia_preco', json_extract(" +
        raw +
        ", '$.proveniencia_preco')) ELSE '{}' END"
      return 'json_patch(' + base + ', ' + proof + ')'
    }

    function snapshotHitJsonSql(alias) {
      var textFields = [
        'id',
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
        'natureza_preco',
        'data_referencia',
        'numero_processo',
        'numero_ata',
        'modalidade',
        'situacao_contratacao',
        'marca',
        'modelo',
        'codigo_item',
        'url_original',
        'payload_hash',
        'qualidade_situacao',
        'motivos_rejeicao',
        'matching_tipo',
        'indexed_at',
        'source_updated_at',
        'last_validated_at',
      ]
      var parts = []
      for (var fieldIndex = 0; fieldIndex < textFields.length; fieldIndex++) {
        var field = textFields[fieldIndex]
        var fallback = field === 'motivos_rejeicao' ? "'[]'" : "''"
        parts.push("'" + field + "'")
        parts.push('COALESCE(' + alias + '.' + field + ', ' + fallback + ')')
      }
      var realFields = ['quantidade', 'valor_unitario', 'valor_total', 'matching_score']
      for (var realIndex = 0; realIndex < realFields.length; realIndex++) {
        var realField = realFields[realIndex]
        parts.push("'" + realField + "'")
        parts.push('CAST(COALESCE(' + alias + '.' + realField + ', 0) AS REAL)')
      }
      parts.push("'raw_payload'")
      // raw_payload remains a JSON string in the HTTP DTO. CAST removes the
      // JSON subtype so json_object does not embed it as a nested object.
      parts.push("('' || " + compactRawPayloadSql(alias) + ')')
      return 'json_object(' + parts.join(', ') + ')'
    }

    function qualifiedOrderSql(order) {
      return order.sql.replace(/\b(valor_unitario|data_referencia|id)\b/g, 'psi.$1')
    }

    function snapshotItemsSql(spec, order, version) {
      if (version === 2 && spec.identityCover && spec.projectionReady) {
        var projectionOrder = qualifiedOrderSql(order)
        return (
          'INSERT INTO cotai_price_search_snapshot_items (snapshot_id, position, hit_json) ' +
          'SELECT {:snapshot_id}, ROW_NUMBER() OVER (ORDER BY ' +
          projectionOrder +
          '), ' +
          "json_object('version',2,'id',psi.id,'rowid',psi.source_rowid,'source',psi.source,'sample_key',psi.sample_key,'price_text',printf('%!.17g',psi.valor_unitario),'data_referencia',COALESCE(psi.data_referencia,''))" +
          ' FROM price_samples_fts CROSS JOIN cotai_price_search_projection_v1 psi ON psi.source_rowid = price_samples_fts.rowid WHERE ' +
          spec.where +
          ' ORDER BY ' +
          projectionOrder
        )
      }
      if (version === 2 && spec.identityCover) {
        var orderedV2 = qualifiedOrderSql(order)
        return (
          'WITH snapshot_filtered AS MATERIALIZED (' +
          " SELECT psi.rowid AS psi_rowid, psi.id, psi.valor_unitario, psi.source, COALESCE(psi.data_referencia, '') AS data_referencia" +
          ' FROM price_samples_fts CROSS JOIN price_samples_index psi INDEXED BY idx_psi_search_identity_cover_v1' +
          ' ON psi.id = COALESCE((SELECT CASE WHEN verified.rowid = price_samples_fts.rowid THEN verified.id ELSE NULL END FROM price_samples_index verified WHERE verified.id = price_samples_fts.sample_id), (SELECT identity_row.id FROM price_samples_index identity_row WHERE identity_row.rowid = price_samples_fts.rowid))' +
          ' AND psi.rowid = price_samples_fts.rowid WHERE ' +
          spec.where +
          ') INSERT INTO cotai_price_search_snapshot_items (snapshot_id, position, hit_json)' +
          ' SELECT {:snapshot_id}, ROW_NUMBER() OVER (ORDER BY ' +
          orderedV2 +
          '), ' +
          "json_object('version',2,'id',psi.id,'rowid',psi.rowid,'source',psi.source,'sample_key',psi.sample_key,'price_text',printf('%!.17g',psi.valor_unitario),'data_referencia',COALESCE(psi.data_referencia,''))" +
          ' FROM snapshot_filtered CROSS JOIN price_samples_index psi ON psi.rowid = snapshot_filtered.psi_rowid' +
          ' ORDER BY ' +
          orderedV2
        )
      }
      var ordered = qualifiedOrderSql(order)
      return (
        'INSERT INTO cotai_price_search_snapshot_items (snapshot_id, position, hit_json) ' +
        'SELECT {:snapshot_id}, ROW_NUMBER() OVER (ORDER BY ' +
        ordered +
        '), ' +
        (version === 2
          ? "json_object('version',2,'id',psi.id,'rowid',psi.rowid,'source',psi.source,'sample_key',psi.sample_key,'price_text',printf('%!.17g',psi.valor_unitario),'data_referencia',COALESCE(psi.data_referencia,''))"
          : snapshotHitJsonSql('psi')) +
        ' FROM price_samples_index psi' +
        spec.joins +
        ' WHERE ' +
        spec.where +
        ' ORDER BY ' +
        ordered +
        ''
      )
    }

    function nullablePageProjection(alias) {
      var integerFields = ['page_rank', 'detail_rowid']
      var realFields = ['quantidade', 'valor_unitario', 'valor_total', 'matching_score']
      var textFields = [
        'id',
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
        'natureza_preco',
        'data_referencia',
        'numero_processo',
        'numero_ata',
        'modalidade',
        'situacao_contratacao',
        'marca',
        'modelo',
        'codigo_item',
        'url_original',
        'payload_hash',
        'raw_payload',
        'qualidade_situacao',
        'motivos_rejeicao',
        'matching_tipo',
        'indexed_at',
        'source_updated_at',
        'last_validated_at',
      ]
      var parts = []
      for (var integerIndex = 0; integerIndex < integerFields.length; integerIndex++) {
        var integerField = integerFields[integerIndex]
        parts.push('COALESCE(' + alias + '.' + integerField + ', 0) AS ' + integerField)
      }
      for (var realIndex = 0; realIndex < realFields.length; realIndex++) {
        var realField = realFields[realIndex]
        parts.push('CAST(COALESCE(' + alias + '.' + realField + ', 0) AS REAL) AS ' + realField)
      }
      for (var textIndex = 0; textIndex < textFields.length; textIndex++) {
        var textField = textFields[textIndex]
        var fallback =
          textField === 'raw_payload' ? "'{}'" : textField === 'motivos_rejeicao' ? "'[]'" : "''"
        parts.push('COALESCE(' + alias + '.' + textField + ', ' + fallback + ') AS ' + textField)
      }
      return parts.join(', ')
    }

    function filterSpec(params, validated, identityCoverReady, projectionReady) {
      var clauses = [
        'psi.search_eligible = 1',
        'psi.search_contract = {:search_contract}',
        'psi.server_trust_version = {:server_trust_version}',
        "psi.source IN ('PNCP','Compras.gov.br')",
        'psi.valor_unitario > 0',
        "(psi.qualidade_situacao IS NULL OR psi.qualidade_situacao != 'rejeitada')",
      ]
      var binds = {
        search_contract: 'cotai-official-price-v3',
        server_trust_version: 'server-v1',
      }
      var joins = ''
      var term = validated.term
      var normalizedTerm = validated.normalizedTerm
      var catalog = validated.catalog
      var usesFts = false
      if (catalog) {
        var kind = catalog[1] || ''
        var code = catalog[2]
        if (kind === 'CATMAT') {
          binds.catalog_catmat_spaced = 'CATMAT ' + code
          binds.catalog_catmat_compact = 'CATMAT' + code
          clauses.push(
            '(psi.codigo_item = {:catalog_catmat_spaced} OR psi.codigo_item = {:catalog_catmat_compact})',
          )
        } else if (kind === 'CATSER') {
          binds.catalog_catser_spaced = 'CATSER ' + code
          binds.catalog_catser_compact = 'CATSER' + code
          clauses.push(
            '(psi.codigo_item = {:catalog_catser_spaced} OR psi.codigo_item = {:catalog_catser_compact})',
          )
        } else {
          binds.catalog_plain = code
          binds.catalog_catmat_spaced = 'CATMAT ' + code
          binds.catalog_catmat_compact = 'CATMAT' + code
          binds.catalog_catser_spaced = 'CATSER ' + code
          binds.catalog_catser_compact = 'CATSER' + code
          clauses.push(
            '(psi.codigo_item = {:catalog_plain} OR psi.codigo_item = {:catalog_catmat_spaced} OR psi.codigo_item = {:catalog_catmat_compact} OR psi.codigo_item = {:catalog_catser_spaced} OR psi.codigo_item = {:catalog_catser_compact})',
          )
        }
      } else {
        var tokens = validated.tokens
        if (validated.exactPhrase) {
          binds.fts_query = 'descricao_normalizada : "' + normalizedTerm + '"'
        } else {
          var ftsParts = []
          for (var tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
            var token = tokens[tokenIndex]
            var variants = [token]
            if (token.length >= 4) {
              if (token.length > 4 && token.slice(-1) === 'S') variants.push(token.slice(0, -1))
              else variants.push(token + 'S')
              if (token.slice(-1) === 'M') variants.push(token.slice(0, -1) + 'NS')
              if (token.slice(-1) === 'R' || token.slice(-1) === 'Z') variants.push(token + 'ES')
            }
            var uniqueVariants = []
            var variantSeen = {}
            for (var variantIndex = 0; variantIndex < variants.length; variantIndex++) {
              if (!variantSeen[variants[variantIndex]]) {
                uniqueVariants.push('"' + variants[variantIndex] + '"')
                variantSeen[variants[variantIndex]] = true
              }
            }
            ftsParts.push(
              uniqueVariants.length === 1
                ? uniqueVariants[0]
                : '(' + uniqueVariants.join(' OR ') + ')',
            )
          }
          binds.fts_query =
            'descricao_normalizada : (' +
            (ftsParts.length ? ftsParts.join(' AND ') : '"ZZZCOTAINOMATCH999999"') +
            ')'
        }
        joins = ' JOIN price_samples_fts ON price_samples_fts.rowid = psi.rowid '
        clauses.push('price_samples_fts MATCH {:fts_query}')
        usesFts = true
      }

      var sources = validated.sources
      if (sources.length) {
        var sourceClauses = []
        for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          var canonicalSource = sources[sourceIndex]
          var sourceKey = 'source_' + sourceIndex
          binds[sourceKey] = canonicalSource
          sourceClauses.push('psi.source = {:' + sourceKey + '}')
        }
        if (sourceClauses.length) clauses.push('(' + sourceClauses.join(' OR ') + ')')
      }

      if (validated.canonicalUf !== 'ALL') {
        binds.uf_filter = validated.canonicalUf
        clauses.push('psi.uf = {:uf_filter}')
      }
      if (validated.cnpj) {
        binds.cnpj_filter = validated.cnpj
        var buyerCnpj =
          "REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(psi.orgao_cnpj,''),'.',''),'/',''),'-',''),' ','')"
        var supplierCnpj =
          "REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(psi.fornecedor_cnpj,''),'.',''),'/',''),'-',''),' ','')"
        clauses.push(
          '(' + buyerCnpj + ' = {:cnpj_filter} OR ' + supplierCnpj + ' = {:cnpj_filter})',
        )
      }
      var months = validated.months
      if (months > 0) {
        binds.date_limit = new Date(Date.now() - months * 30 * 24 * 3600 * 1000).toISOString()
        clauses.push('psi.data_referencia >= {:date_limit}')
      }
      if (validated.dataStart) {
        binds.date_start = validated.dataStart
        clauses.push('psi.data_referencia >= {:date_start}')
      }
      if (validated.dataEndExclusive) {
        binds.date_end_exclusive = validated.dataEndExclusive
        clauses.push('psi.data_referencia < {:date_end_exclusive}')
      }
      if (validated.minimumPrice !== null) {
        binds.minimum_price = validated.minimumPrice
        clauses.push('psi.valor_unitario >= {:minimum_price}')
      }
      if (validated.maximumPrice !== null) {
        binds.maximum_price = validated.maximumPrice
        clauses.push('psi.valor_unitario <= {:maximum_price}')
      }
      if (validated.modality) {
        binds.modality_filter = normalize(validated.modality)
        clauses.push('INSTR(' + normalizedSql('psi.modalidade') + ', {:modality_filter}) > 0')
      }
      if (validated.priceNature) {
        binds.price_nature = normalize(validated.priceNature)
        clauses.push(normalizedSql('psi.natureza_preco') + ' = {:price_nature}')
      }
      if (validated.unit) {
        binds.unit_filter = normalize(validated.unit)
        clauses.push('INSTR(' + normalizedSql('psi.unidade') + ', {:unit_filter}) > 0')
      }
      if (validated.brand) {
        binds.brand_filter = normalize(validated.brand)
        clauses.push('INSTR(' + normalizedSql('psi.marca') + ', {:brand_filter}) > 0')
      }
      var supplierSize = normalize(validated.supplierSize)
      if (validated.onlyMeEpp || supplierSize === 'ME EPP') {
        clauses.push(
          normalizedSql('psi.fornecedor_porte') +
            " IN ('ME EPP','ME','EPP','MICROEMPRESA','EMPRESA DE PEQUENO PORTE')",
        )
      } else if (supplierSize === 'DEMAIS') {
        clauses.push(
          normalizedSql('psi.fornecedor_porte') +
            " NOT IN ('ME EPP','ME','EPP','MICROEMPRESA','EMPRESA DE PEQUENO PORTE','')",
        )
      } else if (supplierSize && supplierSize !== 'TODAS' && supplierSize !== 'TODOS') {
        binds.supplier_size = supplierSize
        clauses.push('INSTR(' + normalizedSql('psi.fornecedor_porte') + ', {:supplier_size}) > 0')
      }
      return {
        term: term,
        normalizedTerm: normalizedTerm,
        canonicalUf: validated.canonicalUf,
        joins: joins,
        where: clauses.join(' AND '),
        binds: binds,
        usesFts: usesFts,
        // Only these scalar predicates fit the measured covering index. Other
        // refinements keep their existing source-table plan.
        projectionReady: projectionReady === true,
        identityCover:
          (identityCoverReady === true || projectionReady === true) &&
          usesFts &&
          !validated.cnpj &&
          !validated.modality &&
          !validated.priceNature &&
          !validated.unit &&
          !validated.brand &&
          !validated.onlyMeEpp &&
          (!supplierSize || supplierSize === 'TODAS' || supplierSize === 'TODOS'),
        months: months,
      }
    }

    function orderSpec(params) {
      var requested = String(params.sort || params.ordenar || 'valor_unitario:asc').trim()
      if (requested === 'maior_preco') requested = 'valor_unitario:desc'
      if (requested === 'menor_preco') requested = 'valor_unitario:asc'
      if (requested === 'mais_recente') requested = 'data_referencia:desc'
      if (requested === 'mais_antigo') requested = 'data_referencia:asc'
      if (requested === 'valor_unitario:desc')
        return { name: requested, sql: 'valor_unitario DESC, id ASC' }
      if (requested === 'data_referencia:desc')
        return {
          name: requested,
          sql: "COALESCE(data_referencia, '') DESC, valor_unitario ASC, id ASC",
        }
      if (requested === 'data_referencia:asc')
        return {
          name: requested,
          sql: "COALESCE(data_referencia, '') ASC, valor_unitario ASC, id ASC",
        }
      return { name: 'valor_unitario:asc', sql: 'valor_unitario ASC, id ASC' }
    }

    function snapshotQueryHash(validated, order) {
      var sources = validated.sources.slice().sort()
      var identity = [
        validated.snapshotVersion === 2 ? 'price-search-snapshot-v2' : 'price-search-snapshot-v1',
        validated.normalizedTerm,
        validated.catalog ? String(validated.catalog[1] || '') : '',
        validated.catalog ? String(validated.catalog[2] || '') : validated.tokens.join('|'),
        validated.exactPhrase ? '1' : '0',
        validated.cnpj || '',
        sources.join('|'),
        validated.canonicalUf,
        validated.months,
        validated.dataStart,
        validated.dataEndExclusive,
        validated.minimumPrice === null ? '' : String(validated.minimumPrice),
        validated.maximumPrice === null ? '' : String(validated.maximumPrice),
        normalize(validated.modality),
        normalize(validated.priceNature),
        normalize(validated.unit),
        normalize(validated.brand),
        normalize(validated.supplierSize),
        validated.onlyMeEpp ? '1' : '0',
        order.name,
        validated.limit,
      ]
      return String($security.sha256(JSON.stringify(identity))).toLowerCase()
    }

    function snapshotTokenHash(snapshot) {
      return String($security.sha256(String(snapshot))).toLowerCase()
    }

    function cursorToken(secret, queryHash, page, version) {
      return (
        (version === 2 ? 'pc2_' : 'pc1_') +
        String($security.sha256(secret + '|' + queryHash + '|' + String(page))).toLowerCase()
      )
    }

    function snapshotModel() {
      return new DynamicModel({
        id: '',
        token_hash: '',
        owner_user_id: '',
        query_hash: '',
        cursor_secret: '',
        sort_name: '',
        page_size: 0,
        page_count: 0,
        captured_count: 0,
        total_count: 0,
        population_complete: 0,
        created_at: '',
        expires_at: '',
      })
    }

    function deleteSnapshot(snapshotId) {
      $app.runInTransaction(function (txApp) {
        txApp
          .db()
          .newQuery(
            'DELETE FROM cotai_price_search_snapshot_items WHERE snapshot_id = {:snapshot_id}',
          )
          .withContext(requestContext)
          .bind({ snapshot_id: snapshotId })
          .execute()
        txApp
          .db()
          .newQuery('DELETE FROM cotai_price_search_snapshots WHERE id = {:snapshot_id}')
          .withContext(requestContext)
          .bind({ snapshot_id: snapshotId })
          .execute()
      })
    }

    function persistSnapshot(txApp, ownerUserId, queryHash, order, pageSize, total, spec, version) {
      var now = new Date()
      var nowIso = now.toISOString()
      var expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString()
      var token =
        (version === 2 ? 'ps2_' : 'ps1_') +
        String($security.sha256($security.randomString(64) + '|' + nowIso)).toLowerCase()
      var snapshotId =
        'pss_' + String($security.sha256($security.randomString(64) + '|' + token)).toLowerCase()
      var secret = String(
        $security.sha256($security.randomString(64) + '|' + snapshotId),
      ).toLowerCase()
      if (pageSize < 1 || pageSize > 100 || total < 1) throw new Error('snapshot_bounds')
      var pageCount = Math.ceil(total / pageSize)
      function txQuery(sql) {
        return txApp.db().newQuery(sql).withContext(requestContext)
      }

      txQuery(
        'DELETE FROM cotai_price_search_snapshot_items WHERE snapshot_id IN (' +
          'SELECT id FROM cotai_price_search_snapshots WHERE expires_at <= {:now})',
      )
        .bind({ now: nowIso })
        .execute()
      txQuery('DELETE FROM cotai_price_search_snapshots WHERE expires_at <= {:now}')
        .bind({ now: nowIso })
        .execute()

      // Keep at most two older snapshots so the newly inserted one is the third.
      txQuery(
        'DELETE FROM cotai_price_search_snapshot_items WHERE snapshot_id IN (' +
          'SELECT id FROM cotai_price_search_snapshots WHERE owner_user_id = {:owner_user_id} ' +
          'ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 2)',
      )
        .bind({ owner_user_id: String(ownerUserId) })
        .execute()
      txQuery(
        'DELETE FROM cotai_price_search_snapshots WHERE id IN (' +
          'SELECT id FROM cotai_price_search_snapshots WHERE owner_user_id = {:owner_user_id} ' +
          'ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 2)',
      )
        .bind({ owner_user_id: String(ownerUserId) })
        .execute()

      txQuery(
        'INSERT INTO cotai_price_search_snapshots (' +
          'id, token_hash, owner_user_id, query_hash, cursor_secret, sort_name, page_size, ' +
          'page_count, captured_count, total_count, population_complete, created_at, expires_at' +
          ') VALUES (' +
          '{:id}, {:token_hash}, {:owner_user_id}, {:query_hash}, {:cursor_secret}, {:sort_name}, ' +
          '{:page_size}, {:page_count}, {:captured_count}, {:total_count}, 1, ' +
          '{:created_at}, {:expires_at})',
      )
        .bind({
          id: snapshotId,
          token_hash: snapshotTokenHash(token),
          owner_user_id: String(ownerUserId),
          query_hash: queryHash,
          cursor_secret: secret,
          sort_name:
            version === 2
              ? JSON.stringify({
                  version: 2,
                  sort: order.name,
                  date_limit: spec.binds.date_limit || '',
                })
              : order.name,
          page_size: pageSize,
          page_count: pageCount,
          captured_count: total,
          total_count: total,
          created_at: nowIso,
          expires_at: expiresAt,
        })
        .execute()

      var snapshotBinds = Object.assign({}, spec.binds, { snapshot_id: snapshotId })
      txQuery(snapshotItemsSql(spec, order, version))
        .bind(snapshotBinds)
        .execute()

      var stats = new DynamicModel({
        captured_count: 0,
        total_bytes: 0,
        max_hit_bytes: 0,
      })
      txQuery(
        'SELECT COUNT(*) AS captured_count, ' +
          'COALESCE(SUM(length(CAST(i.hit_json AS BLOB))), 0) AS total_bytes, ' +
          'COALESCE(MAX(length(CAST(i.hit_json AS BLOB))), 0) AS max_hit_bytes ' +
          'FROM cotai_price_search_snapshot_items i WHERE i.snapshot_id = {:snapshot_id}',
      )
        .bind({ snapshot_id: snapshotId })
        .one(stats)
      if (
        Number(stats.captured_count) !== total ||
        Number(stats.max_hit_bytes) > SNAPSHOT_MAX_HIT_BYTES ||
        Number(stats.total_bytes) > SNAPSHOT_MAX_TOTAL_BYTES
      )
        throw new Error('snapshot_size_or_population_mismatch')

      return {
        token: token,
        secret: secret,
        pageCount: pageCount,
        capturedAt: nowIso,
        capturedCount: total,
        populationComplete: true,
      }
    }

    function loadReferencePage(session, validated, order, envelope, requestedPage) {
      var firstPosition = (requestedPage - 1) * Number(session.page_size) + 1
      var lastPosition = Math.min(
        requestedPage * Number(session.page_size),
        Number(session.captured_count),
      )
      var expected = lastPosition - firstPosition + 1
      if (expected < 1 || expected > 100) return snapshotDrift()
      var spec = filterSpec({}, validated)
      if (spec.months > 0) spec.binds.date_limit = envelope.date_limit
      var dateGuard =
        order.name.indexOf('data_referencia:') === 0
          ? " AND COALESCE(psi.data_referencia,'') = json_extract(ref.hit_json,'$.data_referencia')"
          : ''
      var rows = arrayOf(new DynamicModel(hitShape()))
      // One SQLite statement supplies all current fields, predicates and count.
      // Materializing at most 100 refs never copies the population's proof JSON.
      query(
        'WITH refs AS MATERIALIZED (SELECT position, hit_json FROM cotai_price_search_snapshot_items ' +
          'WHERE snapshot_id = {:snapshot_id} AND position BETWEEN {:first_position} AND {:last_position}) ' +
          'SELECT 0 AS total_count, 0 AS minimum_price, 0 AS maximum_price, 0 AS average_price, 0 AS sum_price, 0 AS sum_square_price,' +
          " 0 AS q1_price, 0 AS median_price, 0 AS q3_price, '{}' AS source_counts_json, '{}' AS uf_counts_json," +
          ' ref.position AS page_rank, ' +
          detailProjection('psi') +
          ' FROM refs ref ' +
          "JOIN price_samples_index psi ON psi.id = json_extract(ref.hit_json,'$.id') AND psi.rowid = json_extract(ref.hit_json,'$.rowid') " +
          spec.joins +
          ' WHERE ' +
          spec.where +
          " AND json_extract(ref.hit_json,'$.version') = 2 AND psi.source = json_extract(ref.hit_json,'$.source')" +
          " AND psi.sample_key = json_extract(ref.hit_json,'$.sample_key') AND printf('%!.17g',psi.valor_unitario) = json_extract(ref.hit_json,'$.price_text')" +
          dateGuard +
          ' ORDER BY ref.position',
      )
        .bind(
          Object.assign({}, spec.binds, {
            snapshot_id: session.id,
            first_position: firstPosition,
            last_position: lastPosition,
          }),
        )
        .all(rows)
      if (rows.length !== expected) return snapshotDrift()
      var hits
      try {
        hits = currentPageHits(rows)
      } catch (error) {
        if (error.snapshotDrift) return snapshotDrift()
        throw error
      }
      if (hits.length !== expected) return snapshotDrift()
      var hasMore = requestedPage < Number(session.page_count)
      return {
        status: 200,
        body: {
          sucesso: true,
          summary_included: false,
          page: requestedPage,
          limit: Number(session.page_size),
          pages: Number(session.page_count),
          snapshot: validated.snapshot,
          next_cursor: hasMore
            ? cursorToken(session.cursor_secret, session.query_hash, requestedPage + 1, 2)
            : null,
          has_more: hasMore,
          snapshot_version: 2,
          snapshot_consistency: 'fixed_ids_current_evidence',
          snapshot_captured_at: session.created_at,
          snapshot_identity_complete: true,
          snapshot_window_count: Number(session.captured_count),
          hits: hits,
        },
      }
    }

    function loadSnapshotContinuation(ownerUserId, validated, queryHash, order) {
      var sessions = arrayOf(snapshotModel())
      query(
        'SELECT id, token_hash, owner_user_id, query_hash, cursor_secret, sort_name, page_size, ' +
          'page_count, captured_count, total_count, population_complete, created_at, expires_at ' +
          'FROM cotai_price_search_snapshots ' +
          'WHERE token_hash = {:token_hash} AND owner_user_id = {:owner_user_id} LIMIT 1',
      )
        .bind({
          token_hash: snapshotTokenHash(validated.snapshot),
          owner_user_id: String(ownerUserId),
        })
        .all(sessions)
      if (!sessions.length)
        return {
          status: 404,
          code: 'SEARCH_SNAPSHOT_NOT_FOUND',
          error: 'Snapshot de busca não encontrado.',
        }

      var session = sessions[0]
      if (new Date(session.expires_at).getTime() <= new Date().getTime()) {
        deleteSnapshot(session.id)
        return {
          status: 410,
          code: 'SEARCH_SNAPSHOT_EXPIRED',
          error: 'A janela estável desta busca expirou. Execute a busca novamente.',
        }
      }
      if (session.query_hash !== queryHash || Number(session.page_size) !== validated.limit)
        return {
          status: 409,
          code: 'SEARCH_SNAPSHOT_MISMATCH',
          error: 'Os filtros, a ordenação ou o tamanho da página mudaram durante a busca.',
        }

      var envelope = null
      if (validated.snapshotVersion === 2) {
        try {
          envelope = JSON.parse(session.sort_name)
        } catch (_) {}
        if (
          !envelope ||
          Array.isArray(envelope) ||
          Object.keys(envelope).sort().join(',') !== 'date_limit,sort,version' ||
          envelope.version !== 2 ||
          envelope.sort !== order.name ||
          typeof envelope.date_limit !== 'string' ||
          (validated.months > 0
            ? !isFinite(Date.parse(envelope.date_limit))
            : envelope.date_limit !== '')
        )
          return {
            status: 409,
            code: 'SEARCH_SNAPSHOT_MISMATCH',
            error: 'Contrato de snapshot incompatível.',
          }
      }
      var requestedPage = 0
      for (var pageNumber = 2; pageNumber <= Number(session.page_count); pageNumber++) {
        if (
          cursorToken(
            session.cursor_secret,
            session.query_hash,
            pageNumber,
            validated.snapshotVersion,
          ) === validated.cursor
        ) {
          requestedPage = pageNumber
          break
        }
      }
      if (!requestedPage)
        return {
          status: 409,
          code: 'SEARCH_SNAPSHOT_MISMATCH',
          error: 'O cursor não pertence a esta janela de busca.',
        }

      if (validated.snapshotVersion === 2)
        return loadReferencePage(session, validated, order, envelope, requestedPage)
      var firstPosition = (requestedPage - 1) * Number(session.page_size) + 1
      var lastPosition = Math.min(
        requestedPage * Number(session.page_size),
        Number(session.captured_count),
      )
      var expectedHitCount = lastPosition - firstPosition + 1
      var storedHits = arrayOf(new DynamicModel({ hit_json: '' }))
      query(
        'SELECT hit_json FROM cotai_price_search_snapshot_items ' +
          'WHERE snapshot_id = {:snapshot_id} AND position BETWEEN {:first_position} AND {:last_position} ' +
          'ORDER BY position',
      )
        .bind({
          snapshot_id: session.id,
          first_position: firstPosition,
          last_position: lastPosition,
        })
        .all(storedHits)
      if (storedHits.length !== expectedHitCount)
        return {
          status: 503,
          code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
          error: 'A página materializada da busca está indisponível.',
        }
      var pageHits = []
      var pageBytes = 0
      var validPage = expectedHitCount > 0 && expectedHitCount <= Number(session.page_size)
      for (var pageHitIndex = 0; validPage && pageHitIndex < storedHits.length; pageHitIndex++) {
        var storedHitJson = String(storedHits[pageHitIndex].hit_json || '')
        var storedHitBytes = utf8ByteLength(storedHitJson)
        pageBytes += storedHitBytes
        if (storedHitBytes > SNAPSHOT_MAX_HIT_BYTES || pageBytes > SNAPSHOT_MAX_PAGE_BYTES) {
          validPage = false
          break
        }
        var parsedHit
        try {
          parsedHit = JSON.parse(storedHitJson)
        } catch (_) {
          parsedHit = null
        }
        if (!validSnapshotHit(parsedHit)) {
          validPage = false
          break
        }
        pageHits.push(parsedHit)
      }
      if (!validPage)
        return {
          status: 503,
          code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
          error: 'A página materializada da busca está inválida.',
        }

      var hasMore = requestedPage < Number(session.page_count)
      return {
        status: 200,
        body: {
          sucesso: true,
          summary_included: false,
          page: requestedPage,
          limit: Number(session.page_size),
          pages: Math.ceil(Number(session.total_count) / Number(session.page_size)) || 1,
          snapshot: validated.snapshot,
          snapshot_version: 1,
          snapshot_consistency: 'frozen_v1',
          next_cursor: hasMore
            ? cursorToken(session.cursor_secret, session.query_hash, requestedPage + 1)
            : null,
          has_more: hasMore,
          snapshot_window_count: Number(session.captured_count),
          snapshot_population_complete: Number(session.population_complete) === 1,
          population_has_more: Number(session.population_complete) !== 1,
          hits: pageHits,
        },
      }
    }

    function summarySql(spec, order) {
      return (
        'WITH filtered AS MATERIALIZED (' +
        (spec.identityCover && spec.projectionReady
          ? " SELECT psi.source_rowid AS psi_rowid, psi.id, psi.valor_unitario, psi.source, COALESCE(psi.uf, '') AS uf, COALESCE(psi.data_referencia, '') AS data_referencia"
          : " SELECT psi.rowid AS psi_rowid, psi.id, psi.valor_unitario, psi.source, COALESCE(psi.uf, '') AS uf, COALESCE(psi.data_referencia, '') AS data_referencia") +
        (spec.identityCover && spec.projectionReady
          ? ' FROM price_samples_fts CROSS JOIN cotai_price_search_projection_v1 psi ON psi.source_rowid = price_samples_fts.rowid'
          : spec.identityCover
            ? // FTS rowid is authoritative, even if its sample_id is stale/empty.
              // Verify the hint through its covering ID index, otherwise resolve rowid.
              ' FROM price_samples_fts CROSS JOIN price_samples_index psi INDEXED BY idx_psi_search_identity_cover_v1' +
              ' ON psi.id = COALESCE((SELECT CASE WHEN verified.rowid = price_samples_fts.rowid THEN verified.id ELSE NULL END FROM price_samples_index verified WHERE verified.id = price_samples_fts.sample_id), (SELECT identity_row.id FROM price_samples_index identity_row WHERE identity_row.rowid = price_samples_fts.rowid))' +
              ' AND psi.rowid = price_samples_fts.rowid'
            : ' FROM price_samples_index psi' + spec.joins) +
        ' WHERE ' +
        spec.where +
        '), ordered_values AS MATERIALIZED (' +
        ' SELECT valor_unitario, id, ROW_NUMBER() OVER (ORDER BY valor_unitario ASC, id ASC) AS value_rank, COUNT(*) OVER () AS value_count' +
        ' FROM filtered' +
        '), moments AS (' +
        ' SELECT COUNT(*) AS total_count, COALESCE(MIN(valor_unitario),0) AS minimum_price, COALESCE(MAX(valor_unitario),0) AS maximum_price,' +
        ' COALESCE(AVG(valor_unitario),0) AS average_price, COALESCE(SUM(valor_unitario),0) AS sum_price,' +
        ' COALESCE(SUM(valor_unitario * valor_unitario),0) AS sum_square_price FROM ordered_values' +
        '), percentile_parts AS (' +
        ' SELECT MAX(value_count) AS n,' +
        ' MAX(CASE WHEN value_rank = CAST((value_count - 1) * 0.25 AS INTEGER) + 1 THEN valor_unitario END) AS q1_low,' +
        ' MAX(CASE WHEN value_rank = CASE WHEN CAST((value_count - 1) * 0.25 AS INTEGER) + 2 > value_count THEN value_count ELSE CAST((value_count - 1) * 0.25 AS INTEGER) + 2 END THEN valor_unitario END) AS q1_high,' +
        ' MAX(CASE WHEN value_rank = CAST((value_count - 1) * 0.50 AS INTEGER) + 1 THEN valor_unitario END) AS median_low,' +
        ' MAX(CASE WHEN value_rank = CASE WHEN CAST((value_count - 1) * 0.50 AS INTEGER) + 2 > value_count THEN value_count ELSE CAST((value_count - 1) * 0.50 AS INTEGER) + 2 END THEN valor_unitario END) AS median_high,' +
        ' MAX(CASE WHEN value_rank = CAST((value_count - 1) * 0.75 AS INTEGER) + 1 THEN valor_unitario END) AS q3_low,' +
        ' MAX(CASE WHEN value_rank = CASE WHEN CAST((value_count - 1) * 0.75 AS INTEGER) + 2 > value_count THEN value_count ELSE CAST((value_count - 1) * 0.75 AS INTEGER) + 2 END THEN valor_unitario END) AS q3_high' +
        ' FROM ordered_values' +
        '), percentiles AS (' +
        ' SELECT CASE WHEN COALESCE(n,0)=0 THEN 0 ELSE q1_low + (((n - 1) * 0.25) - CAST((n - 1) * 0.25 AS INTEGER)) * (q1_high - q1_low) END AS q1_price,' +
        ' CASE WHEN COALESCE(n,0)=0 THEN 0 ELSE median_low + (((n - 1) * 0.50) - CAST((n - 1) * 0.50 AS INTEGER)) * (median_high - median_low) END AS median_price,' +
        ' CASE WHEN COALESCE(n,0)=0 THEN 0 ELSE q3_low + (((n - 1) * 0.75) - CAST((n - 1) * 0.75 AS INTEGER)) * (q3_high - q3_low) END AS q3_price' +
        ' FROM percentile_parts' +
        '), source_counts AS (SELECT source, COUNT(*) AS n FROM filtered GROUP BY source),' +
        " source_json AS (SELECT COALESCE(json_group_object(source,n),'{}') AS source_counts_json FROM source_counts)," +
        " uf_counts AS (SELECT uf, COUNT(*) AS n FROM filtered WHERE uf != '' GROUP BY uf)," +
        " uf_json AS (SELECT COALESCE(json_group_object(uf,n),'{}') AS uf_counts_json FROM uf_counts)," +
        ' page_ids AS (' +
        ' SELECT psi_rowid, ROW_NUMBER() OVER (ORDER BY ' +
        order.sql +
        ') AS page_rank FROM filtered ORDER BY ' +
        order.sql +
        ' LIMIT {:page_limit} OFFSET {:page_offset}' +
        '), page_details AS (' +
        ' SELECT page_ids.page_rank, ' +
        detailProjection('psi') +
        ' FROM page_ids CROSS JOIN price_samples_index psi ON psi.rowid = page_ids.psi_rowid' +
        ')' +
        ' SELECT moments.total_count, moments.minimum_price, moments.maximum_price, moments.average_price, moments.sum_price, moments.sum_square_price,' +
        ' percentiles.q1_price, percentiles.median_price, percentiles.q3_price, source_json.source_counts_json, uf_json.uf_counts_json,' +
        ' ' +
        nullablePageProjection('page_details') +
        ' FROM moments CROSS JOIN percentiles CROSS JOIN source_json CROSS JOIN uf_json LEFT JOIN page_details ON 1=1' +
        ' ORDER BY page_details.page_rank'
      )
    }

    function pageSql(spec, order) {
      return (
        'SELECT 0 AS total_count, 0 AS minimum_price, 0 AS maximum_price, 0 AS average_price, 0 AS sum_price, 0 AS sum_square_price,' +
        " 0 AS q1_price, 0 AS median_price, 0 AS q3_price, '{}' AS source_counts_json, '{}' AS uf_counts_json," +
        ' ROW_NUMBER() OVER (ORDER BY ' +
        order.sql.replace(/\b(valor_unitario|data_referencia|id)\b/g, 'psi.$1') +
        ') AS page_rank, ' +
        detailProjection('psi') +
        ' FROM price_samples_index psi' +
        spec.joins +
        ' WHERE ' +
        spec.where +
        ' ORDER BY ' +
        order.sql.replace(/\b(valor_unitario|data_referencia|id)\b/g, 'psi.$1') +
        ' LIMIT {:page_limit} OFFSET {:page_offset}'
      )
    }

    function loadFreshness() {
      // AUTONOMOUS_DAILY_READ_V1_BEGIN — duplicated for isolated PocketBase callbacks.
      function dailyJson(raw) {
        try {
          return JSON.parse(raw || '{}')
        } catch (_) {
          return {}
        }
      }
      function dailyPublicError(value, fallback) {
        // Match exact public codes only; worker exceptions may contain URLs, bodies or private state.
        var allowed = [
          'SOURCE_UNAVAILABLE',
          'SOURCE_STATE_UNAVAILABLE',
          'SOURCE_STATE_SIZE',
          'SOURCE_STATE_VERSION',
          'SOURCE_HTTP_429',
          'SOURCE_HTTP_500',
          'SOURCE_HTTP_502',
          'SOURCE_HTTP_503',
          'SOURCE_HTTP_504',
          'SOURCE_BODY',
          'SOURCE_PAGE',
          'SOURCE_DOMAIN',
          'SOURCE_DOMAIN_PENDING',
          'SOURCE_BUDGET',
          'SOURCE_LEASE_LOST',
          'SOURCE_CAPACITY',
          'DAILY_OPERATION_FAILED',
          'DAILY_VALIDITY_FAILED',
        ]
        return typeof value === 'string' && allowed.indexOf(value) >= 0
          ? value
          : fallback || 'SOURCE_UNAVAILABLE'
      }
      function dailyTimestamp(value) {
        return typeof value === 'string' &&
          /^20\d\d-\d\d-\d\dT/.test(value) &&
          isFinite(Date.parse(value))
          ? value
          : null
      }
      function dailySource(source, requestedDay, startedAt) {
        var result = {
          source: source,
          status: 'queued',
          source_checked_at: null,
          source_written_at: null,
          last_drained_at: null,
          backlog: null,
          next_attempt_at: null,
          last_error: null,
          coverage: 'partial',
          requested_through: null,
          daily_acknowledged_through: null,
          daily_complete: false,
          daily_checked_count: 0,
          daily_new_count: 0,
          daily_updated_count: 0,
          daily_unchanged_count: 0,
        }
        try {
          var rows = $app.findRecordsByFilter(
            'price_watermarks',
            'fonte = {:source} && cursor_tipo = "autonomous-v1"',
            '',
            2,
            0,
            { source: source },
          )
          if (rows.length !== 1) throw new Error('SOURCE_STATE_UNAVAILABLE')
          var raw = rows[0].getString('detalhes')
          if (raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
          var state = dailyJson(raw)
          if (
            state.version !== 1 ||
            state.source !== source ||
            !state.lanes ||
            typeof state.lanes !== 'object' ||
            Array.isArray(state.lanes)
          )
            throw new Error('SOURCE_STATE_VERSION')
          result.source_checked_at = dailyTimestamp(state.source_checked_at)
          result.source_written_at = dailyTimestamp(state.source_written_at)
          result.last_drained_at = dailyTimestamp(state.last_drained_at)
          result.backlog =
            Number.isSafeInteger(state.backlog) && state.backlog >= 0 ? state.backlog : null
          result.next_attempt_at = dailyTimestamp(state.next_attempt_at)
          result.last_error = state.last_error ? dailyPublicError(state.last_error) : null
          result.requested_through = /^20\d\d-\d\d-\d\d$/.test(state.requested_through || '')
            ? state.requested_through
            : null
          var ack = state.daily_ack || {},
            checked = dailyTimestamp(ack.source_checked_at),
            drained = dailyTimestamp(ack.drained_at)
          var counts = ['checked_count', 'new_count', 'updated_count', 'unchanged_count']
          var validCounts =
            counts.every(function (k) {
              return Number.isSafeInteger(ack[k]) && ack[k] >= 0
            }) && ack.checked_count === ack.new_count + ack.updated_count + ack.unchanged_count
          // An unrelated history-page check/drain never acknowledges the requested daily window.
          var validAck =
            requestedDay &&
            ack.requested_through === requestedDay &&
            checked &&
            drained &&
            Date.parse(checked) >= Date.parse(startedAt) &&
            Date.parse(drained) >= Date.parse(checked) &&
            validCounts &&
            (source === 'PNCP' ? ack.coverage === 'recent_window' : ack.coverage === 'known_codes')
          if (validAck) {
            result.daily_acknowledged_through = ack.requested_through
            result.daily_complete = true
            result.daily_checked_count = ack.checked_count
            result.daily_new_count = ack.new_count
            result.daily_updated_count = ack.updated_count
            result.daily_unchanged_count = ack.unchanged_count
            result.daily_drained_at = drained
          } else {
            // Active counters prove progress only within this durable daily run, never completion.
            var active = (source === 'PNCP' ? state.daily_cycle : state.daily) || {}
            var runStart = dailyTimestamp(startedAt),
              activeStart = dailyTimestamp(active.started_at)
            var activeChecked = dailyTimestamp(active.source_checked_at),
              nowMs = Date.now()
            var validActive =
              /^20\d\d-\d\d-\d\d$/.test(requestedDay || '') &&
              isFinite(Date.parse(requestedDay + 'T00:00:00Z')) &&
              new Date(requestedDay + 'T00:00:00Z').toISOString().slice(0, 10) === requestedDay &&
              requestedDay <= new Date(nowMs - 86400000).toISOString().slice(0, 10) &&
              runStart &&
              activeStart &&
              activeChecked &&
              Date.parse(activeStart) === Date.parse(runStart) &&
              Date.parse(runStart) <= nowMs &&
              Date.parse(activeChecked) >= Date.parse(runStart) &&
              Date.parse(activeChecked) <= nowMs &&
              counts.every(function (k) {
                return Number.isSafeInteger(active[k]) && active[k] >= 0
              }) &&
              active.checked_count ===
                active.new_count + active.updated_count + active.unchanged_count
            if (validActive && source === 'PNCP') {
              var firstChecked = dailyTimestamp(active.first_checked_at)
              var epoch = requestedDay + '@' + new Date(runStart).toISOString()
              validActive =
                active.requested_through === requestedDay &&
                active.phase === 'active' &&
                active.epoch === epoch &&
                state.lanes.updates &&
                state.lanes.updates.daily_epoch === epoch &&
                firstChecked &&
                Date.parse(firstChecked) >= Date.parse(runStart) &&
                Date.parse(firstChecked) <= Date.parse(activeChecked)
            } else if (validActive) {
              validActive = active.target_day === requestedDay && active.complete === false
            }
            if (validActive) {
              result.daily_checked_count = active.checked_count
              result.daily_new_count = active.new_count
              result.daily_updated_count = active.updated_count
              result.daily_unchanged_count = active.unchanged_count
            }
          }
          result.status = result.daily_complete
            ? 'completed'
            : result.last_error
              ? 'error'
              : startedAt && Date.parse(state.last_attempt_at || '') >= Date.parse(startedAt)
                ? 'running'
                : 'queued'
        } catch (err) {
          result.status = 'error'
          result.last_error = dailyPublicError(err.message || err)
        }
        return result
      }
      function dailyRunSummary(rec) {
        if (!rec) return null
        var details = dailyJson(rec.getString('detalhes')),
          day = rec.getString('data_ciclo')
        if (
          details.contract !== 'autonomous-daily-v1' ||
          details.version !== 1 ||
          rec.getString('ciclo_id') !== 'CICLO_AUTONOMOUS_V1_' + day
        )
          return null
        var started = rec.getString('iniciado_em'),
          requested = details.requested_through
        var sources = {
          PNCP: dailySource('PNCP', requested, started),
          'Compras.gov.br': dailySource('Compras.gov.br', requested, started),
        }
        var values = [sources.PNCP, sources['Compras.gov.br']],
          errors = dailyJson(rec.getString('erros'))
        if (!Array.isArray(errors)) errors = []
        errors = errors.map(function (value) {
          return dailyPublicError(value, 'DAILY_OPERATION_FAILED')
        })
        var complete =
          values.every(function (s) {
            return s.daily_complete
          }) && !errors.length
        var status = complete
          ? 'completed'
          : errors.length ||
              values.some(function (s) {
                return s.status === 'error'
              })
            ? 'error'
            : values.some(function (s) {
                  return s.status === 'running' || s.daily_complete
                })
              ? 'running'
              : 'queued'
        var finished = complete
          ? values
              .map(function (s) {
                return s.daily_drained_at
              })
              .sort()
              .pop()
          : ''
        return {
          ciclo_id: rec.getString('ciclo_id'),
          data_ciclo: day,
          status: status,
          iniciado_em: started,
          data_hora: started,
          finalizado_em: finished,
          duracao_ms: rec.getInt('duracao_ms'),
          novas_amostras: values.reduce(function (n, s) {
            return n + s.daily_new_count
          }, 0),
          amostras_validadas: values.reduce(function (n, s) {
            return n + s.daily_checked_count
          }, 0),
          amostras_invalidadas: rec.getInt('amostras_invalidadas'),
          termos_reabertos: 0,
          erros: errors,
          detalhes: {
            version: 1,
            contract: 'autonomous-daily-v1',
            requested_through: requested,
            coverage: 'recent_window_and_known_codes',
            national_backfill_complete: false,
            mensagem: complete
              ? 'Janela recente PNCP e códigos conhecidos de Compras.gov.br verificados; acervo nacional parcial.'
              : 'Verificação oficial diária pendente; manutenção local não comprova atualização das fontes.',
          },
          fontes: sources,
        }
      }
      // AUTONOMOUS_DAILY_READ_V1_END

      var result = {}
      ;['PNCP', 'Compras.gov.br'].forEach(function (source) {
        result[source] = dailySource(source)
        // Legacy cursor/update columns never prove an official verification or price write.
        result[source].ultima_data_sincronizada = null
        result[source].total_coletadas_watermark = null
        result[source].ultima_atualizacao = null
      })
      return result
    }

    function loadDailyRun() {
      // AUTONOMOUS_DAILY_READ_V1_BEGIN — duplicated for isolated PocketBase callbacks.
      function dailyJson(raw) {
        try {
          return JSON.parse(raw || '{}')
        } catch (_) {
          return {}
        }
      }
      function dailyPublicError(value, fallback) {
        // Match exact public codes only; worker exceptions may contain URLs, bodies or private state.
        var allowed = [
          'SOURCE_UNAVAILABLE',
          'SOURCE_STATE_UNAVAILABLE',
          'SOURCE_STATE_SIZE',
          'SOURCE_STATE_VERSION',
          'SOURCE_HTTP_429',
          'SOURCE_HTTP_500',
          'SOURCE_HTTP_502',
          'SOURCE_HTTP_503',
          'SOURCE_HTTP_504',
          'SOURCE_BODY',
          'SOURCE_PAGE',
          'SOURCE_DOMAIN',
          'SOURCE_DOMAIN_PENDING',
          'SOURCE_BUDGET',
          'SOURCE_LEASE_LOST',
          'SOURCE_CAPACITY',
          'DAILY_OPERATION_FAILED',
          'DAILY_VALIDITY_FAILED',
        ]
        return typeof value === 'string' && allowed.indexOf(value) >= 0
          ? value
          : fallback || 'SOURCE_UNAVAILABLE'
      }
      function dailyTimestamp(value) {
        return typeof value === 'string' &&
          /^20\d\d-\d\d-\d\dT/.test(value) &&
          isFinite(Date.parse(value))
          ? value
          : null
      }
      function dailySource(source, requestedDay, startedAt) {
        var result = {
          source: source,
          status: 'queued',
          source_checked_at: null,
          source_written_at: null,
          last_drained_at: null,
          backlog: null,
          next_attempt_at: null,
          last_error: null,
          coverage: 'partial',
          requested_through: null,
          daily_acknowledged_through: null,
          daily_complete: false,
          daily_checked_count: 0,
          daily_new_count: 0,
          daily_updated_count: 0,
          daily_unchanged_count: 0,
        }
        try {
          var rows = $app.findRecordsByFilter(
            'price_watermarks',
            'fonte = {:source} && cursor_tipo = "autonomous-v1"',
            '',
            2,
            0,
            { source: source },
          )
          if (rows.length !== 1) throw new Error('SOURCE_STATE_UNAVAILABLE')
          var raw = rows[0].getString('detalhes')
          if (raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
          var state = dailyJson(raw)
          if (
            state.version !== 1 ||
            state.source !== source ||
            !state.lanes ||
            typeof state.lanes !== 'object' ||
            Array.isArray(state.lanes)
          )
            throw new Error('SOURCE_STATE_VERSION')
          result.source_checked_at = dailyTimestamp(state.source_checked_at)
          result.source_written_at = dailyTimestamp(state.source_written_at)
          result.last_drained_at = dailyTimestamp(state.last_drained_at)
          result.backlog =
            Number.isSafeInteger(state.backlog) && state.backlog >= 0 ? state.backlog : null
          result.next_attempt_at = dailyTimestamp(state.next_attempt_at)
          result.last_error = state.last_error ? dailyPublicError(state.last_error) : null
          result.requested_through = /^20\d\d-\d\d-\d\d$/.test(state.requested_through || '')
            ? state.requested_through
            : null
          var ack = state.daily_ack || {},
            checked = dailyTimestamp(ack.source_checked_at),
            drained = dailyTimestamp(ack.drained_at)
          var counts = ['checked_count', 'new_count', 'updated_count', 'unchanged_count']
          var validCounts =
            counts.every(function (k) {
              return Number.isSafeInteger(ack[k]) && ack[k] >= 0
            }) && ack.checked_count === ack.new_count + ack.updated_count + ack.unchanged_count
          // An unrelated history-page check/drain never acknowledges the requested daily window.
          var validAck =
            requestedDay &&
            ack.requested_through === requestedDay &&
            checked &&
            drained &&
            Date.parse(checked) >= Date.parse(startedAt) &&
            Date.parse(drained) >= Date.parse(checked) &&
            validCounts &&
            (source === 'PNCP' ? ack.coverage === 'recent_window' : ack.coverage === 'known_codes')
          if (validAck) {
            result.daily_acknowledged_through = ack.requested_through
            result.daily_complete = true
            result.daily_checked_count = ack.checked_count
            result.daily_new_count = ack.new_count
            result.daily_updated_count = ack.updated_count
            result.daily_unchanged_count = ack.unchanged_count
            result.daily_drained_at = drained
          } else {
            // Active counters prove progress only within this durable daily run, never completion.
            var active = (source === 'PNCP' ? state.daily_cycle : state.daily) || {}
            var runStart = dailyTimestamp(startedAt),
              activeStart = dailyTimestamp(active.started_at)
            var activeChecked = dailyTimestamp(active.source_checked_at),
              nowMs = Date.now()
            var validActive =
              /^20\d\d-\d\d-\d\d$/.test(requestedDay || '') &&
              isFinite(Date.parse(requestedDay + 'T00:00:00Z')) &&
              new Date(requestedDay + 'T00:00:00Z').toISOString().slice(0, 10) === requestedDay &&
              requestedDay <= new Date(nowMs - 86400000).toISOString().slice(0, 10) &&
              runStart &&
              activeStart &&
              activeChecked &&
              Date.parse(activeStart) === Date.parse(runStart) &&
              Date.parse(runStart) <= nowMs &&
              Date.parse(activeChecked) >= Date.parse(runStart) &&
              Date.parse(activeChecked) <= nowMs &&
              counts.every(function (k) {
                return Number.isSafeInteger(active[k]) && active[k] >= 0
              }) &&
              active.checked_count ===
                active.new_count + active.updated_count + active.unchanged_count
            if (validActive && source === 'PNCP') {
              var firstChecked = dailyTimestamp(active.first_checked_at)
              var epoch = requestedDay + '@' + new Date(runStart).toISOString()
              validActive =
                active.requested_through === requestedDay &&
                active.phase === 'active' &&
                active.epoch === epoch &&
                state.lanes.updates &&
                state.lanes.updates.daily_epoch === epoch &&
                firstChecked &&
                Date.parse(firstChecked) >= Date.parse(runStart) &&
                Date.parse(firstChecked) <= Date.parse(activeChecked)
            } else if (validActive) {
              validActive = active.target_day === requestedDay && active.complete === false
            }
            if (validActive) {
              result.daily_checked_count = active.checked_count
              result.daily_new_count = active.new_count
              result.daily_updated_count = active.updated_count
              result.daily_unchanged_count = active.unchanged_count
            }
          }
          result.status = result.daily_complete
            ? 'completed'
            : result.last_error
              ? 'error'
              : startedAt && Date.parse(state.last_attempt_at || '') >= Date.parse(startedAt)
                ? 'running'
                : 'queued'
        } catch (err) {
          result.status = 'error'
          result.last_error = dailyPublicError(err.message || err)
        }
        return result
      }
      function dailyRunSummary(rec) {
        if (!rec) return null
        var details = dailyJson(rec.getString('detalhes')),
          day = rec.getString('data_ciclo')
        if (
          details.contract !== 'autonomous-daily-v1' ||
          details.version !== 1 ||
          rec.getString('ciclo_id') !== 'CICLO_AUTONOMOUS_V1_' + day
        )
          return null
        var started = rec.getString('iniciado_em'),
          requested = details.requested_through
        var sources = {
          PNCP: dailySource('PNCP', requested, started),
          'Compras.gov.br': dailySource('Compras.gov.br', requested, started),
        }
        var values = [sources.PNCP, sources['Compras.gov.br']],
          errors = dailyJson(rec.getString('erros'))
        if (!Array.isArray(errors)) errors = []
        errors = errors.map(function (value) {
          return dailyPublicError(value, 'DAILY_OPERATION_FAILED')
        })
        var complete =
          values.every(function (s) {
            return s.daily_complete
          }) && !errors.length
        var status = complete
          ? 'completed'
          : errors.length ||
              values.some(function (s) {
                return s.status === 'error'
              })
            ? 'error'
            : values.some(function (s) {
                  return s.status === 'running' || s.daily_complete
                })
              ? 'running'
              : 'queued'
        var finished = complete
          ? values
              .map(function (s) {
                return s.daily_drained_at
              })
              .sort()
              .pop()
          : ''
        return {
          ciclo_id: rec.getString('ciclo_id'),
          data_ciclo: day,
          status: status,
          iniciado_em: started,
          data_hora: started,
          finalizado_em: finished,
          duracao_ms: rec.getInt('duracao_ms'),
          novas_amostras: values.reduce(function (n, s) {
            return n + s.daily_new_count
          }, 0),
          amostras_validadas: values.reduce(function (n, s) {
            return n + s.daily_checked_count
          }, 0),
          amostras_invalidadas: rec.getInt('amostras_invalidadas'),
          termos_reabertos: 0,
          erros: errors,
          detalhes: {
            version: 1,
            contract: 'autonomous-daily-v1',
            requested_through: requested,
            coverage: 'recent_window_and_known_codes',
            national_backfill_complete: false,
            mensagem: complete
              ? 'Janela recente PNCP e códigos conhecidos de Compras.gov.br verificados; acervo nacional parcial.'
              : 'Verificação oficial diária pendente; manutenção local não comprova atualização das fontes.',
          },
          fontes: sources,
        }
      }
      // AUTONOMOUS_DAILY_READ_V1_END

      try {
        var rows = $app.findRecordsByFilter(
          'daily_sync_runs',
          'ciclo_id ~ "CICLO_AUTONOMOUS_V1_"',
          '-data_ciclo',
          1,
          0,
        )
        return rows.length ? dailyRunSummary(rows[0]) : null
      } catch (_) {
        return null
      }
    }

    function loadTask(spec, taskOwnerId) {
      if (!spec.term) return null
      try {
        var rows = arrayOf(
          new DynamicModel({
            id: '',
            task_key: '',
            status: '',
            paginas_consultadas: 0,
            itens_processados: 0,
            amostras_inseridas: 0,
            amostras_atualizadas: 0,
            tentativas: 0,
            pendentes_raw: '[]',
            updated: '',
          }),
        )
        var legacyTaskKey = 'AMBAS#' + spec.normalizedTerm + '#' + spec.canonicalUf
        var ownerTaskKey = legacyTaskKey + '#OWNER#' + String(taskOwnerId)
        query(
          "SELECT id, task_key, status, paginas_consultadas, itens_processados, amostras_inseridas, amostras_atualizadas, tentativas, COALESCE(CAST(pendentes AS TEXT),'[]') AS pendentes_raw, updated " +
            "FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND source = 'AMBAS' " +
            'AND requested_by = {:task_owner} AND (task_key = {:owner_task_key} OR task_key = {:legacy_task_key}) ' +
            "AND COALESCE(NULLIF(uf,''),'ALL') = {:task_uf} " +
            'ORDER BY CASE WHEN task_key = {:owner_task_key} THEN 0 ELSE 1 END, updated DESC LIMIT 1',
        )
          .bind({
            task_owner: String(taskOwnerId),
            owner_task_key: ownerTaskKey,
            legacy_task_key: legacyTaskKey,
            task_uf: spec.canonicalUf,
          })
          .all(rows)
        if (!rows.length) return null
        var task = rows[0]
        var pending = []
        var pendingDisplayValid = false
        try {
          pending = JSON.parse(task.pendentes_raw || '[]')
          pendingDisplayValid = Array.isArray(pending)
        } catch (_) {}
        return {
          id: task.id,
          task_key: task.task_key,
          status: task.status,
          ativa: task.status === 'pending' || task.status === 'running',
          pendentes_count: Array.isArray(pending) ? pending.length : 0,
          // Presentation only: relationships are pending units, not verified purchases.
          pendentes_detalhamento_count: pendingDisplayValid
            ? pending.filter(function (p) {
                return !(p && p._pncp_discovery)
              }).length
            : null,
          descoberta_pendente: pendingDisplayValid
            ? pending.some(function (p) {
                if (!p || !p._pncp_discovery) return false
                var exhausted = p._pncp_discovery.esgotados || {}
                return !(exhausted.ata && exhausted.edital && exhausted.contrato)
              })
            : null,
          paginas_consultadas: Number(task.paginas_consultadas) || 0,
          itens_processados: Number(task.itens_processados) || 0,
          amostras_inseridas: Number(task.amostras_inseridas) || 0,
          amostras_atualizadas: Number(task.amostras_atualizadas) || 0,
          tentativas: Number(task.tentativas) || 0,
          updated: task.updated,
        }
      } catch (_) {
        return null
      }
    }

    try {
      var body = {}
      var queryParams = {}
      try {
        body = e.requestInfo().body || {}
        queryParams = e.requestInfo().query || {}
      } catch (_) {}
      var params = Object.assign({}, queryParams, body)
      var validated = validateRequest(params)
      if (!validated.ok)
        return e.json(400, {
          sucesso: false,
          code: validated.code,
          error: validated.error,
          duracao_ms: new Date().getTime() - startedAt,
        })
      var rateStartedAt = new Date().getTime()
      var rate = consumeRateLimit(e.auth.id)
      phaseTimes.rate_ms = Math.max(0, new Date().getTime() - rateStartedAt)
      if (!rate.available)
        return e.json(503, {
          sucesso: false,
          code: 'SEARCH_RATE_LIMIT_UNAVAILABLE',
          error: 'A proteção de capacidade da busca está indisponível.',
          diagnostic_id: capacityDiagnosticId,
          duracao_ms: new Date().getTime() - startedAt,
        })
      if (!rate.accepted)
        return e.json(429, {
          sucesso: false,
          code: 'SEARCH_RATE_LIMITED',
          error: 'Limite temporário de buscas atingido.',
          retry_after_seconds: 60,
          duracao_ms: new Date().getTime() - startedAt,
        })
      var page = validated.page
      var limit = validated.limit
      var order = orderSpec(params)
      var queryHash = snapshotQueryHash(validated, order)
      if (validated.cursor) {
        try {
          var continuation = loadSnapshotContinuation(e.auth.id, validated, queryHash, order)
          if (continuation.status === 503) logSearchFailure('snapshot_read')
          if (continuation.status !== 200)
            return e.json(continuation.status, {
              sucesso: false,
              code: continuation.code,
              error: continuation.error,
              duracao_ms: new Date().getTime() - startedAt,
            })
          continuation.body.duracao_ms = new Date().getTime() - startedAt
          return e.json(200, continuation.body)
        } catch (snapshotReadError) {
          logSearchFailure('snapshot_read', snapshotReadError)
          return e.json(503, {
            sucesso: false,
            code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
            error: 'A janela materializada desta busca está indisponível.',
            duracao_ms: new Date().getTime() - startedAt,
          })
        }
      }

      var pageOnly = params.include_summary === false && page > 1
      var spec = filterSpec(params, validated, rate.identityCoverReady, rate.projectionReady)
      var captureLimit = limit
      var binds = Object.assign({}, spec.binds, {
        page_limit: captureLimit,
        page_offset: (page - 1) * limit,
      })
      var rows = arrayOf(new DynamicModel(hitShape()))
      var snapshot = null
      var snapshotWriteError = null
      var firstCurrentHits = null
      var capturedAt = ''
      try {
        if (pageOnly) {
          query(pageSql(spec, order)).bind(binds).all(rows)
        } else {
          // BEGIN IMMEDIATE keeps the aggregate/first page and the materialized
          // continuation pages on one SQLite view. Concurrent writers wait and
          // therefore cannot shift, mutate or delete later pages mid-snapshot.
          var transactionRequestedAt = new Date().getTime()
          var transactionBodyFinishedAt = transactionRequestedAt
          $app.runInTransaction(function (txApp) {
            phaseTimes.tx_enter_ms = Math.max(0, new Date().getTime() - transactionRequestedAt)
            capturedAt = new Date().toISOString()
            function txQuery(sql) {
              return txApp.db().newQuery(sql).withContext(requestContext)
            }
            var summaryStartedAt = new Date().getTime()
            rows = readSummaryRows(txQuery(summarySql(spec, order)).bind(binds), rows)
            phaseTimes.summary_ms = Math.max(0, new Date().getTime() - summaryStartedAt)
            var transactionTotal = rows.length ? Number(rows[0].total_count) || 0 : 0
            if (validated.snapshotVersion === 2) {
              var validationStartedAt = new Date().getTime()
              try {
                firstCurrentHits = currentPageHits(rows)
              } catch (error) {
                if (!error.snapshotDrift) snapshotWriteError = error
                throw error
              }
              phaseTimes.validate100_ms = Math.max(0, new Date().getTime() - validationStartedAt)
            }
            if (page === 1 && transactionTotal > limit) {
              try {
                var snapshotStartedAt = new Date().getTime()
                snapshot = persistSnapshot(
                  txApp,
                  e.auth.id,
                  queryHash,
                  order,
                  limit,
                  transactionTotal,
                  spec,
                  validated.snapshotVersion,
                )
                phaseTimes.snapshot_ms = Math.max(0, new Date().getTime() - snapshotStartedAt)
              } catch (error) {
                snapshotWriteError = error
                throw error
              }
            }
            transactionBodyFinishedAt = new Date().getTime()
          })
          phaseTimes.tx_commit_ms = Math.max(0, new Date().getTime() - transactionBodyFinishedAt)
        }
      } catch (searchError) {
        if (searchError.snapshotDrift) {
          var drift = snapshotDrift()
          return e.json(drift.status, {
            sucesso: false,
            code: drift.code,
            error: drift.error,
            duracao_ms: new Date().getTime() - startedAt,
          })
        }
        if (snapshotWriteError) {
          logSearchFailure('snapshot_write', snapshotWriteError)
          return e.json(503, {
            sucesso: false,
            code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
            error: 'Não foi possível fixar uma janela estável para esta busca.',
            duracao_ms: new Date().getTime() - startedAt,
          })
        }
        if (spec.usesFts && ftsFailure(searchError)) {
          logSearchFailure('fts', searchError)
          return e.json(503, {
            sucesso: false,
            code: 'SEARCH_INDEX_UNAVAILABLE',
            etapa: 'fts',
            error:
              'O índice textual oficial está indisponível; nenhum fallback lento foi executado.',
            duracao_ms: new Date().getTime() - startedAt,
          })
        }
        logSearchFailure('query', searchError)
        return e.json(500, {
          sucesso: false,
          code: 'SEARCH_QUERY_FAILED',
          etapa: 'query',
          error: String(searchError && (searchError.message || searchError)),
          duracao_ms: new Date().getTime() - startedAt,
        })
      }

      var capturedHits = firstCurrentHits || []
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        if (!firstCurrentHits && Number(rows[rowIndex].detail_rowid) > 0 && rows[rowIndex].id)
          capturedHits.push(hitFromRow(rows[rowIndex]))
      }
      if (pageOnly) {
        return e.json(200, {
          sucesso: true,
          summary_included: false,
          page: page,
          limit: limit,
          hits: capturedHits,
          duracao_ms: new Date().getTime() - startedAt,
        })
      }

      var summary = rows.length ? rows[0] : hitShape()
      var total = Number(summary.total_count) || 0
      var average = Number(summary.average_price) || 0
      var variance =
        total > 1
          ? Math.max(
              0,
              (Number(summary.sum_square_price) -
                (Number(summary.sum_price) * Number(summary.sum_price)) / total) /
                (total - 1),
            )
          : 0
      var q1 = rounded(summary.q1_price)
      var q3 = rounded(summary.q3_price)
      var iqr = rounded(q3 - q1)
      var sourceCounts = parsedObject(summary.source_counts_json)
      if (!Object.prototype.hasOwnProperty.call(sourceCounts, 'PNCP')) sourceCounts.PNCP = 0
      if (!Object.prototype.hasOwnProperty.call(sourceCounts, 'Compras.gov.br'))
        sourceCounts['Compras.gov.br'] = 0
      var responseHits = capturedHits.slice(0, limit)
      // Include snapshot serialization and its SQLite transaction in the public
      // latency. Reporting only the SELECT time would hide work that delays the
      // HTTP response seen by the caller.
      var duration = new Date().getTime() - startedAt
      var response = e.json(200, {
        sucesso: true,
        summary_included: true,
        summary_valid: true,
        total: total,
        page: page,
        limit: limit,
        pages: Math.ceil(total / limit) || 1,
        snapshot: snapshot ? snapshot.token : undefined,
        next_cursor:
          snapshot && snapshot.pageCount > 1
            ? cursorToken(snapshot.secret, queryHash, 2, validated.snapshotVersion)
            : null,
        has_more: snapshot ? snapshot.pageCount > 1 : page * limit < total,
        snapshot_window_count: snapshot ? snapshot.capturedCount : responseHits.length,
        snapshot_version: validated.snapshotVersion,
        snapshot_captured_at:
          validated.snapshotVersion === 2
            ? snapshot
              ? snapshot.capturedAt
              : capturedAt
            : undefined,
        snapshot_consistency:
          validated.snapshotVersion === 2 ? 'fixed_ids_current_evidence' : 'frozen_v1',
        snapshot_identity_complete: validated.snapshotVersion === 2 ? true : undefined,
        snapshot_population_complete:
          validated.snapshotVersion === 2
            ? undefined
            : snapshot
              ? snapshot.populationComplete
              : true,
        population_has_more:
          validated.snapshotVersion === 2
            ? undefined
            : snapshot
              ? !snapshot.populationComplete
              : false,
        duracao_ms: duration,
        hits: responseHits,
        filtros_aplicados: {
          termo: spec.term,
          palavra_exata: validated.exactPhrase,
          cnpj: validated.cnpj,
          sources: validated.sources,
          uf: params.uf || params.estado || '',
          periodo_meses: spec.months,
          data_inicio: validated.dataStart,
          data_fim: params.data_fim || '',
          preco_min: validated.minimumPrice,
          preco_max: validated.maximumPrice,
          unidade: validated.unit,
          marca: validated.brand,
          porte: validated.onlyMeEpp ? 'ME_EPP' : validated.supplierSize,
          modalidade: validated.modality,
          natureza_preco: validated.priceNature,
          sort: order.name,
        },
        aggregations: {
          total: total,
          por_fonte: sourceCounts,
          por_uf: parsedObject(summary.uf_counts_json),
          estatisticas: {
            n: total,
            media: rounded(average),
            mediana: rounded(summary.median_price),
            q1: q1,
            q3: q3,
            minimo: rounded(summary.minimum_price),
            maximo: rounded(summary.maximum_price),
            desvio_padrao: rounded(Math.sqrt(variance)),
            iqr: iqr,
            limite_inferior_iqr: rounded(Math.max(0, q1 - 1.5 * iqr)),
            limite_superior_iqr: rounded(q3 + 1.5 * iqr),
            regra_outlier: 'IQR_1_5_VERSION_1_0',
          },
        },
        status_tarefa: loadTask(spec, e.auth.id),
        frescor_sincronizacao: loadFreshness(),
        ciclo_diario: loadDailyRun(),
        metricas_consulta: {
          took_ms: duration,
          amostras_avaliadas: total,
          origem_consulta: 'indice_oficial_fts_v3',
          chamadas_externas_disparadas: 0,
          protocolo_auditoria: 'LEI_14133_ART_23_PAINEL_PRECOS',
        },
      })
      if (validated.snapshotVersion === 2) logSearchTiming()
      if (validated.snapshotVersion === 2 && phaseTimes.summary_ms >= 2000)
        logSearchPlan(spec, order, binds)
      return response
    } catch (error) {
      return e.json(500, {
        sucesso: false,
        code: 'SEARCH_HANDLER_FAILED',
        etapa: 'handler',
        error: String(error && (error.message || error)),
        duracao_ms: new Date().getTime() - startedAt,
      })
    }
  },
  $apis.requireAuth(),
  $apis.bodyLimit(32 * 1024),
)

// A rota GET conserva o contrato legado, mas usa exatamente o mesmo conjunto
// elegível, a mesma FTS e a mesma consulta atômica da rota POST.
routerAdd(
  'GET',
  '/backend/v1/precos/busca',
  function (e) {
    var startedAt = new Date().getTime()
    if (!e.auth || !e.auth.id)
      return e.json(401, {
        sucesso: false,
        code: 'AUTH_REQUIRED',
        error: 'Autenticação obrigatória.',
      })
    var requestContext = e.request.context()

    function query(sql) {
      if (requestContext.err()) throw new Error('context canceled')
      return $app.db().newQuery(sql).withContext(requestContext)
    }

    function normalize(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/(\d+)\s*(MG|ML|MCG|KG|G|L)\b/g, '$1$2')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function meaningfulTokens(value) {
      var ignored = {
        A: true,
        O: true,
        AS: true,
        OS: true,
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
        ITEM: true,
        LOTE: true,
        AQUISICAO: true,
        FORNECIMENTO: true,
        REGISTRO: true,
        PRECOS: true,
      }
      var normalized = normalize(value)
      if (!normalized) return []
      var parts = normalized.split(/\s+/)
      var result = []
      var seen = {}
      for (var i = 0; i < parts.length; i++) {
        var token = parts[i]
        if (token.length < 2 || ignored[token] || seen[token]) continue
        seen[token] = true
        result.push(token)
      }
      return result
    }

    function sourceName(value) {
      var normalized = normalize(value)
      if (normalized === 'PNCP') return 'PNCP'
      if (normalized === 'COMPRAS GOV BR' || normalized === 'COMPRASGOVBR') return 'Compras.gov.br'
      return ''
    }

    function rounded(value) {
      var number = Number(value)
      return isFinite(number) ? Number(number.toFixed(4)) : 0
    }

    function parsedObject(value) {
      if (!value) return {}
      if (typeof value === 'object') return value
      try {
        var parsed = JSON.parse(String(value))
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (_) {
        return {}
      }
    }

    function ftsFailure(error) {
      var message = String(error && (error.message || error))
      return /price_samples_fts|fts5|match|no such table|virtual table/i.test(message)
    }

    function normalizedSql(column) {
      var expression = 'UPPER(COALESCE(' + column + ", ''))"
      var replacements = [
        ['Á', 'A'],
        ['À', 'A'],
        ['Â', 'A'],
        ['Ã', 'A'],
        ['Ä', 'A'],
        ['É', 'E'],
        ['È', 'E'],
        ['Ê', 'E'],
        ['Ë', 'E'],
        ['Í', 'I'],
        ['Ì', 'I'],
        ['Î', 'I'],
        ['Ï', 'I'],
        ['Ó', 'O'],
        ['Ò', 'O'],
        ['Ô', 'O'],
        ['Õ', 'O'],
        ['Ö', 'O'],
        ['Ú', 'U'],
        ['Ù', 'U'],
        ['Û', 'U'],
        ['Ü', 'U'],
        ['Ç', 'C'],
        ['_', ' '],
        ['/', ' '],
        ['-', ' '],
        ['.', ' '],
        [',', ' '],
      ]
      for (var index = 0; index < replacements.length; index++)
        expression =
          'REPLACE(' +
          expression +
          ", '" +
          replacements[index][0] +
          "', '" +
          replacements[index][1] +
          "')"
      var compactUnits = ['MG', 'ML', 'MCG', 'KG', 'G', 'L']
      for (var unitIndex = 0; unitIndex < compactUnits.length; unitIndex++)
        expression =
          'REPLACE(' +
          expression +
          ", ' " +
          compactUnits[unitIndex] +
          "', '" +
          compactUnits[unitIndex] +
          "')"
      for (var whitespacePass = 0; whitespacePass < 3; whitespacePass++)
        expression = 'REPLACE(' + expression + ", '  ', ' ')"
      return expression
    }

    function validateRequest(params) {
      function invalid(code, error) {
        return { ok: false, code: code, error: error }
      }
      try {
        if (JSON.stringify(params).length > 8 * 1024)
          return invalid('SEARCH_INPUT_TOO_LARGE', 'Os parâmetros da busca excedem 8 KiB.')
      } catch (_) {
        return invalid('SEARCH_INPUT_INVALID', 'Parâmetros da busca inválidos.')
      }
      function first(names) {
        for (var index = 0; index < names.length; index++)
          if (params[names[index]] !== undefined && params[names[index]] !== null)
            return params[names[index]]
        return undefined
      }
      function optionalText(name, maxLength) {
        var value = params[name]
        if (value === undefined || value === null || value === '') return { ok: true, value: '' }
        if (typeof value !== 'string' || value.length > maxLength)
          return { ok: false, error: 'Filtro inválido: ' + name + '.' }
        return { ok: true, value: value.trim() }
      }
      function isoDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
        var parsed = new Date(value + 'T00:00:00.000Z')
        return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
      }
      function optionalPrice(name) {
        var value = params[name]
        if (value === undefined || value === null || value === '') return { ok: true, value: null }
        var parsed = Number(value)
        if (!isFinite(parsed) || parsed < 0 || parsed > 1000000000000000)
          return { ok: false, error: 'Faixa de preço inválida.' }
        return { ok: true, value: parsed }
      }
      function boundedInteger(value, fallback, minimum, maximum, label) {
        if (value === undefined || value === null || value === '')
          return { ok: true, value: fallback }
        var parsed = Number(value)
        if (
          !isFinite(parsed) ||
          Math.floor(parsed) !== parsed ||
          parsed < minimum ||
          parsed > maximum
        )
          return { ok: false, error: label + ' inválido.' }
        return { ok: true, value: parsed }
      }

      function optionalBoolean(value, label) {
        if (value === undefined || value === null || value === '') return { ok: true, value: false }
        if (value === true || value === 'true' || value === 1 || value === '1')
          return { ok: true, value: true }
        if (value === false || value === 'false' || value === 0 || value === '0')
          return { ok: true, value: false }
        return { ok: false, error: label + ' inválido.' }
      }

      var rawTerm = first(['termo', 'q', 'palavra_chave', 'termo_pesquisa', 'query'])
      if (typeof rawTerm !== 'string')
        return invalid('SEARCH_TERM_REQUIRED', 'Informe um produto ou serviço para pesquisar.')
      var term = rawTerm.trim()
      if (!term || term.length > 240)
        return invalid(
          term ? 'SEARCH_INPUT_TOO_LARGE' : 'SEARCH_TERM_REQUIRED',
          term
            ? 'O termo de busca excede 240 caracteres.'
            : 'Informe um produto ou serviço para pesquisar.',
        )
      var normalizedTerm = normalize(term)
      var catalog = normalizedTerm.match(/^(?:(CATMAT|CATSER)\s*)?(\d{4,8})$/)
      var tokens = meaningfulTokens(term)
      if (!catalog && !tokens.length)
        return invalid('SEARCH_TERM_INVALID', 'O termo não contém palavra significativa.')
      if (!catalog && tokens.length > 16)
        return invalid('SEARCH_INPUT_TOO_LARGE', 'Use no máximo 16 palavras significativas.')

      var exactPhrase = optionalBoolean(first(['palavra_exata', 'exact_phrase']), 'Modo de busca')
      if (!exactPhrase.ok) return invalid('SEARCH_INPUT_INVALID', exactPhrase.error)
      var rawCnpj = first(['cnpj'])
      var cnpj = ''
      if (rawCnpj !== undefined && rawCnpj !== null && rawCnpj !== '') {
        if (typeof rawCnpj !== 'string' || rawCnpj.length > 24 || !/^[\d.\/\-\s]+$/.test(rawCnpj))
          return invalid('SEARCH_INPUT_INVALID', 'CNPJ inválido.')
        cnpj = rawCnpj.replace(/\D/g, '')
        if (!/^\d{14}$/.test(cnpj)) return invalid('SEARCH_INPUT_INVALID', 'CNPJ inválido.')
      }

      var page = boundedInteger(first(['page', 'pagina']), 1, 1, 1000, 'Página')
      if (!page.ok) return invalid('SEARCH_INPUT_INVALID', page.error)
      var limit = boundedInteger(first(['limit', 'tamanho_pagina']), 50, 1, 200, 'Limite')
      if (!limit.ok) return invalid('SEARCH_INPUT_INVALID', limit.error)

      var textFields = [
        ['modalidade', 100],
        ['natureza_preco', 60],
        ['unidade', 100],
        ['marca', 100],
        ['porte', 60],
        ['sort', 40],
        ['ordenar', 40],
      ]
      var texts = {}
      for (var textIndex = 0; textIndex < textFields.length; textIndex++) {
        var checked = optionalText(textFields[textIndex][0], textFields[textIndex][1])
        if (!checked.ok) return invalid('SEARCH_INPUT_INVALID', checked.error)
        texts[textFields[textIndex][0]] = checked.value
      }

      var start = optionalText('data_inicio', 10)
      var end = optionalText('data_fim', 10)
      if (
        !start.ok ||
        !end.ok ||
        (start.value && !isoDate(start.value)) ||
        (end.value && !isoDate(end.value))
      )
        return invalid('SEARCH_INPUT_INVALID', 'Período explícito inválido.')
      if (start.value && end.value && start.value > end.value)
        return invalid(
          'SEARCH_INPUT_INVALID',
          'A data inicial não pode ser posterior à data final.',
        )
      var endExclusive = ''
      if (end.value) {
        var nextDay = new Date(end.value + 'T00:00:00.000Z')
        nextDay.setUTCDate(nextDay.getUTCDate() + 1)
        endExclusive = nextDay.toISOString().slice(0, 10)
      }

      var minimumPrice = optionalPrice('preco_min')
      var maximumPrice = optionalPrice('preco_max')
      if (!minimumPrice.ok || !maximumPrice.ok)
        return invalid('SEARCH_INPUT_INVALID', 'Faixa de preço inválida.')
      if (
        minimumPrice.value !== null &&
        maximumPrice.value !== null &&
        minimumPrice.value > maximumPrice.value
      )
        return invalid('SEARCH_INPUT_INVALID', 'O preço mínimo não pode superar o máximo.')

      var sourceInput = params.sources !== undefined ? params.sources : params.fontes
      if (
        !Array.isArray(sourceInput) &&
        sourceInput !== undefined &&
        sourceInput !== null &&
        sourceInput !== ''
      )
        sourceInput = [sourceInput]
      if (!sourceInput) sourceInput = []
      if (!Array.isArray(sourceInput) || sourceInput.length > 2)
        return invalid('SEARCH_INPUT_INVALID', 'Seleção de fontes inválida.')
      var canonicalSources = []
      var seenSources = {}
      for (var sourceIndex = 0; sourceIndex < sourceInput.length; sourceIndex++) {
        if (typeof sourceInput[sourceIndex] !== 'string' || sourceInput[sourceIndex].length > 32)
          return invalid('SEARCH_INPUT_INVALID', 'Seleção de fontes inválida.')
        var normalizedSource = normalize(sourceInput[sourceIndex])
        if (
          sourceInput.length === 1 &&
          (normalizedSource === 'TODAS' ||
            normalizedSource === 'TODOS' ||
            normalizedSource === 'AMBAS' ||
            normalizedSource === 'ALL')
        )
          continue
        var canonicalSource = sourceName(sourceInput[sourceIndex])
        if (!canonicalSource)
          return invalid('SEARCH_INPUT_INVALID', 'Fonte não permitida nesta pesquisa.')
        if (!seenSources[canonicalSource]) {
          canonicalSources.push(canonicalSource)
          seenSources[canonicalSource] = true
        }
      }
      if (!canonicalSources.length && params.fonte !== undefined && params.fonte !== null) {
        if (typeof params.fonte !== 'string' || params.fonte.length > 32)
          return invalid('SEARCH_INPUT_INVALID', 'Fonte inválida.')
        if (
          normalize(params.fonte) !== 'TODAS' &&
          normalize(params.fonte) !== 'TODOS' &&
          normalize(params.fonte) !== 'AMBAS' &&
          normalize(params.fonte) !== 'ALL'
        ) {
          var singleSource = sourceName(params.fonte)
          if (!singleSource)
            return invalid('SEARCH_INPUT_INVALID', 'Fonte não permitida nesta pesquisa.')
          canonicalSources.push(singleSource)
        }
      }

      var rawUf = first(['uf', 'estado'])
      var canonicalUf = 'ALL'
      if (rawUf !== undefined && rawUf !== null && rawUf !== '') {
        if (typeof rawUf !== 'string') return invalid('SEARCH_INPUT_INVALID', 'UF inválida.')
        var upperUf = rawUf.trim().toUpperCase()
        if (upperUf !== 'TODAS' && upperUf !== 'TODOS' && upperUf !== 'ALL') {
          if (!/^[A-Z]{2}$/.test(upperUf)) return invalid('SEARCH_INPUT_INVALID', 'UF inválida.')
          canonicalUf = upperUf
        }
      }

      var rawPeriod = first(['periodo_meses', 'periodo'])
      var months = 0
      if (
        rawPeriod !== undefined &&
        rawPeriod !== null &&
        rawPeriod !== '' &&
        String(rawPeriod) !== '0'
      ) {
        var normalizedPeriod = normalize(rawPeriod)
        if (normalizedPeriod !== 'TODOS' && normalizedPeriod !== 'TODAS') {
          var periodMatch = normalizedPeriod.match(/^(?:MESES?\s*)?(\d{1,3})$/)
          if (!periodMatch) return invalid('SEARCH_INPUT_INVALID', 'Período relativo inválido.')
          months = parseInt(periodMatch[1], 10)
          if (months < 1 || months > 240)
            return invalid('SEARCH_INPUT_INVALID', 'Período relativo inválido.')
        }
      }

      var onlyMeEpp =
        params.apenas_me_epp === true ||
        String(params.apenas_me_epp || '').toLowerCase() === 'true' ||
        String(params.apenas_me_epp || '') === '1'
      return {
        ok: true,
        term: term,
        normalizedTerm: normalizedTerm,
        catalog: catalog,
        tokens: tokens,
        exactPhrase: exactPhrase.value,
        cnpj: cnpj,
        page: page.value,
        limit: limit.value,
        dataStart: start.value,
        dataEndExclusive: endExclusive,
        minimumPrice: minimumPrice.value,
        maximumPrice: maximumPrice.value,
        sources: canonicalSources,
        canonicalUf: canonicalUf,
        months: months,
        modality: texts.modalidade,
        priceNature: texts.natureza_preco,
        unit: texts.unidade,
        brand: texts.marca,
        supplierSize: texts.porte,
        onlyMeEpp: onlyMeEpp,
      }
    }

    function consumeRateLimit(userId) {
      var accepted = false
      var identityCoverReady = false
      var projectionReady = false
      try {
        $app.runInTransaction(function (txApp) {
          var now = new Date()
          var nowIso = now.toISOString()
          var cutoff = new Date(now.getTime() - 60 * 1000).toISOString()
          var rows = arrayOf(
            new DynamicModel({
              request_count: 0,
              window_started_at: '',
              identity_cover_ready: 0,
              projection_ready: 0,
            }),
          )
          txApp
            .db()
            .newQuery(
              'INSERT INTO cotai_price_search_rate_limits (user_id, window_started_at, request_count, updated_at) ' +
                'VALUES ({:user_id}, {:now}, 1, {:now}) ' +
                'ON CONFLICT(user_id) DO UPDATE SET ' +
                'window_started_at = CASE WHEN julianday(cotai_price_search_rate_limits.window_started_at) <= julianday({:cutoff}) THEN excluded.window_started_at ELSE cotai_price_search_rate_limits.window_started_at END, ' +
                'request_count = CASE WHEN julianday(cotai_price_search_rate_limits.window_started_at) <= julianday({:cutoff}) THEN 1 ELSE cotai_price_search_rate_limits.request_count + 1 END, ' +
                'updated_at = excluded.updated_at ' +
                'WHERE julianday(cotai_price_search_rate_limits.window_started_at) <= julianday({:cutoff}) OR cotai_price_search_rate_limits.request_count < {:request_limit} ' +
                'RETURNING request_count, window_started_at, ' +
                "EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='price_samples_index' AND name='idx_psi_search_identity_cover_v1' " +
                "AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),'')) = 'createindexidx_psi_search_identity_cover_v1onprice_samples_index(id,valor_unitario,source,uf,data_referencia,server_trust_version,search_contract,qualidade_situacao)wheresearch_eligible=1') AS identity_cover_ready, EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_price_search_projection_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtablecotai_price_search_projection_v1(source_rowidintegerprimarykey,idtextunique,valor_unitarionumeric,sourcetext,uftext,data_referenciatext,server_trust_versiontext,search_contracttext,qualidade_situacaotext,search_eligiblenumeric,sample_keytextunique)') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_ai_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtriggercotai_search_projection_ai_v1afterinsertonprice_samples_indexbegininsertorreplaceintocotai_price_search_projection_v1values(new.rowid,new.id,new.valor_unitario,new.source,new.uf,new.data_referencia,new.server_trust_version,new.search_contract,new.qualidade_situacao,new.search_eligible,new.sample_key);end') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_ad_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtriggercotai_search_projection_ad_v1afterdeleteonprice_samples_indexbegindeletefromcotai_price_search_projection_v1wheresource_rowid=old.rowid;end') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_au_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createtriggercotai_search_projection_au_v1afterupdateonprice_samples_indexwhennew.rowidisnotold.rowidornew.idisnotold.idornew.valor_unitarioisnotold.valor_unitarioornew.sourceisnotold.sourceornew.ufisnotold.ufornew.data_referenciaisnotold.data_referenciaornew.server_trust_versionisnotold.server_trust_versionornew.search_contractisnotold.search_contractornew.qualidade_situacaoisnotold.qualidade_situacaoornew.search_eligibleisnotold.search_eligibleornew.sample_keyisnotold.sample_keybegindeletefromcotai_price_search_projection_v1wheresource_rowid=old.rowid;insertorreplaceintocotai_price_search_projection_v1values(new.rowid,new.id,new.valor_unitario,new.source,new.uf,new.data_referencia,new.server_trust_version,new.search_contract,new.qualidade_situacao,new.search_eligible,new.sample_key);end') AND EXISTS(SELECT 1 FROM sqlite_master WHERE name='cotai_search_projection_ready_v1' AND lower(replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),''))='createviewcotai_search_projection_ready_v1asselect1asversion') AS projection_ready",
            )
            .withContext(requestContext)
            .bind({ user_id: String(userId), now: nowIso, cutoff: cutoff, request_limit: 120 })
            .all(rows)
          accepted = rows.length === 1
          identityCoverReady = accepted && Number(rows[0].identity_cover_ready) === 1
          projectionReady = accepted && Number(rows[0].projection_ready) === 1
        })
        return {
          available: true,
          accepted: accepted,
          identityCoverReady: identityCoverReady,
          projectionReady: projectionReady,
        }
      } catch (_) {
        return { available: false, accepted: false }
      }
    }

    function hitShape() {
      return {
        total_count: 0,
        minimum_price: -0,
        maximum_price: -0,
        average_price: -0,
        sum_price: -0,
        sum_square_price: -0,
        q1_price: -0,
        median_price: -0,
        q3_price: -0,
        source_counts_json: '{}',
        uf_counts_json: '{}',
        page_rank: 0,
        detail_rowid: 0,
        id: '',
        sample_key: '',
        source: '',
        source_record_id: '',
        purchase_id: '',
        item_id: '',
        descricao: '',
        descricao_normalizada: '',
        orgao: '',
        orgao_cnpj: '',
        fornecedor_nome: '',
        fornecedor_cnpj: '',
        fornecedor_porte: '',
        uf: '',
        municipio: '',
        unidade: '',
        quantidade: -0,
        valor_unitario: -0,
        valor_total: -0,
        natureza_preco: '',
        data_referencia: '',
        numero_processo: '',
        numero_ata: '',
        modalidade: '',
        situacao_contratacao: '',
        marca: '',
        modelo: '',
        codigo_item: '',
        url_original: '',
        payload_hash: '',
        raw_payload: '{}',
        qualidade_situacao: '',
        motivos_rejeicao: '[]',
        matching_score: -0,
        matching_tipo: '',
        indexed_at: '',
        source_updated_at: '',
        last_validated_at: '',
      }
    }

    function detailProjection(alias) {
      return (
        alias +
        '.rowid AS detail_rowid, ' +
        'COALESCE(' +
        alias +
        ".id, '') AS id, " +
        'COALESCE(' +
        alias +
        ".sample_key, '') AS sample_key, " +
        'COALESCE(' +
        alias +
        ".source, '') AS source, " +
        'COALESCE(' +
        alias +
        ".source_record_id, '') AS source_record_id, " +
        'COALESCE(' +
        alias +
        ".purchase_id, '') AS purchase_id, " +
        'COALESCE(' +
        alias +
        ".item_id, '') AS item_id, " +
        'COALESCE(' +
        alias +
        ".descricao, '') AS descricao, " +
        'COALESCE(' +
        alias +
        ".descricao_normalizada, '') AS descricao_normalizada, " +
        'COALESCE(' +
        alias +
        ".orgao, '') AS orgao, " +
        'COALESCE(' +
        alias +
        ".orgao_cnpj, '') AS orgao_cnpj, " +
        'COALESCE(' +
        alias +
        ".fornecedor_nome, '') AS fornecedor_nome, " +
        'COALESCE(' +
        alias +
        ".fornecedor_cnpj, '') AS fornecedor_cnpj, " +
        'COALESCE(' +
        alias +
        ".fornecedor_porte, '') AS fornecedor_porte, " +
        'COALESCE(' +
        alias +
        ".uf, '') AS uf, " +
        'COALESCE(' +
        alias +
        ".municipio, '') AS municipio, " +
        'COALESCE(' +
        alias +
        ".unidade, '') AS unidade, " +
        'COALESCE(' +
        alias +
        '.quantidade, 0) AS quantidade, ' +
        'COALESCE(' +
        alias +
        '.valor_unitario, 0) AS valor_unitario, ' +
        'COALESCE(' +
        alias +
        '.valor_total, 0) AS valor_total, ' +
        'COALESCE(' +
        alias +
        ".natureza_preco, '') AS natureza_preco, " +
        'COALESCE(' +
        alias +
        ".data_referencia, '') AS data_referencia, " +
        'COALESCE(' +
        alias +
        ".numero_processo, '') AS numero_processo, " +
        'COALESCE(' +
        alias +
        ".numero_ata, '') AS numero_ata, " +
        'COALESCE(' +
        alias +
        ".modalidade, '') AS modalidade, " +
        'COALESCE(' +
        alias +
        ".situacao_contratacao, '') AS situacao_contratacao, " +
        'COALESCE(' +
        alias +
        ".marca, '') AS marca, " +
        'COALESCE(' +
        alias +
        ".modelo, '') AS modelo, " +
        'COALESCE(' +
        alias +
        ".codigo_item, '') AS codigo_item, " +
        'COALESCE(' +
        alias +
        ".url_original, '') AS url_original, " +
        'COALESCE(' +
        alias +
        ".payload_hash, '') AS payload_hash, " +
        'COALESCE(CAST(' +
        alias +
        ".raw_payload AS TEXT), '{}') AS raw_payload, " +
        'COALESCE(' +
        alias +
        ".qualidade_situacao, '') AS qualidade_situacao, " +
        'COALESCE(CAST(' +
        alias +
        ".motivos_rejeicao AS TEXT), '[]') AS motivos_rejeicao, " +
        'COALESCE(' +
        alias +
        '.matching_score, 0) AS matching_score, ' +
        'COALESCE(' +
        alias +
        ".matching_tipo, '') AS matching_tipo, " +
        'COALESCE(' +
        alias +
        ".indexed_at, '') AS indexed_at, " +
        'COALESCE(' +
        alias +
        ".source_updated_at, '') AS source_updated_at, " +
        'COALESCE(' +
        alias +
        ".last_validated_at, '') AS last_validated_at"
      )
    }

    function hitFromRow(row) {
      var hit = {}
      var fields = [
        'id',
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
        'situacao_contratacao',
        'marca',
        'modelo',
        'codigo_item',
        'url_original',
        'payload_hash',
        'raw_payload',
        'qualidade_situacao',
        'motivos_rejeicao',
        'matching_score',
        'matching_tipo',
        'indexed_at',
        'source_updated_at',
        'last_validated_at',
      ]
      for (var i = 0; i < fields.length; i++) hit[fields[i]] = row[fields[i]]
      return hit
    }

    function nullablePageProjection(alias) {
      var integerFields = ['page_rank', 'detail_rowid']
      var realFields = ['quantidade', 'valor_unitario', 'valor_total', 'matching_score']
      var textFields = [
        'id',
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
        'natureza_preco',
        'data_referencia',
        'numero_processo',
        'numero_ata',
        'modalidade',
        'situacao_contratacao',
        'marca',
        'modelo',
        'codigo_item',
        'url_original',
        'payload_hash',
        'raw_payload',
        'qualidade_situacao',
        'motivos_rejeicao',
        'matching_tipo',
        'indexed_at',
        'source_updated_at',
        'last_validated_at',
      ]
      var parts = []
      for (var integerIndex = 0; integerIndex < integerFields.length; integerIndex++) {
        var integerField = integerFields[integerIndex]
        parts.push('COALESCE(' + alias + '.' + integerField + ', 0) AS ' + integerField)
      }
      for (var realIndex = 0; realIndex < realFields.length; realIndex++) {
        var realField = realFields[realIndex]
        parts.push('CAST(COALESCE(' + alias + '.' + realField + ', 0) AS REAL) AS ' + realField)
      }
      for (var textIndex = 0; textIndex < textFields.length; textIndex++) {
        var textField = textFields[textIndex]
        var fallback =
          textField === 'raw_payload' ? "'{}'" : textField === 'motivos_rejeicao' ? "'[]'" : "''"
        parts.push('COALESCE(' + alias + '.' + textField + ', ' + fallback + ') AS ' + textField)
      }
      return parts.join(', ')
    }

    function filterSpec(params, validated, identityCoverReady, projectionReady) {
      var clauses = [
        'psi.search_eligible = 1',
        'psi.search_contract = {:search_contract}',
        'psi.server_trust_version = {:server_trust_version}',
        "psi.source IN ('PNCP','Compras.gov.br')",
        'psi.valor_unitario > 0',
        "(psi.qualidade_situacao IS NULL OR psi.qualidade_situacao != 'rejeitada')",
      ]
      var binds = { search_contract: 'cotai-official-price-v3', server_trust_version: 'server-v1' }
      var joins = ''
      var term = validated.term
      var normalizedTerm = validated.normalizedTerm
      var catalog = validated.catalog
      var usesFts = false
      if (catalog) {
        var kind = catalog[1] || ''
        var code = catalog[2]
        if (kind === 'CATMAT') {
          binds.catalog_catmat_spaced = 'CATMAT ' + code
          binds.catalog_catmat_compact = 'CATMAT' + code
          clauses.push(
            '(psi.codigo_item = {:catalog_catmat_spaced} OR psi.codigo_item = {:catalog_catmat_compact})',
          )
        } else if (kind === 'CATSER') {
          binds.catalog_catser_spaced = 'CATSER ' + code
          binds.catalog_catser_compact = 'CATSER' + code
          clauses.push(
            '(psi.codigo_item = {:catalog_catser_spaced} OR psi.codigo_item = {:catalog_catser_compact})',
          )
        } else {
          binds.catalog_plain = code
          binds.catalog_catmat_spaced = 'CATMAT ' + code
          binds.catalog_catmat_compact = 'CATMAT' + code
          binds.catalog_catser_spaced = 'CATSER ' + code
          binds.catalog_catser_compact = 'CATSER' + code
          clauses.push(
            '(psi.codigo_item = {:catalog_plain} OR psi.codigo_item = {:catalog_catmat_spaced} OR psi.codigo_item = {:catalog_catmat_compact} OR psi.codigo_item = {:catalog_catser_spaced} OR psi.codigo_item = {:catalog_catser_compact})',
          )
        }
      } else {
        var tokens = validated.tokens
        if (validated.exactPhrase) {
          binds.fts_query = 'descricao_normalizada : "' + normalizedTerm + '"'
        } else {
          var ftsParts = []
          for (var tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
            var token = tokens[tokenIndex]
            var variants = [token]
            if (token.length >= 4) {
              if (token.length > 4 && token.slice(-1) === 'S') variants.push(token.slice(0, -1))
              else variants.push(token + 'S')
              if (token.slice(-1) === 'M') variants.push(token.slice(0, -1) + 'NS')
              if (token.slice(-1) === 'R' || token.slice(-1) === 'Z') variants.push(token + 'ES')
            }
            var uniqueVariants = []
            var variantSeen = {}
            for (var variantIndex = 0; variantIndex < variants.length; variantIndex++) {
              if (!variantSeen[variants[variantIndex]]) {
                uniqueVariants.push('"' + variants[variantIndex] + '"')
                variantSeen[variants[variantIndex]] = true
              }
            }
            ftsParts.push(
              uniqueVariants.length === 1
                ? uniqueVariants[0]
                : '(' + uniqueVariants.join(' OR ') + ')',
            )
          }
          binds.fts_query =
            'descricao_normalizada : (' +
            (ftsParts.length ? ftsParts.join(' AND ') : '"ZZZCOTAINOMATCH999999"') +
            ')'
        }
        joins = ' JOIN price_samples_fts ON price_samples_fts.rowid = psi.rowid '
        clauses.push('price_samples_fts MATCH {:fts_query}')
        usesFts = true
      }
      var sources = validated.sources
      if (sources.length) {
        var sourceClauses = []
        for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          var canonicalSource = sources[sourceIndex]
          var sourceKey = 'source_' + sourceIndex
          binds[sourceKey] = canonicalSource
          sourceClauses.push('psi.source = {:' + sourceKey + '}')
        }
        if (sourceClauses.length) clauses.push('(' + sourceClauses.join(' OR ') + ')')
      }
      if (validated.canonicalUf !== 'ALL') {
        binds.uf_filter = validated.canonicalUf
        clauses.push('psi.uf = {:uf_filter}')
      }
      if (validated.cnpj) {
        binds.cnpj_filter = validated.cnpj
        var buyerCnpj =
          "REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(psi.orgao_cnpj,''),'.',''),'/',''),'-',''),' ','')"
        var supplierCnpj =
          "REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(psi.fornecedor_cnpj,''),'.',''),'/',''),'-',''),' ','')"
        clauses.push(
          '(' + buyerCnpj + ' = {:cnpj_filter} OR ' + supplierCnpj + ' = {:cnpj_filter})',
        )
      }
      var months = validated.months
      if (months > 0) {
        binds.date_limit = new Date(Date.now() - months * 30 * 24 * 3600 * 1000).toISOString()
        clauses.push('psi.data_referencia >= {:date_limit}')
      }
      if (validated.dataStart) {
        binds.date_start = validated.dataStart
        clauses.push('psi.data_referencia >= {:date_start}')
      }
      if (validated.dataEndExclusive) {
        binds.date_end_exclusive = validated.dataEndExclusive
        clauses.push('psi.data_referencia < {:date_end_exclusive}')
      }
      if (validated.minimumPrice !== null) {
        binds.minimum_price = validated.minimumPrice
        clauses.push('psi.valor_unitario >= {:minimum_price}')
      }
      if (validated.maximumPrice !== null) {
        binds.maximum_price = validated.maximumPrice
        clauses.push('psi.valor_unitario <= {:maximum_price}')
      }
      if (validated.modality) {
        binds.modality_filter = normalize(validated.modality)
        clauses.push('INSTR(' + normalizedSql('psi.modalidade') + ', {:modality_filter}) > 0')
      }
      if (validated.priceNature) {
        binds.price_nature = normalize(validated.priceNature)
        clauses.push(normalizedSql('psi.natureza_preco') + ' = {:price_nature}')
      }
      if (validated.unit) {
        binds.unit_filter = normalize(validated.unit)
        clauses.push('INSTR(' + normalizedSql('psi.unidade') + ', {:unit_filter}) > 0')
      }
      if (validated.brand) {
        binds.brand_filter = normalize(validated.brand)
        clauses.push('INSTR(' + normalizedSql('psi.marca') + ', {:brand_filter}) > 0')
      }
      var supplierSize = normalize(validated.supplierSize)
      if (validated.onlyMeEpp || supplierSize === 'ME EPP') {
        clauses.push(
          normalizedSql('psi.fornecedor_porte') +
            " IN ('ME EPP','ME','EPP','MICROEMPRESA','EMPRESA DE PEQUENO PORTE')",
        )
      } else if (supplierSize === 'DEMAIS') {
        clauses.push(
          normalizedSql('psi.fornecedor_porte') +
            " NOT IN ('ME EPP','ME','EPP','MICROEMPRESA','EMPRESA DE PEQUENO PORTE','')",
        )
      } else if (supplierSize && supplierSize !== 'TODAS' && supplierSize !== 'TODOS') {
        binds.supplier_size = supplierSize
        clauses.push('INSTR(' + normalizedSql('psi.fornecedor_porte') + ', {:supplier_size}) > 0')
      }
      return {
        term: term,
        normalizedTerm: normalizedTerm,
        canonicalUf: validated.canonicalUf,
        joins: joins,
        where: clauses.join(' AND '),
        binds: binds,
        usesFts: usesFts,
        // Match POST's bounded summary-only access path in this isolated runtime.
        projectionReady: projectionReady === true,
        identityCover:
          (identityCoverReady === true || projectionReady === true) &&
          usesFts &&
          !validated.cnpj &&
          !validated.modality &&
          !validated.priceNature &&
          !validated.unit &&
          !validated.brand &&
          !validated.onlyMeEpp &&
          (!supplierSize || supplierSize === 'TODAS' || supplierSize === 'TODOS'),
        months: months,
      }
    }

    function orderSpec(params) {
      var requested = String(params.sort || params.ordenar || 'valor_unitario:asc').trim()
      if (requested === 'maior_preco') requested = 'valor_unitario:desc'
      if (requested === 'menor_preco') requested = 'valor_unitario:asc'
      if (requested === 'mais_recente') requested = 'data_referencia:desc'
      if (requested === 'mais_antigo') requested = 'data_referencia:asc'
      if (requested === 'valor_unitario:desc')
        return { name: requested, sql: 'valor_unitario DESC, id ASC' }
      if (requested === 'data_referencia:desc')
        return {
          name: requested,
          sql: "COALESCE(data_referencia, '') DESC, valor_unitario ASC, id ASC",
        }
      if (requested === 'data_referencia:asc')
        return {
          name: requested,
          sql: "COALESCE(data_referencia, '') ASC, valor_unitario ASC, id ASC",
        }
      return { name: 'valor_unitario:asc', sql: 'valor_unitario ASC, id ASC' }
    }

    function summarySql(spec, order) {
      return (
        'WITH filtered AS MATERIALIZED (' +
        (spec.identityCover && spec.projectionReady
          ? " SELECT psi.source_rowid AS psi_rowid, psi.id, psi.valor_unitario, psi.source, COALESCE(psi.uf, '') AS uf, COALESCE(psi.data_referencia, '') AS data_referencia"
          : " SELECT psi.rowid AS psi_rowid, psi.id, psi.valor_unitario, psi.source, COALESCE(psi.uf, '') AS uf, COALESCE(psi.data_referencia, '') AS data_referencia") +
        (spec.identityCover && spec.projectionReady
          ? ' FROM price_samples_fts CROSS JOIN cotai_price_search_projection_v1 psi ON psi.source_rowid = price_samples_fts.rowid'
          : spec.identityCover
            ? ' FROM price_samples_fts CROSS JOIN price_samples_index psi INDEXED BY idx_psi_search_identity_cover_v1' +
              ' ON psi.id = COALESCE((SELECT CASE WHEN verified.rowid = price_samples_fts.rowid THEN verified.id ELSE NULL END FROM price_samples_index verified WHERE verified.id = price_samples_fts.sample_id), (SELECT identity_row.id FROM price_samples_index identity_row WHERE identity_row.rowid = price_samples_fts.rowid))' +
              ' AND psi.rowid = price_samples_fts.rowid'
            : ' FROM price_samples_index psi' + spec.joins) +
        ' WHERE ' +
        spec.where +
        '), ordered_values AS MATERIALIZED (' +
        ' SELECT valor_unitario, id, ROW_NUMBER() OVER (ORDER BY valor_unitario ASC, id ASC) AS value_rank, COUNT(*) OVER () AS value_count FROM filtered' +
        '), moments AS (' +
        ' SELECT COUNT(*) AS total_count, COALESCE(MIN(valor_unitario),0) AS minimum_price, COALESCE(MAX(valor_unitario),0) AS maximum_price,' +
        ' COALESCE(AVG(valor_unitario),0) AS average_price, COALESCE(SUM(valor_unitario),0) AS sum_price, COALESCE(SUM(valor_unitario * valor_unitario),0) AS sum_square_price FROM ordered_values' +
        '), percentile_parts AS (' +
        ' SELECT MAX(value_count) AS n,' +
        ' MAX(CASE WHEN value_rank = CAST((value_count - 1) * 0.25 AS INTEGER) + 1 THEN valor_unitario END) AS q1_low,' +
        ' MAX(CASE WHEN value_rank = CASE WHEN CAST((value_count - 1) * 0.25 AS INTEGER) + 2 > value_count THEN value_count ELSE CAST((value_count - 1) * 0.25 AS INTEGER) + 2 END THEN valor_unitario END) AS q1_high,' +
        ' MAX(CASE WHEN value_rank = CAST((value_count - 1) * 0.50 AS INTEGER) + 1 THEN valor_unitario END) AS median_low,' +
        ' MAX(CASE WHEN value_rank = CASE WHEN CAST((value_count - 1) * 0.50 AS INTEGER) + 2 > value_count THEN value_count ELSE CAST((value_count - 1) * 0.50 AS INTEGER) + 2 END THEN valor_unitario END) AS median_high,' +
        ' MAX(CASE WHEN value_rank = CAST((value_count - 1) * 0.75 AS INTEGER) + 1 THEN valor_unitario END) AS q3_low,' +
        ' MAX(CASE WHEN value_rank = CASE WHEN CAST((value_count - 1) * 0.75 AS INTEGER) + 2 > value_count THEN value_count ELSE CAST((value_count - 1) * 0.75 AS INTEGER) + 2 END THEN valor_unitario END) AS q3_high FROM ordered_values' +
        '), percentiles AS (' +
        ' SELECT CASE WHEN COALESCE(n,0)=0 THEN 0 ELSE q1_low + (((n - 1) * 0.25) - CAST((n - 1) * 0.25 AS INTEGER)) * (q1_high - q1_low) END AS q1_price,' +
        ' CASE WHEN COALESCE(n,0)=0 THEN 0 ELSE median_low + (((n - 1) * 0.50) - CAST((n - 1) * 0.50 AS INTEGER)) * (median_high - median_low) END AS median_price,' +
        ' CASE WHEN COALESCE(n,0)=0 THEN 0 ELSE q3_low + (((n - 1) * 0.75) - CAST((n - 1) * 0.75 AS INTEGER)) * (q3_high - q3_low) END AS q3_price FROM percentile_parts' +
        '), source_counts AS (SELECT source, COUNT(*) AS n FROM filtered GROUP BY source),' +
        " source_json AS (SELECT COALESCE(json_group_object(source,n),'{}') AS source_counts_json FROM source_counts)," +
        " uf_counts AS (SELECT uf, COUNT(*) AS n FROM filtered WHERE uf != '' GROUP BY uf)," +
        " uf_json AS (SELECT COALESCE(json_group_object(uf,n),'{}') AS uf_counts_json FROM uf_counts)," +
        ' page_ids AS (SELECT psi_rowid, ROW_NUMBER() OVER (ORDER BY ' +
        order.sql +
        ') AS page_rank FROM filtered ORDER BY ' +
        order.sql +
        ' LIMIT {:page_limit} OFFSET {:page_offset}),' +
        ' page_details AS (SELECT page_ids.page_rank, ' +
        detailProjection('psi') +
        ' FROM page_ids JOIN price_samples_index psi ON psi.rowid = page_ids.psi_rowid)' +
        ' SELECT moments.total_count, moments.minimum_price, moments.maximum_price, moments.average_price, moments.sum_price, moments.sum_square_price,' +
        ' percentiles.q1_price, percentiles.median_price, percentiles.q3_price, source_json.source_counts_json, uf_json.uf_counts_json, ' +
        nullablePageProjection('page_details') +
        ' FROM moments CROSS JOIN percentiles CROSS JOIN source_json CROSS JOIN uf_json LEFT JOIN page_details ON 1=1 ORDER BY page_details.page_rank'
      )
    }

    function loadFreshness() {
      // AUTONOMOUS_DAILY_READ_V1_BEGIN — duplicated for isolated PocketBase callbacks.
      function dailyJson(raw) {
        try {
          return JSON.parse(raw || '{}')
        } catch (_) {
          return {}
        }
      }
      function dailyPublicError(value, fallback) {
        // Match exact public codes only; worker exceptions may contain URLs, bodies or private state.
        var allowed = [
          'SOURCE_UNAVAILABLE',
          'SOURCE_STATE_UNAVAILABLE',
          'SOURCE_STATE_SIZE',
          'SOURCE_STATE_VERSION',
          'SOURCE_HTTP_429',
          'SOURCE_HTTP_500',
          'SOURCE_HTTP_502',
          'SOURCE_HTTP_503',
          'SOURCE_HTTP_504',
          'SOURCE_BODY',
          'SOURCE_PAGE',
          'SOURCE_DOMAIN',
          'SOURCE_DOMAIN_PENDING',
          'SOURCE_BUDGET',
          'SOURCE_LEASE_LOST',
          'SOURCE_CAPACITY',
          'DAILY_OPERATION_FAILED',
          'DAILY_VALIDITY_FAILED',
        ]
        return typeof value === 'string' && allowed.indexOf(value) >= 0
          ? value
          : fallback || 'SOURCE_UNAVAILABLE'
      }
      function dailyTimestamp(value) {
        return typeof value === 'string' &&
          /^20\d\d-\d\d-\d\dT/.test(value) &&
          isFinite(Date.parse(value))
          ? value
          : null
      }
      function dailySource(source, requestedDay, startedAt) {
        var result = {
          source: source,
          status: 'queued',
          source_checked_at: null,
          source_written_at: null,
          last_drained_at: null,
          backlog: null,
          next_attempt_at: null,
          last_error: null,
          coverage: 'partial',
          requested_through: null,
          daily_acknowledged_through: null,
          daily_complete: false,
          daily_checked_count: 0,
          daily_new_count: 0,
          daily_updated_count: 0,
          daily_unchanged_count: 0,
        }
        try {
          var rows = $app.findRecordsByFilter(
            'price_watermarks',
            'fonte = {:source} && cursor_tipo = "autonomous-v1"',
            '',
            2,
            0,
            { source: source },
          )
          if (rows.length !== 1) throw new Error('SOURCE_STATE_UNAVAILABLE')
          var raw = rows[0].getString('detalhes')
          if (raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
          var state = dailyJson(raw)
          if (
            state.version !== 1 ||
            state.source !== source ||
            !state.lanes ||
            typeof state.lanes !== 'object' ||
            Array.isArray(state.lanes)
          )
            throw new Error('SOURCE_STATE_VERSION')
          result.source_checked_at = dailyTimestamp(state.source_checked_at)
          result.source_written_at = dailyTimestamp(state.source_written_at)
          result.last_drained_at = dailyTimestamp(state.last_drained_at)
          result.backlog =
            Number.isSafeInteger(state.backlog) && state.backlog >= 0 ? state.backlog : null
          result.next_attempt_at = dailyTimestamp(state.next_attempt_at)
          result.last_error = state.last_error ? dailyPublicError(state.last_error) : null
          result.requested_through = /^20\d\d-\d\d-\d\d$/.test(state.requested_through || '')
            ? state.requested_through
            : null
          var ack = state.daily_ack || {},
            checked = dailyTimestamp(ack.source_checked_at),
            drained = dailyTimestamp(ack.drained_at)
          var counts = ['checked_count', 'new_count', 'updated_count', 'unchanged_count']
          var validCounts =
            counts.every(function (k) {
              return Number.isSafeInteger(ack[k]) && ack[k] >= 0
            }) && ack.checked_count === ack.new_count + ack.updated_count + ack.unchanged_count
          // An unrelated history-page check/drain never acknowledges the requested daily window.
          var validAck =
            requestedDay &&
            ack.requested_through === requestedDay &&
            checked &&
            drained &&
            Date.parse(checked) >= Date.parse(startedAt) &&
            Date.parse(drained) >= Date.parse(checked) &&
            validCounts &&
            (source === 'PNCP' ? ack.coverage === 'recent_window' : ack.coverage === 'known_codes')
          if (validAck) {
            result.daily_acknowledged_through = ack.requested_through
            result.daily_complete = true
            result.daily_checked_count = ack.checked_count
            result.daily_new_count = ack.new_count
            result.daily_updated_count = ack.updated_count
            result.daily_unchanged_count = ack.unchanged_count
            result.daily_drained_at = drained
          } else {
            // Active counters prove progress only within this durable daily run, never completion.
            var active = (source === 'PNCP' ? state.daily_cycle : state.daily) || {}
            var runStart = dailyTimestamp(startedAt),
              activeStart = dailyTimestamp(active.started_at)
            var activeChecked = dailyTimestamp(active.source_checked_at),
              nowMs = Date.now()
            var validActive =
              /^20\d\d-\d\d-\d\d$/.test(requestedDay || '') &&
              isFinite(Date.parse(requestedDay + 'T00:00:00Z')) &&
              new Date(requestedDay + 'T00:00:00Z').toISOString().slice(0, 10) === requestedDay &&
              requestedDay <= new Date(nowMs - 86400000).toISOString().slice(0, 10) &&
              runStart &&
              activeStart &&
              activeChecked &&
              Date.parse(activeStart) === Date.parse(runStart) &&
              Date.parse(runStart) <= nowMs &&
              Date.parse(activeChecked) >= Date.parse(runStart) &&
              Date.parse(activeChecked) <= nowMs &&
              counts.every(function (k) {
                return Number.isSafeInteger(active[k]) && active[k] >= 0
              }) &&
              active.checked_count ===
                active.new_count + active.updated_count + active.unchanged_count
            if (validActive && source === 'PNCP') {
              var firstChecked = dailyTimestamp(active.first_checked_at)
              var epoch = requestedDay + '@' + new Date(runStart).toISOString()
              validActive =
                active.requested_through === requestedDay &&
                active.phase === 'active' &&
                active.epoch === epoch &&
                state.lanes.updates &&
                state.lanes.updates.daily_epoch === epoch &&
                firstChecked &&
                Date.parse(firstChecked) >= Date.parse(runStart) &&
                Date.parse(firstChecked) <= Date.parse(activeChecked)
            } else if (validActive) {
              validActive = active.target_day === requestedDay && active.complete === false
            }
            if (validActive) {
              result.daily_checked_count = active.checked_count
              result.daily_new_count = active.new_count
              result.daily_updated_count = active.updated_count
              result.daily_unchanged_count = active.unchanged_count
            }
          }
          result.status = result.daily_complete
            ? 'completed'
            : result.last_error
              ? 'error'
              : startedAt && Date.parse(state.last_attempt_at || '') >= Date.parse(startedAt)
                ? 'running'
                : 'queued'
        } catch (err) {
          result.status = 'error'
          result.last_error = dailyPublicError(err.message || err)
        }
        return result
      }
      function dailyRunSummary(rec) {
        if (!rec) return null
        var details = dailyJson(rec.getString('detalhes')),
          day = rec.getString('data_ciclo')
        if (
          details.contract !== 'autonomous-daily-v1' ||
          details.version !== 1 ||
          rec.getString('ciclo_id') !== 'CICLO_AUTONOMOUS_V1_' + day
        )
          return null
        var started = rec.getString('iniciado_em'),
          requested = details.requested_through
        var sources = {
          PNCP: dailySource('PNCP', requested, started),
          'Compras.gov.br': dailySource('Compras.gov.br', requested, started),
        }
        var values = [sources.PNCP, sources['Compras.gov.br']],
          errors = dailyJson(rec.getString('erros'))
        if (!Array.isArray(errors)) errors = []
        errors = errors.map(function (value) {
          return dailyPublicError(value, 'DAILY_OPERATION_FAILED')
        })
        var complete =
          values.every(function (s) {
            return s.daily_complete
          }) && !errors.length
        var status = complete
          ? 'completed'
          : errors.length ||
              values.some(function (s) {
                return s.status === 'error'
              })
            ? 'error'
            : values.some(function (s) {
                  return s.status === 'running' || s.daily_complete
                })
              ? 'running'
              : 'queued'
        var finished = complete
          ? values
              .map(function (s) {
                return s.daily_drained_at
              })
              .sort()
              .pop()
          : ''
        return {
          ciclo_id: rec.getString('ciclo_id'),
          data_ciclo: day,
          status: status,
          iniciado_em: started,
          data_hora: started,
          finalizado_em: finished,
          duracao_ms: rec.getInt('duracao_ms'),
          novas_amostras: values.reduce(function (n, s) {
            return n + s.daily_new_count
          }, 0),
          amostras_validadas: values.reduce(function (n, s) {
            return n + s.daily_checked_count
          }, 0),
          amostras_invalidadas: rec.getInt('amostras_invalidadas'),
          termos_reabertos: 0,
          erros: errors,
          detalhes: {
            version: 1,
            contract: 'autonomous-daily-v1',
            requested_through: requested,
            coverage: 'recent_window_and_known_codes',
            national_backfill_complete: false,
            mensagem: complete
              ? 'Janela recente PNCP e códigos conhecidos de Compras.gov.br verificados; acervo nacional parcial.'
              : 'Verificação oficial diária pendente; manutenção local não comprova atualização das fontes.',
          },
          fontes: sources,
        }
      }
      // AUTONOMOUS_DAILY_READ_V1_END

      var result = {}
      ;['PNCP', 'Compras.gov.br'].forEach(function (source) {
        result[source] = dailySource(source)
        // Legacy cursor/update columns never prove an official verification or price write.
        result[source].ultima_data_sincronizada = null
        result[source].total_coletadas_watermark = null
        result[source].ultima_atualizacao = null
      })
      return result
    }

    function loadDailyRun() {
      // AUTONOMOUS_DAILY_READ_V1_BEGIN — duplicated for isolated PocketBase callbacks.
      function dailyJson(raw) {
        try {
          return JSON.parse(raw || '{}')
        } catch (_) {
          return {}
        }
      }
      function dailyPublicError(value, fallback) {
        // Match exact public codes only; worker exceptions may contain URLs, bodies or private state.
        var allowed = [
          'SOURCE_UNAVAILABLE',
          'SOURCE_STATE_UNAVAILABLE',
          'SOURCE_STATE_SIZE',
          'SOURCE_STATE_VERSION',
          'SOURCE_HTTP_429',
          'SOURCE_HTTP_500',
          'SOURCE_HTTP_502',
          'SOURCE_HTTP_503',
          'SOURCE_HTTP_504',
          'SOURCE_BODY',
          'SOURCE_PAGE',
          'SOURCE_DOMAIN',
          'SOURCE_DOMAIN_PENDING',
          'SOURCE_BUDGET',
          'SOURCE_LEASE_LOST',
          'SOURCE_CAPACITY',
          'DAILY_OPERATION_FAILED',
          'DAILY_VALIDITY_FAILED',
        ]
        return typeof value === 'string' && allowed.indexOf(value) >= 0
          ? value
          : fallback || 'SOURCE_UNAVAILABLE'
      }
      function dailyTimestamp(value) {
        return typeof value === 'string' &&
          /^20\d\d-\d\d-\d\dT/.test(value) &&
          isFinite(Date.parse(value))
          ? value
          : null
      }
      function dailySource(source, requestedDay, startedAt) {
        var result = {
          source: source,
          status: 'queued',
          source_checked_at: null,
          source_written_at: null,
          last_drained_at: null,
          backlog: null,
          next_attempt_at: null,
          last_error: null,
          coverage: 'partial',
          requested_through: null,
          daily_acknowledged_through: null,
          daily_complete: false,
          daily_checked_count: 0,
          daily_new_count: 0,
          daily_updated_count: 0,
          daily_unchanged_count: 0,
        }
        try {
          var rows = $app.findRecordsByFilter(
            'price_watermarks',
            'fonte = {:source} && cursor_tipo = "autonomous-v1"',
            '',
            2,
            0,
            { source: source },
          )
          if (rows.length !== 1) throw new Error('SOURCE_STATE_UNAVAILABLE')
          var raw = rows[0].getString('detalhes')
          if (raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
          var state = dailyJson(raw)
          if (
            state.version !== 1 ||
            state.source !== source ||
            !state.lanes ||
            typeof state.lanes !== 'object' ||
            Array.isArray(state.lanes)
          )
            throw new Error('SOURCE_STATE_VERSION')
          result.source_checked_at = dailyTimestamp(state.source_checked_at)
          result.source_written_at = dailyTimestamp(state.source_written_at)
          result.last_drained_at = dailyTimestamp(state.last_drained_at)
          result.backlog =
            Number.isSafeInteger(state.backlog) && state.backlog >= 0 ? state.backlog : null
          result.next_attempt_at = dailyTimestamp(state.next_attempt_at)
          result.last_error = state.last_error ? dailyPublicError(state.last_error) : null
          result.requested_through = /^20\d\d-\d\d-\d\d$/.test(state.requested_through || '')
            ? state.requested_through
            : null
          var ack = state.daily_ack || {},
            checked = dailyTimestamp(ack.source_checked_at),
            drained = dailyTimestamp(ack.drained_at)
          var counts = ['checked_count', 'new_count', 'updated_count', 'unchanged_count']
          var validCounts =
            counts.every(function (k) {
              return Number.isSafeInteger(ack[k]) && ack[k] >= 0
            }) && ack.checked_count === ack.new_count + ack.updated_count + ack.unchanged_count
          // An unrelated history-page check/drain never acknowledges the requested daily window.
          var validAck =
            requestedDay &&
            ack.requested_through === requestedDay &&
            checked &&
            drained &&
            Date.parse(checked) >= Date.parse(startedAt) &&
            Date.parse(drained) >= Date.parse(checked) &&
            validCounts &&
            (source === 'PNCP' ? ack.coverage === 'recent_window' : ack.coverage === 'known_codes')
          if (validAck) {
            result.daily_acknowledged_through = ack.requested_through
            result.daily_complete = true
            result.daily_checked_count = ack.checked_count
            result.daily_new_count = ack.new_count
            result.daily_updated_count = ack.updated_count
            result.daily_unchanged_count = ack.unchanged_count
            result.daily_drained_at = drained
          } else {
            // Active counters prove progress only within this durable daily run, never completion.
            var active = (source === 'PNCP' ? state.daily_cycle : state.daily) || {}
            var runStart = dailyTimestamp(startedAt),
              activeStart = dailyTimestamp(active.started_at)
            var activeChecked = dailyTimestamp(active.source_checked_at),
              nowMs = Date.now()
            var validActive =
              /^20\d\d-\d\d-\d\d$/.test(requestedDay || '') &&
              isFinite(Date.parse(requestedDay + 'T00:00:00Z')) &&
              new Date(requestedDay + 'T00:00:00Z').toISOString().slice(0, 10) === requestedDay &&
              requestedDay <= new Date(nowMs - 86400000).toISOString().slice(0, 10) &&
              runStart &&
              activeStart &&
              activeChecked &&
              Date.parse(activeStart) === Date.parse(runStart) &&
              Date.parse(runStart) <= nowMs &&
              Date.parse(activeChecked) >= Date.parse(runStart) &&
              Date.parse(activeChecked) <= nowMs &&
              counts.every(function (k) {
                return Number.isSafeInteger(active[k]) && active[k] >= 0
              }) &&
              active.checked_count ===
                active.new_count + active.updated_count + active.unchanged_count
            if (validActive && source === 'PNCP') {
              var firstChecked = dailyTimestamp(active.first_checked_at)
              var epoch = requestedDay + '@' + new Date(runStart).toISOString()
              validActive =
                active.requested_through === requestedDay &&
                active.phase === 'active' &&
                active.epoch === epoch &&
                state.lanes.updates &&
                state.lanes.updates.daily_epoch === epoch &&
                firstChecked &&
                Date.parse(firstChecked) >= Date.parse(runStart) &&
                Date.parse(firstChecked) <= Date.parse(activeChecked)
            } else if (validActive) {
              validActive = active.target_day === requestedDay && active.complete === false
            }
            if (validActive) {
              result.daily_checked_count = active.checked_count
              result.daily_new_count = active.new_count
              result.daily_updated_count = active.updated_count
              result.daily_unchanged_count = active.unchanged_count
            }
          }
          result.status = result.daily_complete
            ? 'completed'
            : result.last_error
              ? 'error'
              : startedAt && Date.parse(state.last_attempt_at || '') >= Date.parse(startedAt)
                ? 'running'
                : 'queued'
        } catch (err) {
          result.status = 'error'
          result.last_error = dailyPublicError(err.message || err)
        }
        return result
      }
      function dailyRunSummary(rec) {
        if (!rec) return null
        var details = dailyJson(rec.getString('detalhes')),
          day = rec.getString('data_ciclo')
        if (
          details.contract !== 'autonomous-daily-v1' ||
          details.version !== 1 ||
          rec.getString('ciclo_id') !== 'CICLO_AUTONOMOUS_V1_' + day
        )
          return null
        var started = rec.getString('iniciado_em'),
          requested = details.requested_through
        var sources = {
          PNCP: dailySource('PNCP', requested, started),
          'Compras.gov.br': dailySource('Compras.gov.br', requested, started),
        }
        var values = [sources.PNCP, sources['Compras.gov.br']],
          errors = dailyJson(rec.getString('erros'))
        if (!Array.isArray(errors)) errors = []
        errors = errors.map(function (value) {
          return dailyPublicError(value, 'DAILY_OPERATION_FAILED')
        })
        var complete =
          values.every(function (s) {
            return s.daily_complete
          }) && !errors.length
        var status = complete
          ? 'completed'
          : errors.length ||
              values.some(function (s) {
                return s.status === 'error'
              })
            ? 'error'
            : values.some(function (s) {
                  return s.status === 'running' || s.daily_complete
                })
              ? 'running'
              : 'queued'
        var finished = complete
          ? values
              .map(function (s) {
                return s.daily_drained_at
              })
              .sort()
              .pop()
          : ''
        return {
          ciclo_id: rec.getString('ciclo_id'),
          data_ciclo: day,
          status: status,
          iniciado_em: started,
          data_hora: started,
          finalizado_em: finished,
          duracao_ms: rec.getInt('duracao_ms'),
          novas_amostras: values.reduce(function (n, s) {
            return n + s.daily_new_count
          }, 0),
          amostras_validadas: values.reduce(function (n, s) {
            return n + s.daily_checked_count
          }, 0),
          amostras_invalidadas: rec.getInt('amostras_invalidadas'),
          termos_reabertos: 0,
          erros: errors,
          detalhes: {
            version: 1,
            contract: 'autonomous-daily-v1',
            requested_through: requested,
            coverage: 'recent_window_and_known_codes',
            national_backfill_complete: false,
            mensagem: complete
              ? 'Janela recente PNCP e códigos conhecidos de Compras.gov.br verificados; acervo nacional parcial.'
              : 'Verificação oficial diária pendente; manutenção local não comprova atualização das fontes.',
          },
          fontes: sources,
        }
      }
      // AUTONOMOUS_DAILY_READ_V1_END

      try {
        var rows = $app.findRecordsByFilter(
          'daily_sync_runs',
          'ciclo_id ~ "CICLO_AUTONOMOUS_V1_"',
          '-data_ciclo',
          1,
          0,
        )
        return rows.length ? dailyRunSummary(rows[0]) : null
      } catch (_) {
        return null
      }
    }

    function loadTask(spec, taskOwnerId) {
      if (!spec.term) return null
      try {
        var rows = arrayOf(
          new DynamicModel({
            id: '',
            task_key: '',
            status: '',
            paginas_consultadas: 0,
            itens_processados: 0,
            amostras_inseridas: 0,
            amostras_atualizadas: 0,
            tentativas: 0,
            pendentes_raw: '[]',
            updated: '',
          }),
        )
        var legacyTaskKey = 'AMBAS#' + spec.normalizedTerm + '#' + spec.canonicalUf
        var ownerTaskKey = legacyTaskKey + '#OWNER#' + String(taskOwnerId)
        query(
          "SELECT id, task_key, status, paginas_consultadas, itens_processados, amostras_inseridas, amostras_atualizadas, tentativas, COALESCE(CAST(pendentes AS TEXT),'[]') AS pendentes_raw, updated " +
            "FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND source = 'AMBAS' " +
            'AND requested_by = {:task_owner} AND (task_key = {:owner_task_key} OR task_key = {:legacy_task_key}) ' +
            "AND COALESCE(NULLIF(uf,''),'ALL') = {:task_uf} " +
            'ORDER BY CASE WHEN task_key = {:owner_task_key} THEN 0 ELSE 1 END, updated DESC LIMIT 1',
        )
          .bind({
            task_owner: String(taskOwnerId),
            owner_task_key: ownerTaskKey,
            legacy_task_key: legacyTaskKey,
            task_uf: spec.canonicalUf,
          })
          .all(rows)
        if (!rows.length) return null
        var task = rows[0]
        var pending = []
        var pendingDisplayValid = false
        try {
          pending = JSON.parse(task.pendentes_raw || '[]')
          pendingDisplayValid = Array.isArray(pending)
        } catch (_) {}
        return {
          id: task.id,
          task_key: task.task_key,
          status: task.status,
          ativa: task.status === 'pending' || task.status === 'running',
          pendentes_count: Array.isArray(pending) ? pending.length : 0,
          // Presentation only: relationships are pending units, not verified purchases.
          pendentes_detalhamento_count: pendingDisplayValid
            ? pending.filter(function (p) {
                return !(p && p._pncp_discovery)
              }).length
            : null,
          descoberta_pendente: pendingDisplayValid
            ? pending.some(function (p) {
                if (!p || !p._pncp_discovery) return false
                var exhausted = p._pncp_discovery.esgotados || {}
                return !(exhausted.ata && exhausted.edital && exhausted.contrato)
              })
            : null,
          paginas_consultadas: Number(task.paginas_consultadas) || 0,
          itens_processados: Number(task.itens_processados) || 0,
          amostras_inseridas: Number(task.amostras_inseridas) || 0,
          amostras_atualizadas: Number(task.amostras_atualizadas) || 0,
          tentativas: Number(task.tentativas) || 0,
          updated: task.updated,
        }
      } catch (_) {
        return null
      }
    }

    try {
      var params = {}
      try {
        params = e.requestInfo().query || {}
      } catch (_) {}
      var validated = validateRequest(params)
      if (!validated.ok)
        return e.json(400, {
          sucesso: false,
          code: validated.code,
          error: validated.error,
          duracao_ms: new Date().getTime() - startedAt,
        })
      var rate = consumeRateLimit(e.auth.id)
      if (!rate.available)
        return e.json(503, {
          sucesso: false,
          code: 'SEARCH_RATE_LIMIT_UNAVAILABLE',
          error: 'A proteção de capacidade da busca está indisponível.',
          duracao_ms: new Date().getTime() - startedAt,
        })
      if (!rate.accepted)
        return e.json(429, {
          sucesso: false,
          code: 'SEARCH_RATE_LIMITED',
          error: 'Limite temporário de buscas atingido.',
          retry_after_seconds: 60,
          duracao_ms: new Date().getTime() - startedAt,
        })
      var page = validated.page
      var limit = validated.limit
      var spec = filterSpec(params, validated, rate.identityCoverReady, rate.projectionReady)
      var order = orderSpec(params)
      var binds = Object.assign({}, spec.binds, {
        page_limit: limit,
        page_offset: (page - 1) * limit,
      })
      var rows = arrayOf(new DynamicModel(hitShape()))
      try {
        query(summarySql(spec, order)).bind(binds).all(rows)
      } catch (searchError) {
        if (spec.usesFts && ftsFailure(searchError)) {
          return e.json(503, {
            sucesso: false,
            code: 'SEARCH_INDEX_UNAVAILABLE',
            etapa: 'fts',
            error:
              'O índice textual oficial está indisponível; nenhum fallback lento foi executado.',
            duracao_ms: new Date().getTime() - startedAt,
          })
        }
        return e.json(500, {
          sucesso: false,
          code: 'SEARCH_QUERY_FAILED',
          etapa: 'query',
          error: String(searchError && (searchError.message || searchError)),
          duracao_ms: new Date().getTime() - startedAt,
        })
      }
      var hits = []
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex++)
        if (Number(rows[rowIndex].detail_rowid) > 0 && rows[rowIndex].id)
          hits.push(hitFromRow(rows[rowIndex]))
      var summary = rows.length ? rows[0] : hitShape()
      var total = Number(summary.total_count) || 0
      var average = Number(summary.average_price) || 0
      var variance =
        total > 1
          ? Math.max(
              0,
              (Number(summary.sum_square_price) -
                (Number(summary.sum_price) * Number(summary.sum_price)) / total) /
                (total - 1),
            )
          : 0
      var q1 = rounded(summary.q1_price)
      var q3 = rounded(summary.q3_price)
      var iqr = rounded(q3 - q1)
      var duration = new Date().getTime() - startedAt
      var sourceCounts = parsedObject(summary.source_counts_json)
      if (!Object.prototype.hasOwnProperty.call(sourceCounts, 'PNCP')) sourceCounts.PNCP = 0
      if (!Object.prototype.hasOwnProperty.call(sourceCounts, 'Compras.gov.br'))
        sourceCounts['Compras.gov.br'] = 0
      return e.json(200, {
        sucesso: true,
        summary_included: true,
        summary_valid: true,
        total: total,
        page: page,
        limit: limit,
        pages: Math.ceil(total / limit) || 1,
        has_more: page * limit < total,
        duracao_ms: duration,
        hits: hits,
        filtros_aplicados: {
          termo: spec.term,
          palavra_exata: validated.exactPhrase,
          cnpj: validated.cnpj,
          sources: validated.sources,
          uf: params.uf || params.estado || '',
          periodo_meses: spec.months,
          data_inicio: validated.dataStart,
          data_fim: params.data_fim || '',
          preco_min: validated.minimumPrice,
          preco_max: validated.maximumPrice,
          unidade: validated.unit,
          marca: validated.brand,
          porte: validated.onlyMeEpp ? 'ME_EPP' : validated.supplierSize,
          modalidade: validated.modality,
          natureza_preco: validated.priceNature,
          sort: order.name,
        },
        aggregations: {
          total: total,
          por_fonte: sourceCounts,
          por_uf: parsedObject(summary.uf_counts_json),
          estatisticas: {
            n: total,
            media: rounded(average),
            mediana: rounded(summary.median_price),
            q1: q1,
            q3: q3,
            minimo: rounded(summary.minimum_price),
            maximo: rounded(summary.maximum_price),
            desvio_padrao: rounded(Math.sqrt(variance)),
            iqr: iqr,
            limite_inferior_iqr: rounded(Math.max(0, q1 - 1.5 * iqr)),
            limite_superior_iqr: rounded(q3 + 1.5 * iqr),
            regra_outlier: 'IQR_1_5_VERSION_1_0',
          },
        },
        status_tarefa: loadTask(spec, e.auth.id),
        frescor_sincronizacao: loadFreshness(),
        ciclo_diario: loadDailyRun(),
        metricas_consulta: {
          took_ms: duration,
          amostras_avaliadas: total,
          origem_consulta: 'indice_oficial_fts_v3',
          chamadas_externas_disparadas: 0,
          protocolo_auditoria: 'LEI_14133_ART_23_PAINEL_PRECOS',
        },
      })
    } catch (error) {
      return e.json(500, {
        sucesso: false,
        code: 'SEARCH_HANDLER_FAILED',
        etapa: 'handler',
        error: String(error && (error.message || error)),
        duracao_ms: new Date().getTime() - startedAt,
      })
    }
  },
  $apis.requireAuth(),
)
