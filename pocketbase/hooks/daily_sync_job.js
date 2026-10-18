// Ciclo Diário de Sincronização Completa e Gestão de Validade na Plataforma COTAI
// Executado diariamente de madrugada (03:00 Horário de Brasília / 06:00 UTC) via cronAdd: "0 6 * * *"
// Endpoint acionável sob demanda para auditoria e testes: POST /backend/v1/sync/daily/trigger e GET /backend/v1/sync/daily/status
//
// RESPONSABILIDADES DO CICLO:
// 1. GESTÃO DE VALIDADE (Regra crítica do usuário):
//    - Verifica as amostras da base cuja vigência expirou ou cuja situação na origem mudou
//      (ata cancelada/revogada, contrato encerrado, vigência expirada).
//    - Marca amostra como qualidade_situacao = 'rejeitada' com motivo explicativo em motivos_rejeicao
//      (ex: "origem vencida: vigência expirada em YYYY-MM-DD") e atualiza situacao_origem = 'Vencida'.
//    - NUNCA deleta (rastreabilidade e auditoria da Lei 14.133/2021), mas exclui da busca de preços elegíveis.
// 2. REGISTRO DE FRESCOR E AUDITORIA:
// A coleta e a retomada de tarefas são exclusivas do fluxo BUSCAR, que preserva prova e acknowledgement.
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

  function extrairCodigoItemDaily(rawCodigo) {
    if (!rawCodigo) return ''
    var raw = String(rawCodigo).trim()
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
          "WHERE server_trust_version = 'server-v1' AND vigencia_fim != '' AND vigencia_fim < {:hoje} AND qualidade_situacao != 'rejeitada' " +
          'LIMIT 500',
      )
      .bind({ hoje: hojeStr })
    var amostrasVencidas = arrayOf(
      new DynamicModel({
        id: '',
        sample_key: '',
        vigencia_fim: '',
        situacao_origem: '',
        qualidade_situacao: '',
        motivos_rejeicao: '',
      }),
    )
    qVencidas.all(amostrasVencidas)

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
          "WHERE server_trust_version = 'server-v1' AND qualidade_situacao != 'rejeitada' AND (" +
          "LOWER(situacao_contratacao) LIKE '%cancelad%' OR " +
          "LOWER(situacao_contratacao) LIKE '%revogad%' OR " +
          "LOWER(situacao_contratacao) LIKE '%rescindid%' OR " +
          "LOWER(situacao_contratacao) LIKE '%anulad%') " +
          'LIMIT 300',
      )
    var amostrasRevogadas = arrayOf(
      new DynamicModel({
        id: '',
        situacao_contratacao: '',
        qualidade_situacao: '',
        motivos_rejeicao: '',
      }),
    )
    qRevogadas.all(amostrasRevogadas)
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
        "SELECT COUNT(*) as total FROM price_samples_index WHERE server_trust_version = 'server-v1' " +
          "AND source IN ('PNCP','Compras.gov.br') AND valor_unitario > 0 " +
          "AND search_eligible = 1 AND search_contract = 'cotai-official-price-v3'",
      )
    var rowCountVal = new DynamicModel({ total: 0 })
    qCountValidas.one(rowCountVal)
    relatorio.amostras_validadas = Number(rowCountVal.total) || 0

    $app
      .db()
      .newQuery(
        'UPDATE price_samples_index SET data_verificacao = {:agora} WHERE id IN (SELECT id ' +
          "FROM price_samples_index WHERE server_trust_version = 'server-v1' " +
          'AND (data_verificacao IS NULL OR data_verificacao < {:ontem}) LIMIT 500)',
      )
      .bind({
        agora: agoraIso,
        ontem: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      })
      .execute()
  } catch (errV) {
    relatorio.erros.push('Validade: ' + errV.message)
  }

  // 2. Coleta autônoma desativada
  // DAILY_LEGACY_COLLECTION_DISABLED_PROOF_ACK_V1
  // Os caminhos antigos não produziam proveniência verificável nem acknowledgement.
  // BUSCAR aciona os adaptadores oficiais PNCP e Compras.gov.br para o termo solicitado.
  // 3. Reabertura autônoma desativada
  // DAILY_AUTONOMOUS_REOPEN_DISABLED_V1
  // Uma nova BUSCAR cria ou retoma somente a tarefa do termo corrente.
  var durTotalMs = new Date().getTime() - tInicio
  relatorio.duracao_ms = durTotalMs
  relatorio.finalizado_em = new Date().toISOString()
  relatorio.status = relatorio.erros.length > 0 ? 'completed_with_errors' : 'completed'
  relatorio.detalhes = {
    fontes_auditadas: ['PNCP', 'Compras.gov.br'],
    mensagem: 'Ciclo diário de validade concluído; coleta autônoma permanece desativada.',
    vigencia_auditada: true,
    coleta_autonoma: 'desativada_sem_contrato_de_prova',
    coleta_autoritativa: 'BUSCAR_PNCP_COMPRAS_PROVA_ACK',
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
routerAdd(
  'POST',
  '/backend/v1/sync/daily/trigger',
  function (e) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
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
            "WHERE server_trust_version = 'server-v1' AND vigencia_fim != '' AND vigencia_fim < {:hoje} AND qualidade_situacao != 'rejeitada' " +
            'LIMIT 100',
        )
        .bind({ hoje: hojeStr })
      var amostrasVencidas = arrayOf(
        new DynamicModel({
          id: '',
          sample_key: '',
          vigencia_fim: '',
          situacao_origem: '',
          qualidade_situacao: '',
          motivos_rejeicao: '',
        }),
      )
      qVencidas.all(amostrasVencidas)

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
          "SELECT COUNT(*) as total FROM price_samples_index WHERE server_trust_version = 'server-v1' " +
            "AND source IN ('PNCP','Compras.gov.br') AND valor_unitario > 0 " +
            "AND search_eligible = 1 AND search_contract = 'cotai-official-price-v3'",
        )
      var rowCountVal = new DynamicModel({ total: 0 })
      qCountValidas.one(rowCountVal)
      relatorio.amostras_validadas = Number(rowCountVal.total) || 0

      $app
        .db()
        .newQuery(
          'UPDATE price_samples_index SET data_verificacao = {:agora} WHERE id IN (SELECT id ' +
            "FROM price_samples_index WHERE server_trust_version = 'server-v1' " +
            'AND (data_verificacao IS NULL OR data_verificacao < {:ontem}) LIMIT 200)',
        )
        .bind({
          agora: agoraIso,
          ontem: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        })
        .execute()
    } catch (errV) {
      relatorio.erros.push('Validade: ' + errV.message)
    }

    // 2. Coleta legada do gatilho desativada
    // DAILY_LEGACY_COLLECTION_DISABLED_PROOF_ACK_V1
    // O gatilho preserva a manutenção de validade; a coleta ocorre apenas via BUSCAR.
    // 3. Reabertura autônoma desativada
    // DAILY_AUTONOMOUS_REOPEN_DISABLED_V1
    // Uma nova BUSCAR cria ou retoma somente a tarefa do termo corrente.
    var durTotalMs = new Date().getTime() - tInicio
    relatorio.duracao_ms = durTotalMs
    relatorio.finalizado_em = new Date().toISOString()
    relatorio.status = 'completed'
    relatorio.detalhes = {
      fontes_auditadas: ['PNCP', 'Compras.gov.br'],
      mensagem: 'Validade acionada manualmente; coleta autônoma permanece desativada.',
      vigencia_auditada: true,
      coleta_autonoma: 'desativada_sem_contrato_de_prova',
      coleta_autoritativa: 'BUSCAR_PNCP_COMPRAS_PROVA_ACK',
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
  },
  $apis.requireAuth(),
)

