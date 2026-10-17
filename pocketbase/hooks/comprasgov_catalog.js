// Read-only CNBS resolver. No price lookup, database access, or catalog persistence.
// PocketBase JSVM convention: helpers live inside the route callback.
routerAdd(
  'GET',
  '/backend/v1/comprasgov/catalogo',
  function (e) {
    var metadata = {
      fonte: 'CNBS',
      quantidadeRetornada: null,
      totalInformadoApi: null,
      paginacaoInformada: false,
      completude: 'nao_informada_pela_api',
      consultasExternas: 0,
    }
    var tipo = ''
    var etapa = ''
    var upstreamThrottle = null

    // Match the existing price-proxy contract without forwarding arbitrary headers.
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

    function failure(status, code, message, upstreamStatus) {
      var error = { codigo: code, mensagem: message }
      if (upstreamStatus !== undefined) error.statusUpstream = upstreamStatus
      var body = {
        sucesso: false,
        protocolo: 'cnbs-catalogo-v1',
        tipo: tipo || null,
        etapa: etapa || null,
        candidatos: [],
        trabalhos: [],
        metadados: metadata,
        erro: error,
      }
      if (upstreamThrottle) body.upstream_throttle = upstreamThrottle
      return e.json(status, body)
    }

    function text(value) {
      return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
    }

    function validCode(value) {
      var code = text(value)
      return /^\d{1,12}$/.test(code) && Number(code) > 0 ? code : null
    }

    function project(record, fields) {
      var result = {}
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i]
        if (Object.prototype.hasOwnProperty.call(record, field)) result[field] = record[field]
      }
      return result
    }

    // Middleware enforces authentication in PocketBase. The local check also
    // prevents upstream IO if this callback is invoked without auth context.
    if (!e.auth) return failure(401, 'AUTH_REQUIRED', 'Autenticação é obrigatória.')

    var query
    try {
      query = e.requestInfo().query || {}
    } catch (_) {
      return failure(400, 'INVALID_PARAMETERS', 'Não foi possível ler os parâmetros da consulta.')
    }
    tipo = text(query.tipo || query.tipo_catalogo).toLowerCase()
    var pdmInput = text(query.codigo_pdm)
    var term = text(query.termo)
    var pdmCode = null
    var url = ''
    if (pdmInput) {
      pdmCode = validCode(pdmInput)
      if (!pdmCode || (tipo && tipo !== 'material')) {
        return failure(
          400,
          'INVALID_PARAMETERS',
          'codigo_pdm deve ser um código numérico de material.',
        )
      }
      tipo = 'material'
      etapa = 'pdm'
      metadata.codigoPdm = pdmCode
      url =
        'https://cnbs.estaleiro.serpro.gov.br/cnbs-api/material/v1/materialCaracteristcaValorporPDM?codigo_pdm=' +
        encodeURIComponent(pdmCode)
    } else {
      if (tipo !== 'material' && tipo !== 'servico') {
        return failure(
          400,
          'INVALID_PARAMETERS',
          'Informe tipo=material ou tipo=servico; cada requisição consulta um catálogo.',
        )
      }
      if (term.length < 2 || term.length > 200) {
        return failure(400, 'INVALID_PARAMETERS', 'termo deve conter entre 2 e 200 caracteres.')
      }
      etapa = 'texto'
      metadata.termo = term
      url =
        tipo === 'material'
          ? 'https://cnbs.estaleiro.serpro.gov.br/cnbs-api/material/v1/palavra?palavra=' +
            encodeURIComponent(term)
          : 'https://cnbs.estaleiro.serpro.gov.br/cnbs-api/servico/v1/palavra?palavra=' +
            encodeURIComponent(term)
    }

    // Fixed official URLs only. Never forward caller credentials, URLs, or headers.
    metadata.urlOficial = url
    metadata.consultasExternas = 1
    var response
    try {
      response = $http.send({
        url: url,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 5,
      })
    } catch (error) {
      var detail = error ? String(error.message || error) : ''
      if (/timeout|timed out|deadline/i.test(detail)) {
        return failure(504, 'UPSTREAM_TIMEOUT', 'O catálogo oficial excedeu o prazo de 5 segundos.')
      }
      return failure(502, 'UPSTREAM_UNAVAILABLE', 'Não foi possível consultar o catálogo oficial.')
    }
    if (!response || typeof response.then === 'function') {
      return failure(
        502,
        'UPSTREAM_RUNTIME',
        'O transporte do catálogo não forneceu uma resposta síncrona compatível.',
      )
    }
    var status = Number(response.statusCode)
    if (!isFinite(status) || status < 200 || status >= 300) {
      if (status === 429 || status === 503) {
        upstreamThrottle = { status: status }
        var retryAfter = retryAfterHeader(response.headers)
        if (retryAfter !== undefined) upstreamThrottle.retry_after = retryAfter
      }
      return failure(
        502,
        'UPSTREAM_HTTP',
        'O catálogo oficial retornou erro HTTP.',
        isFinite(status) ? status : null,
      )
    }
    var records
    try {
      records =
        response.json !== undefined && response.json !== null
          ? response.json
          : JSON.parse(response.raw)
    } catch (_) {
      return failure(502, 'UPSTREAM_JSON', 'O catálogo oficial retornou JSON inválido.')
    }
    if (!Array.isArray(records)) {
      return failure(
        502,
        'UPSTREAM_SCHEMA',
        'O catálogo oficial não retornou o array de metadados esperado.',
      )
    }

    var pdmFields = [
      'codigoPDM',
      'codigoPdm',
      'codigoClasse',
      'codigoGrupo',
      'descricaoPDM',
      'nomePdm',
      'descricaoClasse',
      'nomeClasse',
      'descricaoGrupo',
      'nomeGrupo',
      'statusPDM',
      'statusClasse',
      'statusGrupo',
    ]
    var itemFields = [
      'codigoPdm',
      'codigoItem',
      'nomePdm',
      'statusItem',
      'itemSuspenso',
      'itemSustentavel',
      'itemExclusivoUasgCentral',
      'codigoClasse',
      'codigoNcm',
      'nomeNcm',
      'aplicaMargemPreferencia',
      'aplicaMargemPreferenciaCiiaPac',
      'exigContNacion',
    ]
    var characteristicFields = [
      'codigoCaracteristica',
      'codigoValorCaracteristica',
      'nomeCaracteristica',
      'nomeValorCaracteristica',
      'siglaUnidadeMedida',
      'caracteristicaObrigatoria',
      'statusCaracteristica',
      'numeroCaracteristica',
      'statusValorCaracteristica',
      'tuplaCaracteristica',
    ]
    var serviceFields = [
      'codigoServico',
      'codigo',
      'descricaoServicoAcentuado',
      'nomeServicoAcentuado',
      'codigoSessao',
      'nomeSessao',
      'statusSessao',
      'codigoDivisao',
      'nomeDivisao',
      'statusDivisao',
      'codigoGrupo',
      'nomeGrupo',
      'statusGrupo',
      'codigoClasse',
      'nomeClasse',
      'statusClasse',
      'codigoSubclasse',
      'nomeSubclasse',
      'statusSubclasse',
      'codigoCPC',
      'codigoNbs',
      'status',
      'statusServico',
      'indicadoItemSuspenso',
      'suspenso',
      'exclusivoCentralCompras',
      'aplicaMargemPreferencia',
      'aplicamp',
      'aplicaMargemPreferenciaCiiaPac',
      'exigContNacion',
    ]
    var candidates = []
    var work = []
    var seen = {}
    for (var index = 0; index < records.length; index++) {
      var record = records[index]
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return failure(
          502,
          'UPSTREAM_SCHEMA',
          'O catálogo oficial retornou um candidato incompatível.',
        )
      }
      var code = null
      var candidate
      var task
      if (etapa === 'pdm') {
        code = validCode(record.codigoItem)
        if (record.codigoPdm !== undefined && validCode(record.codigoPdm) !== pdmCode) {
          return failure(502, 'UPSTREAM_SCHEMA', 'O item retornado não pertence ao PDM solicitado.')
        }
        candidate = project(record, itemFields)
        if (record.buscaItemCaracteristica !== undefined) {
          if (!Array.isArray(record.buscaItemCaracteristica)) {
            return failure(
              502,
              'UPSTREAM_SCHEMA',
              'Características do item possuem formato incompatível.',
            )
          }
          candidate.buscaItemCaracteristica = []
          for (var charIndex = 0; charIndex < record.buscaItemCaracteristica.length; charIndex++) {
            var characteristic = record.buscaItemCaracteristica[charIndex]
            if (
              !characteristic ||
              typeof characteristic !== 'object' ||
              Array.isArray(characteristic)
            ) {
              return failure(
                502,
                'UPSTREAM_SCHEMA',
                'Característica do item possui formato incompatível.',
              )
            }
            candidate.buscaItemCaracteristica.push(project(characteristic, characteristicFields))
          }
        }
        task = { etapa: 'precos', tipo: 'material', codigo: code, pagina: 1 }
      } else if (tipo === 'material') {
        code = validCode(record.codigoPdm !== undefined ? record.codigoPdm : record.codigoPDM)
        if (
          record.codigoPdm !== undefined &&
          record.codigoPDM !== undefined &&
          validCode(record.codigoPdm) !== validCode(record.codigoPDM)
        ) {
          return failure(
            502,
            'UPSTREAM_SCHEMA',
            'O catálogo retornou identificadores PDM conflitantes.',
          )
        }
        candidate = project(record, pdmFields)
        task = { etapa: 'pdm', codigoPdm: code }
      } else {
        code = validCode(record.codigoServico)
        candidate = project(record, serviceFields)
        task = { etapa: 'precos', tipo: 'servico', codigo: code, pagina: 1 }
      }
      if (!code)
        return failure(
          502,
          'UPSTREAM_SCHEMA',
          'Um candidato não possui identificador oficial válido.',
        )
      candidates.push(candidate)
      var key = task.etapa + '#' + tipo + '#' + code
      if (!seen[key]) {
        seen[key] = true
        work.push(task)
      }
    }
    metadata.quantidadeRetornada = candidates.length
    return e.json(200, {
      sucesso: true,
      protocolo: 'cnbs-catalogo-v1',
      tipo: tipo,
      etapa: etapa,
      candidatos: candidates,
      trabalhos: work,
      metadados: metadata,
    })
  },
  $apis.requireAuth(),
)
