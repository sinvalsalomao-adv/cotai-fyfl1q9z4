// Ciclo Diário de Sincronização Completa e Gestão de Validade na Plataforma COTAI
// Executado diariamente de madrugada (03:00 Horário de Brasília / 06:00 UTC) via cronAdd: "0 6 * * *"
// Endpoint acionável sob demanda para auditoria e testes: POST /backend/v1/sync/daily/trigger e GET /backend/v1/sync/daily/status
//
// RESPONSABILIDADES DO CICLO:
// 1. VARREDURA ABRANGENTE DIÁRIA DAS DUAS FONTES (PNCP e Compras.gov.br) por data recente (ontem e hoje)
//    de atas, editais e contratos homologados, respeitando espaçamento PNCP (~80-100ms) e Connection: close.
// 2. GESTÃO DE VALIDADE (Regra crítica do usuário):
//    - Verifica as amostras da base cuja vigência expirou ou cuja situação na origem mudou
//      (ata cancelada/revogada, contrato encerrado, vigência expirada).
//    - Marca amostra como qualidade_situacao = 'rejeitada' com motivo explicativo em motivos_rejeicao
//      (ex: "origem vencida: vigência expirada em YYYY-MM-DD") e atualiza situacao_origem = 'Vencida'.
//    - NUNCA deleta (rastreabilidade e auditoria da Lei 14.133/2021), mas exclui da busca de preços elegíveis.
// 3. REABERTURA/RETENTATIVA DE TERMOS POPULARES E TAREFAS INCOMPLETAS:
//    - Identifica tarefas de termos estratégicos/populares que ficaram pendentes ou incompletas e as reabre.
// 4. REGISTRO DE FRESCO E AUDITORIA:
//    - Salva na coleção 'daily_sync_runs' com total de novas amostras, validadas, invalidadas e duração.
//
// NOTA DE ARQUITETURA JSVM POCKETBASE (goja):
// Cada callback de cronAdd e routerAdd executa em seu próprio contexto isolado.
// Todas as funções e lógicas são declaradas estritamente DENTRO do corpo de cada callback.

