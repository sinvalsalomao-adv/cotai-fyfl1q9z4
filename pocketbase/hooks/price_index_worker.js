// Worker oficial do COTAI original: tarefas, coleta autônoma e atualização diária de PNCP e Compras.gov.br.
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
      var taskHttp = $app.findRecordById('price_index_tasks', tarefaIdHttp)
      if (taskHttp.getString('server_trust_version') !== 'server-v1')
        return e.json(404, { sucesso: false, error: 'TASK_NOT_FOUND' })
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

  // COMPRAS_AUTONOMOUS_V1_BEGIN
  // Phase A callback-local integration artifact. No registration, user identity, receipt or I/O.
  function comprasAutonomousHelpers() {
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
      'codigoServico',
    ]
    var maxBodyBytes = 8 * 1024 * 1024
    function exactJson(source) {
      if (typeof source !== 'string' || source.length > maxBodyBytes) throw new Error('JSON_SIZE')
      var at = 0,
        parts = []
      function space() {
        while (at < source.length && /[\x20\t\r\n]/.test(source.charAt(at))) at++
      }
      function stringToken() {
        var start = at++
        while (at < source.length) {
          var ch = source.charAt(at++)
          if (ch === '\\') {
            at++
            continue
          }
          if (ch === '"') return source.slice(start, at)
        }
        throw new Error('JSON_STRING')
      }
      function value(key, depth) {
        if (depth > 64) throw new Error('JSON_DEPTH')
        space()
        var ch = source.charAt(at)
        if (ch === '{') {
          var objectKeys = Object.create(null)
          parts.push('{')
          at++
          space()
          if (source.charAt(at) !== '}')
            while (true) {
              if (source.charAt(at) !== '"') throw new Error('JSON_KEY')
              var token = stringToken(),
                name = JSON.parse(token)
              if (Object.prototype.hasOwnProperty.call(objectKeys, name))
                throw new Error('JSON_DUPLICATE_KEY')
              objectKeys[name] = true
              parts.push(token)
              space()
              if (source.charAt(at++) !== ':') throw new Error('JSON_COLON')
              parts.push(':')
              value(name, depth + 1)
              space()
              if (source.charAt(at) !== ',') break
              parts.push(',')
              at++
              space()
            }
          if (source.charAt(at++) !== '}') throw new Error('JSON_OBJECT')
          parts.push('}')
        } else if (ch === '[') {
          parts.push('[')
          at++
          space()
          if (source.charAt(at) !== ']')
            while (true) {
              value('', depth + 1)
              space()
              if (source.charAt(at) !== ',') break
              parts.push(',')
              at++
            }
          if (source.charAt(at++) !== ']') throw new Error('JSON_ARRAY')
          parts.push(']')
        } else if (ch === '"') {
          parts.push(stringToken())
        } else {
          var scalarStart = at,
            scalarEnd = at
          if (
            ch === 't' &&
            source.charAt(at + 1) === 'r' &&
            source.charAt(at + 2) === 'u' &&
            source.charAt(at + 3) === 'e'
          ) {
            scalarEnd = at + 4
          } else if (
            ch === 'f' &&
            source.charAt(at + 1) === 'a' &&
            source.charAt(at + 2) === 'l' &&
            source.charAt(at + 3) === 's' &&
            source.charAt(at + 4) === 'e'
          ) {
            scalarEnd = at + 5
          } else if (
            ch === 'n' &&
            source.charAt(at + 1) === 'u' &&
            source.charAt(at + 2) === 'l' &&
            source.charAt(at + 3) === 'l'
          ) {
            scalarEnd = at + 4
          } else {
            if (ch === '-') scalarEnd++
            var digit = source.charAt(scalarEnd)
            if (digit === '0') scalarEnd++
            else if (digit >= '1' && digit <= '9') {
              do {
                scalarEnd++
                digit = source.charAt(scalarEnd)
              } while (digit >= '0' && digit <= '9')
            } else throw new Error('JSON_VALUE')
            digit = source.charAt(scalarEnd + 1)
            if (source.charAt(scalarEnd) === '.' && digit >= '0' && digit <= '9') {
              scalarEnd++
              do {
                scalarEnd++
                digit = source.charAt(scalarEnd)
              } while (digit >= '0' && digit <= '9')
            }
            if (source.charAt(scalarEnd) === 'e' || source.charAt(scalarEnd) === 'E') {
              var exponentEnd = scalarEnd + 1
              digit = source.charAt(exponentEnd)
              if (digit === '+' || digit === '-') {
                exponentEnd++
                digit = source.charAt(exponentEnd)
              }
              if (digit >= '0' && digit <= '9') {
                do {
                  exponentEnd++
                  digit = source.charAt(exponentEnd)
                } while (digit >= '0' && digit <= '9')
                scalarEnd = exponentEnd
              }
            }
          }
          var scalar = source.slice(scalarStart, scalarEnd)
          if (
            identityFields.indexOf(key) >= 0 &&
            scalar !== 'null' &&
            scalar !== 'true' &&
            scalar !== 'false'
          ) {
            if (!/^-?(?:0|[1-9]\d*)$/.test(scalar)) throw new Error('JSON_ID_INTEGER')
            parts.push('"' + scalar + '"')
          } else parts.push(scalar)
          at += scalar.length
        }
      }
      value('', 0)
      space()
      if (at !== source.length) throw new Error('JSON_TRAILING')
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
        (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
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
      if (!officialUrl(row.url_original) || !officialUrl(proof.url_evidencia)) return 'URL_INVALID'

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
            [raw.linkEditalOuCompra, raw.link_resultado, raw.url].indexOf(proof.url_evidencia) >= 0
          if (!exactItemQuery && !boundItemLink) return 'URL_INVALID'
        } else if (
          [raw.linkEditalOuCompra, raw.link_resultado, raw.url].indexOf(proof.url_evidencia) < 0
        )
          return 'URL_INVALID'
      }
      return ''
    }

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
    function buildRow(original, work) {
      assertIdentity(original, work)
      var it = normalizeRaw(original, work)
      assertIdentity(it, work)
      var paginaParam = work.page,
        tamPaginaParam = work.size
      var grupoPdm = work.selector === 'codigoPdm',
        codigoPdm = work.code
      var consultaPreco = { urlOficial: requestUrl(work) }
      var uf = '',
        dataInicio = '',
        dataFim = ''
      var fields = ['precoUnitarioHomologado', 'valorUnitario', 'precoUnitario', 'precoPraticado']
      var unitField = ''
      for (var pf = 0; pf < fields.length; pf++) {
        if (it[fields[pf]] != null) {
          if (!positive(it[fields[pf]])) return null
          unitField = fields[pf]
          break
        }
      }
      if (!unitField) return null
      var service = work.kind === 'servico'
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
      var itemId = String((it.numeroItemCompra != null ? it.numeroItemCompra : it.numeroItem) || 1)
      var description = String(
        it.descricaoItem || it.descricao || it.item || 'NÃO INFORMADO',
      ).trim()
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
      var supplierCnpj = String(it.cnpjFornecedor || it.cpfCnpjFornecedor || it.niFornecedor || '')
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
      return row
    }

    function parseResponse(response, decodeBytes) {
      if (
        !response ||
        (response.statusCode != null && (response.statusCode < 200 || response.statusCode >= 300))
      )
        throw new Error('HTTP_INVALID')
      if (response.body != null) {
        if (typeof response.body.length !== 'number' || response.body.length > maxBodyBytes)
          throw new Error('JSON_SIZE')
        if (typeof response.body !== 'string' && typeof decodeBytes !== 'function')
          throw new Error('JSON_BYTE_DECODER_REQUIRED')
        return exactJson(
          typeof response.body === 'string' ? response.body : decodeBytes(response.body),
        )
      }
      if (typeof response.raw === 'string') return exactJson(response.raw)
      if (!response.json || !parsedIdentitySafe(response.json, 0, { remaining: 250000 }))
        throw new Error('JSON_UNSAFE_ID')
      return response.json
    }
    function readPage(body, page, size) {
      if (
        !boundedPositive(page, 1) ||
        !boundedPositive(size, 10, 500) ||
        !body ||
        !Array.isArray(body.resultado) ||
        body.resultado.length > size
      )
        throw new Error('ENVELOPE_INVALID')
      var names = ['totalRegistros', 'totalPaginas', 'paginasRestantes']
      for (var n = 0; n < names.length; n++)
        if (!Number.isSafeInteger(body[names[n]]) || body[names[n]] < 0)
          throw new Error('ENVELOPE_TOTALS')
      if (
        body.paginasRestantes !== Math.max(0, body.totalPaginas - page) ||
        (body.totalRegistros === 0 &&
          (body.resultado.length || body.totalPaginas > 1 || body.paginasRestantes)) ||
        (body.totalRegistros > 0 && body.totalPaginas < 1) ||
        body.resultado.length > body.totalRegistros
      )
        throw new Error('ENVELOPE_TOTALS')
      for (var i = 0; i < body.resultado.length; i++)
        if (
          !body.resultado[i] ||
          typeof body.resultado[i] !== 'object' ||
          Array.isArray(body.resultado[i])
        )
          throw new Error('ENVELOPE_ROW')
      if (
        (body.pagina != null && Number(body.pagina) !== Number(page)) ||
        (body.tamanhoPagina != null && Number(body.tamanhoPagina) !== Number(size))
      )
        throw new Error('ENVELOPE_ECHO')
      return {
        rows: body.resultado,
        nextPage: body.paginasRestantes > 0 ? page + 1 : null,
        total: body.totalRegistros,
      }
    }
    function catalogCodes(body, kind, page) {
      if (kind !== 'material' && kind !== 'servico') throw new Error('WORK_INVALID')
      var parsed = readPage(body, page, 10),
        result = [],
        seen = Object.create(null)
      var key = kind === 'material' ? 'codigoPdm' : 'codigoServico',
        name = kind === 'material' ? 'nomePdm' : 'nomeServico'
      for (var i = 0; i < parsed.rows.length; i++) {
        var row = parsed.rows[i],
          code = text(row[key])
        if (!positiveDigits(row[key]) || typeof row[name] !== 'string' || !row[name].trim())
          throw new Error('CATALOG_IDENTITY_INVALID')
        if (!seen[code]) {
          seen[code] = true
          result.push(code)
        }
      }
      return result
    }
    function requestUrl(work) {
      if (
        !work ||
        ['material', 'servico'].indexOf(work.kind) < 0 ||
        !positiveDigits(work.code) ||
        !boundedPositive(work.page, 1) ||
        !boundedPositive(work.size, 10, 500) ||
        ['codigoPdm', 'codigoItemCatalogo'].indexOf(work.selector) < 0 ||
        (work.kind === 'servico' && work.selector !== 'codigoItemCatalogo')
      )
        throw new Error('WORK_INVALID')
      return (
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/' +
        (work.kind === 'servico'
          ? '3_consultarServico?codigoItemCatalogo=' + encodeURIComponent(work.code)
          : '1_consultarMaterial?tipo=' +
            work.selector +
            '&codigo=' +
            encodeURIComponent(work.code)) +
        '&pagina=' +
        work.page +
        '&tamanhoPagina=' +
        work.size
      )
    }
    function normalizeRaw(original, work) {
      var it = Object.assign({}, original)
      Object.keys(it).forEach(function (key) {
        if (key.indexOf('_cotai_ingestion_') === 0 || key === '_cotai_index_row') delete it[key]
      })
      var unit = obterUnidadeOficialCgov(it)
      if (unit) {
        it.unidadeMedida = unit
        it.unidade = unit
      }
      if (it.estado && !it.uf) it.uf = String(it.estado).toUpperCase()
      if (!it.idCompra && it.codigoCompra) it.idCompra = it.codigoCompra
      if (!it.numeroItemCompra && it.numeroItem) it.numeroItemCompra = it.numeroItem
      // The public producer applies this tag from its trusted request kind before normalization.
      it.tipoItem = work.kind === 'servico' ? 'SERVICO' : 'MATERIAL'
      var code = text(
        first(it, [
          'codigoItemCatalogo',
          work.kind === 'servico' ? 'codigoCatser' : 'codigoCatmat',
        ]),
      )
      if (work.kind === 'servico') {
        it.codigoCatser = code
        it.origemModulo = 'modulo-pesquisa-preco/3_consultarServico'
      } else it.codigoCatmat = code
      return it
    }
    function assertIdentity(raw, work) {
      requestUrl(work)
      if (
        (work.kind === 'material' && raw.tipoItem === 'SERVICO') ||
        (work.kind === 'servico' && raw.tipoItem === 'MATERIAL')
      )
        throw new Error('IDENTITY_NAMESPACE')
      if (!parsedIdentitySafe(raw, 0, { remaining: 250000 })) throw new Error('IDENTITY_UNSAFE')
      var code = first(raw, [
        'codigoItemCatalogo',
        work.kind === 'servico' ? 'codigoCatser' : 'codigoCatmat',
      ])
      if (!positiveDigits(code)) throw new Error('IDENTITY_CODE')
      if (work.selector === 'codigoPdm') {
        if (!positiveDigits(raw.codigoItemCatalogo)) throw new Error('IDENTITY_CODE')
        if (
          (raw.codigoPdm != null && text(raw.codigoPdm) !== text(work.code)) ||
          (raw.codigoPDM != null && text(raw.codigoPDM) !== text(work.code))
        )
          throw new Error('IDENTITY_PDM')
      } else if (text(code) !== text(work.code)) throw new Error('IDENTITY_CODE')
      var alias = work.kind === 'servico' ? 'codigoCatser' : 'codigoCatmat'
      if (raw[alias] != null && text(raw[alias]) !== text(code)) throw new Error('IDENTITY_ALIAS')
      if (
        (work.kind === 'servico' && raw.codigoCatmat != null) ||
        (work.kind === 'material' && raw.codigoCatser != null)
      )
        throw new Error('IDENTITY_NAMESPACE')
      if (
        raw.idCompra != null &&
        raw.codigoCompra != null &&
        text(raw.idCompra) !== text(raw.codigoCompra)
      )
        throw new Error('IDENTITY_PURCHASE')
      if (
        raw.numeroItemCompra != null &&
        raw.numeroItem != null &&
        text(raw.numeroItemCompra) !== text(raw.numeroItem)
      )
        throw new Error('IDENTITY_ITEM')
    }
    function validateRow(row, work) {
      try {
        if (!row || row.source !== 'Compras.gov.br') return 'SOURCE_INVALID'
        var reason = validate(row)
        if (reason) return reason
        var proof = row.raw_payload.proveniencia_preco,
          raw = proof.registro_oficial
        assertIdentity(raw, work)
        var expected = buildRow(raw, work)
        if (!expected) return 'UNIT_PRICE_INVALID'
        if (
          JSON.stringify(comprasReceiptRowContract(row)) !==
          JSON.stringify(comprasReceiptRowContract(expected))
        )
          return 'ROW_CONTRACT_INVALID'
        return ''
      } catch (error) {
        return 'IDENTITY_INVALID'
      }
    }
    function identityParts(row) {
      var proof = row.raw_payload.proveniencia_preco,
        raw = proof.registro_oficial
      if (!parsedIdentitySafe(raw, 0, { remaining: 250000 })) throw new Error('IDENTITY_UNSAFE')
      return [
        proof.identidade.tipo === 'servico' ? 'CATSER' : 'CATMAT',
        text(first(raw, ['idCompra', 'codigoCompra'])),
        text(first(raw, ['idItemCompra', 'numeroItemCompra', 'numeroItem'])),
        text(proof.identidade.fornecedor),
      ]
    }
    function identityPrefix(row) {
      return identityParts(row).slice(0, 3).map(encodeURIComponent).join('#') + '#'
    }
    function factKey(row, hash) {
      return hash(JSON.stringify(identityParts(row)))
    }
    function sameFact(a, b) {
      try {
        if (a.source !== 'Compras.gov.br' || b.source !== a.source || validate(a) || validate(b))
          return false
        if (
          JSON.stringify(identityParts(a)) !== JSON.stringify(identityParts(b)) ||
          a.codigo_item !== b.codigo_item
        )
          return false
        var ar = a.raw_payload.proveniencia_preco.registro_oficial,
          br = b.raw_payload.proveniencia_preco.registro_oficial
        return !(
          ar.idCompraItem != null &&
          br.idCompraItem != null &&
          text(ar.idCompraItem) !== text(br.idCompraItem)
        )
      } catch (error) {
        return false
      }
    }
    function pricePage(body, work) {
      var page = readPage(body, work.page, work.size),
        rows = [],
        rejected = {},
        seen = Object.create(null)
      for (var i = 0; i < page.rows.length; i++) {
        var original = page.rows[i]
        assertIdentity(original, work)
        var row = buildRow(original, work)
        if (!row) {
          rejected.UNIT_PRICE_INVALID = (rejected.UNIT_PRICE_INVALID || 0) + 1
          continue
        }
        var reason = validateRow(row, work)
        if (reason) throw new Error(reason)
        var stable = JSON.stringify(identityParts(row)),
          bytes = JSON.stringify(row.raw_payload.proveniencia_preco.registro_oficial)
        if (seen[stable] != null && seen[stable] !== bytes) throw new Error('CONTRADICTORY_FACT')
        if (seen[stable] == null) {
          rows.push(row)
          seen[stable] = bytes
        }
      }
      return { rows: rows, rejected: rejected, nextPage: page.nextPage, total: page.total }
    }
    function sealRow(row, work, hash) {
      var reason = validateRow(row, work)
      if (reason) throw new Error(reason)
      var contract = 'cotai-official-price-v3',
        parts = [contract, row.source, row.sample_key, row.source_record_id],
        material = []
      for (var i = 0; i < parts.length; i++) material.push(parts[i].length + ':' + parts[i])
      var signature = hash(material.join('|'))
      if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature))
        throw new Error('SERVER_VALIDATION_UNAVAILABLE')
      return {
        contrato: contract,
        fonte: row.source,
        sample_key: row.sample_key,
        source_record_id: row.source_record_id,
        assinatura: signature.toLowerCase(),
      }
    }
    function sourceUpdatedAt(row) {
      var raw = row.raw_payload.proveniencia_preco.registro_oficial
      var fields = [
        'dataAtualizacaoFato',
        'dataHoraAtualizacaoItem',
        'dataHoraAtualizacaoCompra',
        'dataHoraAtualizacao',
      ]
      for (var i = 0; i < fields.length; i++)
        if (typeof raw[fields[i]] === 'string' && isFinite(Date.parse(raw[fields[i]])))
          return raw[fields[i]]
      return ''
    }
    return {
      parseResponse: parseResponse,
      readPage: readPage,
      catalogCodes: catalogCodes,
      requestUrl: requestUrl,
      buildRow: buildRow,
      validateRow: validateRow,
      pricePage: pricePage,
      factKey: factKey,
      sameFact: sameFact,
      identityPrefix: identityPrefix,
      sealRow: sealRow,
      sourceUpdatedAt: sourceUpdatedAt,
    }
  }

  // COMPRAS_AUTONOMOUS_HELPERS_END
  function comprasAutonomousTick() {
    if (modoHttp || Date.now() + 4500 > fimTrabalhoRede - 12000) return
    var h = comprasAutonomousHelpers(),
      deadline = Math.min(Date.now() + 16500, fimTrabalhoRede - 12000),
      calls = 0,
      state = null,
      token = '',
      wmId = ''
    var names = ['initial_material', 'daily_material', 'initial_servico', 'daily_servico']
    function save(tx, rec, s) {
      var json = JSON.stringify(s)
      if (json.length > 64000) throw Error('SOURCE_STATE_SIZE')
      rec.set('detalhes', json)
      tx.save(rec)
    }
    function read(rec) {
      var raw = rec.getString('detalhes')
      if (!raw || raw.length > 64000) throw Error('SOURCE_STATE_SIZE')
      var s = JSON.parse(raw)
      if (
        s.version !== 1 ||
        s.source !== 'Compras.gov.br' ||
        !s.lanes ||
        typeof s.lanes !== 'object' ||
        Array.isArray(s.lanes)
      )
        throw Error('SOURCE_STATE_VERSION')
      return s
    }
    function mergeIntent(s, latest) {
      if (
        latest.requested_through &&
        (!s.requested_through || latest.requested_through > s.requested_through)
      )
        s.requested_through = latest.requested_through
    }
    function commit(s, action) {
      $app.runInTransaction(function (tx) {
        var rec = tx.findRecordById('price_watermarks', wmId),
          latest = read(rec)
        if (
          !latest.claim ||
          latest.claim.token !== token ||
          Date.parse(latest.claim.expires_at) <= Date.now() ||
          Date.now() >= deadline
        )
          throw Error('SOURCE_LEASE_LOST')
        mergeIntent(s, latest)
        if (action) action(tx, s)
        if (Date.now() >= deadline || Date.parse(latest.claim.expires_at) <= Date.now())
          throw Error('SOURCE_BUDGET')
        save(tx, rec, s)
      })
      state = s
    }
    function lane(kind) {
      return {
        kind: kind,
        catalog_page: 1,
        catalog_exhausted: false,
        pending: [],
        next_attempt_at: '',
        pages_scanned: 0,
        prices_checked: 0,
      }
    }
    function copy(s) {
      return JSON.parse(JSON.stringify(s))
    }
    function increment(s, key, n) {
      s[key] = (Number(s[key]) || 0) + n
    }
    function activeJob(l) {
      for (var i = 0; i < l.pending.length; i++)
        if (!(Date.parse(l.pending[i].next_attempt_at) > Date.now())) return i
      return -1
    }
    function validateLane(l) {
      if (
        !l ||
        !Array.isArray(l.pending) ||
        l.pending.length > 20 ||
        ['material', 'servico'].indexOf(l.kind) < 0 ||
        !Number.isSafeInteger(l.catalog_page) ||
        l.catalog_page < 1
      )
        throw Error('SOURCE_LANE_INVALID')
      for (var i = 0; i < l.pending.length; i++)
        if (
          !/^\d+$/.test(l.pending[i].code) ||
          !/[1-9]/.test(l.pending[i].code) ||
          !Number.isSafeInteger(l.pending[i].page) ||
          l.pending[i].page < 1
        )
          throw Error('SOURCE_JOB_INVALID')
    }
    function addCodes(l, codes) {
      var unique = {}
      l.pending.forEach(function (j) {
        unique[j.code] = true
      })
      codes.forEach(function (code) {
        if (!unique[code]) {
          l.pending.push({ code: code, page: 1, attempts: 0, next_attempt_at: '' })
          unique[code] = true
        }
      })
      if (l.pending.length > 20) throw Error('SOURCE_QUEUE_FULL')
    }
    function recount(s) {
      s.backlog = names.reduce(function (sum, n) {
        return sum + (s.lanes[n] ? s.lanes[n].pending.length : 0)
      }, 0)
      s.coverage_partial = !(
        s.lanes.initial_material.catalog_exhausted &&
        s.lanes.initial_servico.catalog_exhausted &&
        s.lanes.initial_material.pending.length === 0 &&
        s.lanes.initial_servico.pending.length === 0
      )
      if (!s.coverage_partial && !s.catalog_drained_at)
        s.catalog_drained_at = new Date().toISOString()
    }
    function dailyStart(s) {
      var target = s.requested_through,
        yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      if (s.daily && !s.daily.complete) return
      if (
        !/^20\d\d-\d\d-\d\d$/.test(target || '') ||
        target > yesterday ||
        (s.daily_ack && s.daily_ack.requested_through >= target)
      )
        return
      var cycleDay = new Date(Date.parse(target + 'T00:00:00Z') + 86400000)
          .toISOString()
          .slice(0, 10),
        cycle
      try {
        cycle = $app.findFirstRecordByData(
          'daily_sync_runs',
          'ciclo_id',
          'CICLO_AUTONOMOUS_V1_' + cycleDay,
        )
      } catch (e) {
        if (/not found|no rows|missing/i.test(String(e))) return
        throw e
      }
      var detail = JSON.parse(cycle.getString('detalhes')),
        started = cycle.getString('iniciado_em')
      if (
        detail.version !== 1 ||
        detail.contract !== 'autonomous-daily-v1' ||
        detail.requested_through !== target ||
        !isFinite(Date.parse(started)) ||
        Date.parse(started) > Date.now()
      )
        return
      s.daily = {
        target_day: target,
        started_at: started,
        complete: false,
        checked_count: 0,
        new_count: 0,
        updated_count: 0,
        unchanged_count: 0,
        source_checked_at: '',
      }
      ;['material', 'servico'].forEach(function (kind) {
        var l = lane(kind)
        l.last_code = ''
        s.lanes['daily_' + kind] = l
      })
    }
    function dailyFinish(s) {
      var d = s.daily
      if (!d || d.complete) return
      if (
        !['daily_material', 'daily_servico'].every(function (n) {
          return s.lanes[n].catalog_exhausted && s.lanes[n].pending.length === 0
        })
      )
        return
      var checked = d.source_checked_at || s.source_checked_at
      if (!checked || Date.parse(checked) < Date.parse(d.started_at)) return
      s.daily_ack = {
        requested_through: d.target_day,
        source_checked_at: checked,
        drained_at: new Date().toISOString(),
        coverage: 'known_codes',
        checked_count: d.checked_count,
        new_count: d.new_count,
        updated_count: d.updated_count,
        unchanged_count: d.unchanged_count,
      }
      d.complete = true
      d.drained_at = s.daily_ack.drained_at
    }
    function stored(rec) {
      var row = {},
        fields = [
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
      fields.forEach(function (k) {
        row[k] = rec.get(k)
      })
      row.raw_payload = JSON.parse(rec.getString('raw_payload'))
      return row
    }
    function trusted(rec, row) {
      var proof = row.raw_payload && row.raw_payload.proveniencia_preco,
        seal = proof && proof.validacao_indice
      if (
        rec.getString('server_trust_version') !== 'server-v1' ||
        rec.getString('search_contract') !== 'cotai-official-price-v3' ||
        !seal ||
        !h.sameFact(row, row)
      )
        return false
      var parts = ['cotai-official-price-v3', row.source, row.sample_key, row.source_record_id],
        signature = $security
          .sha256(
            parts
              .map(function (v) {
                return v.length + ':' + v
              })
              .join('|'),
          )
          .toLowerCase()
      return seal.assinatura === signature && rec.getString('payload_hash') === signature
    }
    function persist(tx, rows, work) {
      var counts = { new_count: 0, updated_count: 0, unchanged_count: 0 },
        now = new Date().toISOString(),
        collection = tx.findCollectionByNameOrId('price_samples_index')
      rows.forEach(function (row) {
        var prefix = h.identityPrefix(row),
          candidates = tx.findRecordsByFilter(
            'price_samples_index',
            'source = {:source} && source_record_id >= {:prefix} && source_record_id < {:upper}',
            '',
            101,
            0,
            { source: 'Compras.gov.br', prefix: prefix, upper: prefix + '\uffff' },
          )
        if (candidates.length > 100) throw Error('SOURCE_IDENTITY_OVERFLOW')
        var same = tx.findRecordsByFilter('price_samples_index', 'sample_key = {:key}', '', 2, 0, {
          key: row.sample_key,
        })
        if (same.length > 1) throw Error('SOURCE_IDENTITY_COLLISION')
        var existing = same[0] || null,
          previous = existing ? stored(existing) : null,
          hadPrior = false
        if (
          existing &&
          (!trusted(existing, previous) ||
            !h.sameFact(previous, row) ||
            previous.source_record_id !== row.source_record_id ||
            previous.valor_unitario !== row.valor_unitario)
        )
          throw Error('SOURCE_IDENTITY_COLLISION')
        var incomingUpdated = h.sourceUpdatedAt(row)
        candidates.forEach(function (rec) {
          var old = stored(rec)
          if (!trusted(rec, old) || !h.sameFact(old, row)) return
          hadPrior = true
          var oldUpdated = h.sourceUpdatedAt(old)
          if (incomingUpdated && oldUpdated && Date.parse(incomingUpdated) < Date.parse(oldUpdated))
            throw Error('SOURCE_STALE_REVISION')
          if (rec.id !== (existing && existing.id) && rec.getInt('search_eligible') === 1) {
            rec.set('search_eligible', 0)
            rec.set('situacao_origem', 'SUPERSEDED')
            tx.save(rec)
          }
        })
        var record = existing || new Record(collection),
          details = copy(row.raw_payload),
          seal = h.sealRow(row, work, $security.sha256)
        details.proveniencia_preco.validacao_indice = seal
        Object.keys(row).forEach(function (k) {
          record.set(k, k === 'raw_payload' ? details : row[k])
        })
        record.set('modelo', '')
        record.set('situacao_contratacao', '')
        record.set('matching_score', 0)
        record.set('matching_tipo', '')
        record.set('vigencia_fim', '')
        record.set('qualidade_situacao', 'aceita')
        record.set('motivos_rejeicao', [])
        record.set('situacao_origem', '')
        record.set('data_coleta', now)
        record.set('data_verificacao', now)
        record.set('indexed_at', now)
        record.set('last_validated_at', now)
        record.set('source_updated_at', incomingUpdated)
        record.set('payload_hash', seal.assinatura)
        record.set('server_trust_version', 'server-v1')
        record.set('search_contract', 'cotai-official-price-v3')
        record.set('search_eligible', 1)
        tx.save(record)
        var unchanged =
          previous &&
          JSON.stringify(previous.raw_payload.proveniencia_preco.registro_oficial) ===
            JSON.stringify(row.raw_payload.proveniencia_preco.registro_oficial)
        counts[unchanged ? 'unchanged_count' : hadPrior ? 'updated_count' : 'new_count']++
      })
      return counts
    }
    function fetch(url) {
      if (calls >= 4 || Date.now() + 4500 > deadline) throw Error('SOURCE_BUDGET')
      calls++
      var res = $http.send({
        url: url,
        method: 'GET',
        timeout: 4,
        headers: { Accept: 'application/json' },
      })
      if (Date.now() >= deadline) throw Error('SOURCE_BUDGET')
      if (!res || typeof res.then === 'function' || res.statusCode !== 200) {
        var err = Error('SOURCE_HTTP_' + (res ? res.statusCode : 0)),
          retry = res && res.headers && (res.headers['Retry-After'] || res.headers['retry-after'])
        if (Array.isArray(retry)) retry = retry[0]
        var delay = /^\d+$/.test(String(retry || ''))
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now()
        if (isFinite(delay) && delay > 0) err.retryMs = Math.min(86400000, delay)
        throw err
      }
      return h.parseResponse(res, function (bytes) {
        return toString(bytes)
      })
    }
    try {
      var found = $app.findRecordsByFilter(
        'price_watermarks',
        'fonte = {:source} && cursor_tipo = "autonomous-v1"',
        '',
        2,
        0,
        { source: 'Compras.gov.br' },
      )
      if (found.length !== 1) return
      wmId = found[0].id
      $app.runInTransaction(function (tx) {
        var rec = tx.findRecordById('price_watermarks', wmId),
          s = read(rec)
        if (s.claim && Date.parse(s.claim.expires_at) > Date.now()) return
        if (Date.parse(s.next_attempt_at) > Date.now()) return
        token = $security.randomString(24)
        s.claim = { token: token, expires_at: new Date(Date.now() + 55000).toISOString() }
        s.last_attempt_at = new Date().toISOString()
        if (!s.lanes.initial_material) s.lanes.initial_material = lane('material')
        if (!s.lanes.initial_servico) s.lanes.initial_servico = lane('servico')
        save(tx, rec, s)
        state = s
      })
      if (!token) return
      var initialize = copy(state)
      var catalogDone =
        initialize.lanes.initial_material.catalog_exhausted &&
        initialize.lanes.initial_servico.catalog_exhausted &&
        initialize.lanes.initial_material.pending.length === 0 &&
        initialize.lanes.initial_servico.pending.length === 0
      if (
        catalogDone &&
        initialize.catalog_drained_at &&
        initialize.catalog_drained_at.slice(0, 10) < new Date().toISOString().slice(0, 10)
      ) {
        initialize.previous_catalog_drained_at = initialize.catalog_drained_at
        initialize.catalog_drained_at = ''
        initialize.lanes.initial_material = lane('material')
        initialize.lanes.initial_servico = lane('servico')
      }
      dailyStart(initialize)
      commit(initialize)
      for (var turn = 0; turn < 12 && calls < 4 && Date.now() + 4500 <= deadline; turn++) {
        var selected = '',
          index = Number(state.next_slot) || 0,
          job = -1,
          mode = ''
        for (var step = 0; step < 4; step++) {
          var name = names[(index + step) % 4],
            l = state.lanes[name],
            daily = name.indexOf('daily_') === 0
          if (!l || (daily && (!state.daily || state.daily.complete))) continue
          validateLane(l)
          if (Date.parse(l.next_attempt_at) > Date.now()) continue
          var j = activeJob(l)
          if (j >= 0 && (l.prefer_price || l.catalog_exhausted || l.pending.length > 10)) {
            selected = name
            job = j
            mode = 'price'
            break
          }
          if (!l.catalog_exhausted && l.pending.length <= 10) {
            selected = name
            mode = daily ? 'known' : 'catalog'
            break
          }
          if (j >= 0) {
            selected = name
            job = j
            mode = 'price'
            break
          }
        }
        // An empty known corpus still needs a post-start official response. This
        // bounded confirmation does not rewind or advance either initial catalog.
        if (
          !selected &&
          state.daily &&
          !state.daily.complete &&
          ['daily_material', 'daily_servico'].every(function (name) {
            var emptyLane = state.lanes[name]
            return (
              emptyLane &&
              emptyLane.catalog_exhausted &&
              !emptyLane.last_code &&
              emptyLane.pending.length === 0
            )
          }) &&
          !(Date.parse(state.lanes.daily_material.next_attempt_at) > Date.now())
        ) {
          selected = 'daily_material'
          mode = 'confirm_empty'
        }
        if (!selected) break
        var next = copy(state),
          laneNext = next.lanes[selected],
          dailyWork = selected.indexOf('daily_') === 0
        next.next_slot = (names.indexOf(selected) + 1) % 4
        try {
          if (mode === 'known') {
            var lower = laneNext.kind === 'material' ? 'CATMAT ' : 'CATSER ',
              codes = arrayOf(new DynamicModel({ codigo_item: '' }))
            $app
              .db()
              .newQuery(
                "SELECT DISTINCT codigo_item FROM price_samples_index WHERE source = 'Compras.gov.br' AND server_trust_version = 'server-v1' AND search_contract = 'cotai-official-price-v3' AND search_eligible = 1 AND valor_unitario > 0 AND codigo_item > {:after} AND codigo_item >= {:lower} AND codigo_item < {:upper} ORDER BY codigo_item LIMIT 10",
              )
              .bind({ after: laneNext.last_code || lower, lower: lower, upper: lower + '\uffff' })
              .all(codes)
            if (!codes.length) laneNext.catalog_exhausted = true
            else {
              var extracted = codes.map(function (row) {
                var c = String(row.codigo_item)
                if (
                  c.indexOf(lower) !== 0 ||
                  !/^\d+$/.test(c.slice(lower.length)) ||
                  !/[1-9]/.test(c.slice(lower.length))
                )
                  throw Error('SOURCE_KNOWN_CODE_INVALID')
                return c.slice(lower.length)
              })
              addCodes(laneNext, extracted)
              laneNext.last_code = String(codes[codes.length - 1].codigo_item)
              laneNext.prefer_price = true
            }
            dailyFinish(next)
            recount(next)
            commit(next)
            continue
          }
          var work, body, parsed
          if (mode === 'confirm_empty') {
            body = fetch(
              'https://dadosabertos.compras.gov.br/modulo-material/3_consultarPdmMaterial?pagina=1&tamanhoPagina=10',
            )
            h.catalogCodes(body, 'material', 1)
          } else if (mode === 'catalog') {
            var path =
              laneNext.kind === 'material'
                ? '/modulo-material/3_consultarPdmMaterial'
                : '/modulo-servico/6_consultarItemServico'
            body = fetch(
              'https://dadosabertos.compras.gov.br' +
                path +
                '?pagina=' +
                laneNext.catalog_page +
                '&tamanhoPagina=10',
            )
            parsed = h.readPage(body, laneNext.catalog_page, 10)
            addCodes(laneNext, h.catalogCodes(body, laneNext.kind, laneNext.catalog_page))
            if (parsed.nextPage === null) laneNext.catalog_exhausted = true
            else laneNext.catalog_page = parsed.nextPage
            laneNext.prefer_price = true
          } else {
            var pending = laneNext.pending[job]
            work = {
              kind: laneNext.kind,
              selector:
                !dailyWork && laneNext.kind === 'material' ? 'codigoPdm' : 'codigoItemCatalogo',
              code: pending.code,
              page: pending.page,
              size: 100,
            }
            body = fetch(h.requestUrl(work))
            parsed = h.pricePage(body, work)
            laneNext.pending.splice(job, 1)
            if (parsed.nextPage !== null)
              laneNext.pending.push({
                code: pending.code,
                page: parsed.nextPage,
                attempts: 0,
                next_attempt_at: '',
              })
            laneNext.prefer_price = false
            increment(
              laneNext,
              'rejected_count',
              Object.keys(parsed.rejected).reduce(function (sum, k) {
                return sum + parsed.rejected[k]
              }, 0),
            )
          }
          var checkedAt = new Date().toISOString()
          if (mode === 'confirm_empty') next.daily.source_checked_at = checkedAt
          laneNext.source_checked_at = checkedAt
          next.source_checked_at = checkedAt
          laneNext.last_error = ''
          laneNext.next_attempt_at = ''
          increment(laneNext, 'pages_scanned', 1)
          recount(next)
          commit(next, function (tx, s) {
            if (mode === 'price') {
              var counts = persist(tx, parsed.rows, work),
                count = counts.new_count + counts.updated_count + counts.unchanged_count
              increment(laneNext, 'prices_checked', count)
              increment(s, 'checked_count', count)
              Object.keys(counts).forEach(function (k) {
                increment(s, k, counts[k])
                if (dailyWork) increment(s.daily, k, counts[k])
              })
              if (dailyWork) {
                increment(s.daily, 'checked_count', count)
                s.daily.source_checked_at = checkedAt
              }
              if (count) {
                s.source_written_at = checkedAt
                laneNext.source_written_at = checkedAt
              }
            }
            dailyFinish(s)
            s.last_error = names.some(function (n) {
              return s.lanes[n] && s.lanes[n].last_error
            })
              ? 'SOURCE_WORK_PENDING'
              : ''
          })
        } catch (error) {
          if (/SOURCE_LEASE_LOST|SOURCE_BUDGET/.test(String(error.message || error))) break
          var failed = copy(state),
            fl = failed.lanes[selected],
            reason =
              String(error.message || 'SOURCE_FAILED')
                .replace(/[^A-Z0-9_]/g, '')
                .slice(0, 80) || 'SOURCE_FAILED'
          failed.next_slot = next.next_slot
          fl.last_error = reason
          failed.last_error = reason
          var failure = mode === 'price' ? fl.pending[job] : fl
          failure.attempts = (failure.attempts || 0) + 1
          failure.next_attempt_at = new Date(
            Date.now() +
              Math.max(
                error.retryMs || 0,
                Math.min(86400000, 60000 * Math.pow(2, Math.min(failure.attempts - 1, 10))),
              ),
          ).toISOString()
          if (mode === 'price') {
            fl.pending.splice(job, 1)
            fl.pending.push(failure)
          }
          try {
            commit(failed)
          } catch (e) {
            break
          }
        }
      }
    } finally {
      if (token)
        try {
          $app.runInTransaction(function (tx) {
            var rec = tx.findRecordById('price_watermarks', wmId),
              latest = read(rec)
            if (latest.claim && latest.claim.token === token) {
              latest.claim = null
              save(tx, rec, latest)
            }
          })
        } catch (_) {}
    }
  }
  // COMPRAS_AUTONOMOUS_V1_END

  // AUTONOMOUS_SOURCE_V1_BEGIN
  function pncpSystemTask(rec) {
    return (
      !!rec &&
      rec.getString('server_trust_version') === 'server-v1' &&
      !rec.getString('requested_by') &&
      rec.getString('source') === 'PNCP' &&
      /^system:autonomous-v1:PNCP:(publication|updates|retry:\d{14}:20\d{2}:\d{1,6}(?::[a-f0-9]{32})?)$/.test(
        rec.getString('task_key'),
      )
    )
  }
  function autonomousRetryTick() {
    if (modoHttp) return
    var due = arrayOf(new DynamicModel({ id: '' })),
      now = new Date().toISOString()
    $app
      .db()
      .newQuery(
        "SELECT id FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND requested_by = '' AND source = 'PNCP' AND task_key LIKE 'system:autonomous-v1:PNCP:retry:%' AND status = 'failed' AND json_valid(pendentes) AND julianday(json_extract(pendentes, '$[1]._autonomous_retry_at')) <= julianday({:now}) ORDER BY finished_at, id LIMIT 1",
      )
      .bind({ now: now })
      .all(due)
    if (!due.length) return
    $app.runInTransaction(function (tx) {
      var task = tx.findRecordById('price_index_tasks', due[0].id)
      if (!pncpSystemTask(task) || task.getString('status') !== 'failed') return
      var queue = JSON.parse(task.getString('pendentes') || '[]'),
        p = queue[1]
      if (
        queue.length !== 2 ||
        !queue[0]._pncp_discovery ||
        !p ||
        Date.parse(p._autonomous_retry_at) > Date.parse(now)
      )
        return
      p.r = 0
      task.set('pendentes', JSON.stringify(queue))
      task.set('status', 'pending')
      tx.save(task)
    })
  }
  function pncpMergeDependencies(a, b) {
    var result = [],
      seen = {}
    ;(a || []).concat(b || []).forEach(function (d) {
      if (
        !d ||
        (d.lane !== 'publication' && d.lane !== 'updates') ||
        !/^20\d{2}-\d{2}-\d{2}$/.test(d.date) ||
        typeof d.window !== 'string' ||
        d.window.length > 80
      )
        throw new Error('SOURCE_DEPENDENCY')
      if (d.daily_epoch != null && (typeof d.daily_epoch !== 'string' || d.daily_epoch.length > 80))
        throw new Error('SOURCE_DEPENDENCY')
      var key = d.lane + '|' + d.window + '|' + (d.daily_epoch || '')
      if (!seen[key]) {
        seen[key] = true
        var value = { lane: d.lane, date: d.date, window: d.window }
        if (d.daily_epoch) value.daily_epoch = d.daily_epoch
        result.push(value)
      }
    })
    if (result.length > 256) throw new Error('SOURCE_DEPENDENCY_CAPACITY')
    return result.sort(function (a, b) {
      return (a.lane + a.window).localeCompare(b.lane + b.window)
    })
  }
  function pncpRetryDependencyPending(lane, from, to, app) {
    var found = arrayOf(new DynamicModel({ id: '' }))
    ;(app || $app)
      .db()
      .newQuery(
        "SELECT t.id FROM price_index_tasks t WHERE t.server_trust_version='server-v1' AND t.requested_by='' AND t.task_key LIKE 'system:autonomous-v1:PNCP:retry:%' AND t.status != 'completed' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(t.pendentes) THEN t.pendentes ELSE '[]' END) p WHERE json_extract(p.value,'$._pncp_discovery') IS NULL AND (json_type(p.value,'$._source_dependencies') IS NULL OR EXISTS (SELECT 1 FROM json_each(p.value,'$._source_dependencies') d WHERE json_extract(d.value,'$.lane')={:lane} AND json_extract(d.value,'$.date') >= {:from} AND json_extract(d.value,'$.date') <= {:to}))) LIMIT 1",
      )
      .bind({ lane: lane, from: from, to: to })
      .all(found)
    return found.length > 0
  }
  function autonomousRead(rec) {
    var raw = rec.getString('detalhes')
    if (!raw || raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
    var state = JSON.parse(raw)
    if (
      state.version !== 1 ||
      state.source !== rec.getString('fonte') ||
      !state.lanes ||
      Array.isArray(state.lanes)
    )
      throw new Error('SOURCE_STATE_VERSION')
    return state
  }
  function autonomousDate(date, delta) {
    if (!/^20\d\d-\d\d-\d\d$/.test(date) || !isFinite(Date.parse(date + 'T00:00:00Z')))
      throw new Error('SOURCE_DATE')
    return new Date(Date.parse(date + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10)
  }
  function pncpDailyRun(app, target) {
    try {
      var next = autonomousDate(target, 1)
      if (autonomousDate(target, 0) !== target || target >= new Date().toISOString().slice(0, 10))
        return null
      var rec = app.findFirstRecordByData(
        'daily_sync_runs',
        'ciclo_id',
        'CICLO_AUTONOMOUS_V1_' + next,
      )
      var details = JSON.parse(rec.getString('detalhes') || '{}'),
        started = rec.getString('iniciado_em')
      if (
        details.version !== 1 ||
        details.contract !== 'autonomous-daily-v1' ||
        details.requested_through !== target ||
        !isFinite(Date.parse(started)) ||
        Date.parse(started) > new Date().getTime()
      )
        return null
      return {
        requested_through: target,
        started_at: started,
        epoch: target + '@' + new Date(started).toISOString(),
      }
    } catch (_) {
      return null
    }
  }
  function pncpCount(target, kind) {
    ;['checked_count', 'new_count', 'updated_count', 'unchanged_count', 'written_count'].forEach(
      function (k) {
        if (target[k] == null) target[k] = 0
        if (!Number.isSafeInteger(target[k]) || target[k] < 0) throw new Error('SOURCE_COUNT')
      },
    )
    target.checked_count++
    target[kind + '_count']++
    if (kind !== 'unchanged') target.written_count++
    if (!Number.isSafeInteger(target.checked_count) || !Number.isSafeInteger(target.written_count))
      throw new Error('SOURCE_COUNT')
  }
  function pncpMergeAccounting(state, current) {
    var keys = [
      'checked_count',
      'new_count',
      'updated_count',
      'unchanged_count',
      'written_count',
      'source_written_at',
    ]
    keys.forEach(function (k) {
      if (current[k] != null) state[k] = current[k]
    })
    Object.keys(current.lanes).forEach(function (name) {
      if (!state.lanes[name]) return
      keys.forEach(function (k) {
        if (current.lanes[name][k] != null) state.lanes[name][k] = current.lanes[name][k]
      })
    })
    if (
      state.daily_cycle &&
      current.daily_cycle &&
      state.daily_cycle.epoch === current.daily_cycle.epoch
    )
      keys.forEach(function (k) {
        if (current.daily_cycle[k] != null) state.daily_cycle[k] = current.daily_cycle[k]
      })
  }
  function pncpPriceCheckKind(app, sample, existing) {
    if (!existing) {
      var previous = app.findRecordsByFilter(
        'price_samples_index',
        "source = 'PNCP' && source_record_id = {:identity} && server_trust_version = 'server-v1'",
        '',
        1,
        0,
        { identity: sample.source_record_id },
      )
      return previous.length ? 'updated' : 'new'
    }
    var raw = parseJsonWorkerSafe(existing.getString('raw_payload')) || {},
      oldProof = raw.proveniencia_preco || {}
    if (
      pncpCanonical(oldProof.registro_oficial) !==
      pncpCanonical(sample.raw_payload.proveniencia_preco.registro_oficial)
    )
      return 'updated'
    var fields = [
      'descricao',
      'unidade',
      'natureza_preco',
      'data_referencia',
      'modalidade',
      'situacao_contratacao',
      'codigo_item',
      'vigencia_fim',
    ]
    for (var i = 0; i < fields.length; i++)
      if (
        existing.getString(fields[i]) !==
        String(sample[fields[i]] || (fields[i] === 'unidade' ? 'UN' : ''))
      )
        return 'updated'
    return Number(existing.getString('valor_unitario')) === Number(sample.valor_unitario) &&
      Number(existing.getString('quantidade')) === (Number(sample.quantidade) || 0) &&
      Number(existing.getString('valor_total')) === (Number(sample.valor_total) || 0) &&
      existing.getInt('search_eligible') === 1
      ? 'unchanged'
      : 'updated'
  }
  function pncpAccountPrice(app, accounting, sample, kind, checkedAt) {
    if (!accounting) return
    if (modoHttp) throw new Error('SOURCE_TASK_IDENTITY')
    var task = app.findRecordById('price_index_tasks', accounting.task_id)
    if (
      !pncpSystemTask(task) ||
      task.getString('status') !== 'running' ||
      task.getInt('tentativas') !== accounting.tentativas ||
      task.getString('started_at') !== accounting.started_at
    )
      throw new Error('SOURCE_TASK_LEASE')
    var purchase = accounting.purchase,
      found = null,
      queue = JSON.parse(task.getString('pendentes') || '[]')
    for (var qi = 0; qi < queue.length; qi++)
      if (
        queue[qi].c === purchase.c &&
        Number(queue[qi].a) === Number(purchase.a) &&
        Number(queue[qi].s) === Number(purchase.s)
      ) {
        found = queue[qi]
        break
      }
    var identity = sample.raw_payload.proveniencia_preco.identidade
    if (
      !found ||
      identity.cnpj !== found.c ||
      Number(identity.ano) !== Number(found.a) ||
      Number(identity.sequencial) !== Number(found.s)
    )
      throw new Error('SOURCE_TASK_IDENTITY')
    if (!kind) return
    var dependencies = pncpMergeDependencies(found._source_dependencies || [], []),
      rows = app.findRecordsByFilter(
        'price_watermarks',
        'fonte = {:source} && cursor_tipo = "autonomous-v1"',
        '',
        1,
        0,
        { source: 'PNCP' },
      )
    if (!rows.length) throw new Error('SOURCE_STATE_MISSING')
    var rec = rows[0],
      state = autonomousRead(rec),
      now = new Date().toISOString(),
      lanes = {},
      cycle = state.daily_cycle,
      daily = false
    pncpCount(state, kind)
    dependencies.forEach(function (d) {
      lanes[d.lane] = true
      if (
        cycle &&
        cycle.phase === 'active' &&
        d.daily_epoch === cycle.epoch &&
        d.lane === 'updates' &&
        d.date >= cycle.from &&
        d.date <= cycle.requested_through
      ) {
        if (
          !isFinite(Date.parse(checkedAt)) ||
          Date.parse(checkedAt) < Date.parse(cycle.started_at)
        )
          throw new Error('SOURCE_DAILY_PROOF')
        daily = true
      }
    })
    Object.keys(lanes).forEach(function (name) {
      if (!state.lanes[name]) throw new Error('SOURCE_LANE_MISSING')
      pncpCount(state.lanes[name], kind)
      if (kind !== 'unchanged') state.lanes[name].source_written_at = now
    })
    if (daily) pncpCount(cycle, kind)
    if (kind !== 'unchanged') state.source_written_at = now
    var json = JSON.stringify(state)
    if (json.length > 64000) throw new Error('SOURCE_STATE_SIZE')
    rec.set('detalhes', json)
    app.save(rec)
  }
  function pncpDailyAcknowledge(app, state, now) {
    var cycle = state.daily_cycle,
      lane = state.lanes.updates
    if (
      !cycle ||
      cycle.phase !== 'active' ||
      !lane ||
      lane.daily_epoch !== cycle.epoch ||
      !lane.complete ||
      lane.end !== cycle.requested_through ||
      !isFinite(Date.parse(cycle.source_checked_at)) ||
      !isFinite(Date.parse(cycle.first_checked_at)) ||
      Date.parse(cycle.first_checked_at) < Date.parse(cycle.started_at)
    )
      return
    var authority = pncpDailyRun(app, cycle.requested_through)
    if (!authority || authority.epoch !== cycle.epoch) return
    var primary = arrayOf(new DynamicModel({ id: '' }))
    app
      .db()
      .newQuery('SELECT id FROM price_index_tasks WHERE task_key = {:key} LIMIT 1')
      .bind({ key: 'system:autonomous-v1:PNCP:updates' })
      .all(primary)
    var task = primary.length ? app.findRecordById('price_index_tasks', primary[0].id) : null
    if (
      task &&
      (!pncpSystemTask(task) ||
        task.getString('status') !== 'completed' ||
        JSON.parse(task.getString('pendentes') || '[]').some(function (p) {
          return !p._pncp_discovery
        }))
    )
      return
    if (pncpRetryDependencyPending('updates', cycle.from, cycle.requested_through, app)) return
    var keys = ['checked_count', 'new_count', 'updated_count', 'unchanged_count']
    if (
      !keys.every(function (k) {
        return Number.isSafeInteger(cycle[k]) && cycle[k] >= 0
      }) ||
      cycle.checked_count !== cycle.new_count + cycle.updated_count + cycle.unchanged_count
    )
      throw new Error('SOURCE_COUNT')
    now = new Date().toISOString()
    state.daily_ack = {
      requested_through: cycle.requested_through,
      source_checked_at: cycle.source_checked_at,
      drained_at: now,
      checked_count: cycle.checked_count,
      new_count: cycle.new_count,
      updated_count: cycle.updated_count,
      unchanged_count: cycle.unchanged_count,
      coverage: 'recent_window',
    }
    lane.backlog = 0
    lane.quarantine_pending = false
    state.backlog = Object.keys(state.lanes).reduce(function (n, name) {
      return n + (state.lanes[name].backlog || 0)
    }, 0)
    lane.drained_at = now
    lane.last_drained_window = lane.last_admitted_window
    state.last_drained_at = now
    cycle.phase = 'complete'
  }

  function autonomousSourceTick() {
    // Leave the full 16.5s Compras slice and 12s consumer reservation intact.
    var deadline = Math.min(new Date().getTime() + 9500, fimTrabalhoRede - 28500)
    if (modoHttp || new Date().getTime() + 8000 > deadline) return null
    var rows = $app.findRecordsByFilter(
      'price_watermarks',
      'fonte = {:source} && cursor_tipo = "autonomous-v1"',
      '',
      1,
      0,
      { source: 'PNCP' },
    )
    if (!rows.length) return null // Only migration-controlled state is eligible.
    var state,
      claim,
      wmId = rows[0].id,
      now = new Date().toISOString(),
      retryMs = 60000
    function saveState(tx, rec, value) {
      var json = JSON.stringify(value)
      if (json.length > 64000) throw new Error('SOURCE_STATE_SIZE')
      rec.set('detalhes', json)
      tx.save(rec)
    }
    function checkpointDomain(release) {
      var saved
      $app.runInTransaction(function (tx) {
        var rec = tx.findRecordById('price_watermarks', wmId),
          current = autonomousRead(rec)
        if (
          !current.claim ||
          current.claim.token !== claim ||
          Date.parse(current.claim.expires_at) <= new Date().getTime()
        )
          throw new Error('SOURCE_LEASE_LOST')
        if (new Date().getTime() >= deadline)
          throw new Error('SOURCE_BUDGET')
          // Change only domain metadata; concurrent counters, daily intent and cursors survive.
        ;['modalities', 'modalities_checked_at', 'domain_error', 'domain_next_attempt_at'].forEach(
          function (key) {
            current[key] = state[key]
          },
        )
        if (release) current.claim = null
        saveState(tx, rec, current)
        if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
        saved = current
      })
      return saved
    }
    function fetchOfficial(url) {
      if (new Date().getTime() + 8000 > deadline) throw new Error('SOURCE_BUDGET')
      var res = $http.send({
        url: url,
        method: 'GET',
        timeout: 8,
        headers: { Accept: 'application/json' },
      })
      if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
      if (res && typeof res.then === 'function') throw new Error('UPSTREAM_RUNTIME')
      if (!res || (res.statusCode !== 200 && res.statusCode !== 204)) {
        var retry = res && res.headers && (res.headers['Retry-After'] || res.headers['retry-after'])
        if (Array.isArray(retry)) retry = retry[0]
        if (retry)
          retryMs = Math.max(
            retryMs,
            /^\d+$/.test(String(retry))
              ? Number(retry) * 1000
              : Date.parse(retry) - new Date().getTime(),
          )
        throw new Error('SOURCE_HTTP_' + (res ? res.statusCode : 0))
      }
      if (res.statusCode === 204) return null
      var body = res.json !== undefined ? res.json : res.raw
      if (typeof body === 'string') body = JSON.parse(body)
      if (!body || typeof body !== 'object' || typeof body.then === 'function')
        throw new Error('SOURCE_BODY')
      return body
    }
    try {
      $app.runInTransaction(function (tx) {
        var rec = tx.findRecordById('price_watermarks', wmId),
          s = autonomousRead(rec)
        if (s.claim && Date.parse(s.claim.expires_at) > Date.parse(now)) return
        if (Date.parse(s.next_attempt_at) > Date.parse(now)) return
        claim = $security.randomString(24)
        s.claim = { token: claim, expires_at: new Date(Date.parse(now) + 55000).toISOString() }
        s.last_attempt_at = now
        saveState(tx, rec, s)
        state = s
      })
      if (!claim) return null
      var yesterday = autonomousDate(now.slice(0, 10), -1),
        freshUpdates = !state.lanes.updates
      if (
        !state.daily_cycle ||
        (state.daily_cycle.phase === 'complete' &&
          state.requested_through > state.daily_cycle.requested_through)
      ) {
        var authority = pncpDailyRun($app, state.requested_through)
        if (
          authority &&
          (!state.daily_ack || state.daily_ack.requested_through !== authority.requested_through)
        )
          state.daily_cycle = Object.assign(authority, {
            phase: 'waiting',
            checked_count: 0,
            new_count: 0,
            updated_count: 0,
            unchanged_count: 0,
            written_count: 0,
          })
      }
      if (!state.lanes.publication)
        state.lanes.publication = { date: yesterday, modality: 0, page: 1 }
      if (!state.lanes.updates)
        state.lanes.updates = {
          date: autonomousDate(yesterday, -2),
          end: yesterday,
          modality: 0,
          page: 1,
        }
      var domainDue =
        !Array.isArray(state.modalities) ||
        !state.modalities.length ||
        now.slice(0, 10) !== String(state.modalities_checked_at || '').slice(0, 10)
      if (domainDue && !(Date.parse(state.domain_next_attempt_at) > Date.parse(now))) {
        try {
          var domain = fetchOfficial('https://pncp.gov.br/api/pncp/v1/modalidades')
          if (!Array.isArray(domain) || !domain.length || domain.length > 256)
            throw new Error('SOURCE_DOMAIN')
          var merged = {},
            domainValid = false
          ;(state.modalities || []).concat(domain).forEach(function (m) {
            var id = Number(m.id),
              name = m.nome || m.name || ''
            if (!Number.isSafeInteger(id) || id <= 0 || id > 100000 || typeof name !== 'string')
              throw new Error('SOURCE_DOMAIN_ID')
            merged[id] = { id: id, name: name.slice(0, 160) }
            domainValid = true
          })
          if (!domainValid) throw new Error('SOURCE_DOMAIN')
          // Append new IDs: don't shift an active modality cursor when the domain grows.
          var oldIds = (state.modalities || []).map(function (m) {
            return m.id
          })
          state.modalities = oldIds
            .map(function (id) {
              return merged[id]
            })
            .concat(
              Object.keys(merged)
                .map(Number)
                .sort(function (a, b) {
                  return a - b
                })
                .filter(function (id) {
                  return oldIds.indexOf(id) < 0
                })
                .map(function (id) {
                  return merged[id]
                }),
            )
          state.modalities_checked_at = now
          state.domain_error = ''
          state.domain_next_attempt_at = ''
        } catch (domainError) {
          state.domain_error = String(domainError.message).slice(0, 160)
          state.domain_next_attempt_at = new Date(
            Date.parse(now) + Math.max(300000, retryMs),
          ).toISOString()
          if (!Array.isArray(state.modalities) || !state.modalities.length) throw domainError
        }
        // Persist a completed domain independently of a later feed response or timeout.
        // Slow refreshes get their own turn; cached history resumes on the next tick.
        if (new Date().getTime() + 8000 > deadline) return checkpointDomain(true)
        checkpointDomain(false)
      }
      if (!Array.isArray(state.modalities) || !state.modalities.length)
        throw new Error('SOURCE_DOMAIN_PENDING')
      var laneName = state.next_lane === 'updates' ? 'updates' : 'publication'
      state.next_lane = laneName === 'publication' ? 'updates' : 'publication'
      var lane = state.lanes[laneName],
        key = 'system:autonomous-v1:PNCP:' + laneName
      var task = null,
        pending = []
      try {
        task = $app.findFirstRecordByData('price_index_tasks', 'task_key', key)
      } catch (_) {}
      if (task && !pncpSystemTask(task)) throw new Error('SOURCE_TASK_IDENTITY')
      if (task)
        pending = JSON.parse(task.getString('pendentes') || '[]').filter(function (p) {
          return !p._pncp_discovery
        })
      if (!Array.isArray(pending) || pending.length > 100) throw new Error('SOURCE_QUEUE_SIZE')
      state.quarantine_pending =
        $app.findRecordsByFilter(
          'price_index_tasks',
          "task_key ~ {:retryPrefix} && server_trust_version = 'server-v1' && requested_by = '' && status != 'completed'",
          '',
          1,
          0,
          { retryPrefix: 'system:autonomous-v1:PNCP:retry:' },
        ).length > 0
      state.coverage_partial = state.quarantine_pending
      var spillCandidates = pending
        .filter(function (p) {
          return Number(p.r) >= 4
        })
        .slice(0, 10)
      lane.backlog = pending.length
      lane.quarantine_pending = pncpRetryDependencyPending(
        laneName,
        laneName === 'updates'
          ? lane.start || autonomousDate(lane.end || lane.date, -2)
          : String(lane.last_admitted_window || lane.date).slice(0, 10),
        laneName === 'updates'
          ? lane.end || lane.date
          : String(lane.last_admitted_window || lane.date).slice(0, 10),
      )
      if (
        task &&
        task.getString('status') === 'completed' &&
        !pending.length &&
        !lane.quarantine_pending
      ) {
        lane.drained_at = now
        if (lane.last_admitted_window) lane.last_drained_window = lane.last_admitted_window
        state.last_drained_at = now
        // Draining zero-price purchases is not a source-price write.
      }
      var laneDrained =
        !pending.length &&
        (!task || task.getString('status') === 'completed') &&
        !lane.quarantine_pending
      var daily = state.daily_cycle
      var startDaily =
        laneName === 'updates' &&
        daily &&
        daily.phase === 'waiting' &&
        laneDrained &&
        (freshUpdates || lane.complete)
      if (
        startDaily ||
        (laneName === 'updates' &&
          lane.complete &&
          laneDrained &&
          (!daily || daily.phase === 'complete') &&
          (!lane.end || lane.end < yesterday))
      ) {
        var endDate = startDaily ? daily.requested_through : yesterday
        lane.date = autonomousDate(lane.end && lane.end < endDate ? lane.end : endDate, -2)
        if (lane.date < '2021-04-01') lane.date = '2021-04-01'
        lane.end = endDate
        lane.start = lane.date
        lane.page = 1
        lane.modality = 0
        lane.complete = false
        lane.daily_epoch = startDaily ? daily.epoch : ''
        if (startDaily) {
          daily.phase = 'active'
          daily.from = lane.start
        }
      }
      var blocked =
        lane.complete ||
        pending.length - spillCandidates.length > 90 ||
        (task && task.getString('status') === 'running')
      var additions = [],
        body = null,
        url = '',
        admittedWindow = ''
      if (!blocked) {
        autonomousDate(lane.date, 0)
        if (
          lane.date < '2021-04-01' ||
          lane.date > yesterday ||
          !Number.isInteger(lane.page) ||
          lane.page < 1 ||
          !Number.isInteger(lane.modality) ||
          lane.modality < 0 ||
          lane.modality >= state.modalities.length
        )
          throw new Error('SOURCE_CURSOR')
        var modalityId = Number(state.modalities[lane.modality].id)
        if (!Number.isSafeInteger(modalityId) || modalityId < 1 || modalityId > 100000)
          throw new Error('SOURCE_MODALITY')
        url =
          'https://pncp.gov.br/api/consulta/v1/contratacoes/' +
          (laneName === 'publication' ? 'publicacao' : 'atualizacao') +
          '?dataInicial=' +
          lane.date.replace(/-/g, '') +
          '&dataFinal=' +
          lane.date.replace(/-/g, '') +
          '&codigoModalidadeContratacao=' +
          modalityId +
          '&pagina=' +
          lane.page +
          '&tamanhoPagina=10'
        // Metadata persistence or queue reads may have used the remaining request budget.
        // Yield before HTTP starts; this is not a failed official-source attempt.
        if (new Date().getTime() + 8000 > deadline) return checkpointDomain(true)
        body = fetchOfficial(url)
        if (
          body !== null &&
          (!Array.isArray(body.data) ||
            body.data.length > 10 ||
            Number(body.numeroPagina) !== lane.page ||
            !Number.isInteger(Number(body.totalPaginas)) ||
            Number(body.totalPaginas) < 0 ||
            (body.data.length && Number(body.totalPaginas) < lane.page) ||
            (!body.data.length && Number(body.totalPaginas) > 0))
        )
          throw new Error('SOURCE_PAGE')
        var entries = body ? body.data : []
        entries.forEach(function (entry) {
          var control =
            typeof entry.numeroControlePNCP === 'string' &&
            /^(\d{14})-1-(\d{6})\/(20\d{2})$/.exec(entry.numeroControlePNCP)
          if (
            !control ||
            !entry.orgaoEntidade ||
            entry.orgaoEntidade.cnpj !== control[1] ||
            Number(entry.anoCompra) !== Number(control[3]) ||
            Number(entry.sequencialCompra) !== Number(control[2]) ||
            Number(control[2]) < 1
          )
            throw new Error('SOURCE_PURCHASE_ID')
          additions.push({
            c: control[1],
            a: Number(control[3]),
            s: Number(control[2]),
            t: 'edital',
            r: 0,
            numeroControlePNCP: entry.numeroControlePNCP,
            o: String(entry.orgaoEntidade.razaoSocial || '').slice(0, 300),
            u: String((entry.unidadeOrgao && entry.unidadeOrgao.ufSigla) || '').slice(0, 2),
            m: String((entry.unidadeOrgao && entry.unidadeOrgao.municipioNome) || '').slice(0, 160),
            numeroProcesso: String(entry.processo || '').slice(0, 160),
            modalidadeNome: String(
              entry.modalidadeNome || state.modalities[lane.modality].name || '',
            ).slice(0, 160),
            situacaoCompraNome: String(entry.situacaoCompraNome || '').slice(0, 160),
            situacaoCompraId: entry.situacaoCompraId,
            source_updated_at: String(
              entry.dataAtualizacaoGlobal || entry.dataAtualizacao || '',
            ).slice(0, 40),
            source_checked_at: now,
            _source_dependencies: [
              {
                lane: laneName,
                date: lane.date,
                window: lane.date + ':' + modalityId + ':' + lane.page,
                daily_epoch: laneName === 'updates' ? lane.daily_epoch || '' : '',
              },
            ],
          })
        })
        admittedWindow = lane.date + ':' + modalityId + ':' + lane.page
      }
      $app.runInTransaction(function (tx) {
        var rec = tx.findRecordById('price_watermarks', wmId),
          current = autonomousRead(rec)
        if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
        if (
          !current.claim ||
          current.claim.token !== claim ||
          Date.parse(current.claim.expires_at) <= new Date().getTime()
        )
          throw new Error('SOURCE_LEASE_LOST')
        pncpMergeAccounting(state, current)
        var queue = [],
          t = null
        if (task) {
          t = tx.findRecordById('price_index_tasks', task.id)
          if (!pncpSystemTask(t)) throw new Error('SOURCE_TASK_IDENTITY')
          queue = JSON.parse(t.getString('pendentes') || '[]').filter(function (p) {
            return !p._pncp_discovery
          })
        }
        if (t && t.getString('status') === 'running' && !blocked)
          throw new Error('SOURCE_TASK_RACE')
        if (t && t.getString('status') !== 'running') {
          var spilled = 0
          queue = queue.filter(function (p) {
            if (Number(p.r) < 4 || spilled >= 10) return true
            if (
              !/^\d{14}$/.test(String(p.c)) ||
              !/^20\d{2}$/.test(String(p.a)) ||
              !/^\d{1,6}$/.test(String(p.s))
            )
              throw new Error('SOURCE_RETRY_ID')
            var retryVersion = $security
              .sha256(
                String(p.source_checked_at || '') +
                  '|' +
                  String(p.source_updated_at || '') +
                  '|' +
                  laneName +
                  '|' +
                  JSON.stringify({
                    dependencies: p._source_dependencies || [],
                    j: p.j || null,
                    i: p.i || 0,
                    b: p.b || 0,
                  }),
              )
              .slice(0, 32)
            var retryKey =
                'system:autonomous-v1:PNCP:retry:' +
                p.c +
                ':' +
                p.a +
                ':' +
                p.s +
                ':' +
                retryVersion,
              retryTask = null
            try {
              retryTask = tx.findFirstRecordByData('price_index_tasks', 'task_key', retryKey)
            } catch (_) {}
            if (retryTask && !pncpSystemTask(retryTask)) throw new Error('SOURCE_RETRY_IDENTITY')
            if (!retryTask || retryTask.getString('status') === 'completed') {
              if (!retryTask)
                retryTask = new Record(tx.findCollectionByNameOrId('price_index_tasks'))
              var originalCache = null
              try {
                originalCache = tx.findFirstRecordByData(
                  'pncp_item_cache',
                  'cache_key',
                  p.c + '_' + p.a + '_' + p.s + '_autonomous_' + laneName,
                )
              } catch (_) {}
              if (
                originalCache &&
                originalCache.getString('server_trust_version') === 'server-v1'
              ) {
                var retryCacheKey =
                    p.c + '_' + p.a + '_' + p.s + '_autonomous_retry_' + retryVersion,
                  retryCache = null
                try {
                  retryCache = tx.findFirstRecordByData(
                    'pncp_item_cache',
                    'cache_key',
                    retryCacheKey,
                  )
                } catch (_) {}
                if (!retryCache)
                  retryCache = new Record(tx.findCollectionByNameOrId('pncp_item_cache'))
                retryCache.set('cache_key', retryCacheKey)
                retryCache.set('cnpj', p.c)
                retryCache.set('ano', p.a)
                retryCache.set('sequencial', p.s)
                retryCache.set('raw_itens', originalCache.getString('raw_itens'))
                retryCache.set('total_itens', originalCache.getInt('total_itens'))
                retryCache.set('server_trust_version', 'server-v1')
                tx.save(retryCache)
              }
              p._autonomous_retry_cache = retryVersion
              p._autonomous_retry_at = new Date(Date.parse(now) + 1800000).toISOString()
              p._retry_count = 0
              retryTask.set('task_key', retryKey)
              retryTask.set('source', 'PNCP')
              retryTask.set('requested_by', '')
              retryTask.set('server_trust_version', 'server-v1')
              retryTask.set('termo', 'Reconsulta oficial PNCP')
              retryTask.set('status', 'failed')
              retryTask.set('admitted_at', now)
              retryTask.set(
                'pendentes',
                JSON.stringify([
                  { _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } } },
                  p,
                ]),
              )
              tx.save(retryTask)
            }
            // The reserved retry acknowledges this exact version/checkpoint/dependency set.
            spilled++
            return false
          })
          if (spilled) {
            lane.quarantined_total = (lane.quarantined_total || 0) + spilled
            state.quarantine_pending = true
            state.coverage_partial = true
            t.set(
              'pendentes',
              JSON.stringify(
                [
                  { _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } } },
                ].concat(queue),
              ),
            )
            t.set('status', queue.length ? 'pending' : 'completed')
            tx.save(t)
          }
        }
        if (!blocked) {
          additions.forEach(function (p) {
            var at = -1
            for (var qi = 0; qi < queue.length; qi++)
              if (
                queue[qi].c === p.c &&
                Number(queue[qi].a) === p.a &&
                Number(queue[qi].s) === p.s
              ) {
                at = qi
                break
              }
            if (at < 0) queue.push(p)
            else {
              var dependencies = pncpMergeDependencies(
                queue[at]._source_dependencies,
                p._source_dependencies,
              )
              if (p.source_updated_at && p.source_updated_at > (queue[at].source_updated_at || ''))
                queue[at] = p
              queue[at]._source_dependencies = dependencies
            }
          })
          if (queue.length > 100 || JSON.stringify(queue).length > 160000)
            throw new Error('SOURCE_CAPACITY')
          if (queue.length) {
            if (!t) {
              t = new Record(tx.findCollectionByNameOrId('price_index_tasks'))
              t.set('task_key', key)
              t.set('source', 'PNCP')
              t.set('termo', 'Coleta oficial PNCP')
              t.set('requested_by', '')
              t.set('server_trust_version', 'server-v1')
              t.set('admitted_at', now)
            }
            t.set(
              'pendentes',
              JSON.stringify(
                [
                  { _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } } },
                ].concat(queue),
              ),
            )
            t.set('status', 'pending')
            tx.save(t)
          }
          lane.last_admitted_window = admittedWindow
          lane.pages_scanned = (lane.pages_scanned || 0) + 1
          lane.purchases_queued = (lane.purchases_queued || 0) + additions.length
          if (body && lane.page < Number(body.totalPaginas)) lane.page++
          else {
            lane.page = 1
            lane.modality++
            if (lane.modality >= state.modalities.length) {
              lane.modality = 0
              if (laneName === 'publication') {
                if (lane.date === '2021-04-01') lane.complete = true
                else lane.date = autonomousDate(lane.date, -1)
              } else if (lane.date >= lane.end) lane.complete = true
              else lane.date = autonomousDate(lane.date, 1)
            }
          }
          lane.last_error = ''
          state.source_checked_at = now
          lane.source_checked_at = now
          if (
            laneName === 'updates' &&
            state.daily_cycle &&
            state.daily_cycle.phase === 'active' &&
            lane.daily_epoch === state.daily_cycle.epoch
          ) {
            if (!state.daily_cycle.first_checked_at) state.daily_cycle.first_checked_at = now
            state.daily_cycle.source_checked_at = now
          }
        }
        lane.backlog = queue.length
        state.backlog = Object.keys(state.lanes).reduce(function (n, k) {
          return n + (state.lanes[k].backlog || 0)
        }, 0)
        if (
          current.requested_through &&
          (!state.requested_through || current.requested_through > state.requested_through)
        )
          state.requested_through = current.requested_through
        state.claim = null
        state.next_attempt_at = ''
        state.failures = 0
        state.last_error = ''
        rec.set('status', state.backlog ? 'running' : 'idle')
        rec.set('last_watermark_date', lane.date)
        rec.set('last_cursor_page', lane.page)
        rec.set('ultimo_erro', '')
        rec.set('tentativas_consecutivas_falha', 0)
        pncpDailyAcknowledge(tx, state, now)
        saveState(tx, rec, state)
        if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
      })
      return state
    } catch (err) {
      if (claim)
        try {
          $app.runInTransaction(function (tx) {
            var rec = tx.findRecordById('price_watermarks', wmId),
              s = autonomousRead(rec)
            if (!s.claim || s.claim.token !== claim) return
            s.claim = null
            s.failures = (s.failures || 0) + 1
            s.last_error = String(err.message || err).slice(0, 300)
            if (laneName === 'publication' || laneName === 'updates') {
              s.next_lane = laneName === 'publication' ? 'updates' : 'publication'
              if (s.lanes[laneName]) s.lanes[laneName].last_error = s.last_error
            }
            s.next_attempt_at = new Date(
              Date.parse(now) +
                Math.min(
                  86400000,
                  Math.max(retryMs, 60000 * Math.pow(2, Math.min(s.failures - 1, 6))),
                ),
            ).toISOString()
            rec.set('status', 'error')
            rec.set('ultimo_erro', s.last_error)
            rec.set('tentativas_consecutivas_falha', s.failures)
            saveState(tx, rec, s)
          })
        } catch (_) {}
      return null
    }
  }
  // AUTONOMOUS_SOURCE_V1_END

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
      u: String(
        entry.uf ||
          (entry.unidadeOrgao && entry.unidadeOrgao.ufSigla) ||
          (entry.municipio_uf ? entry.municipio_uf.split('-')[1] : '') ||
          '',
      ).trim(),
      m: String(
        entry.municipio_nome ||
          entry.municipio ||
          (entry.unidadeOrgao && entry.unidadeOrgao.municipioNome) ||
          '',
      ).trim(),
      numeroProcesso: String(
        entry.processo_origem ||
          entry.numeroProcesso ||
          entry.numero_processo ||
          entry.processo ||
          '',
      ).trim(),
      codigoCatalogo: extrairCodigoItemWorker(entry, entry),
      materialOuServico: String(entry.materialOuServico || entry.tipoCatalogo || ''),
      modalidadeNome: String(entry.modalidadeNome || entry.modalidade_nome || ''),
      situacaoCompraNome: String(entry.situacaoCompraNome || ''),
      source_updated_at: String(entry.dataAtualizacaoGlobal || entry.dataAtualizacao || ''),
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
  function pncpSchedulable(p) {
    // Recovery keeps the task pending; only fresh proof can admit ordinary purchase work.
    if (p.t === 'contrato' && !pncpVerifiedPurchase(p))
      return (
        pncpLegacyCandidate(p) &&
        !!p._pncp_relacao &&
        [
          'relacao_ausente',
          'contrato_http',
          'origem_nao_comprovada',
          'adiado',
          'campos_compra_invalidos',
        ].indexOf(p._pncp_relacao.lastStatus) >= 0
      )
    return pncpActionable(p)
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
      if (!resultEntry || typeof resultEntry !== 'object' || Array.isArray(resultEntry)) continue
      var resultItem = resultEntry.numeroItem || resultEntry.numero_item
      if (resultItem != null && Number(resultItem) !== identity.numeroItem) return null
    }
    return envelope
  }
  function pncpResultEnvelope(identity, item, url, body, captured) {
    var positive = pncpPositive(body)
    var entries = Array.isArray(body) ? body : body && (body.items || body.data || body.resultado)
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

  function extrairCodigoItemWorker(itmObj, parentObj) {
    itmObj = itmObj || {}
    parentObj = parentObj || {}
    function fromOwner(owner) {
      var candidates = [
        owner.codigo_catalogo,
        owner.codigoCatalogo,
        owner.catalogoCodigoItem,
        owner.codigoItem,
        owner.codigoMaterialOuServico,
      ]
      var kind = String(owner.materialOuServico || owner.tipoCatalogo || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
      for (var codeIndex = 0; codeIndex < candidates.length; codeIndex++) {
        var raw = String(candidates[codeIndex] || '').trim()
        var explicit = /\b(CATMAT|CATSER)\s*[:#-]?\s*(\d{4,8})\b/i.exec(raw)
        if (explicit) return explicit[1].toUpperCase() + ' ' + explicit[2]
        var numeric = /\b(\d{4,8})\b/.exec(raw)
        if (!numeric) continue
        if (kind === 'S' || kind.indexOf('SERVIC') !== -1) return 'CATSER ' + numeric[1]
        if (kind === 'M' || kind.indexOf('MATERIAL') !== -1) return 'CATMAT ' + numeric[1]
      }
      return ''
    }
    var itemCode = fromOwner(itmObj)
    if (itemCode) return itemCode
    var parentCode = fromOwner(parentObj)
    if (parentCode) return parentCode
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
    if (typeof sleep === 'function') {
      sleep(ms)
      return
    }
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
        if (res && typeof res.then === 'function') return { ok: false, error: 'UPSTREAM_RUNTIME' }
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

  function validarESelarAmostraPncpWorker(a) {
    if (!a || a.source !== 'PNCP') return null
    var value = Number(a.valor_unitario)
    if (!isFinite(value) || value <= 0) return null
    if (
      typeof a.source_record_id !== 'string' ||
      !a.source_record_id ||
      a.purchase_id !== a.source_record_id ||
      typeof a.item_id !== 'string' ||
      !a.item_id ||
      typeof a.descricao !== 'string' ||
      !a.descricao.trim() ||
      typeof a.descricao_normalizada !== 'string' ||
      !a.descricao_normalizada.trim() ||
      a.sample_key !== gerarSampleKeyUtil(a)
    )
      return null
    var details = a.raw_payload
    if (typeof details === 'string') {
      try {
        details = JSON.parse(details)
      } catch (_) {
        return null
      }
    }
    var proof = details && details.proveniencia_preco
    var raw = proof && proof.registro_oficial
    var identity = proof && proof.identidade
    if (
      !proof ||
      proof.versao !== 1 ||
      proof.status !== 'verificada' ||
      proof.fonte !== 'PNCP' ||
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !identity ||
      raw.isDemo === true ||
      raw.is_demo === true ||
      Number(raw.situacaoCompraItemResultadoId) === 2 ||
      Number(raw.situacaoCompraItem) === 3 ||
      Number(raw.situacaoCompraItemId) === 3 ||
      !!raw.dataCancelamento
    )
      return null
    var allowedFields = [
      'valorUnitarioHomologado',
      'valor_unitario_homologado',
      'valorUnitarioEstimado',
      'valor_unitario_estimado',
      'valorUnitario',
      'valor_unitario',
    ]
    if (
      allowedFields.indexOf(proof.campo_unitario) < 0 ||
      !isFinite(Number(raw[proof.campo_unitario])) ||
      Number(raw[proof.campo_unitario]) <= 0 ||
      Number(raw[proof.campo_unitario]) !== value ||
      !isFinite(Number(proof.valor_unitario)) ||
      Number(proof.valor_unitario) !== value
    )
      return null
    var nature = proof.natureza === 'contratado' ? 'homologado' : proof.natureza
    if (
      (nature !== 'homologado' && nature !== 'estimado') ||
      a.natureza_preco !== nature ||
      (/estimado/i.test(proof.campo_unitario) && nature !== 'estimado') ||
      (/homologado/i.test(proof.campo_unitario) && nature !== 'homologado')
    )
      return null
    if (String(details.numeroItem || '1') !== a.item_id) return null
    var cnpj = String(identity.cnpj || '')
    var year = String(identity.ano || '')
    var sequence = String(identity.sequencial || '')
    var item = String(identity.numeroItem || '')
    if (
      !/^\d{14}$/.test(cnpj) ||
      !/^\d{4}$/.test(year) ||
      !/^\d+$/.test(sequence) ||
      Number(sequence) <= 0 ||
      !/^\d+$/.test(item) ||
      Number(item) <= 0 ||
      item !== a.item_id ||
      String(a.orgao_cnpj || '') !== cnpj
    )
      return null
    var purchase = cnpj + '/' + year + '/' + sequence
    var evidence =
      'https://pncp.gov.br/api/pncp/v1/orgaos/' +
      cnpj +
      '/compras/' +
      year +
      '/' +
      sequence +
      '/itens/' +
      item
    if (
      a.url_original !== 'https://pncp.gov.br/app/editais/' + purchase ||
      (proof.url_evidencia !== evidence && proof.url_evidencia !== evidence + '/resultados')
    )
      return null
    var supplier = String(raw.niFornecedor || a.fornecedor_cnpj || '').replace(/\D/g, '')
    var expectedId =
      purchase +
      '/itens/' +
      item +
      (raw.sequencialResultado ? '/resultados/' + raw.sequencialResultado : '') +
      (supplier ? '/fornecedor/' + supplier : '')
    if (
      a.source_record_id !== expectedId ||
      (raw.numeroItem != null && String(raw.numeroItem) !== a.item_id)
    )
      return null
    if (proof.data_oficial || proof.campo_data || a.data_referencia) {
      if (
        proof.campo_data !== 'dataResultado' ||
        !proof.data_oficial ||
        String(raw.dataResultado || '') !== String(proof.data_oficial) ||
        String(a.data_referencia || '') !== String(proof.data_oficial) ||
        !isFinite(Date.parse(proof.data_oficial))
      )
        return null
    }
    if (typeof $security === 'undefined' || !$security || typeof $security.sha256 !== 'function')
      return null
    var contract = 'cotai-official-price-v3'
    var parts = [contract, a.source, a.sample_key, a.source_record_id]
    var material = []
    for (var p = 0; p < parts.length; p++) {
      var part = String(parts[p])
      material.push(part.length + ':' + part)
    }
    var signature = $security.sha256(material.join('|'))
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return null
    var seal = {
      contrato: 'cotai-official-price-v3',
      fonte: a.source,
      sample_key: a.sample_key,
      source_record_id: a.source_record_id,
      assinatura: signature.toLowerCase(),
    }
    details = Object.assign({}, details)
    proof = Object.assign({}, proof)
    // Any marker returned by a remote source is non-authoritative.
    proof.validacao_indice = seal
    details.proveniencia_preco = proof
    return { raw_payload: details, payload_hash: seal.assinatura }
  }

  function pncpOfficialUpdatedAt(raw) {
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch (_) {
        return ''
      }
    }
    var official = raw && raw.proveniencia_preco && raw.proveniencia_preco.registro_oficial
    var date =
      (official && (official.dataAtualizacaoGlobal || official.dataAtualizacao)) ||
      (raw && raw.compra_oficial && raw.compra_oficial.dataAtualizacaoGlobal) ||
      ''
    return typeof date === 'string' && isFinite(Date.parse(date)) ? date : ''
  }
  function pncpNewerOfficial(app, identity, date) {
    if (!date) return false
    var found = arrayOf(new DynamicModel({ source_record_id: '' }))
    app
      .db()
      .newQuery(
        "SELECT source_record_id FROM price_samples_index WHERE source='PNCP' AND source_record_id={:identity} AND server_trust_version='server-v1' AND CASE WHEN json_valid(raw_payload) THEN julianday(COALESCE(NULLIF(json_extract(raw_payload,'$.proveniencia_preco.registro_oficial.dataAtualizacaoGlobal'),''),NULLIF(json_extract(raw_payload,'$.proveniencia_preco.registro_oficial.dataAtualizacao'),''),json_extract(raw_payload,'$.compra_oficial.dataAtualizacaoGlobal'))) ELSE NULL END > julianday({:sourceDate}) LIMIT 1",
      )
      .bind({ identity: identity, sourceDate: date })
      .all(found)
    return found.length > 0
  }
  function pncpScopeBlocked(app, identity, verifiedAt) {
    var m =
      /^(\d{14}\/20\d{2}\/\d+\/itens\/)(\d+)(?:\/resultados\/(\d+))?(?:\/fornecedor\/\d+)?$/.exec(
        String(identity),
      )
    if (!m) return true
    var found = arrayOf(new DynamicModel({ scope: '' }))
    app
      .db()
      .newQuery(
        "SELECT scope FROM cotai_pncp_scope_state WHERE scope IN ({:purchase},{:item},{:result}) AND cancelled_at != '' AND (julianday(active_at) IS NULL OR julianday(active_at) <= julianday(cancelled_at) OR julianday({:verified}) IS NULL OR julianday({:verified}) <= julianday(cancelled_at)) LIMIT 1",
      )
      .bind({
        purchase: m[1],
        item: m[1] + m[2] + '/',
        result: m[3] ? m[1] + m[2] + '/resultados/' + m[3] + '/' : '',
        verified: verifiedAt || '',
      })
      .all(found)
    return found.length > 0
  }
  function pncpObserveScope(app, prefix, status, checked, official) {
    if (
      !/^\d{14}\/20\d{2}\/\d+\/itens\/(?:\d+\/(?:resultados\/\d+\/)?)?$/.test(prefix) ||
      !isFinite(Date.parse(checked)) ||
      (status !== 'cancelled' && status !== 'active')
    )
      throw new Error('PNCP_SCOPE_OBSERVATION')
    var evidence = { scope: prefix, status: status, checked_at: checked, record: {} }
    ;[
      'situacaoCompraNome',
      'situacaoCompraId',
      'situacaoCompraItem',
      'situacaoCompraItemId',
      'situacaoCompraItemNome',
      'situacaoCompraItemResultadoId',
      'dataCancelamento',
      'motivoCancelamento',
      'dataAtualizacao',
      'dataAtualizacaoGlobal',
      'source_updated_at',
      'numeroItem',
      'sequencialResultado',
    ].forEach(function (k) {
      var v = official && official[k]
      if (typeof v === 'string') evidence.record[k] = v.slice(0, 1000)
      else if (typeof v === 'number') evidence.record[k] = v
    })
    var field = status === 'cancelled' ? 'cancelled_at' : 'active_at',
      proof = status === 'cancelled' ? 'cancellation_evidence' : 'active_evidence'
    app
      .db()
      .newQuery(
        'INSERT INTO cotai_pncp_scope_state(scope,' +
          field +
          ',' +
          proof +
          ') VALUES({:scope},{:checked},{:evidence}) ON CONFLICT(scope) DO UPDATE SET ' +
          field +
          '=excluded.' +
          field +
          ',' +
          proof +
          '=excluded.' +
          proof +
          ' WHERE julianday(excluded.' +
          field +
          ') > COALESCE(julianday(cotai_pncp_scope_state.' +
          field +
          '),0)',
      )
      .bind({ scope: prefix, checked: checked, evidence: JSON.stringify(evidence) })
      .execute()
  }
  function pncpInvalidateOfficial(prefix, checked, official) {
    if (
      !/^\d{14}\/20\d{2}\/\d+\/itens\/(?:\d+\/(?:resultados\/\d+\/)?)?$/.test(prefix) ||
      !isFinite(Date.parse(checked))
    )
      throw new Error('PNCP_INVALIDATION_ID')
    $app.runInTransaction(function (tx) {
      pncpObserveScope(tx, prefix, 'cancelled', checked, official)
      tx.db()
        .newQuery(
          "UPDATE price_samples_index SET search_eligible = 0, situacao_origem = 'SOURCE_CANCELLED', data_verificacao = {:checked}, last_validated_at = {:checked}, qualidade_situacao = 'rejeitada', motivos_rejeicao = '[\"SOURCE_CANCELLED\"]' WHERE source = 'PNCP' AND server_trust_version = 'server-v1' AND search_contract = 'cotai-official-price-v3' AND (source_record_id = {:exact} OR (source_record_id >= {:prefix} AND source_record_id < {:upper} AND substr(source_record_id,1,length({:prefix})) = {:prefix})) AND NOT EXISTS (SELECT 1 FROM cotai_pncp_scope_state WHERE scope={:prefix} AND julianday(active_at)>julianday({:checked})) AND (last_validated_at = '' OR julianday(last_validated_at) <= julianday({:checked}))",
        )
        .bind({ prefix: prefix, exact: prefix.slice(0, -1), upper: prefix + '~', checked: checked })
        .execute()
    })
  }

  // Persistência progressiva com campos de auditoria, qualidade, hash e situação
  function persistirLoteAmostrasProgressivo(amostras, colecaoAmostras, accounting) {
    if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
    var inseridas = 0
    var atualizadas = 0
    var excluidas = []
    var falhou = false
    var agora = new Date().toISOString()
    var col = colecaoAmostras || $app.findCollectionByNameOrId('price_samples_index')

    for (var i = 0; i < amostras.length; i++) {
      var a = amostras[i]
      var estrita = validarESelarAmostraPncpWorker(a)
      if (!estrita) continue
      a.raw_payload = estrita.raw_payload
      var proofFresh = a.raw_payload.proveniencia_preco
      a.source_updated_at = pncpOfficialUpdatedAt(a.raw_payload)
      var checkedAt = proofFresh.resultado_capturado_em || agora
      var freshlyFetched =
        proofFresh.resultado_reutilizado === false &&
        isFinite(Date.parse(proofFresh.resultado_capturado_em))
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
      var pHash = estrita.payload_hash

      var sampleSaved = 0
      try {
        $app.runInTransaction(function (txSample) {
          var existente = null
          try {
            existente = txSample.findFirstRecordByData('price_samples_index', 'sample_key', key)
          } catch (_) {
            existente = null
          }

          if (pncpNewerOfficial(txSample, a.source_record_id, a.source_updated_at)) {
            excluidas.push(key)
            return
          }

          if (pncpScopeBlocked(txSample, a.source_record_id, freshlyFetched ? checkedAt : '')) {
            excluidas.push(key)
            return
          }

          var cancelled = txSample.findRecordsByFilter(
            'price_samples_index',
            "source = 'PNCP' && source_record_id = {:identity} && server_trust_version = 'server-v1' && situacao_origem = 'SOURCE_CANCELLED'",
            '-data_verificacao',
            1,
            0,
            { identity: a.source_record_id },
          )
          var canRestore =
            freshlyFetched &&
            a.source_status_checked_at &&
            a.situacao_contratacao &&
            !/revogad|anulad|cancelad|suspens/i.test(a.situacao_contratacao) &&
            (!cancelled.length ||
              Date.parse(a.source_status_checked_at) >
                Date.parse(cancelled[0].getString('data_verificacao')))
          if (
            (cancelled.length && !canRestore) ||
            (existente &&
              existente.getString('situacao_origem') === 'SUPERSEDED' &&
              !freshlyFetched)
          ) {
            excluidas.push(key)
            return
          }
          var countKind = accounting ? pncpPriceCheckKind(txSample, a, existente) : 'updated'
          if (freshlyFetched)
            txSample
              .db()
              .newQuery(
                "UPDATE price_samples_index SET search_eligible = 0, situacao_origem = 'SUPERSEDED' WHERE source = 'PNCP' AND server_trust_version = 'server-v1' AND search_contract = 'cotai-official-price-v3' AND source_record_id = {:identity} AND sample_key <> {:key}",
              )
              .bind({
                identity: a.source_record_id,
                key: key,
              })
              .execute()
          if (existente) {
            existente.set('source', a.source)
            existente.set('source_record_id', a.source_record_id)
            existente.set('purchase_id', a.purchase_id)
            existente.set('item_id', a.item_id)
            existente.set('descricao', a.descricao)
            existente.set('descricao_normalizada', descNorm)
            existente.set('orgao', a.orgao || 'Órgão Público')
            existente.set('orgao_cnpj', a.orgao_cnpj)
            existente.set('fornecedor_nome', a.fornecedor_nome || 'NÃO INFORMADO')
            existente.set('fornecedor_cnpj', a.fornecedor_cnpj || '')
            existente.set('fornecedor_porte', a.fornecedor_porte || 'DEMAIS')
            existente.set('uf', a.uf || '')
            existente.set('municipio', a.municipio || '')
            existente.set('unidade', a.unidade || 'UN')
            existente.set('quantidade', Number(a.quantidade) || 0)
            existente.set('valor_unitario', vUnit)
            existente.set('valor_total', Number(a.valor_total) || 0)
            existente.set('natureza_preco', a.natureza_preco || '')
            existente.set('data_referencia', a.data_referencia || '')
            existente.set('data_coleta', agora)
            existente.set('numero_processo', a.numero_processo || '')
            existente.set('numero_ata', a.numero_ata || '')
            existente.set('modalidade', a.modalidade || '')
            existente.set('situacao_contratacao', a.situacao_contratacao || '')
            existente.set('marca', a.marca || 'NÃO INFORMADO')
            existente.set('modelo', a.modelo || 'NÃO INFORMADO')
            existente.set('codigo_item', a.codigo_item || '')
            existente.set('url_original', a.url_original || '')
            existente.set('indexed_at', agora)
            existente.set('source_updated_at', a.source_updated_at || '')
            existente.set('last_validated_at', checkedAt)
            existente.set('payload_hash', pHash)
            existente.set('raw_payload', rawStr)
            existente.set('qualidade_situacao', qualidade)
            existente.set('motivos_rejeicao', JSON.stringify(motivos))
            existente.set('matching_score', a.matching_score || 100)
            existente.set('matching_tipo', a.matching_tipo || 'codigo_ou_texto')
            existente.set('vigencia_fim', a.vigencia_fim || '')
            existente.set('situacao_origem', '')
            existente.set('data_verificacao', checkedAt)
            existente.set('server_trust_version', 'server-v1')
            existente.set('search_contract', 'cotai-official-price-v3')
            existente.set('search_eligible', qualidade === 'rejeitada' ? 0 : 1)
            txSample.save(existente)
            pncpAccountPrice(
              txSample,
              accounting,
              a,
              qualidade === 'rejeitada' ? null : countKind,
              proofFresh.resultado_capturado_em,
            )
            sampleSaved = 2
          } else {
            // Rejeitadas sem preço válido não devem poluir a busca como válidas
            if (qualidade === 'rejeitada') {
              return
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
            rec.set('modalidade', a.modalidade || '')
            rec.set('situacao_contratacao', a.situacao_contratacao || '')
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
            rec.set('source_updated_at', a.source_updated_at || '')
            rec.set('last_validated_at', checkedAt)
            rec.set('data_verificacao', checkedAt)
            rec.set('vigencia_fim', a.vigencia_fim || '')
            rec.set('server_trust_version', 'server-v1')
            rec.set('search_contract', 'cotai-official-price-v3')
            rec.set('search_eligible', 1)
            txSample.save(rec)
            pncpAccountPrice(
              txSample,
              accounting,
              a,
              qualidade === 'rejeitada' ? null : countKind,
              proofFresh.resultado_capturado_em,
            )
            sampleSaved = 1
          }
        })
        if (sampleSaved === 1) inseridas++
        if (sampleSaved === 2) atualizadas++
      } catch (errRec) {
        console.log('[PRICE-WORKER] Erro ao gravar registro individual:', errRec.message)
        falhou = true
      }
    }
    return { inseridas: inseridas, atualizadas: atualizadas, excluidas: excluidas, falhou: falhou }
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
        typeof op.falhas !== 'number' ||
        !isFinite(op.falhas) ||
        Math.floor(op.falhas) !== op.falhas ||
        op.falhas < 0 ||
        op.falhas >= 4 ||
        op.quarentena ||
        (op.claim && Number(op.ate) > new Date().getTime()))
    )
      return false
    // Narrow compatibility admission only; fresh official proof is still mandatory.
    if (op && op.lastStatus === 'campos_compra_invalidos')
      return (
        p.r === 0 &&
        (p.b === undefined || p.b === 0) &&
        (p.i === undefined || p.i === 0) &&
        op.falhas === 0 &&
        p.numeroControlePNCP === origin.controle
      )
    if (
      op &&
      ['relacao_ausente', 'contrato_http', 'origem_nao_comprovada', 'adiado', 'resolvendo'].indexOf(
        op.lastStatus,
      ) < 0
    )
      return false
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
      if (rec && rec.getString('server_trust_version') !== 'server-v1') rec = null
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
    var before = task.getString('pendentes'),
      attempts = task.getInt('tentativas'),
      started = task.getString('started_at'),
      progress = task.getString('progress_at')
    var list = parseJsonWorkerSafe(before)
    if (!Array.isArray(list)) return
    // Optional DB admission slice only; admitted proof retains its existing source budget.
    var index = -1,
      checked = 0,
      skipped = []
    for (var i = 0; i < list.length; i++) {
      if (new Date().getTime() >= scanDeadline || checked >= 4) break
      if (!pncpLegacyCandidate(list[i])) continue
      checked++
      if (!pncpHasPriorWork($app, list[i], scanDeadline)) {
        index = i
        break
      }
      skipped.push({ index: i, json: JSON.stringify(list[i]) })
    }
    if (index < 0) {
      if (
        state === 'pending' &&
        skipped.length > 0 &&
        new Date().getTime() + 4080 <= fimTrabalhoRede
      )
        return {
          taskId: task.id,
          state: state,
          attempts: attempts,
          started: started,
          progress: progress,
          length: list.length,
          snapshot: list,
          skipped: skipped,
        }
      return
    }
    if (new Date().getTime() + 4080 > fimTrabalhoRede) return
    var old = list[index]
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
      "SELECT id FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND status = 'running' AND " +
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

  if (!modoHttp) {
    try {
      autonomousRetryTick()
      autonomousSourceTick()
    } catch (_) {}
    try {
      comprasAutonomousTick()
    } catch (_) {}
  }
  var tarefasSelecionadasNesteTick = []
  for (var taskTurn = 0; taskTurn < MAX_TAREFAS_POR_TICK; taskTurn++) {
    if (trabalhoAdiadoPorTempo || new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000) {
      break
    }

    var tarefaAdquirida = null,
      pncpRecoveryPlan = null
    try {
      // One recovery opportunity per tick, even while an older task keeps requeueing.
      // Remaining turns retain pending-first selection and the existing stale fallback.
      var tarefas = modoHttp ? [$app.findRecordById('price_index_tasks', tarefaIdHttp)] : []
      if (modoHttp && tarefas[0].getString('server_trust_version') !== 'server-v1') tarefas = []
      // This turn only implements PNCP, never certification of Compras completion.
      if (modoHttp) {
        var fonteHttp = (tarefas[0].getString('source') || 'AMBAS').toUpperCase()
        if (fonteHttp !== 'AMBAS' && fonteHttp.indexOf('PNCP') === -1) tarefas = []
      }
      if (!modoHttp && taskTurn === 0 && Math.floor(new Date().getTime() / 60000) % 2 === 0) {
        var reserved = arrayOf(new DynamicModel({ id: '' }))
        $app
          .db()
          .newQuery(
            "SELECT id FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND requested_by = '' AND source = 'PNCP' AND task_key LIKE 'system:autonomous-v1:PNCP:%' AND status = 'pending' ORDER BY COALESCE(julianday(finished_at),0), id LIMIT 1",
          )
          .all(reserved)
        if (reserved.length) tarefas = [$app.findRecordById('price_index_tasks', reserved[0].id)]
      }
      if (!modoHttp && taskTurn === 0 && tarefas.length === 0) {
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
        var sqlPendente =
          "SELECT id FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND status = 'pending'"
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
        pncpRecoveryPlan = pncpRecoverTask(tarefas[0])
        if (trabalhoAdiadoPorTempo || new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000)
          break
        $app.runInTransaction(function (txApp) {
          var tRec = txApp.findRecordById('price_index_tasks', tarefas[0].id)
          if (tRec.getString('server_trust_version') !== 'server-v1') return
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
          var rawPendentes = tRec.getString('pendentes')
          var parsedPendentes = []
          if (rawPendentes) {
            try {
              var pJson = JSON.parse(rawPendentes)
              if (Array.isArray(pJson)) parsedPendentes = pJson
            } catch (_) {}
          }
          if (
            pncpRecoveryPlan &&
            pncpRecoveryPlan.taskId === tRec.id &&
            tRec.getString('status') === pncpRecoveryPlan.state &&
            tRec.getInt('tentativas') === pncpRecoveryPlan.attempts &&
            tRec.getString('started_at') === pncpRecoveryPlan.started &&
            tRec.getString('progress_at') === pncpRecoveryPlan.progress
          ) {
            var podeRotacionar = parsedPendentes.length >= pncpRecoveryPlan.length
            for (var planoI = 0; podeRotacionar && planoI < pncpRecoveryPlan.length; planoI++) {
              if (new Date().getTime() >= fimTrabalhoRede) return
              podeRotacionar =
                JSON.stringify(parsedPendentes[planoI]) ===
                JSON.stringify(pncpRecoveryPlan.snapshot[planoI])
            }
            if (podeRotacionar) {
              var posicoesPuladas = {},
                chavesPuladas = {},
                movidos = []
              for (var skipI = 0; skipI < pncpRecoveryPlan.skipped.length; skipI++) {
                var skip = pncpRecoveryPlan.skipped[skipI]
                if (JSON.stringify(parsedPendentes[skip.index]) !== skip.json) {
                  podeRotacionar = false
                  break
                }
                var chavePulada = pncpPendingKey(parsedPendentes[skip.index])
                if (!chavePulada) {
                  podeRotacionar = false
                  break
                }
                posicoesPuladas[skip.index] = true
                chavesPuladas['$' + chavePulada] = true
                movidos.push(parsedPendentes[skip.index])
              }
              var ocorrenciasPuladas = {}
              for (var dupI = 0; podeRotacionar && dupI < parsedPendentes.length; dupI++) {
                if (new Date().getTime() >= fimTrabalhoRede) return
                var chaveAtualPulada = pncpPendingKey(parsedPendentes[dupI])
                if (!chavesPuladas['$' + chaveAtualPulada]) continue
                var chaveContagem = '$' + chaveAtualPulada
                ocorrenciasPuladas[chaveContagem] = (ocorrenciasPuladas[chaveContagem] || 0) + 1
                if (ocorrenciasPuladas[chaveContagem] > 1) podeRotacionar = false
              }
              if (podeRotacionar) {
                var mantidos = []
                for (var pendI = 0; pendI < parsedPendentes.length; pendI++)
                  if (!posicoesPuladas[pendI]) mantidos.push(parsedPendentes[pendI])
                parsedPendentes = mantidos.concat(movidos)
                rawPendentes = JSON.stringify(parsedPendentes)
                tRec.set('pendentes', rawPendentes)
              }
            }
          }
          if (new Date().getTime() >= fimTrabalhoRede) return
          var agoraIso = new Date().toISOString()
          var tenta = (parseInt(tRec.getString('tentativas'), 10) || 0) + 1
          tRec.set('status', 'running')
          tRec.set('started_at', agoraIso)
          tRec.set('progress_at', agoraIso)
          tRec.set('tentativas', tenta)
          txApp.save(tRec)

          tarefaAdquirida = {
            id: tRec.id,
            task_key: tRec.getString('task_key'),
            autonomous: !modoHttp && pncpSystemTask(tRec),
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

    var tarefaSistemaPncp = tarefaAdquirida.autonomous === true
    var fimRedeAntesTurno = fimTrabalhoRede
    if (tarefaSistemaPncp) fimTrabalhoRede = Math.min(fimTrabalhoRede, new Date().getTime() + 12000)
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
        rec.getString('server_trust_version') === 'server-v1' &&
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
    if (tarefaSistemaPncp) descobertaPncp.esgotados = { ata: true, edital: true, contrato: true }
    var contratacoesProcessadasNesteCiclo = 0

    // Etapa PNCP para a tarefa
    if (source === 'AMBAS' || source.indexOf('PNCP') !== -1) {
      var tokens = extractWorkerTokensUtil(termo)
      var tokenPrincipal = tokens.length > 0 ? tokens[0] : ''
      var tokenStem = stemWorkerTokenUtil(tokenPrincipal)

      function itemEhCompativelWorker(desc) {
        if (!desc) return false
        if (typeof tarefaSistemaPncp !== 'undefined' && tarefaSistemaPncp) return true
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
              numeroProcesso: pItem.numeroProcesso || '',
              codigoCatalogo: pItem.codigoCatalogo || '',
              materialOuServico: pItem.materialOuServico || '',
              modalidadeNome: pItem.modalidadeNome || '',
              situacaoCompraNome: pItem.situacaoCompraNome || '',
              source_updated_at: pItem.source_updated_at || '',
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
                numeroProcesso:
                  it.processo_origem ||
                  it.numeroProcesso ||
                  it.numero_processo ||
                  it.processo ||
                  '',
                codigoCatalogo: extrairCodigoItemWorker(it, it),
                materialOuServico: it.materialOuServico || it.tipoCatalogo || '',
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
                numeroProcesso: lo.numeroProcesso || '',
                codigoCatalogo: lo.codigoCatalogo || '',
                materialOuServico: lo.materialOuServico || '',
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
        var autonomousEpochC =
          (tarefaSistemaPncp &&
            cItemProcessando._pendente &&
            cItemProcessando._pendente.source_checked_at) ||
          ''
        if (autonomousEpochC)
          cacheKeyC +=
            '_autonomous_' +
            (cItemProcessando._pendente._autonomous_retry_cache
              ? /^[a-f0-9]{32}$/.test(String(cItemProcessando._pendente._autonomous_retry_cache))
                ? 'retry_' + cItemProcessando._pendente._autonomous_retry_cache
                : 'retry'
              : tarefaAdquirida.task_key.split(':').pop())
        if (
          autonomousEpochC &&
          /revogad|anulad|cancelad|suspens/i.test(cItemProcessando.situacaoCompraNome || '')
        ) {
          pncpInvalidateOfficial(
            cnpjC + '/' + anoC + '/' + seqC + '/itens/',
            autonomousEpochC,
            cItemProcessando,
          )
          continue
        }
        if (
          autonomousEpochC &&
          /^(divulgada(?: no pncp)?|publicada|homologada|em andamento)$/i.test(
            cItemProcessando.situacaoCompraNome || '',
          )
        )
          pncpObserveScope(
            $app,
            cnpjC + '/' + anoC + '/' + seqC + '/itens/',
            'active',
            autonomousEpochC,
            cItemProcessando,
          )
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
            numeroProcesso: cItemProcessando.numeroProcesso || '',
            codigoCatalogo: cItemProcessando.codigoCatalogo || '',
            materialOuServico: cItemProcessando.materialOuServico || '',
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
          if (cRec && cRec.getString('server_trust_version') !== 'server-v1') cRec = null
          if (
            cRec &&
            autonomousEpochC &&
            (parseJsonWorkerSafe(cRec.getString('raw_itens')) || {}).autonomous_epoch !==
              autonomousEpochC
          )
            cRec = null
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
                  var atualC =
                    rC && rC.getString('server_trust_version') === 'server-v1'
                      ? parseJsonWorkerSafe(rC.getString('raw_itens'))
                      : null
                  if (autonomousEpochC && (!atualC || atualC.autonomous_epoch !== autonomousEpochC))
                    atualC = null
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
                    trabalhoPaginaC = {
                      v: 1,
                      pagina: proximaPaginaC,
                      refs: refsTrabalhoC,
                      checked_at: new Date().toISOString(),
                    }
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
                  if (autonomousEpochC) cacheSalvoC.autonomous_epoch = autonomousEpochC
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
                  rC.set('server_trust_version', 'server-v1')
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
                  trabalhoPaginaC = {
                    v: 1,
                    pagina: proximaPaginaC,
                    refs: refsTrabalhoC,
                    checked_at: new Date().toISOString(),
                  }
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
          if (
            Number(itmObj.situacaoCompraItem) === 3 ||
            Number(itmObj.situacaoCompraItemId) === 3
          ) {
            var itemStatusChecked =
              (typeof trabalhoPaginaC !== 'undefined' &&
                trabalhoPaginaC &&
                trabalhoPaginaC.checked_at) ||
              (typeof autonomousEpochC !== 'undefined' && autonomousEpochC) ||
              ''
            if (itemStatusChecked)
              pncpInvalidateOfficial(
                cnpjC + '/' + anoC + '/' + seqC + '/itens/' + numItemInt + '/',
                itemStatusChecked,
                itmObj,
              )
            aposentarItemC(itmObj)
            continue
          }
          var itemActiveChecked =
            (typeof trabalhoPaginaC !== 'undefined' &&
              trabalhoPaginaC &&
              trabalhoPaginaC.checked_at) ||
            ''
          if (
            itemActiveChecked &&
            /^(homologado|em andamento)$/i.test(itmObj.situacaoCompraItemNome || '')
          )
            pncpObserveScope(
              $app,
              cnpjC + '/' + anoC + '/' + seqC + '/itens/' + numItemInt + '/',
              'active',
              itemActiveChecked,
              itmObj,
            )
          var houveCancelamentoC = false
          var campoFallbackC = ''
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
              campoFallbackC = camposUnitarios[campoIdx]
              break
            }
          }
          var valorFallbackC = campoFallbackC ? Number(itmObj[campoFallbackC]) : 0
          var naturezaFallbackC = /homologado/i.test(campoFallbackC) ? 'homologado' : 'estimado'
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
          var resultadoCapturadoEm = ''
          var resultadoReutilizado = false
          var fornecedorFallbackNomeC =
            (itmObj.fornecedor &&
              (itmObj.fornecedor.nomeRazaoSocialFornecedor || itmObj.fornecedor.nomeRazaoSocial)) ||
            'NÃO INFORMADO'
          var fornecedorFallbackCnpjC =
            (itmObj.fornecedor && (itmObj.fornecedor.niFornecedor || itmObj.fornecedor.cnpj)) ||
            'NÃO INFORMADO'
          var resultadosHomologadosC = []
          var identidadesResultadosC = {}
          var respostaResultadosConfirmadaC = false

          if (!urlItem) {
            aposentarItemC(itmObj)
            continue
          }
          if (urlItem) {
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
            if (typeof tarefaSistemaPncp !== 'undefined' && tarefaSistemaPncp) cacheResultado = null
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
                respostaResultadosConfirmadaC = true
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
                if (resIt.numeroItem != null && Number(resIt.numeroItem) !== numItemInt) continue
                if (
                  !cacheResultado &&
                  Number(resIt.situacaoCompraItemResultadoId) === 1 &&
                  /^\d+$/.test(String(resIt.sequencialResultado || '')) &&
                  !resIt.dataCancelamento
                )
                  pncpObserveScope(
                    $app,
                    cnpjC +
                      '/' +
                      anoC +
                      '/' +
                      seqC +
                      '/itens/' +
                      numItemInt +
                      '/resultados/' +
                      resIt.sequencialResultado +
                      '/',
                    'active',
                    resultadoCapturadoEm,
                    resIt,
                  )
                if (Number(resIt.situacaoCompraItemResultadoId) === 2 || resIt.dataCancelamento) {
                  houveCancelamentoC = true
                  if (!cacheResultado && /^\d+$/.test(String(resIt.sequencialResultado || '')))
                    pncpInvalidateOfficial(
                      cnpjC +
                        '/' +
                        anoC +
                        '/' +
                        seqC +
                        '/itens/' +
                        numItemInt +
                        '/resultados/' +
                        resIt.sequencialResultado +
                        '/',
                      resultadoCapturadoEm,
                      resIt,
                    )
                  continue
                }
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
                  var fornecedorResultadoC = String(
                    resIt.niFornecedor || resIt.cnpj || resIt.cpfCnpjFornecedor || '',
                  ).replace(/\D/g, '')
                  var sequencialResultadoC = String(resIt.sequencialResultado || '')
                  var numeroItemResultadoC = resIt.numeroItem || resIt.numero_item
                  if (
                    !fornecedorResultadoC ||
                    !/^\d+$/.test(sequencialResultadoC) ||
                    (numeroItemResultadoC != null && Number(numeroItemResultadoC) !== numItemInt)
                  )
                    continue
                  var identidadeResultadoC = sequencialResultadoC + '_' + fornecedorResultadoC
                  if (identidadesResultadosC[identidadeResultadoC]) continue
                  identidadesResultadosC[identidadeResultadoC] = true
                  resultadosHomologadosC.push({
                    registro: resIt,
                    campo: campoResultado,
                    valor: vR,
                    natureza: 'homologado',
                    url: urlRes,
                    fornecedor_nome:
                      resIt.nomeRazaoSocialFornecedor || resIt.nomeFornecedor || 'NÃO INFORMADO',
                    fornecedor_cnpj: fornecedorResultadoC,
                    sequencial_resultado: sequencialResultadoC,
                  })
                }
              }
            }
          }

          var qItem = Number(itmObj.quantidade) > 0 ? Number(itmObj.quantidade) : 0
          var candidatosPrecoC = resultadosHomologadosC
          if (
            candidatosPrecoC.length === 0 &&
            !houveCancelamentoC &&
            respostaResultadosConfirmadaC &&
            campoFallbackC &&
            isFinite(valorFallbackC) &&
            valorFallbackC > 0
          )
            candidatosPrecoC = [
              {
                registro: itmObj,
                campo: campoFallbackC,
                valor: valorFallbackC,
                natureza: naturezaFallbackC,
                url: urlItem,
                fornecedor_nome: fornecedorFallbackNomeC,
                fornecedor_cnpj: fornecedorFallbackCnpjC,
                sequencial_resultado: '',
              },
            ]

          if (!respostaResultadosConfirmadaC) break
          if (candidatosPrecoC.length === 0 || numItemInt <= 0) {
            aposentarItemC(itmObj)
            continue
          }

          var numControlePncp = cItemProcessando.numeroControlePNCP
          var urlOrig = 'https://pncp.gov.br/app/editais/' + cnpjC + '/' + anoC + '/' + seqC
          var amostrasDoItemC = []
          for (
            var candidatoPrecoIdxC = 0;
            candidatoPrecoIdxC < candidatosPrecoC.length;
            candidatoPrecoIdxC++
          ) {
            var candidatoPrecoC = candidatosPrecoC[candidatoPrecoIdxC]
            var registroPrecoC = candidatoPrecoC.registro
            var campoUnitarioC = candidatoPrecoC.campo
            var vUnitFinalC = Number(candidatoPrecoC.valor)
            var natC = candidatoPrecoC.natureza
            var forNomeC = candidatoPrecoC.fornecedor_nome || 'NÃO INFORMADO'
            var forCnpjC = candidatoPrecoC.fornecedor_cnpj || 'NÃO INFORMADO'
            var sequencialResultadoCandidatoC = candidatoPrecoC.sequencial_resultado || ''
            var fornecedorIdentidadeC = String(
              registroPrecoC.niFornecedor || forCnpjC || '',
            ).replace(/\D/g, '')
            var identidadeItemC =
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
                  (sequencialResultadoCandidatoC
                    ? '/resultados/' + sequencialResultadoCandidatoC
                    : '') +
                  (fornecedorIdentidadeC ? '/fornecedor/' + fornecedorIdentidadeC : '')
                : ''
            var identidadeProvaC = {
              cnpj: cnpjC,
              ano: anoC,
              sequencial: seqC,
              numeroItem: numItemInt,
            }
            if (sequencialResultadoCandidatoC) {
              identidadeProvaC.sequencialResultado = Number(sequencialResultadoCandidatoC)
              identidadeProvaC.fornecedor = fornecedorIdentidadeC
            }
            var amPncpC = {
              source: 'PNCP',
              source_record_id: identidadeItemC,
              purchase_id: identidadeItemC,
              item_id: String(numItemInt),
              descricao: dItem,
              descricao_normalizada: canonicalNormWorkerText(dItem),
              orgao:
                itmObj.orgao_comprador ||
                (itmObj.orgaoEntidade && itmObj.orgaoEntidade.razaoSocial) ||
                cItemProcessando.orgao,
              orgao_cnpj: cnpjC,
              fornecedor_nome: forNomeC,
              fornecedor_cnpj: forCnpjC,
              fornecedor_porte:
                forNomeC.indexOf('ME') !== -1 || forNomeC.indexOf('EPP') !== -1
                  ? 'ME_EPP'
                  : 'DEMAIS',
              uf:
                itmObj.uf ||
                (itmObj.unidadeOrgao && itmObj.unidadeOrgao.ufSigla) ||
                cItemProcessando.uf ||
                '',
              municipio:
                itmObj.municipio_nome ||
                itmObj.municipio ||
                (itmObj.unidadeOrgao && itmObj.unidadeOrgao.municipioNome) ||
                cItemProcessando.municipio ||
                '',
              unidade: extrairUnidadeQualificadaWorkerUtil(
                itmObj.unidadeMedida || itmObj.unidade,
                dItem,
              ),
              quantidade: qItem,
              valor_unitario: vUnitFinalC,
              valor_total: Number(
                registroPrecoC.valorTotalHomologado || registroPrecoC.valorTotal || 0,
              ),
              natureza_preco: natC,
              data_referencia: registroPrecoC.dataResultado || '',
              numero_processo:
                itmObj.processo_origem ||
                itmObj.numeroProcesso ||
                itmObj.numero_processo ||
                itmObj.processo ||
                cItemProcessando.numeroProcesso ||
                numControlePncp,
              numero_ata: '',
              modalidade: cItemProcessando.modalidadeNome || '',
              situacao_contratacao: cItemProcessando.situacaoCompraNome || '',
              source_updated_at:
                registroPrecoC.dataAtualizacao || cItemProcessando.source_updated_at || '',
              source_status_checked_at:
                typeof autonomousEpochC !== 'undefined' ? autonomousEpochC : '',
              marca: itmObj.marcaNome || 'NÃO INFORMADO',
              modelo: 'NÃO INFORMADO',
              codigo_item: extrairCodigoItemWorker(itmObj, cItemProcessando),
              url_original: urlOrig,
              matching_score: calcularDiceScoreWorker(tokens, extractWorkerTokensUtil(dItem)),
              matching_tipo: 'texto_normalizado',
              raw_payload: {
                compra_oficial: { dataAtualizacaoGlobal: cItemProcessando.source_updated_at || '' },
                relacao_documental:
                  cItemProcessando._pendente && cItemProcessando._pendente._pncp_compra,
                numeroControlePNCP: numControlePncp,
                numeroItem: numItemInt,
                tipo_documento: cItemProcessando._tipoDoc || 'ata',
                quantidade_informada: qItem > 0,
                proveniencia_preco: {
                  versao: 1,
                  status: 'verificada',
                  fonte: 'PNCP',
                  campo_unitario: campoUnitarioC,
                  valor_unitario: vUnitFinalC,
                  natureza: natC,
                  url_evidencia: candidatoPrecoC.url,
                  identidade: identidadeProvaC,
                  registro_oficial: registroPrecoC,
                  data_oficial: registroPrecoC.dataResultado || '',
                  campo_data: registroPrecoC.dataResultado ? 'dataResultado' : '',
                },
              },
            }
            if (resultadoCapturadoEm) {
              amPncpC.raw_payload.proveniencia_preco.resultado_capturado_em = resultadoCapturadoEm
              amPncpC.raw_payload.proveniencia_preco.resultado_reutilizado = resultadoReutilizado
            }
            amPncpC.sample_key = gerarSampleKeyUtil(amPncpC)
            amostrasDoItemC.push(amPncpC)
          }

          if (!colecaoAmostrasCiclo)
            colecaoAmostrasCiclo = $app.findCollectionByNameOrId('price_samples_index')
          var salvoItemC = persistirLoteAmostrasProgressivo(
            amostrasDoItemC,
            colecaoAmostrasCiclo,
            tarefaSistemaPncp
              ? {
                  task_id: tarefaAdquirida.id,
                  started_at: tarefaAdquirida.started_at,
                  tentativas: tarefaAdquirida.tentativas,
                  purchase: cItemProcessando._pendente,
                }
              : null,
          )
          amostrasInseridasTotal += salvoItemC.inseridas
          amostrasAtualizadasTotal += salvoItemC.atualizadas
          if (
            salvoItemC.falhou ||
            salvoItemC.inseridas + salvoItemC.atualizadas + (salvoItemC.excluidas || []).length <
              amostrasDoItemC.length
          ) {
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
            totalAmostrasHttp += salvoItemC.inseridas + salvoItemC.atualizadas
            for (
              var amostraHttpIdxC = 0;
              amostraHttpIdxC < amostrasDoItemC.length;
              amostraHttpIdxC++
            ) {
              var amPncp = amostrasDoItemC[amostraHttpIdxC]
              if ((salvoItemC.excluidas || []).indexOf(amPncp.sample_key) >= 0) continue
              if (amostrasHttp.length >= 50) break
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
          return pncpSchedulable(p)
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
          return pncpSchedulable(p)
        })
        var statusFinal = possuiTrabalhoAcionavel
          ? 'pending'
          : pendentesRestantes.length > 0
            ? 'failed'
            : 'completed'
        if (
          tarefaSistemaPncp &&
          tarefaAdquirida.task_key.indexOf(':retry:') !== -1 &&
          statusFinal === 'failed'
        ) {
          pendentesRestantes = pendentesRestantes.filter(function (p) {
            return !p._pncp_discovery
          })
          pendentesRestantes.forEach(function (p) {
            p._retry_count = (p._retry_count || 0) + 1
            // This retry already owns its versioned cache; only rearm its next attempt.
            p._autonomous_retry_at = new Date(
              Date.parse(agoraFinal) +
                Math.min(86400000, 1800000 * Math.pow(2, Math.min(p._retry_count, 5))),
            ).toISOString()
          })
          pendentesRestantes.unshift({
            _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } },
          })
        }
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
    if (tarefaSistemaPncp) {
      fimTrabalhoRede = fimRedeAntesTurno
      trabalhoAdiadoPorTempo = new Date().getTime() >= fimTrabalhoRede
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
      var tarefaHttpAutorizada
      try {
        tarefaHttpAutorizada = $app.findRecordById('price_index_tasks', tarefaIdHttp)
      } catch (_) {
        return e.json(404, { sucesso: false, error: 'TASK_NOT_FOUND' })
      }
      if (
        tarefaHttpAutorizada.getString('server_trust_version') !== 'server-v1' ||
        !tarefaHttpAutorizada.getString('requested_by') ||
        tarefaHttpAutorizada.getString('requested_by') !== String(e.auth.id)
      )
        return e.json(403, { sucesso: false, error: 'TASK_FORBIDDEN' })

      var nowRate = new Date()
      var cutoffRate = new Date(nowRate.getTime() - 60 * 1000).toISOString()
      var rateRows = arrayOf(new DynamicModel({ request_count: 0 }))
      try {
        $app
          .db()
          .newQuery(
            'INSERT INTO cotai_backend_rate_limits ' +
              '(user_id, route_key, window_started_at, request_count, updated_at) ' +
              "VALUES ({:user}, 'TASK_PROCESS', {:now}, 1, {:now}) " +
              'ON CONFLICT(user_id, route_key) DO UPDATE SET ' +
              'window_started_at = CASE WHEN julianday(cotai_backend_rate_limits.window_started_at) <= julianday({:cutoff}) THEN excluded.window_started_at ELSE cotai_backend_rate_limits.window_started_at END, ' +
              'request_count = CASE WHEN julianday(cotai_backend_rate_limits.window_started_at) <= julianday({:cutoff}) THEN 1 ELSE cotai_backend_rate_limits.request_count + 1 END, ' +
              'updated_at = excluded.updated_at ' +
              'WHERE julianday(cotai_backend_rate_limits.window_started_at) <= julianday({:cutoff}) OR cotai_backend_rate_limits.request_count < 30 ' +
              'RETURNING request_count',
          )
          .bind({
            user: String(e.auth.id),
            now: nowRate.toISOString(),
            cutoff: cutoffRate,
          })
          .all(rateRows)
      } catch (_) {
        return e.json(503, { sucesso: false, error: 'TASK_PROCESS_RATE_LIMIT_UNAVAILABLE' })
      }
      if (rateRows.length !== 1)
        return e.json(429, {
          sucesso: false,
          error: 'TASK_PROCESS_RATE_LIMITED',
          retry_after_seconds: 60,
        })
    }
    var tInicioCiclo = new Date().getTime()
    console.log('[PRICE-WORKER-CRON] Tick do cron disparado. Processando fila e watermarks...')
    var MAX_DURATION_MS = modoHttp ? 20000 : 48000
    var fimTrabalhoRede = tInicioCiclo + MAX_DURATION_MS - (modoHttp ? 5000 : 8000)
    var trabalhoAdiadoPorTempo = false
    var amostrasHttp = []
    var totalAmostrasHttp = 0

    // AUTONOMOUS_SOURCE_V1_BEGIN
    function pncpSystemTask(rec) {
      return (
        !!rec &&
        rec.getString('server_trust_version') === 'server-v1' &&
        !rec.getString('requested_by') &&
        rec.getString('source') === 'PNCP' &&
        /^system:autonomous-v1:PNCP:(publication|updates|retry:\d{14}:20\d{2}:\d{1,6}(?::[a-f0-9]{32})?)$/.test(
          rec.getString('task_key'),
        )
      )
    }
    function autonomousRetryTick() {
      if (modoHttp) return
      var due = arrayOf(new DynamicModel({ id: '' })),
        now = new Date().toISOString()
      $app
        .db()
        .newQuery(
          "SELECT id FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND requested_by = '' AND source = 'PNCP' AND task_key LIKE 'system:autonomous-v1:PNCP:retry:%' AND status = 'failed' AND json_valid(pendentes) AND julianday(json_extract(pendentes, '$[1]._autonomous_retry_at')) <= julianday({:now}) ORDER BY finished_at, id LIMIT 1",
        )
        .bind({ now: now })
        .all(due)
      if (!due.length) return
      $app.runInTransaction(function (tx) {
        var task = tx.findRecordById('price_index_tasks', due[0].id)
        if (!pncpSystemTask(task) || task.getString('status') !== 'failed') return
        var queue = JSON.parse(task.getString('pendentes') || '[]'),
          p = queue[1]
        if (
          queue.length !== 2 ||
          !queue[0]._pncp_discovery ||
          !p ||
          Date.parse(p._autonomous_retry_at) > Date.parse(now)
        )
          return
        p.r = 0
        task.set('pendentes', JSON.stringify(queue))
        task.set('status', 'pending')
        tx.save(task)
      })
    }
    function pncpMergeDependencies(a, b) {
      var result = [],
        seen = {}
      ;(a || []).concat(b || []).forEach(function (d) {
        if (
          !d ||
          (d.lane !== 'publication' && d.lane !== 'updates') ||
          !/^20\d{2}-\d{2}-\d{2}$/.test(d.date) ||
          typeof d.window !== 'string' ||
          d.window.length > 80
        )
          throw new Error('SOURCE_DEPENDENCY')
        if (
          d.daily_epoch != null &&
          (typeof d.daily_epoch !== 'string' || d.daily_epoch.length > 80)
        )
          throw new Error('SOURCE_DEPENDENCY')
        var key = d.lane + '|' + d.window + '|' + (d.daily_epoch || '')
        if (!seen[key]) {
          seen[key] = true
          var value = { lane: d.lane, date: d.date, window: d.window }
          if (d.daily_epoch) value.daily_epoch = d.daily_epoch
          result.push(value)
        }
      })
      if (result.length > 256) throw new Error('SOURCE_DEPENDENCY_CAPACITY')
      return result.sort(function (a, b) {
        return (a.lane + a.window).localeCompare(b.lane + b.window)
      })
    }
    function pncpRetryDependencyPending(lane, from, to, app) {
      var found = arrayOf(new DynamicModel({ id: '' }))
      ;(app || $app)
        .db()
        .newQuery(
          "SELECT t.id FROM price_index_tasks t WHERE t.server_trust_version='server-v1' AND t.requested_by='' AND t.task_key LIKE 'system:autonomous-v1:PNCP:retry:%' AND t.status != 'completed' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(t.pendentes) THEN t.pendentes ELSE '[]' END) p WHERE json_extract(p.value,'$._pncp_discovery') IS NULL AND (json_type(p.value,'$._source_dependencies') IS NULL OR EXISTS (SELECT 1 FROM json_each(p.value,'$._source_dependencies') d WHERE json_extract(d.value,'$.lane')={:lane} AND json_extract(d.value,'$.date') >= {:from} AND json_extract(d.value,'$.date') <= {:to}))) LIMIT 1",
        )
        .bind({ lane: lane, from: from, to: to })
        .all(found)
      return found.length > 0
    }
    function autonomousRead(rec) {
      var raw = rec.getString('detalhes')
      if (!raw || raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
      var state = JSON.parse(raw)
      if (
        state.version !== 1 ||
        state.source !== rec.getString('fonte') ||
        !state.lanes ||
        Array.isArray(state.lanes)
      )
        throw new Error('SOURCE_STATE_VERSION')
      return state
    }
    function autonomousDate(date, delta) {
      if (!/^20\d\d-\d\d-\d\d$/.test(date) || !isFinite(Date.parse(date + 'T00:00:00Z')))
        throw new Error('SOURCE_DATE')
      return new Date(Date.parse(date + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10)
    }
    function pncpDailyRun(app, target) {
      try {
        var next = autonomousDate(target, 1)
        if (autonomousDate(target, 0) !== target || target >= new Date().toISOString().slice(0, 10))
          return null
        var rec = app.findFirstRecordByData(
          'daily_sync_runs',
          'ciclo_id',
          'CICLO_AUTONOMOUS_V1_' + next,
        )
        var details = JSON.parse(rec.getString('detalhes') || '{}'),
          started = rec.getString('iniciado_em')
        if (
          details.version !== 1 ||
          details.contract !== 'autonomous-daily-v1' ||
          details.requested_through !== target ||
          !isFinite(Date.parse(started)) ||
          Date.parse(started) > new Date().getTime()
        )
          return null
        return {
          requested_through: target,
          started_at: started,
          epoch: target + '@' + new Date(started).toISOString(),
        }
      } catch (_) {
        return null
      }
    }
    function pncpCount(target, kind) {
      ;['checked_count', 'new_count', 'updated_count', 'unchanged_count', 'written_count'].forEach(
        function (k) {
          if (target[k] == null) target[k] = 0
          if (!Number.isSafeInteger(target[k]) || target[k] < 0) throw new Error('SOURCE_COUNT')
        },
      )
      target.checked_count++
      target[kind + '_count']++
      if (kind !== 'unchanged') target.written_count++
      if (
        !Number.isSafeInteger(target.checked_count) ||
        !Number.isSafeInteger(target.written_count)
      )
        throw new Error('SOURCE_COUNT')
    }
    function pncpMergeAccounting(state, current) {
      var keys = [
        'checked_count',
        'new_count',
        'updated_count',
        'unchanged_count',
        'written_count',
        'source_written_at',
      ]
      keys.forEach(function (k) {
        if (current[k] != null) state[k] = current[k]
      })
      Object.keys(current.lanes).forEach(function (name) {
        if (!state.lanes[name]) return
        keys.forEach(function (k) {
          if (current.lanes[name][k] != null) state.lanes[name][k] = current.lanes[name][k]
        })
      })
      if (
        state.daily_cycle &&
        current.daily_cycle &&
        state.daily_cycle.epoch === current.daily_cycle.epoch
      )
        keys.forEach(function (k) {
          if (current.daily_cycle[k] != null) state.daily_cycle[k] = current.daily_cycle[k]
        })
    }
    function pncpPriceCheckKind(app, sample, existing) {
      if (!existing) {
        var previous = app.findRecordsByFilter(
          'price_samples_index',
          "source = 'PNCP' && source_record_id = {:identity} && server_trust_version = 'server-v1'",
          '',
          1,
          0,
          { identity: sample.source_record_id },
        )
        return previous.length ? 'updated' : 'new'
      }
      var raw = parseJsonWorkerSafe(existing.getString('raw_payload')) || {},
        oldProof = raw.proveniencia_preco || {}
      if (
        pncpCanonical(oldProof.registro_oficial) !==
        pncpCanonical(sample.raw_payload.proveniencia_preco.registro_oficial)
      )
        return 'updated'
      var fields = [
        'descricao',
        'unidade',
        'natureza_preco',
        'data_referencia',
        'modalidade',
        'situacao_contratacao',
        'codigo_item',
        'vigencia_fim',
      ]
      for (var i = 0; i < fields.length; i++)
        if (
          existing.getString(fields[i]) !==
          String(sample[fields[i]] || (fields[i] === 'unidade' ? 'UN' : ''))
        )
          return 'updated'
      return Number(existing.getString('valor_unitario')) === Number(sample.valor_unitario) &&
        Number(existing.getString('quantidade')) === (Number(sample.quantidade) || 0) &&
        Number(existing.getString('valor_total')) === (Number(sample.valor_total) || 0) &&
        existing.getInt('search_eligible') === 1
        ? 'unchanged'
        : 'updated'
    }
    function pncpAccountPrice(app, accounting, sample, kind, checkedAt) {
      if (!accounting) return
      if (modoHttp) throw new Error('SOURCE_TASK_IDENTITY')
      var task = app.findRecordById('price_index_tasks', accounting.task_id)
      if (
        !pncpSystemTask(task) ||
        task.getString('status') !== 'running' ||
        task.getInt('tentativas') !== accounting.tentativas ||
        task.getString('started_at') !== accounting.started_at
      )
        throw new Error('SOURCE_TASK_LEASE')
      var purchase = accounting.purchase,
        found = null,
        queue = JSON.parse(task.getString('pendentes') || '[]')
      for (var qi = 0; qi < queue.length; qi++)
        if (
          queue[qi].c === purchase.c &&
          Number(queue[qi].a) === Number(purchase.a) &&
          Number(queue[qi].s) === Number(purchase.s)
        ) {
          found = queue[qi]
          break
        }
      var identity = sample.raw_payload.proveniencia_preco.identidade
      if (
        !found ||
        identity.cnpj !== found.c ||
        Number(identity.ano) !== Number(found.a) ||
        Number(identity.sequencial) !== Number(found.s)
      )
        throw new Error('SOURCE_TASK_IDENTITY')
      if (!kind) return
      var dependencies = pncpMergeDependencies(found._source_dependencies || [], []),
        rows = app.findRecordsByFilter(
          'price_watermarks',
          'fonte = {:source} && cursor_tipo = "autonomous-v1"',
          '',
          1,
          0,
          { source: 'PNCP' },
        )
      if (!rows.length) throw new Error('SOURCE_STATE_MISSING')
      var rec = rows[0],
        state = autonomousRead(rec),
        now = new Date().toISOString(),
        lanes = {},
        cycle = state.daily_cycle,
        daily = false
      pncpCount(state, kind)
      dependencies.forEach(function (d) {
        lanes[d.lane] = true
        if (
          cycle &&
          cycle.phase === 'active' &&
          d.daily_epoch === cycle.epoch &&
          d.lane === 'updates' &&
          d.date >= cycle.from &&
          d.date <= cycle.requested_through
        ) {
          if (
            !isFinite(Date.parse(checkedAt)) ||
            Date.parse(checkedAt) < Date.parse(cycle.started_at)
          )
            throw new Error('SOURCE_DAILY_PROOF')
          daily = true
        }
      })
      Object.keys(lanes).forEach(function (name) {
        if (!state.lanes[name]) throw new Error('SOURCE_LANE_MISSING')
        pncpCount(state.lanes[name], kind)
        if (kind !== 'unchanged') state.lanes[name].source_written_at = now
      })
      if (daily) pncpCount(cycle, kind)
      if (kind !== 'unchanged') state.source_written_at = now
      var json = JSON.stringify(state)
      if (json.length > 64000) throw new Error('SOURCE_STATE_SIZE')
      rec.set('detalhes', json)
      app.save(rec)
    }
    function pncpDailyAcknowledge(app, state, now) {
      var cycle = state.daily_cycle,
        lane = state.lanes.updates
      if (
        !cycle ||
        cycle.phase !== 'active' ||
        !lane ||
        lane.daily_epoch !== cycle.epoch ||
        !lane.complete ||
        lane.end !== cycle.requested_through ||
        !isFinite(Date.parse(cycle.source_checked_at)) ||
        !isFinite(Date.parse(cycle.first_checked_at)) ||
        Date.parse(cycle.first_checked_at) < Date.parse(cycle.started_at)
      )
        return
      var authority = pncpDailyRun(app, cycle.requested_through)
      if (!authority || authority.epoch !== cycle.epoch) return
      var primary = arrayOf(new DynamicModel({ id: '' }))
      app
        .db()
        .newQuery('SELECT id FROM price_index_tasks WHERE task_key = {:key} LIMIT 1')
        .bind({ key: 'system:autonomous-v1:PNCP:updates' })
        .all(primary)
      var task = primary.length ? app.findRecordById('price_index_tasks', primary[0].id) : null
      if (
        task &&
        (!pncpSystemTask(task) ||
          task.getString('status') !== 'completed' ||
          JSON.parse(task.getString('pendentes') || '[]').some(function (p) {
            return !p._pncp_discovery
          }))
      )
        return
      if (pncpRetryDependencyPending('updates', cycle.from, cycle.requested_through, app)) return
      var keys = ['checked_count', 'new_count', 'updated_count', 'unchanged_count']
      if (
        !keys.every(function (k) {
          return Number.isSafeInteger(cycle[k]) && cycle[k] >= 0
        }) ||
        cycle.checked_count !== cycle.new_count + cycle.updated_count + cycle.unchanged_count
      )
        throw new Error('SOURCE_COUNT')
      now = new Date().toISOString()
      state.daily_ack = {
        requested_through: cycle.requested_through,
        source_checked_at: cycle.source_checked_at,
        drained_at: now,
        checked_count: cycle.checked_count,
        new_count: cycle.new_count,
        updated_count: cycle.updated_count,
        unchanged_count: cycle.unchanged_count,
        coverage: 'recent_window',
      }
      lane.backlog = 0
      lane.quarantine_pending = false
      state.backlog = Object.keys(state.lanes).reduce(function (n, name) {
        return n + (state.lanes[name].backlog || 0)
      }, 0)
      lane.drained_at = now
      lane.last_drained_window = lane.last_admitted_window
      state.last_drained_at = now
      cycle.phase = 'complete'
    }

    function autonomousSourceTick() {
      // Leave the full 16.5s Compras slice and 12s consumer reservation intact.
      var deadline = Math.min(new Date().getTime() + 9500, fimTrabalhoRede - 28500)
      if (modoHttp || new Date().getTime() + 8000 > deadline) return null
      var rows = $app.findRecordsByFilter(
        'price_watermarks',
        'fonte = {:source} && cursor_tipo = "autonomous-v1"',
        '',
        1,
        0,
        { source: 'PNCP' },
      )
      if (!rows.length) return null // Only migration-controlled state is eligible.
      var state,
        claim,
        wmId = rows[0].id,
        now = new Date().toISOString(),
        retryMs = 60000
      function saveState(tx, rec, value) {
        var json = JSON.stringify(value)
        if (json.length > 64000) throw new Error('SOURCE_STATE_SIZE')
        rec.set('detalhes', json)
        tx.save(rec)
      }
      function checkpointDomain(release) {
        var saved
        $app.runInTransaction(function (tx) {
          var rec = tx.findRecordById('price_watermarks', wmId),
            current = autonomousRead(rec)
          if (
            !current.claim ||
            current.claim.token !== claim ||
            Date.parse(current.claim.expires_at) <= new Date().getTime()
          )
            throw new Error('SOURCE_LEASE_LOST')
          if (new Date().getTime() >= deadline)
            throw new Error('SOURCE_BUDGET')
            // Change only domain metadata; concurrent counters, daily intent and cursors survive.
          ;[
            'modalities',
            'modalities_checked_at',
            'domain_error',
            'domain_next_attempt_at',
          ].forEach(function (key) {
            current[key] = state[key]
          })
          if (release) current.claim = null
          saveState(tx, rec, current)
          if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
          saved = current
        })
        return saved
      }
      function fetchOfficial(url) {
        if (new Date().getTime() + 8000 > deadline) throw new Error('SOURCE_BUDGET')
        var res = $http.send({
          url: url,
          method: 'GET',
          timeout: 8,
          headers: { Accept: 'application/json' },
        })
        if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
        if (res && typeof res.then === 'function') throw new Error('UPSTREAM_RUNTIME')
        if (!res || (res.statusCode !== 200 && res.statusCode !== 204)) {
          var retry =
            res && res.headers && (res.headers['Retry-After'] || res.headers['retry-after'])
          if (Array.isArray(retry)) retry = retry[0]
          if (retry)
            retryMs = Math.max(
              retryMs,
              /^\d+$/.test(String(retry))
                ? Number(retry) * 1000
                : Date.parse(retry) - new Date().getTime(),
            )
          throw new Error('SOURCE_HTTP_' + (res ? res.statusCode : 0))
        }
        if (res.statusCode === 204) return null
        var body = res.json !== undefined ? res.json : res.raw
        if (typeof body === 'string') body = JSON.parse(body)
        if (!body || typeof body !== 'object' || typeof body.then === 'function')
          throw new Error('SOURCE_BODY')
        return body
      }
      try {
        $app.runInTransaction(function (tx) {
          var rec = tx.findRecordById('price_watermarks', wmId),
            s = autonomousRead(rec)
          if (s.claim && Date.parse(s.claim.expires_at) > Date.parse(now)) return
          if (Date.parse(s.next_attempt_at) > Date.parse(now)) return
          claim = $security.randomString(24)
          s.claim = { token: claim, expires_at: new Date(Date.parse(now) + 55000).toISOString() }
          s.last_attempt_at = now
          saveState(tx, rec, s)
          state = s
        })
        if (!claim) return null
        var yesterday = autonomousDate(now.slice(0, 10), -1),
          freshUpdates = !state.lanes.updates
        if (
          !state.daily_cycle ||
          (state.daily_cycle.phase === 'complete' &&
            state.requested_through > state.daily_cycle.requested_through)
        ) {
          var authority = pncpDailyRun($app, state.requested_through)
          if (
            authority &&
            (!state.daily_ack || state.daily_ack.requested_through !== authority.requested_through)
          )
            state.daily_cycle = Object.assign(authority, {
              phase: 'waiting',
              checked_count: 0,
              new_count: 0,
              updated_count: 0,
              unchanged_count: 0,
              written_count: 0,
            })
        }
        if (!state.lanes.publication)
          state.lanes.publication = { date: yesterday, modality: 0, page: 1 }
        if (!state.lanes.updates)
          state.lanes.updates = {
            date: autonomousDate(yesterday, -2),
            end: yesterday,
            modality: 0,
            page: 1,
          }
        var domainDue =
          !Array.isArray(state.modalities) ||
          !state.modalities.length ||
          now.slice(0, 10) !== String(state.modalities_checked_at || '').slice(0, 10)
        if (domainDue && !(Date.parse(state.domain_next_attempt_at) > Date.parse(now))) {
          try {
            var domain = fetchOfficial('https://pncp.gov.br/api/pncp/v1/modalidades')
            if (!Array.isArray(domain) || !domain.length || domain.length > 256)
              throw new Error('SOURCE_DOMAIN')
            var merged = {},
              domainValid = false
            ;(state.modalities || []).concat(domain).forEach(function (m) {
              var id = Number(m.id),
                name = m.nome || m.name || ''
              if (!Number.isSafeInteger(id) || id <= 0 || id > 100000 || typeof name !== 'string')
                throw new Error('SOURCE_DOMAIN_ID')
              merged[id] = { id: id, name: name.slice(0, 160) }
              domainValid = true
            })
            if (!domainValid) throw new Error('SOURCE_DOMAIN')
            // Append new IDs: don't shift an active modality cursor when the domain grows.
            var oldIds = (state.modalities || []).map(function (m) {
              return m.id
            })
            state.modalities = oldIds
              .map(function (id) {
                return merged[id]
              })
              .concat(
                Object.keys(merged)
                  .map(Number)
                  .sort(function (a, b) {
                    return a - b
                  })
                  .filter(function (id) {
                    return oldIds.indexOf(id) < 0
                  })
                  .map(function (id) {
                    return merged[id]
                  }),
              )
            state.modalities_checked_at = now
            state.domain_error = ''
            state.domain_next_attempt_at = ''
          } catch (domainError) {
            state.domain_error = String(domainError.message).slice(0, 160)
            state.domain_next_attempt_at = new Date(
              Date.parse(now) + Math.max(300000, retryMs),
            ).toISOString()
            if (!Array.isArray(state.modalities) || !state.modalities.length) throw domainError
          }
          // Persist a completed domain independently of a later feed response or timeout.
          // Slow refreshes get their own turn; cached history resumes on the next tick.
          if (new Date().getTime() + 8000 > deadline) return checkpointDomain(true)
          checkpointDomain(false)
        }
        if (!Array.isArray(state.modalities) || !state.modalities.length)
          throw new Error('SOURCE_DOMAIN_PENDING')
        var laneName = state.next_lane === 'updates' ? 'updates' : 'publication'
        state.next_lane = laneName === 'publication' ? 'updates' : 'publication'
        var lane = state.lanes[laneName],
          key = 'system:autonomous-v1:PNCP:' + laneName
        var task = null,
          pending = []
        try {
          task = $app.findFirstRecordByData('price_index_tasks', 'task_key', key)
        } catch (_) {}
        if (task && !pncpSystemTask(task)) throw new Error('SOURCE_TASK_IDENTITY')
        if (task)
          pending = JSON.parse(task.getString('pendentes') || '[]').filter(function (p) {
            return !p._pncp_discovery
          })
        if (!Array.isArray(pending) || pending.length > 100) throw new Error('SOURCE_QUEUE_SIZE')
        state.quarantine_pending =
          $app.findRecordsByFilter(
            'price_index_tasks',
            "task_key ~ {:retryPrefix} && server_trust_version = 'server-v1' && requested_by = '' && status != 'completed'",
            '',
            1,
            0,
            { retryPrefix: 'system:autonomous-v1:PNCP:retry:' },
          ).length > 0
        state.coverage_partial = state.quarantine_pending
        var spillCandidates = pending
          .filter(function (p) {
            return Number(p.r) >= 4
          })
          .slice(0, 10)
        lane.backlog = pending.length
        lane.quarantine_pending = pncpRetryDependencyPending(
          laneName,
          laneName === 'updates'
            ? lane.start || autonomousDate(lane.end || lane.date, -2)
            : String(lane.last_admitted_window || lane.date).slice(0, 10),
          laneName === 'updates'
            ? lane.end || lane.date
            : String(lane.last_admitted_window || lane.date).slice(0, 10),
        )
        if (
          task &&
          task.getString('status') === 'completed' &&
          !pending.length &&
          !lane.quarantine_pending
        ) {
          lane.drained_at = now
          if (lane.last_admitted_window) lane.last_drained_window = lane.last_admitted_window
          state.last_drained_at = now
          // Draining zero-price purchases is not a source-price write.
        }
        var laneDrained =
          !pending.length &&
          (!task || task.getString('status') === 'completed') &&
          !lane.quarantine_pending
        var daily = state.daily_cycle
        var startDaily =
          laneName === 'updates' &&
          daily &&
          daily.phase === 'waiting' &&
          laneDrained &&
          (freshUpdates || lane.complete)
        if (
          startDaily ||
          (laneName === 'updates' &&
            lane.complete &&
            laneDrained &&
            (!daily || daily.phase === 'complete') &&
            (!lane.end || lane.end < yesterday))
        ) {
          var endDate = startDaily ? daily.requested_through : yesterday
          lane.date = autonomousDate(lane.end && lane.end < endDate ? lane.end : endDate, -2)
          if (lane.date < '2021-04-01') lane.date = '2021-04-01'
          lane.end = endDate
          lane.start = lane.date
          lane.page = 1
          lane.modality = 0
          lane.complete = false
          lane.daily_epoch = startDaily ? daily.epoch : ''
          if (startDaily) {
            daily.phase = 'active'
            daily.from = lane.start
          }
        }
        var blocked =
          lane.complete ||
          pending.length - spillCandidates.length > 90 ||
          (task && task.getString('status') === 'running')
        var additions = [],
          body = null,
          url = '',
          admittedWindow = ''
        if (!blocked) {
          autonomousDate(lane.date, 0)
          if (
            lane.date < '2021-04-01' ||
            lane.date > yesterday ||
            !Number.isInteger(lane.page) ||
            lane.page < 1 ||
            !Number.isInteger(lane.modality) ||
            lane.modality < 0 ||
            lane.modality >= state.modalities.length
          )
            throw new Error('SOURCE_CURSOR')
          var modalityId = Number(state.modalities[lane.modality].id)
          if (!Number.isSafeInteger(modalityId) || modalityId < 1 || modalityId > 100000)
            throw new Error('SOURCE_MODALITY')
          url =
            'https://pncp.gov.br/api/consulta/v1/contratacoes/' +
            (laneName === 'publication' ? 'publicacao' : 'atualizacao') +
            '?dataInicial=' +
            lane.date.replace(/-/g, '') +
            '&dataFinal=' +
            lane.date.replace(/-/g, '') +
            '&codigoModalidadeContratacao=' +
            modalityId +
            '&pagina=' +
            lane.page +
            '&tamanhoPagina=10'
          // Metadata persistence or queue reads may have used the remaining request budget.
          // Yield before HTTP starts; this is not a failed official-source attempt.
          if (new Date().getTime() + 8000 > deadline) return checkpointDomain(true)
          body = fetchOfficial(url)
          if (
            body !== null &&
            (!Array.isArray(body.data) ||
              body.data.length > 10 ||
              Number(body.numeroPagina) !== lane.page ||
              !Number.isInteger(Number(body.totalPaginas)) ||
              Number(body.totalPaginas) < 0 ||
              (body.data.length && Number(body.totalPaginas) < lane.page) ||
              (!body.data.length && Number(body.totalPaginas) > 0))
          )
            throw new Error('SOURCE_PAGE')
          var entries = body ? body.data : []
          entries.forEach(function (entry) {
            var control =
              typeof entry.numeroControlePNCP === 'string' &&
              /^(\d{14})-1-(\d{6})\/(20\d{2})$/.exec(entry.numeroControlePNCP)
            if (
              !control ||
              !entry.orgaoEntidade ||
              entry.orgaoEntidade.cnpj !== control[1] ||
              Number(entry.anoCompra) !== Number(control[3]) ||
              Number(entry.sequencialCompra) !== Number(control[2]) ||
              Number(control[2]) < 1
            )
              throw new Error('SOURCE_PURCHASE_ID')
            additions.push({
              c: control[1],
              a: Number(control[3]),
              s: Number(control[2]),
              t: 'edital',
              r: 0,
              numeroControlePNCP: entry.numeroControlePNCP,
              o: String(entry.orgaoEntidade.razaoSocial || '').slice(0, 300),
              u: String((entry.unidadeOrgao && entry.unidadeOrgao.ufSigla) || '').slice(0, 2),
              m: String((entry.unidadeOrgao && entry.unidadeOrgao.municipioNome) || '').slice(
                0,
                160,
              ),
              numeroProcesso: String(entry.processo || '').slice(0, 160),
              modalidadeNome: String(
                entry.modalidadeNome || state.modalities[lane.modality].name || '',
              ).slice(0, 160),
              situacaoCompraNome: String(entry.situacaoCompraNome || '').slice(0, 160),
              situacaoCompraId: entry.situacaoCompraId,
              source_updated_at: String(
                entry.dataAtualizacaoGlobal || entry.dataAtualizacao || '',
              ).slice(0, 40),
              source_checked_at: now,
              _source_dependencies: [
                {
                  lane: laneName,
                  date: lane.date,
                  window: lane.date + ':' + modalityId + ':' + lane.page,
                  daily_epoch: laneName === 'updates' ? lane.daily_epoch || '' : '',
                },
              ],
            })
          })
          admittedWindow = lane.date + ':' + modalityId + ':' + lane.page
        }
        $app.runInTransaction(function (tx) {
          var rec = tx.findRecordById('price_watermarks', wmId),
            current = autonomousRead(rec)
          if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
          if (
            !current.claim ||
            current.claim.token !== claim ||
            Date.parse(current.claim.expires_at) <= new Date().getTime()
          )
            throw new Error('SOURCE_LEASE_LOST')
          pncpMergeAccounting(state, current)
          var queue = [],
            t = null
          if (task) {
            t = tx.findRecordById('price_index_tasks', task.id)
            if (!pncpSystemTask(t)) throw new Error('SOURCE_TASK_IDENTITY')
            queue = JSON.parse(t.getString('pendentes') || '[]').filter(function (p) {
              return !p._pncp_discovery
            })
          }
          if (t && t.getString('status') === 'running' && !blocked)
            throw new Error('SOURCE_TASK_RACE')
          if (t && t.getString('status') !== 'running') {
            var spilled = 0
            queue = queue.filter(function (p) {
              if (Number(p.r) < 4 || spilled >= 10) return true
              if (
                !/^\d{14}$/.test(String(p.c)) ||
                !/^20\d{2}$/.test(String(p.a)) ||
                !/^\d{1,6}$/.test(String(p.s))
              )
                throw new Error('SOURCE_RETRY_ID')
              var retryVersion = $security
                .sha256(
                  String(p.source_checked_at || '') +
                    '|' +
                    String(p.source_updated_at || '') +
                    '|' +
                    laneName +
                    '|' +
                    JSON.stringify({
                      dependencies: p._source_dependencies || [],
                      j: p.j || null,
                      i: p.i || 0,
                      b: p.b || 0,
                    }),
                )
                .slice(0, 32)
              var retryKey =
                  'system:autonomous-v1:PNCP:retry:' +
                  p.c +
                  ':' +
                  p.a +
                  ':' +
                  p.s +
                  ':' +
                  retryVersion,
                retryTask = null
              try {
                retryTask = tx.findFirstRecordByData('price_index_tasks', 'task_key', retryKey)
              } catch (_) {}
              if (retryTask && !pncpSystemTask(retryTask)) throw new Error('SOURCE_RETRY_IDENTITY')
              if (!retryTask || retryTask.getString('status') === 'completed') {
                if (!retryTask)
                  retryTask = new Record(tx.findCollectionByNameOrId('price_index_tasks'))
                var originalCache = null
                try {
                  originalCache = tx.findFirstRecordByData(
                    'pncp_item_cache',
                    'cache_key',
                    p.c + '_' + p.a + '_' + p.s + '_autonomous_' + laneName,
                  )
                } catch (_) {}
                if (
                  originalCache &&
                  originalCache.getString('server_trust_version') === 'server-v1'
                ) {
                  var retryCacheKey =
                      p.c + '_' + p.a + '_' + p.s + '_autonomous_retry_' + retryVersion,
                    retryCache = null
                  try {
                    retryCache = tx.findFirstRecordByData(
                      'pncp_item_cache',
                      'cache_key',
                      retryCacheKey,
                    )
                  } catch (_) {}
                  if (!retryCache)
                    retryCache = new Record(tx.findCollectionByNameOrId('pncp_item_cache'))
                  retryCache.set('cache_key', retryCacheKey)
                  retryCache.set('cnpj', p.c)
                  retryCache.set('ano', p.a)
                  retryCache.set('sequencial', p.s)
                  retryCache.set('raw_itens', originalCache.getString('raw_itens'))
                  retryCache.set('total_itens', originalCache.getInt('total_itens'))
                  retryCache.set('server_trust_version', 'server-v1')
                  tx.save(retryCache)
                }
                p._autonomous_retry_cache = retryVersion
                p._autonomous_retry_at = new Date(Date.parse(now) + 1800000).toISOString()
                p._retry_count = 0
                retryTask.set('task_key', retryKey)
                retryTask.set('source', 'PNCP')
                retryTask.set('requested_by', '')
                retryTask.set('server_trust_version', 'server-v1')
                retryTask.set('termo', 'Reconsulta oficial PNCP')
                retryTask.set('status', 'failed')
                retryTask.set('admitted_at', now)
                retryTask.set(
                  'pendentes',
                  JSON.stringify([
                    { _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } } },
                    p,
                  ]),
                )
                tx.save(retryTask)
              }
              // The reserved retry acknowledges this exact version/checkpoint/dependency set.
              spilled++
              return false
            })
            if (spilled) {
              lane.quarantined_total = (lane.quarantined_total || 0) + spilled
              state.quarantine_pending = true
              state.coverage_partial = true
              t.set(
                'pendentes',
                JSON.stringify(
                  [
                    { _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } } },
                  ].concat(queue),
                ),
              )
              t.set('status', queue.length ? 'pending' : 'completed')
              tx.save(t)
            }
          }
          if (!blocked) {
            additions.forEach(function (p) {
              var at = -1
              for (var qi = 0; qi < queue.length; qi++)
                if (
                  queue[qi].c === p.c &&
                  Number(queue[qi].a) === p.a &&
                  Number(queue[qi].s) === p.s
                ) {
                  at = qi
                  break
                }
              if (at < 0) queue.push(p)
              else {
                var dependencies = pncpMergeDependencies(
                  queue[at]._source_dependencies,
                  p._source_dependencies,
                )
                if (
                  p.source_updated_at &&
                  p.source_updated_at > (queue[at].source_updated_at || '')
                )
                  queue[at] = p
                queue[at]._source_dependencies = dependencies
              }
            })
            if (queue.length > 100 || JSON.stringify(queue).length > 160000)
              throw new Error('SOURCE_CAPACITY')
            if (queue.length) {
              if (!t) {
                t = new Record(tx.findCollectionByNameOrId('price_index_tasks'))
                t.set('task_key', key)
                t.set('source', 'PNCP')
                t.set('termo', 'Coleta oficial PNCP')
                t.set('requested_by', '')
                t.set('server_trust_version', 'server-v1')
                t.set('admitted_at', now)
              }
              t.set(
                'pendentes',
                JSON.stringify(
                  [
                    { _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } } },
                  ].concat(queue),
                ),
              )
              t.set('status', 'pending')
              tx.save(t)
            }
            lane.last_admitted_window = admittedWindow
            lane.pages_scanned = (lane.pages_scanned || 0) + 1
            lane.purchases_queued = (lane.purchases_queued || 0) + additions.length
            if (body && lane.page < Number(body.totalPaginas)) lane.page++
            else {
              lane.page = 1
              lane.modality++
              if (lane.modality >= state.modalities.length) {
                lane.modality = 0
                if (laneName === 'publication') {
                  if (lane.date === '2021-04-01') lane.complete = true
                  else lane.date = autonomousDate(lane.date, -1)
                } else if (lane.date >= lane.end) lane.complete = true
                else lane.date = autonomousDate(lane.date, 1)
              }
            }
            lane.last_error = ''
            state.source_checked_at = now
            lane.source_checked_at = now
            if (
              laneName === 'updates' &&
              state.daily_cycle &&
              state.daily_cycle.phase === 'active' &&
              lane.daily_epoch === state.daily_cycle.epoch
            ) {
              if (!state.daily_cycle.first_checked_at) state.daily_cycle.first_checked_at = now
              state.daily_cycle.source_checked_at = now
            }
          }
          lane.backlog = queue.length
          state.backlog = Object.keys(state.lanes).reduce(function (n, k) {
            return n + (state.lanes[k].backlog || 0)
          }, 0)
          if (
            current.requested_through &&
            (!state.requested_through || current.requested_through > state.requested_through)
          )
            state.requested_through = current.requested_through
          state.claim = null
          state.next_attempt_at = ''
          state.failures = 0
          state.last_error = ''
          rec.set('status', state.backlog ? 'running' : 'idle')
          rec.set('last_watermark_date', lane.date)
          rec.set('last_cursor_page', lane.page)
          rec.set('ultimo_erro', '')
          rec.set('tentativas_consecutivas_falha', 0)
          pncpDailyAcknowledge(tx, state, now)
          saveState(tx, rec, state)
          if (new Date().getTime() >= deadline) throw new Error('SOURCE_BUDGET')
        })
        return state
      } catch (err) {
        if (claim)
          try {
            $app.runInTransaction(function (tx) {
              var rec = tx.findRecordById('price_watermarks', wmId),
                s = autonomousRead(rec)
              if (!s.claim || s.claim.token !== claim) return
              s.claim = null
              s.failures = (s.failures || 0) + 1
              s.last_error = String(err.message || err).slice(0, 300)
              if (laneName === 'publication' || laneName === 'updates') {
                s.next_lane = laneName === 'publication' ? 'updates' : 'publication'
                if (s.lanes[laneName]) s.lanes[laneName].last_error = s.last_error
              }
              s.next_attempt_at = new Date(
                Date.parse(now) +
                  Math.min(
                    86400000,
                    Math.max(retryMs, 60000 * Math.pow(2, Math.min(s.failures - 1, 6))),
                  ),
              ).toISOString()
              rec.set('status', 'error')
              rec.set('ultimo_erro', s.last_error)
              rec.set('tentativas_consecutivas_falha', s.failures)
              saveState(tx, rec, s)
            })
          } catch (_) {}
        return null
      }
    }
    // AUTONOMOUS_SOURCE_V1_END

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
        u: String(
          entry.uf ||
            (entry.unidadeOrgao && entry.unidadeOrgao.ufSigla) ||
            (entry.municipio_uf ? entry.municipio_uf.split('-')[1] : '') ||
            '',
        ).trim(),
        m: String(
          entry.municipio_nome ||
            entry.municipio ||
            (entry.unidadeOrgao && entry.unidadeOrgao.municipioNome) ||
            '',
        ).trim(),
        numeroProcesso: String(
          entry.processo_origem ||
            entry.numeroProcesso ||
            entry.numero_processo ||
            entry.processo ||
            '',
        ).trim(),
        codigoCatalogo: extrairCodigoItemWorker(entry, entry),
        materialOuServico: String(entry.materialOuServico || entry.tipoCatalogo || ''),
        modalidadeNome: String(entry.modalidadeNome || entry.modalidade_nome || ''),
        situacaoCompraNome: String(entry.situacaoCompraNome || ''),
        source_updated_at: String(entry.dataAtualizacaoGlobal || entry.dataAtualizacao || ''),
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
    function pncpSchedulable(p) {
      // Recovery keeps the task pending; only fresh proof can admit ordinary purchase work.
      if (p.t === 'contrato' && !pncpVerifiedPurchase(p))
        return (
          pncpLegacyCandidate(p) &&
          !!p._pncp_relacao &&
          [
            'relacao_ausente',
            'contrato_http',
            'origem_nao_comprovada',
            'adiado',
            'campos_compra_invalidos',
          ].indexOf(p._pncp_relacao.lastStatus) >= 0
        )
      return pncpActionable(p)
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
        if (!resultEntry || typeof resultEntry !== 'object' || Array.isArray(resultEntry)) continue
        var resultItem = resultEntry.numeroItem || resultEntry.numero_item
        if (resultItem != null && Number(resultItem) !== identity.numeroItem) return null
      }
      return envelope
    }
    function pncpResultEnvelope(identity, item, url, body, captured) {
      var positive = pncpPositive(body)
      var entries = Array.isArray(body) ? body : body && (body.items || body.data || body.resultado)
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

    function extrairCodigoItemWorker(itmObj, parentObj) {
      itmObj = itmObj || {}
      parentObj = parentObj || {}
      function fromOwner(owner) {
        var candidates = [
          owner.codigo_catalogo,
          owner.codigoCatalogo,
          owner.catalogoCodigoItem,
          owner.codigoItem,
          owner.codigoMaterialOuServico,
        ]
        var kind = String(owner.materialOuServico || owner.tipoCatalogo || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
        for (var codeIndex = 0; codeIndex < candidates.length; codeIndex++) {
          var raw = String(candidates[codeIndex] || '').trim()
          var explicit = /\b(CATMAT|CATSER)\s*[:#-]?\s*(\d{4,8})\b/i.exec(raw)
          if (explicit) return explicit[1].toUpperCase() + ' ' + explicit[2]
          var numeric = /\b(\d{4,8})\b/.exec(raw)
          if (!numeric) continue
          if (kind === 'S' || kind.indexOf('SERVIC') !== -1) return 'CATSER ' + numeric[1]
          if (kind === 'M' || kind.indexOf('MATERIAL') !== -1) return 'CATMAT ' + numeric[1]
        }
        return ''
      }
      var itemCode = fromOwner(itmObj)
      if (itemCode) return itemCode
      var parentCode = fromOwner(parentObj)
      if (parentCode) return parentCode
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
      if (typeof sleep === 'function') {
        sleep(ms)
        return
      }
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
          if (res && typeof res.then === 'function') return { ok: false, error: 'UPSTREAM_RUNTIME' }
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

    function validarESelarAmostraPncpWorker(a) {
      if (!a || a.source !== 'PNCP') return null
      var value = Number(a.valor_unitario)
      if (!isFinite(value) || value <= 0) return null
      if (
        typeof a.source_record_id !== 'string' ||
        !a.source_record_id ||
        a.purchase_id !== a.source_record_id ||
        typeof a.item_id !== 'string' ||
        !a.item_id ||
        typeof a.descricao !== 'string' ||
        !a.descricao.trim() ||
        typeof a.descricao_normalizada !== 'string' ||
        !a.descricao_normalizada.trim() ||
        a.sample_key !== gerarSampleKeyUtil(a)
      )
        return null
      var details = a.raw_payload
      if (typeof details === 'string') {
        try {
          details = JSON.parse(details)
        } catch (_) {
          return null
        }
      }
      var proof = details && details.proveniencia_preco
      var raw = proof && proof.registro_oficial
      var identity = proof && proof.identidade
      if (
        !proof ||
        proof.versao !== 1 ||
        proof.status !== 'verificada' ||
        proof.fonte !== 'PNCP' ||
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        !identity ||
        raw.isDemo === true ||
        raw.is_demo === true ||
        Number(raw.situacaoCompraItemResultadoId) === 2 ||
        Number(raw.situacaoCompraItem) === 3 ||
        Number(raw.situacaoCompraItemId) === 3 ||
        !!raw.dataCancelamento
      )
        return null
      var allowedFields = [
        'valorUnitarioHomologado',
        'valor_unitario_homologado',
        'valorUnitarioEstimado',
        'valor_unitario_estimado',
        'valorUnitario',
        'valor_unitario',
      ]
      if (
        allowedFields.indexOf(proof.campo_unitario) < 0 ||
        !isFinite(Number(raw[proof.campo_unitario])) ||
        Number(raw[proof.campo_unitario]) <= 0 ||
        Number(raw[proof.campo_unitario]) !== value ||
        !isFinite(Number(proof.valor_unitario)) ||
        Number(proof.valor_unitario) !== value
      )
        return null
      var nature = proof.natureza === 'contratado' ? 'homologado' : proof.natureza
      if (
        (nature !== 'homologado' && nature !== 'estimado') ||
        a.natureza_preco !== nature ||
        (/estimado/i.test(proof.campo_unitario) && nature !== 'estimado') ||
        (/homologado/i.test(proof.campo_unitario) && nature !== 'homologado')
      )
        return null
      if (String(details.numeroItem || '1') !== a.item_id) return null
      var cnpj = String(identity.cnpj || '')
      var year = String(identity.ano || '')
      var sequence = String(identity.sequencial || '')
      var item = String(identity.numeroItem || '')
      if (
        !/^\d{14}$/.test(cnpj) ||
        !/^\d{4}$/.test(year) ||
        !/^\d+$/.test(sequence) ||
        Number(sequence) <= 0 ||
        !/^\d+$/.test(item) ||
        Number(item) <= 0 ||
        item !== a.item_id ||
        String(a.orgao_cnpj || '') !== cnpj
      )
        return null
      var purchase = cnpj + '/' + year + '/' + sequence
      var evidence =
        'https://pncp.gov.br/api/pncp/v1/orgaos/' +
        cnpj +
        '/compras/' +
        year +
        '/' +
        sequence +
        '/itens/' +
        item
      if (
        a.url_original !== 'https://pncp.gov.br/app/editais/' + purchase ||
        (proof.url_evidencia !== evidence && proof.url_evidencia !== evidence + '/resultados')
      )
        return null
      var supplier = String(raw.niFornecedor || a.fornecedor_cnpj || '').replace(/\D/g, '')
      var expectedId =
        purchase +
        '/itens/' +
        item +
        (raw.sequencialResultado ? '/resultados/' + raw.sequencialResultado : '') +
        (supplier ? '/fornecedor/' + supplier : '')
      if (
        a.source_record_id !== expectedId ||
        (raw.numeroItem != null && String(raw.numeroItem) !== a.item_id)
      )
        return null
      if (proof.data_oficial || proof.campo_data || a.data_referencia) {
        if (
          proof.campo_data !== 'dataResultado' ||
          !proof.data_oficial ||
          String(raw.dataResultado || '') !== String(proof.data_oficial) ||
          String(a.data_referencia || '') !== String(proof.data_oficial) ||
          !isFinite(Date.parse(proof.data_oficial))
        )
          return null
      }
      if (typeof $security === 'undefined' || !$security || typeof $security.sha256 !== 'function')
        return null
      var contract = 'cotai-official-price-v3'
      var parts = [contract, a.source, a.sample_key, a.source_record_id]
      var material = []
      for (var p = 0; p < parts.length; p++) {
        var part = String(parts[p])
        material.push(part.length + ':' + part)
      }
      var signature = $security.sha256(material.join('|'))
      if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return null
      var seal = {
        contrato: 'cotai-official-price-v3',
        fonte: a.source,
        sample_key: a.sample_key,
        source_record_id: a.source_record_id,
        assinatura: signature.toLowerCase(),
      }
      details = Object.assign({}, details)
      proof = Object.assign({}, proof)
      // Any marker returned by a remote source is non-authoritative.
      proof.validacao_indice = seal
      details.proveniencia_preco = proof
      return { raw_payload: details, payload_hash: seal.assinatura }
    }

    function pncpOfficialUpdatedAt(raw) {
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw)
        } catch (_) {
          return ''
        }
      }
      var official = raw && raw.proveniencia_preco && raw.proveniencia_preco.registro_oficial
      var date =
        (official && (official.dataAtualizacaoGlobal || official.dataAtualizacao)) ||
        (raw && raw.compra_oficial && raw.compra_oficial.dataAtualizacaoGlobal) ||
        ''
      return typeof date === 'string' && isFinite(Date.parse(date)) ? date : ''
    }
    function pncpNewerOfficial(app, identity, date) {
      if (!date) return false
      var found = arrayOf(new DynamicModel({ source_record_id: '' }))
      app
        .db()
        .newQuery(
          "SELECT source_record_id FROM price_samples_index WHERE source='PNCP' AND source_record_id={:identity} AND server_trust_version='server-v1' AND CASE WHEN json_valid(raw_payload) THEN julianday(COALESCE(NULLIF(json_extract(raw_payload,'$.proveniencia_preco.registro_oficial.dataAtualizacaoGlobal'),''),NULLIF(json_extract(raw_payload,'$.proveniencia_preco.registro_oficial.dataAtualizacao'),''),json_extract(raw_payload,'$.compra_oficial.dataAtualizacaoGlobal'))) ELSE NULL END > julianday({:sourceDate}) LIMIT 1",
        )
        .bind({ identity: identity, sourceDate: date })
        .all(found)
      return found.length > 0
    }
    function pncpScopeBlocked(app, identity, verifiedAt) {
      var m =
        /^(\d{14}\/20\d{2}\/\d+\/itens\/)(\d+)(?:\/resultados\/(\d+))?(?:\/fornecedor\/\d+)?$/.exec(
          String(identity),
        )
      if (!m) return true
      var found = arrayOf(new DynamicModel({ scope: '' }))
      app
        .db()
        .newQuery(
          "SELECT scope FROM cotai_pncp_scope_state WHERE scope IN ({:purchase},{:item},{:result}) AND cancelled_at != '' AND (julianday(active_at) IS NULL OR julianday(active_at) <= julianday(cancelled_at) OR julianday({:verified}) IS NULL OR julianday({:verified}) <= julianday(cancelled_at)) LIMIT 1",
        )
        .bind({
          purchase: m[1],
          item: m[1] + m[2] + '/',
          result: m[3] ? m[1] + m[2] + '/resultados/' + m[3] + '/' : '',
          verified: verifiedAt || '',
        })
        .all(found)
      return found.length > 0
    }
    function pncpObserveScope(app, prefix, status, checked, official) {
      if (
        !/^\d{14}\/20\d{2}\/\d+\/itens\/(?:\d+\/(?:resultados\/\d+\/)?)?$/.test(prefix) ||
        !isFinite(Date.parse(checked)) ||
        (status !== 'cancelled' && status !== 'active')
      )
        throw new Error('PNCP_SCOPE_OBSERVATION')
      var evidence = { scope: prefix, status: status, checked_at: checked, record: {} }
      ;[
        'situacaoCompraNome',
        'situacaoCompraId',
        'situacaoCompraItem',
        'situacaoCompraItemId',
        'situacaoCompraItemNome',
        'situacaoCompraItemResultadoId',
        'dataCancelamento',
        'motivoCancelamento',
        'dataAtualizacao',
        'dataAtualizacaoGlobal',
        'source_updated_at',
        'numeroItem',
        'sequencialResultado',
      ].forEach(function (k) {
        var v = official && official[k]
        if (typeof v === 'string') evidence.record[k] = v.slice(0, 1000)
        else if (typeof v === 'number') evidence.record[k] = v
      })
      var field = status === 'cancelled' ? 'cancelled_at' : 'active_at',
        proof = status === 'cancelled' ? 'cancellation_evidence' : 'active_evidence'
      app
        .db()
        .newQuery(
          'INSERT INTO cotai_pncp_scope_state(scope,' +
            field +
            ',' +
            proof +
            ') VALUES({:scope},{:checked},{:evidence}) ON CONFLICT(scope) DO UPDATE SET ' +
            field +
            '=excluded.' +
            field +
            ',' +
            proof +
            '=excluded.' +
            proof +
            ' WHERE julianday(excluded.' +
            field +
            ') > COALESCE(julianday(cotai_pncp_scope_state.' +
            field +
            '),0)',
        )
        .bind({ scope: prefix, checked: checked, evidence: JSON.stringify(evidence) })
        .execute()
    }
    function pncpInvalidateOfficial(prefix, checked, official) {
      if (
        !/^\d{14}\/20\d{2}\/\d+\/itens\/(?:\d+\/(?:resultados\/\d+\/)?)?$/.test(prefix) ||
        !isFinite(Date.parse(checked))
      )
        throw new Error('PNCP_INVALIDATION_ID')
      $app.runInTransaction(function (tx) {
        pncpObserveScope(tx, prefix, 'cancelled', checked, official)
        tx.db()
          .newQuery(
            "UPDATE price_samples_index SET search_eligible = 0, situacao_origem = 'SOURCE_CANCELLED', data_verificacao = {:checked}, last_validated_at = {:checked}, qualidade_situacao = 'rejeitada', motivos_rejeicao = '[\"SOURCE_CANCELLED\"]' WHERE source = 'PNCP' AND server_trust_version = 'server-v1' AND search_contract = 'cotai-official-price-v3' AND (source_record_id = {:exact} OR (source_record_id >= {:prefix} AND source_record_id < {:upper} AND substr(source_record_id,1,length({:prefix})) = {:prefix})) AND NOT EXISTS (SELECT 1 FROM cotai_pncp_scope_state WHERE scope={:prefix} AND julianday(active_at)>julianday({:checked})) AND (last_validated_at = '' OR julianday(last_validated_at) <= julianday({:checked}))",
          )
          .bind({
            prefix: prefix,
            exact: prefix.slice(0, -1),
            upper: prefix + '~',
            checked: checked,
          })
          .execute()
      })
    }

    // Persistência progressiva com campos de auditoria, qualidade, hash e situação
    function persistirLoteAmostrasProgressivo(amostras, colecaoAmostras, accounting) {
      if (!amostras || amostras.length === 0) return { inseridas: 0, atualizadas: 0 }
      var inseridas = 0
      var atualizadas = 0
      var excluidas = []
      var falhou = false
      var agora = new Date().toISOString()
      var col = colecaoAmostras || $app.findCollectionByNameOrId('price_samples_index')

      for (var i = 0; i < amostras.length; i++) {
        var a = amostras[i]
        var estrita = validarESelarAmostraPncpWorker(a)
        if (!estrita) continue
        a.raw_payload = estrita.raw_payload
        var proofFresh = a.raw_payload.proveniencia_preco
        a.source_updated_at = pncpOfficialUpdatedAt(a.raw_payload)
        var checkedAt = proofFresh.resultado_capturado_em || agora
        var freshlyFetched =
          proofFresh.resultado_reutilizado === false &&
          isFinite(Date.parse(proofFresh.resultado_capturado_em))
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
        var pHash = estrita.payload_hash

        var sampleSaved = 0
        try {
          $app.runInTransaction(function (txSample) {
            var existente = null
            try {
              existente = txSample.findFirstRecordByData('price_samples_index', 'sample_key', key)
            } catch (_) {
              existente = null
            }

            if (pncpNewerOfficial(txSample, a.source_record_id, a.source_updated_at)) {
              excluidas.push(key)
              return
            }

            if (pncpScopeBlocked(txSample, a.source_record_id, freshlyFetched ? checkedAt : '')) {
              excluidas.push(key)
              return
            }

            var cancelled = txSample.findRecordsByFilter(
              'price_samples_index',
              "source = 'PNCP' && source_record_id = {:identity} && server_trust_version = 'server-v1' && situacao_origem = 'SOURCE_CANCELLED'",
              '-data_verificacao',
              1,
              0,
              { identity: a.source_record_id },
            )
            var canRestore =
              freshlyFetched &&
              a.source_status_checked_at &&
              a.situacao_contratacao &&
              !/revogad|anulad|cancelad|suspens/i.test(a.situacao_contratacao) &&
              (!cancelled.length ||
                Date.parse(a.source_status_checked_at) >
                  Date.parse(cancelled[0].getString('data_verificacao')))
            if (
              (cancelled.length && !canRestore) ||
              (existente &&
                existente.getString('situacao_origem') === 'SUPERSEDED' &&
                !freshlyFetched)
            ) {
              excluidas.push(key)
              return
            }
            var countKind = accounting ? pncpPriceCheckKind(txSample, a, existente) : 'updated'
            if (freshlyFetched)
              txSample
                .db()
                .newQuery(
                  "UPDATE price_samples_index SET search_eligible = 0, situacao_origem = 'SUPERSEDED' WHERE source = 'PNCP' AND server_trust_version = 'server-v1' AND search_contract = 'cotai-official-price-v3' AND source_record_id = {:identity} AND sample_key <> {:key}",
                )
                .bind({
                  identity: a.source_record_id,
                  key: key,
                })
                .execute()
            if (existente) {
              existente.set('source', a.source)
              existente.set('source_record_id', a.source_record_id)
              existente.set('purchase_id', a.purchase_id)
              existente.set('item_id', a.item_id)
              existente.set('descricao', a.descricao)
              existente.set('descricao_normalizada', descNorm)
              existente.set('orgao', a.orgao || 'Órgão Público')
              existente.set('orgao_cnpj', a.orgao_cnpj)
              existente.set('fornecedor_nome', a.fornecedor_nome || 'NÃO INFORMADO')
              existente.set('fornecedor_cnpj', a.fornecedor_cnpj || '')
              existente.set('fornecedor_porte', a.fornecedor_porte || 'DEMAIS')
              existente.set('uf', a.uf || '')
              existente.set('municipio', a.municipio || '')
              existente.set('unidade', a.unidade || 'UN')
              existente.set('quantidade', Number(a.quantidade) || 0)
              existente.set('valor_unitario', vUnit)
              existente.set('valor_total', Number(a.valor_total) || 0)
              existente.set('natureza_preco', a.natureza_preco || '')
              existente.set('data_referencia', a.data_referencia || '')
              existente.set('data_coleta', agora)
              existente.set('numero_processo', a.numero_processo || '')
              existente.set('numero_ata', a.numero_ata || '')
              existente.set('modalidade', a.modalidade || '')
              existente.set('situacao_contratacao', a.situacao_contratacao || '')
              existente.set('marca', a.marca || 'NÃO INFORMADO')
              existente.set('modelo', a.modelo || 'NÃO INFORMADO')
              existente.set('codigo_item', a.codigo_item || '')
              existente.set('url_original', a.url_original || '')
              existente.set('indexed_at', agora)
              existente.set('source_updated_at', a.source_updated_at || '')
              existente.set('last_validated_at', checkedAt)
              existente.set('payload_hash', pHash)
              existente.set('raw_payload', rawStr)
              existente.set('qualidade_situacao', qualidade)
              existente.set('motivos_rejeicao', JSON.stringify(motivos))
              existente.set('matching_score', a.matching_score || 100)
              existente.set('matching_tipo', a.matching_tipo || 'codigo_ou_texto')
              existente.set('vigencia_fim', a.vigencia_fim || '')
              existente.set('situacao_origem', '')
              existente.set('data_verificacao', checkedAt)
              existente.set('server_trust_version', 'server-v1')
              existente.set('search_contract', 'cotai-official-price-v3')
              existente.set('search_eligible', qualidade === 'rejeitada' ? 0 : 1)
              txSample.save(existente)
              pncpAccountPrice(
                txSample,
                accounting,
                a,
                qualidade === 'rejeitada' ? null : countKind,
                proofFresh.resultado_capturado_em,
              )
              sampleSaved = 2
            } else {
              // Rejeitadas sem preço válido não devem poluir a busca como válidas
              if (qualidade === 'rejeitada') {
                return
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
              rec.set('modalidade', a.modalidade || '')
              rec.set('situacao_contratacao', a.situacao_contratacao || '')
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
              rec.set('source_updated_at', a.source_updated_at || '')
              rec.set('last_validated_at', checkedAt)
              rec.set('data_verificacao', checkedAt)
              rec.set('vigencia_fim', a.vigencia_fim || '')
              rec.set('server_trust_version', 'server-v1')
              rec.set('search_contract', 'cotai-official-price-v3')
              rec.set('search_eligible', 1)
              txSample.save(rec)
              pncpAccountPrice(
                txSample,
                accounting,
                a,
                qualidade === 'rejeitada' ? null : countKind,
                proofFresh.resultado_capturado_em,
              )
              sampleSaved = 1
            }
          })
          if (sampleSaved === 1) inseridas++
          if (sampleSaved === 2) atualizadas++
        } catch (errRec) {
          console.log('[PRICE-WORKER] Erro ao gravar registro individual:', errRec.message)
          falhou = true
        }
      }
      return {
        inseridas: inseridas,
        atualizadas: atualizadas,
        excluidas: excluidas,
        falhou: falhou,
      }
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
          typeof op.falhas !== 'number' ||
          !isFinite(op.falhas) ||
          Math.floor(op.falhas) !== op.falhas ||
          op.falhas < 0 ||
          op.falhas >= 4 ||
          op.quarentena ||
          (op.claim && Number(op.ate) > new Date().getTime()))
      )
        return false
      // Narrow compatibility admission only; fresh official proof is still mandatory.
      if (op && op.lastStatus === 'campos_compra_invalidos')
        return (
          p.r === 0 &&
          (p.b === undefined || p.b === 0) &&
          (p.i === undefined || p.i === 0) &&
          op.falhas === 0 &&
          p.numeroControlePNCP === origin.controle
        )
      if (
        op &&
        [
          'relacao_ausente',
          'contrato_http',
          'origem_nao_comprovada',
          'adiado',
          'resolvendo',
        ].indexOf(op.lastStatus) < 0
      )
        return false
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
        if (rec && rec.getString('server_trust_version') !== 'server-v1') rec = null
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
      var before = task.getString('pendentes'),
        attempts = task.getInt('tentativas'),
        started = task.getString('started_at'),
        progress = task.getString('progress_at')
      var list = parseJsonWorkerSafe(before)
      if (!Array.isArray(list)) return
      // Optional DB admission slice only; admitted proof retains its existing source budget.
      var index = -1,
        checked = 0,
        skipped = []
      for (var i = 0; i < list.length; i++) {
        if (new Date().getTime() >= scanDeadline || checked >= 4) break
        if (!pncpLegacyCandidate(list[i])) continue
        checked++
        if (!pncpHasPriorWork($app, list[i], scanDeadline)) {
          index = i
          break
        }
        skipped.push({ index: i, json: JSON.stringify(list[i]) })
      }
      if (index < 0) {
        if (
          state === 'pending' &&
          skipped.length > 0 &&
          new Date().getTime() + 4080 <= fimTrabalhoRede
        )
          return {
            taskId: task.id,
            state: state,
            attempts: attempts,
            started: started,
            progress: progress,
            length: list.length,
            snapshot: list,
            skipped: skipped,
          }
        return
      }
      if (new Date().getTime() + 4080 > fimTrabalhoRede) return
      var old = list[index]
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
        "SELECT id FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND status = 'running' AND " +
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

      var tarefaAdquirida = null,
        pncpRecoveryPlan = null
      try {
        // One recovery opportunity per tick, even while an older task keeps requeueing.
        // Remaining turns retain pending-first selection and the existing stale fallback.
        var tarefas = modoHttp ? [$app.findRecordById('price_index_tasks', tarefaIdHttp)] : []
        if (modoHttp && tarefas[0].getString('server_trust_version') !== 'server-v1') tarefas = []
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
          var sqlPendente =
            "SELECT id FROM price_index_tasks WHERE server_trust_version = 'server-v1' AND status = 'pending'"
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
          pncpRecoveryPlan = pncpRecoverTask(tarefas[0])
          if (
            trabalhoAdiadoPorTempo ||
            new Date().getTime() - tInicioCiclo > MAX_DURATION_MS - 10000
          )
            break
          $app.runInTransaction(function (txApp) {
            var tRec = txApp.findRecordById('price_index_tasks', tarefas[0].id)
            if (tRec.getString('server_trust_version') !== 'server-v1') return
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
            var rawPendentes = tRec.getString('pendentes')
            var parsedPendentes = []
            if (rawPendentes) {
              try {
                var pJson = JSON.parse(rawPendentes)
                if (Array.isArray(pJson)) parsedPendentes = pJson
              } catch (_) {}
            }
            if (
              pncpRecoveryPlan &&
              pncpRecoveryPlan.taskId === tRec.id &&
              tRec.getString('status') === pncpRecoveryPlan.state &&
              tRec.getInt('tentativas') === pncpRecoveryPlan.attempts &&
              tRec.getString('started_at') === pncpRecoveryPlan.started &&
              tRec.getString('progress_at') === pncpRecoveryPlan.progress
            ) {
              var podeRotacionar = parsedPendentes.length >= pncpRecoveryPlan.length
              for (var planoI = 0; podeRotacionar && planoI < pncpRecoveryPlan.length; planoI++) {
                if (new Date().getTime() >= fimTrabalhoRede) return
                podeRotacionar =
                  JSON.stringify(parsedPendentes[planoI]) ===
                  JSON.stringify(pncpRecoveryPlan.snapshot[planoI])
              }
              if (podeRotacionar) {
                var posicoesPuladas = {},
                  chavesPuladas = {},
                  movidos = []
                for (var skipI = 0; skipI < pncpRecoveryPlan.skipped.length; skipI++) {
                  var skip = pncpRecoveryPlan.skipped[skipI]
                  if (JSON.stringify(parsedPendentes[skip.index]) !== skip.json) {
                    podeRotacionar = false
                    break
                  }
                  var chavePulada = pncpPendingKey(parsedPendentes[skip.index])
                  if (!chavePulada) {
                    podeRotacionar = false
                    break
                  }
                  posicoesPuladas[skip.index] = true
                  chavesPuladas['$' + chavePulada] = true
                  movidos.push(parsedPendentes[skip.index])
                }
                var ocorrenciasPuladas = {}
                for (var dupI = 0; podeRotacionar && dupI < parsedPendentes.length; dupI++) {
                  if (new Date().getTime() >= fimTrabalhoRede) return
                  var chaveAtualPulada = pncpPendingKey(parsedPendentes[dupI])
                  if (!chavesPuladas['$' + chaveAtualPulada]) continue
                  var chaveContagem = '$' + chaveAtualPulada
                  ocorrenciasPuladas[chaveContagem] = (ocorrenciasPuladas[chaveContagem] || 0) + 1
                  if (ocorrenciasPuladas[chaveContagem] > 1) podeRotacionar = false
                }
                if (podeRotacionar) {
                  var mantidos = []
                  for (var pendI = 0; pendI < parsedPendentes.length; pendI++)
                    if (!posicoesPuladas[pendI]) mantidos.push(parsedPendentes[pendI])
                  parsedPendentes = mantidos.concat(movidos)
                  rawPendentes = JSON.stringify(parsedPendentes)
                  tRec.set('pendentes', rawPendentes)
                }
              }
            }
            if (new Date().getTime() >= fimTrabalhoRede) return
            var agoraIso = new Date().toISOString()
            var tenta = (parseInt(tRec.getString('tentativas'), 10) || 0) + 1
            tRec.set('status', 'running')
            tRec.set('started_at', agoraIso)
            tRec.set('progress_at', agoraIso)
            tRec.set('tentativas', tenta)
            txApp.save(tRec)

            tarefaAdquirida = {
              id: tRec.id,
              task_key: tRec.getString('task_key'),
              autonomous: !modoHttp && pncpSystemTask(tRec),
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

      var tarefaSistemaPncp = tarefaAdquirida.autonomous === true
      var fimRedeAntesTurno = fimTrabalhoRede
      if (tarefaSistemaPncp)
        fimTrabalhoRede = Math.min(fimTrabalhoRede, new Date().getTime() + 12000)
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
          rec.getString('server_trust_version') === 'server-v1' &&
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
      if (tarefaSistemaPncp) descobertaPncp.esgotados = { ata: true, edital: true, contrato: true }
      var contratacoesProcessadasNesteCiclo = 0

      // Etapa PNCP para a tarefa
      if (source === 'AMBAS' || source.indexOf('PNCP') !== -1) {
        var tokens = extractWorkerTokensUtil(termo)
        var tokenPrincipal = tokens.length > 0 ? tokens[0] : ''
        var tokenStem = stemWorkerTokenUtil(tokenPrincipal)

        function itemEhCompativelWorker(desc) {
          if (!desc) return false
          if (typeof tarefaSistemaPncp !== 'undefined' && tarefaSistemaPncp) return true
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
                numeroProcesso: pItem.numeroProcesso || '',
                codigoCatalogo: pItem.codigoCatalogo || '',
                materialOuServico: pItem.materialOuServico || '',
                modalidadeNome: pItem.modalidadeNome || '',
                situacaoCompraNome: pItem.situacaoCompraNome || '',
                source_updated_at: pItem.source_updated_at || '',
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
                  numeroProcesso:
                    it.processo_origem ||
                    it.numeroProcesso ||
                    it.numero_processo ||
                    it.processo ||
                    '',
                  codigoCatalogo: extrairCodigoItemWorker(it, it),
                  materialOuServico: it.materialOuServico || it.tipoCatalogo || '',
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
                  numeroProcesso: lo.numeroProcesso || '',
                  codigoCatalogo: lo.codigoCatalogo || '',
                  materialOuServico: lo.materialOuServico || '',
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
          var autonomousEpochC =
            (tarefaSistemaPncp &&
              cItemProcessando._pendente &&
              cItemProcessando._pendente.source_checked_at) ||
            ''
          if (autonomousEpochC)
            cacheKeyC +=
              '_autonomous_' +
              (cItemProcessando._pendente._autonomous_retry_cache
                ? /^[a-f0-9]{32}$/.test(String(cItemProcessando._pendente._autonomous_retry_cache))
                  ? 'retry_' + cItemProcessando._pendente._autonomous_retry_cache
                  : 'retry'
                : tarefaAdquirida.task_key.split(':').pop())
          if (
            autonomousEpochC &&
            /revogad|anulad|cancelad|suspens/i.test(cItemProcessando.situacaoCompraNome || '')
          ) {
            pncpInvalidateOfficial(
              cnpjC + '/' + anoC + '/' + seqC + '/itens/',
              autonomousEpochC,
              cItemProcessando,
            )
            continue
          }
          if (
            autonomousEpochC &&
            /^(divulgada(?: no pncp)?|publicada|homologada|em andamento)$/i.test(
              cItemProcessando.situacaoCompraNome || '',
            )
          )
            pncpObserveScope(
              $app,
              cnpjC + '/' + anoC + '/' + seqC + '/itens/',
              'active',
              autonomousEpochC,
              cItemProcessando,
            )
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
              numeroProcesso: cItemProcessando.numeroProcesso || '',
              codigoCatalogo: cItemProcessando.codigoCatalogo || '',
              materialOuServico: cItemProcessando.materialOuServico || '',
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
            if (cRec && cRec.getString('server_trust_version') !== 'server-v1') cRec = null
            if (
              cRec &&
              autonomousEpochC &&
              (parseJsonWorkerSafe(cRec.getString('raw_itens')) || {}).autonomous_epoch !==
                autonomousEpochC
            )
              cRec = null
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
                    var atualC =
                      rC && rC.getString('server_trust_version') === 'server-v1'
                        ? parseJsonWorkerSafe(rC.getString('raw_itens'))
                        : null
                    if (
                      autonomousEpochC &&
                      (!atualC || atualC.autonomous_epoch !== autonomousEpochC)
                    )
                      atualC = null
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
                      trabalhoPaginaC = {
                        v: 1,
                        pagina: proximaPaginaC,
                        refs: refsTrabalhoC,
                        checked_at: new Date().toISOString(),
                      }
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
                    if (autonomousEpochC) cacheSalvoC.autonomous_epoch = autonomousEpochC
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
                    rC.set('server_trust_version', 'server-v1')
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
                    trabalhoPaginaC = {
                      v: 1,
                      pagina: proximaPaginaC,
                      refs: refsTrabalhoC,
                      checked_at: new Date().toISOString(),
                    }
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
            if (
              Number(itmObj.situacaoCompraItem) === 3 ||
              Number(itmObj.situacaoCompraItemId) === 3
            ) {
              var itemStatusChecked =
                (typeof trabalhoPaginaC !== 'undefined' &&
                  trabalhoPaginaC &&
                  trabalhoPaginaC.checked_at) ||
                (typeof autonomousEpochC !== 'undefined' && autonomousEpochC) ||
                ''
              if (itemStatusChecked)
                pncpInvalidateOfficial(
                  cnpjC + '/' + anoC + '/' + seqC + '/itens/' + numItemInt + '/',
                  itemStatusChecked,
                  itmObj,
                )
              aposentarItemC(itmObj)
              continue
            }
            var itemActiveChecked =
              (typeof trabalhoPaginaC !== 'undefined' &&
                trabalhoPaginaC &&
                trabalhoPaginaC.checked_at) ||
              ''
            if (
              itemActiveChecked &&
              /^(homologado|em andamento)$/i.test(itmObj.situacaoCompraItemNome || '')
            )
              pncpObserveScope(
                $app,
                cnpjC + '/' + anoC + '/' + seqC + '/itens/' + numItemInt + '/',
                'active',
                itemActiveChecked,
                itmObj,
              )
            var houveCancelamentoC = false
            var campoFallbackC = ''
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
                campoFallbackC = camposUnitarios[campoIdx]
                break
              }
            }
            var valorFallbackC = campoFallbackC ? Number(itmObj[campoFallbackC]) : 0
            var naturezaFallbackC = /homologado/i.test(campoFallbackC) ? 'homologado' : 'estimado'
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
            var resultadoCapturadoEm = ''
            var resultadoReutilizado = false
            var fornecedorFallbackNomeC =
              (itmObj.fornecedor &&
                (itmObj.fornecedor.nomeRazaoSocialFornecedor ||
                  itmObj.fornecedor.nomeRazaoSocial)) ||
              'NÃO INFORMADO'
            var fornecedorFallbackCnpjC =
              (itmObj.fornecedor && (itmObj.fornecedor.niFornecedor || itmObj.fornecedor.cnpj)) ||
              'NÃO INFORMADO'
            var resultadosHomologadosC = []
            var identidadesResultadosC = {}
            var respostaResultadosConfirmadaC = false

            if (!urlItem) {
              aposentarItemC(itmObj)
              continue
            }
            if (urlItem) {
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
              if (typeof tarefaSistemaPncp !== 'undefined' && tarefaSistemaPncp)
                cacheResultado = null
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
                  respostaResultadosConfirmadaC = true
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
                  if (resIt.numeroItem != null && Number(resIt.numeroItem) !== numItemInt) continue
                  if (
                    !cacheResultado &&
                    Number(resIt.situacaoCompraItemResultadoId) === 1 &&
                    /^\d+$/.test(String(resIt.sequencialResultado || '')) &&
                    !resIt.dataCancelamento
                  )
                    pncpObserveScope(
                      $app,
                      cnpjC +
                        '/' +
                        anoC +
                        '/' +
                        seqC +
                        '/itens/' +
                        numItemInt +
                        '/resultados/' +
                        resIt.sequencialResultado +
                        '/',
                      'active',
                      resultadoCapturadoEm,
                      resIt,
                    )
                  if (Number(resIt.situacaoCompraItemResultadoId) === 2 || resIt.dataCancelamento) {
                    houveCancelamentoC = true
                    if (!cacheResultado && /^\d+$/.test(String(resIt.sequencialResultado || '')))
                      pncpInvalidateOfficial(
                        cnpjC +
                          '/' +
                          anoC +
                          '/' +
                          seqC +
                          '/itens/' +
                          numItemInt +
                          '/resultados/' +
                          resIt.sequencialResultado +
                          '/',
                        resultadoCapturadoEm,
                        resIt,
                      )
                    continue
                  }
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
                    var fornecedorResultadoC = String(
                      resIt.niFornecedor || resIt.cnpj || resIt.cpfCnpjFornecedor || '',
                    ).replace(/\D/g, '')
                    var sequencialResultadoC = String(resIt.sequencialResultado || '')
                    var numeroItemResultadoC = resIt.numeroItem || resIt.numero_item
                    if (
                      !fornecedorResultadoC ||
                      !/^\d+$/.test(sequencialResultadoC) ||
                      (numeroItemResultadoC != null && Number(numeroItemResultadoC) !== numItemInt)
                    )
                      continue
                    var identidadeResultadoC = sequencialResultadoC + '_' + fornecedorResultadoC
                    if (identidadesResultadosC[identidadeResultadoC]) continue
                    identidadesResultadosC[identidadeResultadoC] = true
                    resultadosHomologadosC.push({
                      registro: resIt,
                      campo: campoResultado,
                      valor: vR,
                      natureza: 'homologado',
                      url: urlRes,
                      fornecedor_nome:
                        resIt.nomeRazaoSocialFornecedor || resIt.nomeFornecedor || 'NÃO INFORMADO',
                      fornecedor_cnpj: fornecedorResultadoC,
                      sequencial_resultado: sequencialResultadoC,
                    })
                  }
                }
              }
            }

            var qItem = Number(itmObj.quantidade) > 0 ? Number(itmObj.quantidade) : 0
            var candidatosPrecoC = resultadosHomologadosC
            if (
              candidatosPrecoC.length === 0 &&
              !houveCancelamentoC &&
              respostaResultadosConfirmadaC &&
              campoFallbackC &&
              isFinite(valorFallbackC) &&
              valorFallbackC > 0
            )
              candidatosPrecoC = [
                {
                  registro: itmObj,
                  campo: campoFallbackC,
                  valor: valorFallbackC,
                  natureza: naturezaFallbackC,
                  url: urlItem,
                  fornecedor_nome: fornecedorFallbackNomeC,
                  fornecedor_cnpj: fornecedorFallbackCnpjC,
                  sequencial_resultado: '',
                },
              ]

            if (!respostaResultadosConfirmadaC) break
            if (candidatosPrecoC.length === 0 || numItemInt <= 0) {
              aposentarItemC(itmObj)
              continue
            }

            var numControlePncp = cItemProcessando.numeroControlePNCP
            var urlOrig = 'https://pncp.gov.br/app/editais/' + cnpjC + '/' + anoC + '/' + seqC
            var amostrasDoItemC = []
            for (
              var candidatoPrecoIdxC = 0;
              candidatoPrecoIdxC < candidatosPrecoC.length;
              candidatoPrecoIdxC++
            ) {
              var candidatoPrecoC = candidatosPrecoC[candidatoPrecoIdxC]
              var registroPrecoC = candidatoPrecoC.registro
              var campoUnitarioC = candidatoPrecoC.campo
              var vUnitFinalC = Number(candidatoPrecoC.valor)
              var natC = candidatoPrecoC.natureza
              var forNomeC = candidatoPrecoC.fornecedor_nome || 'NÃO INFORMADO'
              var forCnpjC = candidatoPrecoC.fornecedor_cnpj || 'NÃO INFORMADO'
              var sequencialResultadoCandidatoC = candidatoPrecoC.sequencial_resultado || ''
              var fornecedorIdentidadeC = String(
                registroPrecoC.niFornecedor || forCnpjC || '',
              ).replace(/\D/g, '')
              var identidadeItemC =
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
                    (sequencialResultadoCandidatoC
                      ? '/resultados/' + sequencialResultadoCandidatoC
                      : '') +
                    (fornecedorIdentidadeC ? '/fornecedor/' + fornecedorIdentidadeC : '')
                  : ''
              var identidadeProvaC = {
                cnpj: cnpjC,
                ano: anoC,
                sequencial: seqC,
                numeroItem: numItemInt,
              }
              if (sequencialResultadoCandidatoC) {
                identidadeProvaC.sequencialResultado = Number(sequencialResultadoCandidatoC)
                identidadeProvaC.fornecedor = fornecedorIdentidadeC
              }
              var amPncpC = {
                source: 'PNCP',
                source_record_id: identidadeItemC,
                purchase_id: identidadeItemC,
                item_id: String(numItemInt),
                descricao: dItem,
                descricao_normalizada: canonicalNormWorkerText(dItem),
                orgao:
                  itmObj.orgao_comprador ||
                  (itmObj.orgaoEntidade && itmObj.orgaoEntidade.razaoSocial) ||
                  cItemProcessando.orgao,
                orgao_cnpj: cnpjC,
                fornecedor_nome: forNomeC,
                fornecedor_cnpj: forCnpjC,
                fornecedor_porte:
                  forNomeC.indexOf('ME') !== -1 || forNomeC.indexOf('EPP') !== -1
                    ? 'ME_EPP'
                    : 'DEMAIS',
                uf:
                  itmObj.uf ||
                  (itmObj.unidadeOrgao && itmObj.unidadeOrgao.ufSigla) ||
                  cItemProcessando.uf ||
                  '',
                municipio:
                  itmObj.municipio_nome ||
                  itmObj.municipio ||
                  (itmObj.unidadeOrgao && itmObj.unidadeOrgao.municipioNome) ||
                  cItemProcessando.municipio ||
                  '',
                unidade: extrairUnidadeQualificadaWorkerUtil(
                  itmObj.unidadeMedida || itmObj.unidade,
                  dItem,
                ),
                quantidade: qItem,
                valor_unitario: vUnitFinalC,
                valor_total: Number(
                  registroPrecoC.valorTotalHomologado || registroPrecoC.valorTotal || 0,
                ),
                natureza_preco: natC,
                data_referencia: registroPrecoC.dataResultado || '',
                numero_processo:
                  itmObj.processo_origem ||
                  itmObj.numeroProcesso ||
                  itmObj.numero_processo ||
                  itmObj.processo ||
                  cItemProcessando.numeroProcesso ||
                  numControlePncp,
                numero_ata: '',
                modalidade: cItemProcessando.modalidadeNome || '',
                situacao_contratacao: cItemProcessando.situacaoCompraNome || '',
                source_updated_at:
                  registroPrecoC.dataAtualizacao || cItemProcessando.source_updated_at || '',
                source_status_checked_at:
                  typeof autonomousEpochC !== 'undefined' ? autonomousEpochC : '',
                marca: itmObj.marcaNome || 'NÃO INFORMADO',
                modelo: 'NÃO INFORMADO',
                codigo_item: extrairCodigoItemWorker(itmObj, cItemProcessando),
                url_original: urlOrig,
                matching_score: calcularDiceScoreWorker(tokens, extractWorkerTokensUtil(dItem)),
                matching_tipo: 'texto_normalizado',
                raw_payload: {
                  compra_oficial: {
                    dataAtualizacaoGlobal: cItemProcessando.source_updated_at || '',
                  },
                  relacao_documental:
                    cItemProcessando._pendente && cItemProcessando._pendente._pncp_compra,
                  numeroControlePNCP: numControlePncp,
                  numeroItem: numItemInt,
                  tipo_documento: cItemProcessando._tipoDoc || 'ata',
                  quantidade_informada: qItem > 0,
                  proveniencia_preco: {
                    versao: 1,
                    status: 'verificada',
                    fonte: 'PNCP',
                    campo_unitario: campoUnitarioC,
                    valor_unitario: vUnitFinalC,
                    natureza: natC,
                    url_evidencia: candidatoPrecoC.url,
                    identidade: identidadeProvaC,
                    registro_oficial: registroPrecoC,
                    data_oficial: registroPrecoC.dataResultado || '',
                    campo_data: registroPrecoC.dataResultado ? 'dataResultado' : '',
                  },
                },
              }
              if (resultadoCapturadoEm) {
                amPncpC.raw_payload.proveniencia_preco.resultado_capturado_em = resultadoCapturadoEm
                amPncpC.raw_payload.proveniencia_preco.resultado_reutilizado = resultadoReutilizado
              }
              amPncpC.sample_key = gerarSampleKeyUtil(amPncpC)
              amostrasDoItemC.push(amPncpC)
            }

            if (!colecaoAmostrasCiclo)
              colecaoAmostrasCiclo = $app.findCollectionByNameOrId('price_samples_index')
            var salvoItemC = persistirLoteAmostrasProgressivo(
              amostrasDoItemC,
              colecaoAmostrasCiclo,
              tarefaSistemaPncp
                ? {
                    task_id: tarefaAdquirida.id,
                    started_at: tarefaAdquirida.started_at,
                    tentativas: tarefaAdquirida.tentativas,
                    purchase: cItemProcessando._pendente,
                  }
                : null,
            )
            amostrasInseridasTotal += salvoItemC.inseridas
            amostrasAtualizadasTotal += salvoItemC.atualizadas
            if (
              salvoItemC.falhou ||
              salvoItemC.inseridas + salvoItemC.atualizadas + (salvoItemC.excluidas || []).length <
                amostrasDoItemC.length
            ) {
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
              totalAmostrasHttp += salvoItemC.inseridas + salvoItemC.atualizadas
              for (
                var amostraHttpIdxC = 0;
                amostraHttpIdxC < amostrasDoItemC.length;
                amostraHttpIdxC++
              ) {
                var amPncp = amostrasDoItemC[amostraHttpIdxC]
                if ((salvoItemC.excluidas || []).indexOf(amPncp.sample_key) >= 0) continue
                if (amostrasHttp.length >= 50) break
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
            return pncpSchedulable(p)
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
            return pncpSchedulable(p)
          })
          var statusFinal = possuiTrabalhoAcionavel
            ? 'pending'
            : pendentesRestantes.length > 0
              ? 'failed'
              : 'completed'
          if (
            tarefaSistemaPncp &&
            tarefaAdquirida.task_key.indexOf(':retry:') !== -1 &&
            statusFinal === 'failed'
          ) {
            pendentesRestantes = pendentesRestantes.filter(function (p) {
              return !p._pncp_discovery
            })
            pendentesRestantes.forEach(function (p) {
              p._retry_count = (p._retry_count || 0) + 1
              // This retry already owns its versioned cache; only rearm its next attempt.
              p._autonomous_retry_at = new Date(
                Date.parse(agoraFinal) +
                  Math.min(86400000, 1800000 * Math.pow(2, Math.min(p._retry_count, 5))),
              ).toISOString()
            })
            pendentesRestantes.unshift({
              _pncp_discovery: { esgotados: { ata: true, edital: true, contrato: true } },
            })
          }
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
  $apis.bodyLimit(8 * 1024),
)

// 3. Endpoint HTTP de estatísticas e métricas de observabilidade com watermarks: GET /backend/v1/tasks/stats
routerAdd(
  'GET',
  '/backend/v1/tasks/stats',
  function (e) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
    try {
      var totalTarefas = 0
      var pendentes = 0
      var emExecucao = 0
      var concluidas = 0
      var comFalha = 0

      try {
        var q = $app
          .db()
          .newQuery(
            "SELECT status, COUNT(*) as cnt FROM price_index_tasks WHERE server_trust_version = 'server-v1' " +
              'AND requested_by = {:user} GROUP BY status',
          )
          .bind({ user: String(e.auth.id) })
        var rows = arrayOf(new DynamicModel({ status: '', cnt: 0 }))
        q.all(rows)
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
            'SELECT source, COUNT(*) as cnt FROM price_samples_index ' +
              "WHERE server_trust_version = 'server-v1' AND source IN ('PNCP', 'Compras.gov.br') " +
              'AND valor_unitario > 0 AND search_eligible = 1 ' +
              "AND search_contract = 'cotai-official-price-v3' " +
              'GROUP BY source',
          )
        var rowsA = arrayOf(new DynamicModel({ source: '', cnt: 0 }))
        qA.all(rowsA)
        for (var j = 0; j < rowsA.length; j++) {
          var src = rowsA[j].source
          var cntA = Number(rowsA[j].cnt) || 0
          totalAmostras += cntA
          if (src === 'PNCP') amostrasPncp = cntA
          else if (src === 'Compras.gov.br') amostrasComprasGov = cntA
        }
        amostrasValidasQualidade = totalAmostras
      } catch (_) {}

      // Source state is server-owned. Do not project legacy client-writable totals,
      // private leases/queues or raw exception strings into the authenticated DTO.
      function publicSourceStats(source) {
        function count(value) {
          return Number.isSafeInteger(value) && value >= 0 ? value : null
        }
        function sumKnown(values) {
          var total = 0,
            known = false
          for (var i = 0; i < values.length; i++)
            if (count(values[i]) !== null) {
              total += values[i]
              known = true
            }
          return known && Number.isSafeInteger(total) ? total : null
        }
        function timestamp(value) {
          return typeof value === 'string' &&
            /^20\d\d-\d\d-\d\dT/.test(value) &&
            isFinite(Date.parse(value))
            ? value
            : null
        }
        function date(value) {
          return typeof value === 'string' &&
            /^20\d\d-\d\d-\d\d$/.test(value) &&
            isFinite(Date.parse(value))
            ? value
            : null
        }
        var dto = {
          fonte: source,
          cursor_tipo: 'autonomous-v1',
          status: 'unavailable',
          source_checked_at: null,
          source_written_at: null,
          last_drained_at: null,
          next_attempt_at: null,
          paginas_consultadas: null,
          revisoes_gravadas: null,
          backlog: null,
          backlog_unit: source === 'PNCP' ? 'contratacoes' : 'codigos_catalogo',
          retries_pendentes: null,
          requested_through: null,
          last_error: null,
          coverage: 'partial',
          last_watermark_date: null,
          last_cursor_page: null,
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
          var state = JSON.parse(raw || '{}')
          if (
            state.version !== 1 ||
            state.source !== source ||
            !state.lanes ||
            typeof state.lanes !== 'object' ||
            Array.isArray(state.lanes)
          )
            throw new Error('SOURCE_STATE_VERSION')
          dto.source_checked_at = timestamp(state.source_checked_at)
          dto.source_written_at = timestamp(state.source_written_at)
          dto.last_drained_at = timestamp(state.last_drained_at)
          dto.next_attempt_at = timestamp(state.next_attempt_at)
          var lanes = Object.keys(state.lanes).map(function (key) {
            return state.lanes[key] || {}
          })
          dto.paginas_consultadas = count(state.pages_scanned)
          if (dto.paginas_consultadas === null)
            dto.paginas_consultadas = sumKnown(
              lanes.map(function (lane) {
                return lane.pages_scanned
              }),
            )
          dto.revisoes_gravadas = count(state.written_count)
          if (dto.revisoes_gravadas === null && state.written_count == null)
            dto.revisoes_gravadas =
              source === 'PNCP'
                ? sumKnown(
                    lanes.map(function (lane) {
                      return lane.written_count
                    }),
                  )
                : sumKnown([state.new_count, state.updated_count])
          dto.backlog = count(state.backlog)
          dto.retries_pendentes = count(state.quarantine_pending)
          dto.tem_retries_pendentes =
            typeof state.quarantine_pending === 'boolean'
              ? state.quarantine_pending
              : dto.retries_pendentes === null
                ? null
                : dto.retries_pendentes > 0
          dto.requested_through = date(state.requested_through)
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
          ]
          dto.last_error = state.last_error
            ? allowed.indexOf(state.last_error) >= 0
              ? state.last_error
              : 'SOURCE_UNAVAILABLE'
            : null
          var lane = state.lanes.publication
          if (source === 'PNCP' && lane) {
            dto.last_watermark_date = date(lane.date)
            dto.last_cursor_page = count(lane.page)
          }
          dto.status = dto.last_error
            ? 'error'
            : dto.next_attempt_at && Date.parse(dto.next_attempt_at) > Date.now()
              ? 'backoff'
              : 'scheduled'
        } catch (_) {
          dto.last_error = 'SOURCE_STATE_UNAVAILABLE'
        }
        return dto
      }
      var watermarksList = [publicSourceStats('PNCP'), publicSourceStats('Compras.gov.br')]

      var probePost = null
      var probeGet = null
      // Campos legados mantidos como null: stats não executa sondagens nem escreve logs.

      return e.json(200, {
        sucesso: true,
        worker_ativo: null,
        worker_configurado: true,
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
        coleta_autonoma: {
          cobertura_nacional_completa: false,
          unidade_contagem: 'revisoes_de_precos; nao produtos distintos',
          observacao:
            'Agendamento configurado não comprova execução; confira respostas, gravações e janelas concluídas.',
        },
        probe_prices_search_post: probePost,
        probe_prices_search_get: probeGet,
      })
    } catch (errStats) {
      return e.json(500, {
        sucesso: false,
        error: 'TASK_STATS_UNAVAILABLE',
      })
    }
  },
  $apis.requireAuth(),
)