// 3. Endpoint de consulta do frescor do ciclo diário: GET /backend/v1/sync/daily/status
routerAdd(
  'GET',
  '/backend/v1/sync/daily/status',
  function (e) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
    try {
      var ultimoCiclo = null
      try {
        var rows = arrayOf(
          new DynamicModel({
            ciclo_id: '',
            data_ciclo: '',
            status: '',
            iniciado_em: '',
            finalizado_em: '',
            duracao_ms: 0,
            novas_amostras: 0,
            amostras_validadas: 0,
            amostras_invalidadas: 0,
            termos_reabertos: 0,
            detalhes: '',
            updated: '',
          }),
        )
        $app
          .db()
          .newQuery(
            'SELECT ciclo_id, data_ciclo, status, iniciado_em, finalizado_em, duracao_ms, ' +
              'novas_amostras, amostras_validadas, amostras_invalidadas, termos_reabertos, detalhes, updated ' +
              'FROM daily_sync_runs ORDER BY created DESC LIMIT 1',
          )
          .all(rows)
        if (rows && rows.length > 0) {
          ultimoCiclo = rows[0]
        }
      } catch (_) {}

      var totalAmostrasValidas = 0
      var totalAmostrasRejeitadas = 0
      try {
        var qVal = arrayOf(new DynamicModel({ qualidade_situacao: '', cnt: 0 }))
        $app
          .db()
          .newQuery(
            "SELECT CASE WHEN search_eligible = 1 THEN 'aceita' ELSE 'rejeitada' END AS qualidade_situacao, COUNT(*) as cnt FROM price_samples_index " +
              "WHERE server_trust_version = 'server-v1' AND source IN ('PNCP','Compras.gov.br') AND valor_unitario > 0 " +
              "AND search_contract = 'cotai-official-price-v3' GROUP BY search_eligible",
          )
          .all(qVal)
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
  },
  $apis.requireAuth(),
)