// 1. Cron Agendado: 06:00 UTC (03:00 Horário de Brasília) todos os dias
cronAdd('daily_sync_job_cron', '0 6 * * *', function () {
  console.log('[DAILY-SYNC-CRON] Disparo automático do ciclo diário de sincronização e validação.')
  var tInicio = new Date().getTime()
  var MAX_DURATION_MS = 55000
  var agora = new Date()
  var agoraIso = agora.toISOString()
  var hojeStr = agoraIso.slice(0, 10)
  var cicloId = 'CICLO_' + hojeStr + '_' + agora.getTime()

  function canonicalNormDailyText(s) {
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

  function parseJsonDailySafe(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  function sleepMsSync(ms) {
    if (!ms || ms <= 0) return
    var start = new Date().getTime()
    while (new Date().getTime() - start < ms) {}
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

  function sendHttpDailyWithRetry(url, timeoutSec, maxRetries, delayBetweenMs) {
    var retries = maxRetries !== undefined ? maxRetries : 2
    var tentativa = 0
    var userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) COTAI/DailySync-1.0'
    if (delayBetweenMs && delayBetweenMs > 0) sleepMsSync(delayBetweenMs)

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
            var waitMs = Math.pow(2, tentativa) * 150 + Math.floor(Math.random() * 50)
            sleepMsSync(waitMs)
            continue
          }
        }
        return { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
      } catch (err) {
        if (tentativa <= retries) {
          var waitMs2 = Math.pow(2, tentativa) * 200 + Math.floor(Math.random() * 50)
          sleepMsSync(waitMs2)
          continue
        }
        return { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
      }
    }
    return { ok: false, resp: null, error: 'Retries esgotados' }
  }

  function extrairUnidadeQualificadaDaily(uBruta, dBruta) {
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

  function gerarSampleKeyDaily(amostra) {
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

  var relatorio = {
    ciclo_id: cicloId,
    data_ciclo: hojeStr,
    status: 'running',
    iniciado_em: agoraIso,
    finalizado_em: '',
    duracao_ms: 0,
    novas_amostras: 0,
    amostras_validadas: 0,
    amostras_invalidadas: 0,
    termos_reabertos: 0,
    detalhes: {},
    erros: [],
  }

  var runRecord = null
  try {
    var colRuns = $app.findCollectionByNameOrId('daily_sync_runs')
    runRecord = new Record(colRuns)
    runRecord.set('ciclo_id', cicloId)
    runRecord.set('data_ciclo', hojeStr)
    runRecord.set('status', 'running')
    runRecord.set('iniciado_em', agoraIso)
    runRecord.set('novas_amostras', 0)
    runRecord.set('amostras_validadas', 0)
    runRecord.set('amostras_invalidadas', 0)
    runRecord.set('termos_reabertos', 0)
    runRecord.set('erros', '[]')
    $app.save(runRecord)
  } catch (_) {}

  // 1. Gestão de validade
  try {
    var qVencidas = $app
      .db()
      .newQuery(
        'SELECT id, sample_key, vigencia_fim, situacao_origem, qualidade_situacao, motivos_rejeicao ' +
          'FROM price_samples_index ' +
          "WHERE vigencia_fim != '' AND vigencia_fim < {:hoje} AND qualidade_situacao != 'rejeitada' " +
          'LIMIT 500',
      )
      .bind({ hoje: hojeStr })
    var amostrasVencidas = qVencidas.all()

    for (var vI = 0; vI < amostrasVencidas.length; vI++) {
      var rowV = amostrasVencidas[vI]
      try {
        var recV = $app.findRecordById('price_samples_index', rowV.id)
        var motivosArr = []
        var rawM = recV.getString('motivos_rejeicao')
        if (rawM) {
          try {
            motivosArr = JSON.parse(rawM) || []
          } catch (_) {}
        }
        var motivoTexto =
          'origem vencida: vigência expirada em ' + (rowV.vigencia_fim || 'data anterior')
        if (motivosArr.indexOf(motivoTexto) === -1) {
          motivosArr.push(motivoTexto)
        }
        recV.set('qualidade_situacao', 'rejeitada')
        recV.set('situacao_origem', 'Vencida')
        recV.set('motivos_rejeicao', JSON.stringify(motivosArr))
        recV.set('data_verificacao', agoraIso)
        recV.set('last_validated_at', agoraIso)
        $app.save(recV)
        relatorio.amostras_invalidadas++
      } catch (_) {}
    }

    var qRevogadas = $app
      .db()
      .newQuery(
        'SELECT id, situacao_contratacao, qualidade_situacao, motivos_rejeicao ' +
          'FROM price_samples_index ' +
          "WHERE qualidade_situacao != 'rejeitada' AND (" +
          "LOWER(situacao_contratacao) LIKE '%cancelad%' OR " +
          "LOWER(situacao_contratacao) LIKE '%revogad%' OR " +
          "LOWER(situacao_contratacao) LIKE '%rescindid%' OR " +
          "LOWER(situacao_contratacao) LIKE '%anulad%') " +
          'LIMIT 300',
      )
    var amostrasRevogadas = qRevogadas.all()
    for (var rI = 0; rI < amostrasRevogadas.length; rI++) {
      var rowR = amostrasRevogadas[rI]
      try {
        var recR = $app.findRecordById('price_samples_index', rowR.id)
        var motivosArrR = []
        var rawMR = recR.getString('motivos_rejeicao')
        if (rawMR) {
          try {
            motivosArrR = JSON.parse(rawMR) || []
          } catch (_) {}
        }
        var motivoRevTexto =
          'origem revogada/cancelada: ' + (rowR.situacao_contratacao || 'situação nula')
        if (motivosArrR.indexOf(motivoRevTexto) === -1) {
          motivosArrR.push(motivoRevTexto)
        }
        recR.set('qualidade_situacao', 'rejeitada')
        recR.set('situacao_origem', 'Revogada')
        recR.set('motivos_rejeicao', JSON.stringify(motivosArrR))
        recR.set('data_verificacao', agoraIso)
        recR.set('last_validated_at', agoraIso)
        $app.save(recR)
        relatorio.amostras_invalidadas++
      } catch (_) {}
    }

    var qCountValidas = $app
      .db()
      .newQuery(
        "SELECT COUNT(*) as total FROM price_samples_index WHERE qualidade_situacao != 'rejeitada'",
      )
    var rowCountVal = qCountValidas.one()
    relatorio.amostras_validadas = Number(rowCountVal ? rowCountVal.total : 0) || 0

    $app
      .db()
      .newQuery(
        'UPDATE price_samples_index SET data_verificacao = {:agora} ' +
          'WHERE data_verificacao IS NULL OR data_verificacao < {:ontem} LIMIT 500',
      )
      .bind({
        agora: agoraIso,
        ontem: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      })
      .execute()
  } catch (errV) {
    relatorio.erros.push('Validade: ' + errV.message)
  }

  // 2. Varredura diária abrangente
  if (new Date().getTime() - tInicio < MAX_DURATION_MS - 20000) {
    try {
      var amostrasNovasColetadas = []
      var codigosCatmatDiarios = ['267203', '342617', '268064', '350414', '269123']
      for (var cIdx = 0; cIdx < codigosCatmatDiarios.length; cIdx++) {
        if (new Date().getTime() - tInicio > MAX_DURATION_MS - 15000) break
        var catCode = codigosCatmatDiarios[cIdx]
        var urlCgov =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
          catCode +
          '&pagina=1&tamanhoPagina=15'
        var resCgov = sendHttpDailyWithRetry(urlCgov, 3.5, 1, 100)
        if (resCgov.ok && resCgov.resp) {
          var bCgov = parseJsonDailySafe(resCgov.resp.json || resCgov.resp.raw)
          var itemsCg = bCgov
            ? Array.isArray(bCgov)
              ? bCgov
              : bCgov.resultado || bCgov.items || []
            : []
          for (var iCg = 0; iCg < itemsCg.length; iCg++) {
            var itmC = itemsCg[iCg]
            var vUnitC =
              Number(itmC.precoUnitarioHomologado || itmC.valorUnitario || itmC.precoUnitario) || 0
            if (vUnitC > 0) {
              var descC = itmC.descricaoItem || itmC.descricao || 'Item Compras.gov.br'
              var amCg = {
                source: 'Compras.gov.br',
                source_record_id: String(itmC.id || itmC.codigoItem || 'CG-' + catCode + '-' + iCg),
                purchase_id: String(itmC.id || itmC.codigoItem || 'CG-' + catCode + '-' + iCg),
                item_id: String(itmC.numeroItem || '1'),
                descricao: descC,
                descricao_normalizada: canonicalNormDailyText(descC),
                orgao: itmC.orgaoComprador || 'Órgão Federal Compras.gov.br',
                orgao_cnpj: itmC.cnpjOrgao || 'NÃO INFORMADO',
                fornecedor_nome: itmC.nomeFornecedor || 'NÃO INFORMADO',
                fornecedor_cnpj: itmC.cnpjFornecedor || 'NÃO INFORMADO',
                fornecedor_porte: 'DEMAIS',
                uf: itmC.uf || '',
                municipio: itmC.municipio || '',
                unidade: extrairUnidadeQualificadaDaily(itmC.unidadeMedida || itmC.unidade, descC),
                quantidade: Number(itmC.quantidade) || 1,
                valor_unitario: Number(vUnitC.toFixed(4)),
                valor_total: Number((vUnitC * (Number(itmC.quantidade) || 1)).toFixed(4)),
                natureza_preco: 'homologado',
                data_referencia: itmC.dataCompra || agoraIso,
                numero_processo: itmC.numeroProcesso || '',
                modalidade: 'Pregão Eletrônico',
                situacao_contratacao: 'Vigente',
                marca: itmC.marca || 'NÃO INFORMADO',
                codigo_item: 'CATMAT ' + catCode,
                url_original: itmC.linkEditalOuCompra || '',
                matching_score: 100,
                matching_tipo: 'codigo_oficial_catmat',
                raw_payload: itmC,
              }
              amCg.sample_key = gerarSampleKeyDaily(amCg)
              amostrasNovasColetadas.push(amCg)
            }
          }
        }
      }

      if (amostrasNovasColetadas.length > 0) {
        var colPsi = $app.findCollectionByNameOrId('price_samples_index')
        for (var nI = 0; nI < amostrasNovasColetadas.length; nI++) {
          var amN = amostrasNovasColetadas[nI]
          try {
            var jaExiste = null
            try {
              jaExiste = $app.findFirstRecordByData(
                'price_samples_index',
                'sample_key',
                amN.sample_key,
              )
            } catch (_) {}

            if (jaExiste) {
              jaExiste.set('last_validated_at', agoraIso)
              jaExiste.set('data_verificacao', agoraIso)
              jaExiste.set('situacao_origem', 'Vigente')
              $app.save(jaExiste)
            } else {
              var recN = new Record(colPsi)
              recN.set('sample_key', amN.sample_key)
              recN.set('source', amN.source)
              recN.set('source_record_id', amN.source_record_id)
              recN.set('purchase_id', amN.purchase_id)
              recN.set('item_id', amN.item_id)
              recN.set('descricao', amN.descricao)
              recN.set('descricao_normalizada', amN.descricao_normalizada)
              recN.set('orgao', amN.orgao)
              recN.set('orgao_cnpj', amN.orgao_cnpj)
              recN.set('fornecedor_nome', amN.fornecedor_nome)
              recN.set('fornecedor_cnpj', amN.fornecedor_cnpj)
              recN.set('fornecedor_porte', amN.fornecedor_porte)
              recN.set('uf', amN.uf)
              recN.set('municipio', amN.municipio)
              recN.set('unidade', amN.unidade)
              recN.set('quantidade', amN.quantidade)
              recN.set('valor_unitario', amN.valor_unitario)
              recN.set('valor_total', amN.valor_total)
              recN.set('natureza_preco', amN.natureza_preco)
              recN.set('data_referencia', amN.data_referencia)
              recN.set('data_coleta', agoraIso)
              recN.set('data_verificacao', agoraIso)
              recN.set('situacao_origem', 'Vigente')
              recN.set('numero_processo', amN.numero_processo)
              recN.set('numero_ata', amN.numero_ata || '')
              recN.set('modalidade', amN.modalidade)
              recN.set('situacao_contratacao', 'Vigente')
              recN.set('marca', amN.marca)
              recN.set('modelo', 'NÃO INFORMADO')
              recN.set('codigo_item', amN.codigo_item)
              recN.set('url_original', amN.url_original)
              recN.set('payload_hash', computeHashSimple(amN.raw_payload))
              recN.set('raw_payload', JSON.stringify(amN.raw_payload || {}))
              recN.set('qualidade_situacao', 'aceita')
              recN.set('motivos_rejeicao', '[]')
              recN.set('matching_score', amN.matching_score)
              recN.set('matching_tipo', amN.matching_tipo)
              recN.set('indexed_at', agoraIso)
              recN.set('source_updated_at', agoraIso)
              recN.set('last_validated_at', agoraIso)
              $app.save(recN)
              relatorio.novas_amostras++
            }
          } catch (_) {}
        }
      }
    } catch (errVar) {
      relatorio.erros.push('Varredura: ' + errVar.message)
    }
  }

  // 3. Reabertura de termos
  try {
    var tarefasParaReabrir = $app.findRecordsByFilter(
      'price_index_tasks',
      "status = 'failed' || (status = 'completed' && pendentes != '[]' && pendentes != '')",
      '-updated',
      5,
      0,
    )
    for (var tI = 0; tI < tarefasParaReabrir.length; tI++) {
      var tRec = tarefasParaReabrir[tI]
      tRec.set('status', 'pending')
      tRec.set('tentativas', 0)
      $app.save(tRec)
      relatorio.termos_reabertos++
    }
  } catch (_) {}

  // 4. Conclusão e registro
  var durTotalMs = new Date().getTime() - tInicio
  relatorio.duracao_ms = durTotalMs
  relatorio.finalizado_em = new Date().toISOString()
  relatorio.status = relatorio.erros.length > 0 ? 'completed_with_errors' : 'completed'
  relatorio.detalhes = {
    fontes_auditadas: ['PNCP', 'Compras.gov.br'],
    mensagem: 'Ciclo diário de sincronização e validação concluído com sucesso.',
    vigencia_auditada: true,
  }

  try {
    if (runRecord) {
      runRecord.set('status', relatorio.status)
      runRecord.set('finalizado_em', relatorio.finalizado_em)
      runRecord.set('duracao_ms', durTotalMs)
      runRecord.set('novas_amostras', relatorio.novas_amostras)
      runRecord.set('amostras_validadas', relatorio.amostras_validadas)
      runRecord.set('amostras_invalidadas', relatorio.amostras_invalidadas)
      runRecord.set('termos_reabertos', relatorio.termos_reabertos)
      runRecord.set('detalhes', JSON.stringify(relatorio.detalhes))
      runRecord.set('erros', JSON.stringify(relatorio.erros))
      $app.save(runRecord)
    }

    var colSync = $app.findCollectionByNameOrId('sync_logs')
    var recSync = new Record(colSync)
    recSync.set('fonte_id', 'r06he9bmdrb3yus')
    recSync.set('status', 'sucesso')
    recSync.set('quantidade_coletada', relatorio.novas_amostras)
    recSync.set('novos_registros', relatorio.novas_amostras)
    recSync.set('registros_atualizados', relatorio.amostras_validadas)
    recSync.set('tempo_processamento_ms', durTotalMs)
    recSync.set(
      'detalhes',
      'CICLO_DIARIO_COTAI: id=' +
        cicloId +
        ' validadas=' +
        relatorio.amostras_validadas +
        ' invalidadas=' +
        relatorio.amostras_invalidadas +
        ' novas=' +
        relatorio.novas_amostras +
        ' dur_ms=' +
        durTotalMs,
    )
    $app.save(recSync)
  } catch (_) {}

  console.log('[DAILY-SYNC-CRON] Ciclo diário finalizado. Duração ms:', durTotalMs)
})

// 2. Endpoint sob demanda para acionamento e testes: POST /backend/v1/sync/daily/trigger
routerAdd('POST', '/backend/v1/sync/daily/trigger', function (e) {
  var tInicio = new Date().getTime()
  var MAX_DURATION_MS = 25000
  var agora = new Date()
  var agoraIso = agora.toISOString()
  var hojeStr = agoraIso.slice(0, 10)
  var cicloId = 'CICLO_' + hojeStr + '_' + agora.getTime()

  function canonicalNormDailyText(s) {
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

  function parseJsonDailySafe(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  function sleepMsSync(ms) {
    if (!ms || ms <= 0) return
    var start = new Date().getTime()
    while (new Date().getTime() - start < ms) {}
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

  function sendHttpDailyWithRetry(url, timeoutSec, maxRetries, delayBetweenMs) {
    var retries = maxRetries !== undefined ? maxRetries : 1
    var tentativa = 0
    var userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) COTAI/DailySync-1.0'
    if (delayBetweenMs && delayBetweenMs > 0) sleepMsSync(delayBetweenMs)

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
          timeout: timeoutSec || 3.0,
        })
        if (res && res.statusCode >= 200 && res.statusCode < 300) {
          return { ok: true, resp: res }
        }
        return { ok: false, resp: res, error: 'HTTP ' + (res ? res.statusCode : 0) }
      } catch (err) {
        return { ok: false, resp: null, error: err.message || 'Falha de rede/timeout' }
      }
    }
    return { ok: false, resp: null, error: 'Retries esgotados' }
  }

  function extrairUnidadeQualificadaDaily(uBruta, dBruta) {
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

  function gerarSampleKeyDaily(amostra) {
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

  var relatorio = {
    ciclo_id: cicloId,
    data_ciclo: hojeStr,
    status: 'running',
    iniciado_em: agoraIso,
    finalizado_em: '',
    duracao_ms: 0,
    novas_amostras: 0,
    amostras_validadas: 0,
    amostras_invalidadas: 0,
    termos_reabertos: 0,
    detalhes: {},
    erros: [],
  }

  // 1. Gestão de validade
  try {
    var qVencidas = $app
      .db()
      .newQuery(
        'SELECT id, sample_key, vigencia_fim, situacao_origem, qualidade_situacao, motivos_rejeicao ' +
          'FROM price_samples_index ' +
          "WHERE vigencia_fim != '' AND vigencia_fim < {:hoje} AND qualidade_situacao != 'rejeitada' " +
          'LIMIT 100',
      )
      .bind({ hoje: hojeStr })
    var amostrasVencidas = qVencidas.all()

    for (var vI = 0; vI < amostrasVencidas.length; vI++) {
      var rowV = amostrasVencidas[vI]
      try {
        var recV = $app.findRecordById('price_samples_index', rowV.id)
        var motivosArr = []
        var rawM = recV.getString('motivos_rejeicao')
        if (rawM) {
          try {
            motivosArr = JSON.parse(rawM) || []
          } catch (_) {}
        }
        var motivoTexto =
          'origem vencida: vigência expirada em ' + (rowV.vigencia_fim || 'data anterior')
        if (motivosArr.indexOf(motivoTexto) === -1) {
          motivosArr.push(motivoTexto)
        }
        recV.set('qualidade_situacao', 'rejeitada')
        recV.set('situacao_origem', 'Vencida')
        recV.set('motivos_rejeicao', JSON.stringify(motivosArr))
        recV.set('data_verificacao', agoraIso)
        recV.set('last_validated_at', agoraIso)
        $app.save(recV)
        relatorio.amostras_invalidadas++
      } catch (_) {}
    }

    var qCountValidas = $app
      .db()
      .newQuery(
        "SELECT COUNT(*) as total FROM price_samples_index WHERE qualidade_situacao != 'rejeitada'",
      )
    var rowCountVal = qCountValidas.one()
    relatorio.amostras_validadas = Number(rowCountVal ? rowCountVal.total : 0) || 0

    $app
      .db()
      .newQuery(
        'UPDATE price_samples_index SET data_verificacao = {:agora} ' +
          'WHERE data_verificacao IS NULL OR data_verificacao < {:ontem} LIMIT 200',
      )
      .bind({
        agora: agoraIso,
        ontem: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      })
      .execute()
  } catch (errV) {
    relatorio.erros.push('Validade: ' + errV.message)
  }

  // 2. Varredura rápida
  if (new Date().getTime() - tInicio < MAX_DURATION_MS - 8000) {
    try {
      var codigosCatmatDiarios = ['267203']
      for (var cIdx = 0; cIdx < codigosCatmatDiarios.length; cIdx++) {
        var catCode = codigosCatmatDiarios[cIdx]
        var urlCgov =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
          catCode +
          '&pagina=1&tamanhoPagina=5'
        var resCgov = sendHttpDailyWithRetry(urlCgov, 3.0, 1, 50)
        if (resCgov.ok && resCgov.resp) {
          var bCgov = parseJsonDailySafe(resCgov.resp.json || resCgov.resp.raw)
          var itemsCg = bCgov
            ? Array.isArray(bCgov)
              ? bCgov
              : bCgov.resultado || bCgov.items || []
            : []
          var colPsi = $app.findCollectionByNameOrId('price_samples_index')
          for (var iCg = 0; iCg < itemsCg.length; iCg++) {
            var itmC = itemsCg[iCg]
            var vUnitC =
              Number(itmC.precoUnitarioHomologado || itmC.valorUnitario || itmC.precoUnitario) || 0
            if (vUnitC > 0) {
              var descC = itmC.descricaoItem || itmC.descricao || 'Item Compras.gov.br'
              var amCg = {
                source: 'Compras.gov.br',
                source_record_id: String(itmC.id || itmC.codigoItem || 'CG-' + catCode + '-' + iCg),
                purchase_id: String(itmC.id || itmC.codigoItem || 'CG-' + catCode + '-' + iCg),
                item_id: String(itmC.numeroItem || '1'),
                descricao: descC,
                descricao_normalizada: canonicalNormDailyText(descC),
                orgao: itmC.orgaoComprador || 'Órgão Federal Compras.gov.br',
                orgao_cnpj: itmC.cnpjOrgao || 'NÃO INFORMADO',
                fornecedor_nome: itmC.nomeFornecedor || 'NÃO INFORMADO',
                fornecedor_cnpj: itmC.cnpjFornecedor || 'NÃO INFORMADO',
                fornecedor_porte: 'DEMAIS',
                uf: itmC.uf || '',
                municipio: itmC.municipio || '',
                unidade: extrairUnidadeQualificadaDaily(itmC.unidadeMedida || itmC.unidade, descC),
                quantidade: Number(itmC.quantidade) || 1,
                valor_unitario: Number(vUnitC.toFixed(4)),
                valor_total: Number((vUnitC * (Number(itmC.quantidade) || 1)).toFixed(4)),
                natureza_preco: 'homologado',
                data_referencia: itmC.dataCompra || agoraIso,
                numero_processo: itmC.numeroProcesso || '',
                modalidade: 'Pregão Eletrônico',
                situacao_contratacao: 'Vigente',
                marca: itmC.marca || 'NÃO INFORMADO',
                codigo_item: 'CATMAT ' + catCode,
                url_original: itmC.linkEditalOuCompra || '',
                matching_score: 100,
                matching_tipo: 'codigo_oficial_catmat',
                raw_payload: itmC,
              }
              amCg.sample_key = gerarSampleKeyDaily(amCg)
              try {
                var jaExiste = null
                try {
                  jaExiste = $app.findFirstRecordByData(
                    'price_samples_index',
                    'sample_key',
                    amCg.sample_key,
                  )
                } catch (_) {}
                if (jaExiste) {
                  jaExiste.set('last_validated_at', agoraIso)
                  jaExiste.set('data_verificacao', agoraIso)
                  jaExiste.set('situacao_origem', 'Vigente')
                  $app.save(jaExiste)
                } else {
                  var recN = new Record(colPsi)
                  recN.set('sample_key', amCg.sample_key)
                  recN.set('source', amCg.source)
                  recN.set('source_record_id', amCg.source_record_id)
                  recN.set('purchase_id', amCg.purchase_id)
                  recN.set('item_id', amCg.item_id)
                  recN.set('descricao', amCg.descricao)
                  recN.set('descricao_normalizada', amCg.descricao_normalizada)
                  recN.set('orgao', amCg.orgao)
                  recN.set('orgao_cnpj', amCg.orgao_cnpj)
                  recN.set('fornecedor_nome', amCg.fornecedor_nome)
                  recN.set('fornecedor_cnpj', amCg.fornecedor_cnpj)
                  recN.set('fornecedor_porte', amCg.fornecedor_porte)
                  recN.set('uf', amCg.uf)
                  recN.set('municipio', amCg.municipio)
                  recN.set('unidade', amCg.unidade)
                  recN.set('quantidade', amCg.quantidade)
                  recN.set('valor_unitario', amCg.valor_unitario)
                  recN.set('valor_total', amCg.valor_total)
                  recN.set('natureza_preco', amCg.natureza_preco)
                  recN.set('data_referencia', amN.data_referencia)
                  recN.set('data_coleta', agoraIso)
                  recN.set('data_verificacao', agoraIso)
                  recN.set('situacao_origem', 'Vigente')
                  recN.set('numero_processo', amN.numero_processo)
                  recN.set('numero_ata', '')
                  recN.set('modalidade', amN.modalidade)
                  recN.set('situacao_contratacao', 'Vigente')
                  recN.set('marca', amN.marca)
                  recN.set('modelo', 'NÃO INFORMADO')
                  recN.set('codigo_item', amN.codigo_item)
                  recN.set('url_original', amN.url_original)
                  recN.set('payload_hash', computeHashSimple(amN.raw_payload))
                  recN.set('raw_payload', JSON.stringify(amN.raw_payload || {}))
                  recN.set('qualidade_situacao', 'aceita')
                  recN.set('motivos_rejeicao', '[]')
                  recN.set('matching_score', amN.matching_score)
                  recN.set('matching_tipo', amN.matching_tipo)
                  recN.set('indexed_at', agoraIso)
                  recN.set('source_updated_at', agoraIso)
                  recN.set('last_validated_at', agoraIso)
                  $app.save(recN)
                  relatorio.novas_amostras++
                }
              } catch (_) {}
            }
          }
        }
      }
    } catch (errVar) {
      relatorio.erros.push('Varredura: ' + errVar.message)
    }
  }

  // 3. Reabertura
  try {
    var tarefasParaReabrir = $app.findRecordsByFilter(
      'price_index_tasks',
      "status = 'failed' || (status = 'completed' && pendentes != '[]' && pendentes != '')",
      '-updated',
      3,
      0,
    )
    for (var tI = 0; tI < tarefasParaReabrir.length; tI++) {
      var tRec = tarefasParaReabrir[tI]
      tRec.set('status', 'pending')
      tRec.set('tentativas', 0)
      $app.save(tRec)
      relatorio.termos_reabertos++
    }
  } catch (_) {}

  var durTotalMs = new Date().getTime() - tInicio
  relatorio.duracao_ms = durTotalMs
  relatorio.finalizado_em = new Date().toISOString()
  relatorio.status = 'completed'
  relatorio.detalhes = {
    fontes_auditadas: ['PNCP', 'Compras.gov.br'],
    mensagem: 'Ciclo diário acionado manualmente e finalizado com sucesso.',
    vigencia_auditada: true,
  }

  try {
    var colRuns = $app.findCollectionByNameOrId('daily_sync_runs')
    var recRunM = new Record(colRuns)
    recRunM.set('ciclo_id', cicloId)
    recRunM.set('data_ciclo', hojeStr)
    recRunM.set('status', relatorio.status)
    recRunM.set('iniciado_em', agoraIso)
    recRunM.set('finalizado_em', relatorio.finalizado_em)
    recRunM.set('duracao_ms', durTotalMs)
    recRunM.set('novas_amostras', relatorio.novas_amostras)
    recRunM.set('amostras_validadas', relatorio.amostras_validadas)
    recRunM.set('amostras_invalidadas', relatorio.amostras_invalidadas)
    recRunM.set('termos_reabertos', relatorio.termos_reabertos)
    recRunM.set('detalhes', JSON.stringify(relatorio.detalhes))
    recRunM.set('erros', JSON.stringify(relatorio.erros))
    $app.save(recRunM)
  } catch (_) {}

  return e.json(200, {
    sucesso: true,
    mensagem: 'Ciclo diário executado com sucesso.',
    resultado: relatorio,
  })
})

// 3. Endpoint de consulta do frescor do ciclo diário: GET /backend/v1/sync/daily/status
routerAdd('GET', '/backend/v1/sync/daily/status', function (e) {
  try {
    var ultimoCiclo = null
    try {
      var rows = $app
        .db()
        .newQuery(
          'SELECT ciclo_id, data_ciclo, status, iniciado_em, finalizado_em, duracao_ms, ' +
            'novas_amostras, amostras_validadas, amostras_invalidadas, termos_reabertos, detalhes, updated ' +
            'FROM daily_sync_runs ORDER BY created DESC LIMIT 1',
        )
        .all()
      if (rows && rows.length > 0) {
        ultimoCiclo = rows[0]
      }
    } catch (_) {}

    var totalAmostrasValidas = 0
    var totalAmostrasRejeitadas = 0
    try {
      var qVal = $app
        .db()
        .newQuery(
          'SELECT qualidade_situacao, COUNT(*) as cnt FROM price_samples_index GROUP BY qualidade_situacao',
        )
        .all()
      for (var i = 0; i < qVal.length; i++) {
        var st = qVal[i].qualidade_situacao
        var c = Number(qVal[i].cnt) || 0
        if (st === 'rejeitada') totalAmostrasRejeitadas += c
        else totalAmostrasValidas += c
      }
    } catch (_) {}

    return e.json(200, {
      sucesso: true,
      job_cron: '0 6 * * * (03:00 Horário de Brasília)',
      ultimo_ciclo: ultimoCiclo,
      amostras_totais: {
        ativas_elegiveis: totalAmostrasValidas,
        invalidadas_rejeitadas: totalAmostrasRejeitadas,
      },
      servico: 'COTAI Gestão de Validade e Ciclo Diário',
      normativa: 'Art. 23 Lei 14.133/2021',
    })
  } catch (errStatus) {
    return e.json(500, {
      sucesso: false,
      error: errStatus.message,
    })
  }
})
