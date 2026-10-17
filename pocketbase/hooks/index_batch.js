// Fixed-collection, authenticated ingestion. No remote calls, inference, or per-row HTTP fallback.
routerAdd(
  'POST',
  '/backend/v1/cotai/index-batch',
  (e) => {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })

    var body
    try {
      body = e.requestInfo().body
    } catch (_) {
      return e.json(400, { sucesso: false, error: 'INVALID_BODY' })
    }
    if (!body || !Array.isArray(body.amostras)) {
      return e.json(400, { sucesso: false, error: 'INVALID_BATCH' })
    }
    // The middleware enforces actual byte size before parsing. This also bounds direct handler calls.
    if (body.amostras.length > 100 || JSON.stringify(body).length > 2 * 1024 * 1024) {
      return e.json(413, { sucesso: false, error: 'BATCH_TOO_LARGE' })
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
      if (
        !match ||
        !/\.gov\.br$/i.test(match[1]) ||
        match[1].toLowerCase() === 'catalogo.compras.gov.br'
      )
        return null
      return { host: match[1].toLowerCase(), path: match[2] || '/' }
    }
    function query(url, name) {
      var match = url.match(new RegExp('[?&]' + name + '=([^&#]*)'))
      try {
        return match ? decodeURIComponent(match[1]) : ''
      } catch (_) {
        return ''
      }
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
        var namespace = id.tipo === 'servico' ? 'CATSER' : 'CATMAT'
        var expectedId = [namespace, purchaseId, item, text(proof.data_oficial), supplierId]
          .map(encodeURIComponent)
          .join('#')
        if (row.source_record_id !== expectedId || row.url_original !== proof.url_evidencia)
          return 'IDENTITY_INVALID'
        var parsed = officialUrl(proof.url_evidencia)
        if (parsed.host === 'dadosabertos.compras.gov.br') {
          var path =
            id.tipo === 'servico'
              ? '/modulo-pesquisa-preco/3_consultarServico'
              : '/modulo-pesquisa-preco/1_consultarMaterial'
          if (
            parsed.path.split('?')[0] !== path ||
            query(proof.url_evidencia, id.tipo === 'servico' ? 'codigoItemCatalogo' : 'codigo') !==
              text(id.codigoCatalogo) ||
            (id.tipo === 'material' && query(proof.url_evidencia, 'tipo') !== 'codigoItemCatalogo')
          )
            return 'URL_INVALID'
          var filters = ['pagina', 'tamanhoPagina', 'estado', 'dataInicial', 'dataFinal']
          for (var f = 0; f < filters.length; f++) {
            var field = filters[f]
            if (
              context[field] != null &&
              text(context[field]) !== '' &&
              query(proof.url_evidencia, field) !== text(context[field])
            )
              return 'URL_INVALID'
          }
        } else if (
          [raw.linkEditalOuCompra, raw.link_resultado, raw.url].indexOf(proof.url_evidencia) < 0
        )
          return 'URL_INVALID'
      }
      return ''
    }

    function storedRow(record) {
      var row = {}
      for (var k = 0; k < fields.length; k++) row[fields[k]] = record.get(fields[k])
      if (typeof row.raw_payload === 'string') {
        try {
          row.raw_payload = JSON.parse(row.raw_payload)
        } catch (_) {
          row.raw_payload = null
        }
      }
      return row
    }
    function precisionAlias(old, exact) {
      if (
        !old ||
        old.source !== 'Compras.gov.br' ||
        exact.source !== old.source ||
        validate(old, true)
      )
        return false
      var a = old.raw_payload.proveniencia_preco,
        b = exact.raw_payload.proveniencia_preco
      var ar = a.registro_oficial,
        br = b.registro_oficial
      var ap = first(ar, ['idCompra', 'codigoCompra']),
        bp = first(br, ['idCompra', 'codigoCompra'])
      if (
        typeof ap !== 'number' ||
        Number.isSafeInteger(ap) ||
        !isFinite(ap) ||
        Math.floor(ap) !== ap ||
        typeof bp !== 'string' ||
        !/^\d+$/.test(bp) ||
        Number(bp) !== ap ||
        typeof ar.idCompraItem !== 'string' ||
        !ar.idCompraItem ||
        ar.idCompraItem !== br.idCompraItem
      )
        return false
      var same = [
        'source',
        'item_id',
        'codigo_item',
        'fornecedor_cnpj',
        'data_referencia',
        'unidade',
        'quantidade',
        'valor_unitario',
        'natureza_preco',
      ]
      for (var s = 0; s < same.length; s++) if (old[same[s]] !== exact[same[s]]) return false
      if (
        a.natureza !== b.natureza ||
        a.identidade.tipo !== b.identidade.tipo ||
        text(a.identidade.codigoCatalogo) !== text(b.identidade.codigoCatalogo) ||
        text(a.identidade.idItemCompra) !== text(b.identidade.idItemCompra) ||
        text(a.identidade.numeroItemCompra) !== text(b.identidade.numeroItemCompra) ||
        text(a.identidade.fornecedor) !== text(b.identidade.fornecedor)
      )
        return false
      var pair = [old, exact]
      for (var p = 0; p < pair.length; p++) {
        var row = pair[p],
          proof = row.raw_payload.proveniencia_preco,
          raw = proof.registro_oficial
        var unit =
          text(
            raw.unidadeMedida ||
              raw.siglaUnidadeFornecimento ||
              raw.siglaUnidadeMedida ||
              raw.unidadeFornecimento ||
              raw.nomeUnidadeFornecimento ||
              raw.unidade ||
              '',
          ).trim() || 'NÃO INFORMADO'
        var quantity = Number(
          first(raw, ['quantidade', 'quantidadeItem', 'quantidadeTotal', 'quantidadeHomologada']),
        )
        quantity = isFinite(quantity) && quantity > 0 ? quantity : 0
        var supplier = text(first(raw, ['cnpjFornecedor', 'cpfCnpjFornecedor', 'niFornecedor']))
        if (
          row.unidade !== unit ||
          row.quantidade !== quantity ||
          text(row.fornecedor_cnpj) !== supplier ||
          row.codigo_item !==
            (proof.identidade.tipo === 'servico' ? 'CATSER ' : 'CATMAT ') +
              text(proof.identidade.codigoCatalogo)
        )
          return false
      }
      return true
    }
    function legacyKey(value) {
      if (value.source !== 'Compras.gov.br') return ''
      var proof = value.raw_payload.proveniencia_preco
      var purchase = first(proof.registro_oficial, ['idCompra', 'codigoCompra'])
      if (
        typeof purchase !== 'string' ||
        !/^\d+$/.test(purchase) ||
        !isFinite(Number(purchase)) ||
        Number.isSafeInteger(Number(purchase)) ||
        text(Number(purchase)) === purchase
      )
        return ''
      var parts = value.source_record_id.split('#')
      parts[1] = encodeURIComponent(text(Number(purchase)))
      var oldId = parts.join('#')
      return sampleKey({
        source: value.source,
        source_record_id: oldId,
        item_id: value.item_id,
        orgao_cnpj: value.orgao_cnpj,
        fornecedor_cnpj: value.fornecedor_cnpj,
        valor_unitario: value.valor_unitario,
      })
    }

    var accepted = [],
      seen = Object.create(null),
      reasons = {},
      ignored = 0
    for (var i = 0; i < body.amostras.length; i++) {
      var row = body.amostras[i]
      var reason
      try {
        reason = validate(row)
      } catch (_) {
        reason = 'PROOF_INVALID'
      }
      if (!reason && seen[row.sample_key]) reason = 'DUPLICATE_IN_BATCH'
      if (reason) {
        ignored++
        reasons[reason] = (reasons[reason] || 0) + 1
        continue
      }
      seen[row.sample_key] = true
      accepted.push(row)
    }
    var inserted = 0,
      updated = 0
    // Never accept a collection, filter, SQL fragment, record id, or arbitrary writable field from the caller.
    var fields = [
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
    try {
      if (accepted.length)
        $app.runInTransaction((txApp) => {
          var collection = txApp.findCollectionByNameOrId('price_samples_index')
          var now = new Date().toISOString()
          for (var n = 0; n < accepted.length; n++) {
            var value = accepted[n]
            var found = txApp.findRecordsByFilter(
              'price_samples_index',
              'sample_key = {:key}',
              '',
              1,
              0,
              { key: value.sample_key },
            )
            var correction = null
            if (found.length && value.source === 'Compras.gov.br') {
              var canonicalOld = storedRow(found[0]),
                canonicalProof =
                  canonicalOld.raw_payload && canonicalOld.raw_payload.proveniencia_preco
              var canonicalRaw = canonicalProof && canonicalProof.registro_oficial
              var canonicalPurchase =
                canonicalRaw && first(canonicalRaw, ['idCompra', 'codigoCompra'])
              var unsafeOld =
                typeof canonicalPurchase === 'number' && !Number.isSafeInteger(canonicalPurchase)
              var incomingRaw = value.raw_payload.proveniencia_preco.registro_oficial
              if (
                (unsafeOld && !precisionAlias(canonicalOld, value)) ||
                (canonicalRaw &&
                  typeof canonicalRaw.idCompraItem === 'string' &&
                  typeof incomingRaw.idCompraItem === 'string' &&
                  canonicalRaw.idCompraItem !== incomingRaw.idCompraItem)
              ) {
                // Existing unique key cannot hold two contradictory official proofs.
                // Keep the old row; the direct exact sample remains available to UI.
                ignored++
                reasons.IDENTITY_COLLISION = (reasons.IDENTITY_COLLISION || 0) + 1
                continue
              }
              if (unsafeOld)
                correction = {
                  versao: 1,
                  source_record_id_anterior: canonicalOld.source_record_id,
                  source_record_id_exato: value.source_record_id,
                  corrigido_em: now,
                  prova_anterior: canonicalProof,
                }
            }
            if (!found.length) {
              var oldKey = legacyKey(value)
              if (oldKey) {
                var candidates = txApp.findRecordsByFilter(
                  'price_samples_index',
                  'sample_key = {:key}',
                  '',
                  2,
                  0,
                  { key: oldKey },
                )
                if (candidates.length === 1) {
                  var old = storedRow(candidates[0])
                  if (precisionAlias(old, value)) {
                    found = candidates
                    correction = {
                      versao: 1,
                      source_record_id_anterior: old.source_record_id,
                      source_record_id_exato: value.source_record_id,
                      corrigido_em: now,
                      prova_anterior: old.raw_payload.proveniencia_preco,
                    }
                  }
                }
              }
            }
            var existing = found.length > 0
            var record = existing ? found[0] : new Record(collection)
            // Caller metadata is never authoritative. Keep at most one server audit.
            var previous = existing ? storedRow(record).raw_payload : null
            var audit = (previous && previous.correcao_identidade_compras) || correction
            var details = Object.assign({}, value.raw_payload)
            delete details.correcao_identidade_compras
            if (audit) details.correcao_identidade_compras = audit
            for (var j = 0; j < fields.length; j++) {
              if (Object.prototype.hasOwnProperty.call(value, fields[j]))
                record.set(fields[j], fields[j] === 'raw_payload' ? details : value[fields[j]])
            }
            if (!existing) record.set('indexed_at', now)
            record.set('source_updated_at', now)
            record.set('last_validated_at', now)
            txApp.save(record)
            if (existing) updated++
            else inserted++
          }
        })
    } catch (_) {
      return e.json(500, {
        sucesso: false,
        error: 'INDEX_BATCH_WRITE_FAILED',
        inseridas: 0,
        atualizadas: 0,
      })
    }
    return e.json(200, {
      sucesso: true,
      recebidas: body.amostras.length,
      inseridas: inserted,
      atualizadas: updated,
      ignoradas: ignored,
      motivos_ignoradas: reasons,
    })
  },
  $apis.requireAuth(),
  $apis.bodyLimit(2 * 1024 * 1024),
)
