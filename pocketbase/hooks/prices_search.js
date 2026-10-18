// Busca oficial rápida no índice persistente.
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
      var cursor = first(['cursor'])
      var snapshot = first(['snapshot'])
      var hasCursor = cursor !== undefined && cursor !== null && cursor !== ''
      var hasSnapshot = snapshot !== undefined && snapshot !== null && snapshot !== ''
      if (hasCursor !== hasSnapshot)
        return invalid('SEARCH_CURSOR_INVALID', 'Cursor e snapshot devem ser enviados juntos.')
      if (
        (hasCursor && (typeof cursor !== 'string' || !/^pc1_[0-9a-f]{64}$/.test(cursor))) ||
        (hasSnapshot && (typeof snapshot !== 'string' || !/^ps1_[0-9a-f]{64}$/.test(snapshot)))
      )
        return invalid('SEARCH_CURSOR_INVALID', 'Cursor ou snapshot inválido.')
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
      }
    }

    function consumeRateLimit(userId) {
      var accepted = false
      try {
        $app.runInTransaction(function (txApp) {
          var now = new Date()
          var nowIso = now.toISOString()
          var cutoff = new Date(now.getTime() - 60 * 1000).toISOString()
          var rows = arrayOf(new DynamicModel({ request_count: 0, window_started_at: '' }))
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
                'RETURNING request_count, window_started_at',
            )
            .withContext(requestContext)
            .bind({ user_id: String(userId), now: nowIso, cutoff: cutoff, request_limit: 120 })
            .all(rows)
          accepted = rows.length === 1
        })
        return { available: true, accepted: accepted }
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

    function snapshotItemsSql(spec, order) {
      var ordered = qualifiedOrderSql(order)
      return (
        'INSERT INTO cotai_price_search_snapshot_items (snapshot_id, position, hit_json) ' +
        'SELECT {:snapshot_id}, ROW_NUMBER() OVER (ORDER BY ' +
        ordered +
        '), ' +
        snapshotHitJsonSql('psi') +
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

    function filterSpec(params, validated) {
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
        'price-search-snapshot-v1',
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

    function cursorToken(secret, queryHash, page) {
      return (
        'pc1_' +
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

    function persistSnapshot(txApp, ownerUserId, queryHash, order, pageSize, total, spec) {
      var now = new Date()
      var nowIso = now.toISOString()
      var expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString()
      var token =
        'ps1_' + String($security.sha256($security.randomString(64) + '|' + nowIso)).toLowerCase()
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
          sort_name: order.name,
          page_size: pageSize,
          page_count: pageCount,
          captured_count: total,
          total_count: total,
          created_at: nowIso,
          expires_at: expiresAt,
        })
        .execute()

      var snapshotBinds = Object.assign({}, spec.binds, { snapshot_id: snapshotId })
      txQuery(snapshotItemsSql(spec, order)).bind(snapshotBinds).execute()

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
        capturedCount: total,
        populationComplete: true,
      }
    }

    function loadSnapshotContinuation(ownerUserId, validated, queryHash) {
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

      var requestedPage = 0
      for (var pageNumber = 2; pageNumber <= Number(session.page_count); pageNumber++) {
        if (
          cursorToken(session.cursor_secret, session.query_hash, pageNumber) === validated.cursor
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
        " SELECT psi.rowid AS psi_rowid, psi.id, psi.valor_unitario, psi.source, COALESCE(psi.uf, '') AS uf, COALESCE(psi.data_referencia, '') AS data_referencia" +
        ' FROM price_samples_index psi' +
        spec.joins +
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
        ' FROM page_ids JOIN price_samples_index psi ON psi.rowid = page_ids.psi_rowid' +
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
      var result = {}
      try {
        var rows = arrayOf(
          new DynamicModel({
            fonte: '',
            last_watermark_date: '',
            status: '',
            amostras_coletadas_total: 0,
            updated: '',
          }),
        )
        query(
          'SELECT fonte, last_watermark_date, status, amostras_coletadas_total, updated FROM price_watermarks',
        ).all(rows)
        for (var i = 0; i < rows.length; i++) {
          result[rows[i].fonte] = {
            ultima_data_sincronizada: rows[i].last_watermark_date,
            status: rows[i].status,
            total_coletadas_watermark: Number(rows[i].amostras_coletadas_total) || 0,
            ultima_atualizacao: rows[i].updated,
          }
        }
      } catch (_) {}
      return result
    }

    function loadDailyRun() {
      try {
        var rows = arrayOf(
          new DynamicModel({
            ciclo_id: '',
            data_ciclo: '',
            status: '',
            finalizado_em: '',
            duracao_ms: 0,
            novas_amostras: 0,
            amostras_validadas: 0,
            amostras_invalidadas: 0,
            updated: '',
          }),
        )
        query(
          'SELECT ciclo_id, data_ciclo, status, finalizado_em, duracao_ms, novas_amostras, amostras_validadas, amostras_invalidadas, updated FROM daily_sync_runs ORDER BY created DESC LIMIT 1',
        ).all(rows)
        if (!rows.length) return null
        var row = rows[0]
        return {
          ciclo_id: row.ciclo_id,
          data_ciclo: row.data_ciclo,
          status: row.status,
          data_hora: row.finalizado_em || row.updated,
          novas_amostras: Number(row.novas_amostras) || 0,
          amostras_validadas: Number(row.amostras_validadas) || 0,
          amostras_invalidadas: Number(row.amostras_invalidadas) || 0,
          duracao_ms: Number(row.duracao_ms) || 0,
        }
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
        try {
          pending = JSON.parse(task.pendentes_raw || '[]')
        } catch (_) {}
        return {
          id: task.id,
          task_key: task.task_key,
          status: task.status,
          ativa: task.status === 'pending' || task.status === 'running',
          pendentes_count: Array.isArray(pending) ? pending.length : 0,
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
      var order = orderSpec(params)
      var queryHash = snapshotQueryHash(validated, order)
      if (validated.cursor) {
        try {
          var continuation = loadSnapshotContinuation(e.auth.id, validated, queryHash)
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
          return e.json(503, {
            sucesso: false,
            code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
            error: 'A janela materializada desta busca está indisponível.',
            duracao_ms: new Date().getTime() - startedAt,
          })
        }
      }

      var pageOnly = params.include_summary === false && page > 1
      var spec = filterSpec(params, validated)
      var captureLimit = limit
      var binds = Object.assign({}, spec.binds, {
        page_limit: captureLimit,
        page_offset: (page - 1) * limit,
      })
      var rows = arrayOf(new DynamicModel(hitShape()))
      var snapshot = null
      var snapshotWriteError = null
      try {
        if (pageOnly) {
          query(pageSql(spec, order)).bind(binds).all(rows)
        } else {
          // BEGIN IMMEDIATE keeps the aggregate/first page and the materialized
          // continuation pages on one SQLite view. Concurrent writers wait and
          // therefore cannot shift, mutate or delete later pages mid-snapshot.
          $app.runInTransaction(function (txApp) {
            function txQuery(sql) {
              return txApp.db().newQuery(sql).withContext(requestContext)
            }
            txQuery(summarySql(spec, order)).bind(binds).all(rows)
            var transactionTotal = rows.length ? Number(rows[0].total_count) || 0 : 0
            if (page === 1 && transactionTotal > limit) {
              try {
                snapshot = persistSnapshot(
                  txApp,
                  e.auth.id,
                  queryHash,
                  order,
                  limit,
                  transactionTotal,
                  spec,
                )
              } catch (error) {
                snapshotWriteError = error
                throw error
              }
            }
          })
        }
      } catch (searchError) {
        if (snapshotWriteError) {
          return e.json(503, {
            sucesso: false,
            code: 'SEARCH_SNAPSHOT_UNAVAILABLE',
            error: 'Não foi possível fixar uma janela estável para esta busca.',
            duracao_ms: new Date().getTime() - startedAt,
          })
        }
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

      var capturedHits = []
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        if (Number(rows[rowIndex].detail_rowid) > 0 && rows[rowIndex].id)
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
      return e.json(200, {
        sucesso: true,
        summary_included: true,
        summary_valid: true,
        total: total,
        page: page,
        limit: limit,
        pages: Math.ceil(total / limit) || 1,
        snapshot: snapshot ? snapshot.token : undefined,
        next_cursor:
          snapshot && snapshot.pageCount > 1 ? cursorToken(snapshot.secret, queryHash, 2) : null,
        has_more: snapshot ? snapshot.pageCount > 1 : page * limit < total,
        snapshot_window_count: snapshot ? snapshot.capturedCount : responseHits.length,
        snapshot_population_complete: snapshot ? snapshot.populationComplete : true,
        population_has_more: snapshot ? !snapshot.populationComplete : false,
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
      try {
        $app.runInTransaction(function (txApp) {
          var now = new Date()
          var nowIso = now.toISOString()
          var cutoff = new Date(now.getTime() - 60 * 1000).toISOString()
          var rows = arrayOf(new DynamicModel({ request_count: 0, window_started_at: '' }))
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
                'RETURNING request_count, window_started_at',
            )
            .withContext(requestContext)
            .bind({ user_id: String(userId), now: nowIso, cutoff: cutoff, request_limit: 120 })
            .all(rows)
          accepted = rows.length === 1
        })
        return { available: true, accepted: accepted }
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

    function filterSpec(params, validated) {
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
        " SELECT psi.rowid AS psi_rowid, psi.id, psi.valor_unitario, psi.source, COALESCE(psi.uf, '') AS uf, COALESCE(psi.data_referencia, '') AS data_referencia" +
        ' FROM price_samples_index psi' +
        spec.joins +
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
      var result = {}
      try {
        var rows = arrayOf(
          new DynamicModel({
            fonte: '',
            last_watermark_date: '',
            status: '',
            amostras_coletadas_total: 0,
            updated: '',
          }),
        )
        query(
          'SELECT fonte, last_watermark_date, status, amostras_coletadas_total, updated FROM price_watermarks',
        ).all(rows)
        for (var i = 0; i < rows.length; i++) {
          result[rows[i].fonte] = {
            ultima_data_sincronizada: rows[i].last_watermark_date,
            status: rows[i].status,
            total_coletadas_watermark: Number(rows[i].amostras_coletadas_total) || 0,
            ultima_atualizacao: rows[i].updated,
          }
        }
      } catch (_) {}
      return result
    }

    function loadDailyRun() {
      try {
        var rows = arrayOf(
          new DynamicModel({
            ciclo_id: '',
            data_ciclo: '',
            status: '',
            finalizado_em: '',
            duracao_ms: 0,
            novas_amostras: 0,
            amostras_validadas: 0,
            amostras_invalidadas: 0,
            updated: '',
          }),
        )
        query(
          'SELECT ciclo_id, data_ciclo, status, finalizado_em, duracao_ms, novas_amostras, amostras_validadas, amostras_invalidadas, updated FROM daily_sync_runs ORDER BY created DESC LIMIT 1',
        ).all(rows)
        if (!rows.length) return null
        var row = rows[0]
        return {
          ciclo_id: row.ciclo_id,
          data_ciclo: row.data_ciclo,
          status: row.status,
          data_hora: row.finalizado_em || row.updated,
          novas_amostras: Number(row.novas_amostras) || 0,
          amostras_validadas: Number(row.amostras_validadas) || 0,
          amostras_invalidadas: Number(row.amostras_invalidadas) || 0,
          duracao_ms: Number(row.duracao_ms) || 0,
        }
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
        try {
          pending = JSON.parse(task.pendentes_raw || '[]')
        } catch (_) {}
        return {
          id: task.id,
          task_key: task.task_key,
          status: task.status,
          ativa: task.status === 'pending' || task.status === 'running',
          pendentes_count: Array.isArray(pending) ? pending.length : 0,
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
      var spec = filterSpec(params, validated)
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
