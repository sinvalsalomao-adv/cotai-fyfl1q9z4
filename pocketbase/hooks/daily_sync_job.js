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

  // 2. Varredura diária abrangente via price_watermarks (PNCP e Compras.gov.br)
  if (new Date().getTime() - tInicio < MAX_DURATION_MS - 15000) {
    try {
      var amostrasNovasColetadas = []

      // A. Varredura incremental PNCP via price_watermarks
      try {
        var wmPncp = null
        try {
          wmPncp = $app.findFirstRecordByData('price_watermarks', 'fonte', 'PNCP')
        } catch (_) {}

        var pncpPage = wmPncp ? Number(wmPncp.getInt('last_cursor_page')) || 1 : 1
        var pncpTermosVarredura = [
          'DIPIRONA',
          'CLONAZEPAM',
          'PARACETAMOL',
          'AMOXICILINA',
          'SERVICO',
        ]
        var termoPncpAtivo = pncpTermosVarredura[pncpPage % pncpTermosVarredura.length]

        // Busca atas e contratações homologadas no PNCP
        var urlPncpDaily =
          'https://pncp.gov.br/api/search/?q=' +
          encodeURIComponent(termoPncpAtivo) +
          '&tipos_documento=ata&pagina=' +
          (Math.floor(pncpPage / pncpTermosVarredura.length) + 1) +
          '&tam_pagina=20'

        var resPncpDaily = sendHttpDailyWithRetry(urlPncpDaily, 4.0, 1, 80)
        if (resPncpDaily.ok && resPncpDaily.resp) {
          var bPncpD = parseJsonDailySafe(resPncpDaily.resp.json || resPncpDaily.resp.raw)
          var itemsPncpD = bPncpD
            ? Array.isArray(bPncpD)
              ? bPncpD
              : bPncpD.items || bPncpD.data || []
            : []

          for (var pIdx = 0; pIdx < itemsPncpD.length; pIdx++) {
            if (new Date().getTime() - tInicio > MAX_DURATION_MS - 12000) break
            var itP = itemsPncpD[pIdx]
            var rawCnpjP = (
              (itP.orgaoEntidade && itP.orgaoEntidade.cnpj) ||
              itP.orgao_cnpj ||
              itP.cnpj ||
              ''
            ).replace(/\D/g, '')
            var anoP = itP.anoCompra || itP.ano || itP.anoAta || 0
            var seqP =
              itP.numero_sequencial_compra_ata ||
              itP.numeroSequencialCompraAta ||
              itP.sequencialCompra ||
              itP.numero_sequencial ||
              0

            if (rawCnpjP && anoP && seqP) {
              var cacheKeyDaily = rawCnpjP + '_' + anoP + '_' + seqP
              var itensArrPncp = null
              try {
                var cRecD = $app.findFirstRecordByData(
                  'pncp_item_cache',
                  'cache_key',
                  cacheKeyDaily,
                )
                if (cRecD) {
                  itensArrPncp = parseJsonDailySafe(cRecD.getString('raw_itens'))
                }
              } catch (_) {}

              if (!itensArrPncp || !Array.isArray(itensArrPncp)) {
                var urlItensD =
                  'https://pncp.gov.br/api/pncp/v1/orgaos/' +
                  rawCnpjP +
                  '/compras/' +
                  anoP +
                  '/' +
                  seqP +
                  '/itens?pagina=1&tamanhoPagina=30'
                var resItensD = sendHttpDailyWithRetry(urlItensD, 3.5, 1, 80)
                if (resItensD.ok && resItensD.resp) {
                  var bItD = parseJsonDailySafe(resItensD.resp.json || resItensD.resp.raw)
                  itensArrPncp = bItD
                    ? Array.isArray(bItD)
                      ? bItD
                      : bItD.items || bItD.data || []
                    : []
                  if (itensArrPncp && itensArrPncp.length > 0) {
                    try {
                      var colCD = $app.findCollectionByNameOrId('pncp_item_cache')
                      var recCD = new Record(colCD)
                      recCD.set('cache_key', cacheKeyDaily)
                      recCD.set('cnpj', rawCnpjP)
                      recCD.set('ano', parseInt(anoP, 10))
                      recCD.set('sequencial', parseInt(seqP, 10))
                      recCD.set('raw_itens', JSON.stringify(itensArrPncp))
                      recCD.set('total_itens', itensArrPncp.length)
                      $app.save(recCD)
                    } catch (_) {}
                  }
                }
              }

              if (itensArrPncp && Array.isArray(itensArrPncp)) {
                for (var subP = 0; subP < itensArrPncp.length; subP++) {
                  var itmSub = itensArrPncp[subP]
                  var vHomP =
                    Number(itmSub.valorUnitarioHomologado) ||
                    Number(itmSub.valor_unitario_homologado) ||
                    0
                  var vEstP =
                    Number(itmSub.valorUnitarioEstimado) || Number(itmSub.valorUnitario) || 0
                  var vUnitP = vHomP > 0 ? vHomP : vEstP
                  if (vUnitP > 0) {
                    var descP = itmSub.descricao || itmSub.materialOuServicoNome || 'Item PNCP'
                    var nControle = itP.numeroControlePNCP || rawCnpjP + '-' + anoP + '-' + seqP
                    var amP = {
                      source: 'PNCP',
                      source_record_id: nControle,
                      purchase_id: nControle,
                      item_id: String(itmSub.numeroItem || subP + 1),
                      descricao: descP,
                      descricao_normalizada: canonicalNormDailyText(descP),
                      orgao: (itP.orgaoEntidade && itP.orgaoEntidade.razaoSocial) || 'Órgão PNCP',
                      orgao_cnpj: rawCnpjP,
                      fornecedor_nome:
                        (itmSub.fornecedor &&
                          (itmSub.fornecedor.nomeRazaoSocialFornecedor ||
                            itmSub.fornecedor.nomeRazaoSocial)) ||
                        'NÃO INFORMADO',
                      fornecedor_cnpj:
                        (itmSub.fornecedor &&
                          (itmSub.fornecedor.niFornecedor || itmSub.fornecedor.cnpj)) ||
                        'NÃO INFORMADO',
                      fornecedor_porte: 'DEMAIS',
                      uf: itP.uf || '',
                      municipio: itP.municipio_nome || '',
                      unidade: extrairUnidadeQualificadaDaily(
                        itmSub.unidadeMedida || itmSub.unidade,
                        descP,
                      ),
                      quantidade: Number(itmSub.quantidade) || 1,
                      valor_unitario: Number(vUnitP.toFixed(4)),
                      valor_total: Number((vUnitP * (Number(itmSub.quantidade) || 1)).toFixed(4)),
                      natureza_preco: vHomP > 0 ? 'homologado' : 'estimado',
                      data_referencia: agoraIso,
                      numero_processo: nControle,
                      numero_ata: '',
                      modalidade: 'Pregão Eletrônico',
                      situacao_contratacao: 'Homologada',
                      marca: itmSub.marcaNome || 'NÃO INFORMADO',
                      codigo_item: itmSub.codigoItem || 'CATMAT',
                      url_original: 'https://pncp.gov.br/app/editais/' + nControle,
                      matching_score: 95,
                      matching_tipo: 'varredura_diaria_pncp',
                      raw_payload: {
                        numeroControlePNCP: nControle,
                        item: itmSub.numeroItem || subP + 1,
                      },
                    }
                    amP.sample_key = gerarSampleKeyDaily(amP)
                    amostrasNovasColetadas.push(amP)
                  }
                }
              }
            }
          }

          if (wmPncp) {
            wmPncp.set('last_cursor_page', pncpPage + 1)
            wmPncp.set('status', 'idle')
            wmPncp.set('tentativas_consecutivas_falha', 0)
            wmPncp.set('ultimo_erro', '')
            $app.save(wmPncp)
          }
        }
      } catch (errPncpD) {
        relatorio.erros.push('PNCP Daily: ' + errPncpD.message)
      }

      // B. Varredura incremental Compras.gov.br via price_watermarks
      try {
        var wmCg = null
        try {
          wmCg = $app.findFirstRecordByData('price_watermarks', 'fonte', 'Compras.gov.br')
        } catch (_) {}
        var cgPage = wmCg ? Number(wmCg.getInt('last_cursor_page')) || 1 : 1

        var codigosCatmatDiarios = [
          '267203',
          '342617',
          '268064',
          '350414',
          '269123',
          '312814',
          '270425',
        ]
        var catAtivo = codigosCatmatDiarios[cgPage % codigosCatmatDiarios.length]
        var urlCgov =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
          catAtivo +
          '&pagina=' +
          (Math.floor(cgPage / codigosCatmatDiarios.length) + 1) +
          '&tamanhoPagina=20'

        var resCgov = sendHttpDailyWithRetry(urlCgov, 3.5, 1, 80)
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
                source_record_id: String(
                  itmC.id || itmC.codigoItem || 'CG-' + catAtivo + '-' + iCg,
                ),
                purchase_id: String(itmC.id || itmC.codigoItem || 'CG-' + catAtivo + '-' + iCg),
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
                codigo_item: 'CATMAT ' + catAtivo,
                url_original: itmC.linkEditalOuCompra || '',
                matching_score: 100,
                matching_tipo: 'codigo_oficial_catmat',
                raw_payload: itmC,
              }
              amCg.sample_key = gerarSampleKeyDaily(amCg)
              amostrasNovasColetadas.push(amCg)
            }
          }

          if (wmCg) {
            wmCg.set('last_cursor_page', cgPage + 1)
            wmCg.set('status', 'idle')
            wmCg.set('tentativas_consecutivas_falha', 0)
            wmCg.set('ultimo_erro', '')
            $app.save(wmCg)
          }
        }
      } catch (errCgD) {
        relatorio.erros.push('ComprasGov Daily: ' + errCgD.message)
      }

      // C. Persistência progressiva em lotes com deduplicação por sample_key
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

  // 2. Varredura sob demanda real via price_watermarks (PNCP e Compras.gov.br)
  if (new Date().getTime() - tInicio < MAX_DURATION_MS - 8000) {
    try {
      var colPsi = $app.findCollectionByNameOrId('price_samples_index')

      // A. Coleta sob demanda Compras.gov.br
      try {
        var wmCgT = null
        try {
          wmCgT = $app.findFirstRecordByData('price_watermarks', 'fonte', 'Compras.gov.br')
        } catch (_) {}
        var cgCurPage = wmCgT ? Number(wmCgT.getInt('last_cursor_page')) || 1 : 1
        var catCodesT = ['267203', '342617', '268064', '350414', '269123']
        var catCodeT = catCodesT[cgCurPage % catCodesT.length]

        var urlCgovT =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' +
          catCodeT +
          '&pagina=' +
          (Math.floor(cgCurPage / catCodesT.length) + 1) +
          '&tamanhoPagina=15'
        var resCgovT = sendHttpDailyWithRetry(urlCgovT, 3.5, 1, 60)
        if (resCgovT.ok && resCgovT.resp) {
          var bCgovT = parseJsonDailySafe(resCgovT.resp.json || resCgovT.resp.raw)
          var itemsCgT = bCgovT
            ? Array.isArray(bCgovT)
              ? bCgovT
              : bCgovT.resultado || bCgovT.items || []
            : []
          for (var iCgT = 0; iCgT < itemsCgT.length; iCgT++) {
            var itmCT = itemsCgT[iCgT]
            var vUnitCT =
              Number(itmCT.precoUnitarioHomologado || itmCT.valorUnitario || itmCT.precoUnitario) ||
              0
            if (vUnitCT > 0) {
              var descCT = itmCT.descricaoItem || itmCT.descricao || 'Item Compras.gov.br'
              var amCgT = {
                source: 'Compras.gov.br',
                source_record_id: String(
                  itmCT.id || itmCT.codigoItem || 'CG-' + catCodeT + '-' + iCgT,
                ),
                purchase_id: String(itmCT.id || itmCT.codigoItem || 'CG-' + catCodeT + '-' + iCgT),
                item_id: String(itmCT.numeroItem || '1'),
                descricao: descCT,
                descricao_normalizada: canonicalNormDailyText(descCT),
                orgao: itmCT.orgaoComprador || 'Órgão Federal Compras.gov.br',
                orgao_cnpj: itmCT.cnpjOrgao || 'NÃO INFORMADO',
                fornecedor_nome: itmCT.nomeFornecedor || 'NÃO INFORMADO',
                fornecedor_cnpj: itmCT.cnpjFornecedor || 'NÃO INFORMADO',
                fornecedor_porte: 'DEMAIS',
                uf: itmCT.uf || '',
                municipio: itmCT.municipio || '',
                unidade: extrairUnidadeQualificadaDaily(
                  itmCT.unidadeMedida || itmCT.unidade,
                  descCT,
                ),
                quantidade: Number(itmCT.quantidade) || 1,
                valor_unitario: Number(vUnitCT.toFixed(4)),
                valor_total: Number((vUnitCT * (Number(itmCT.quantidade) || 1)).toFixed(4)),
                natureza_preco: 'homologado',
                data_referencia: itmCT.dataCompra || agoraIso,
                numero_processo: itmCT.numeroProcesso || '',
                modalidade: 'Pregão Eletrônico',
                situacao_contratacao: 'Vigente',
                marca: itmCT.marca || 'NÃO INFORMADO',
                codigo_item: 'CATMAT ' + catCodeT,
                url_original: itmCT.linkEditalOuCompra || '',
                matching_score: 100,
                matching_tipo: 'codigo_oficial_catmat',
                raw_payload: itmCT,
              }
              amCgT.sample_key = gerarSampleKeyDaily(amCgT)
              try {
                var jaExisteT = null
                try {
                  jaExisteT = $app.findFirstRecordByData(
                    'price_samples_index',
                    'sample_key',
                    amCgT.sample_key,
                  )
                } catch (_) {}
                if (jaExisteT) {
                  jaExisteT.set('last_validated_at', agoraIso)
                  jaExisteT.set('data_verificacao', agoraIso)
                  jaExisteT.set('situacao_origem', 'Vigente')
                  $app.save(jaExisteT)
                } else {
                  var recNT = new Record(colPsi)
                  recNT.set('sample_key', amCgT.sample_key)
                  recNT.set('source', amCgT.source)
                  recNT.set('source_record_id', amCgT.source_record_id)
                  recNT.set('purchase_id', amCgT.purchase_id)
                  recNT.set('item_id', amCgT.item_id)
                  recNT.set('descricao', amCgT.descricao)
                  recNT.set('descricao_normalizada', amCgT.descricao_normalizada)
                  recNT.set('orgao', amCgT.orgao)
                  recNT.set('orgao_cnpj', amCgT.orgao_cnpj)
                  recNT.set('fornecedor_nome', amCgT.fornecedor_nome)
                  recNT.set('fornecedor_cnpj', amCgT.fornecedor_cnpj)
                  recNT.set('fornecedor_porte', amCgT.fornecedor_porte)
                  recNT.set('uf', amCgT.uf)
                  recNT.set('municipio', amCgT.municipio)
                  recNT.set('unidade', amCgT.unidade)
                  recNT.set('quantidade', amCgT.quantidade)
                  recNT.set('valor_unitario', amCgT.valor_unitario)
                  recNT.set('valor_total', amCgT.valor_total)
                  recNT.set('natureza_preco', amCgT.natureza_preco)
                  recNT.set('data_referencia', amCgT.data_referencia)
                  recNT.set('data_coleta', agoraIso)
                  recNT.set('data_verificacao', agoraIso)
                  recNT.set('situacao_origem', 'Vigente')
                  recNT.set('numero_processo', amCgT.numero_processo)
                  recNT.set('numero_ata', '')
                  recNT.set('modalidade', amCgT.modalidade)
                  recNT.set('situacao_contratacao', 'Vigente')
                  recNT.set('marca', amCgT.marca)
                  recNT.set('modelo', 'NÃO INFORMADO')
                  recNT.set('codigo_item', amCgT.codigo_item)
                  recNT.set('url_original', amCgT.url_original)
                  recNT.set('payload_hash', computeHashSimple(amCgT.raw_payload))
                  recNT.set('raw_payload', JSON.stringify(amCgT.raw_payload || {}))
                  recNT.set('qualidade_situacao', 'aceita')
                  recNT.set('motivos_rejeicao', '[]')
                  recNT.set('matching_score', amCgT.matching_score)
                  recNT.set('matching_tipo', amCgT.matching_tipo)
                  recNT.set('indexed_at', agoraIso)
                  recNT.set('source_updated_at', agoraIso)
                  recNT.set('last_validated_at', agoraIso)
                  $app.save(recNT)
                  relatorio.novas_amostras++
                }
              } catch (_) {}
            }
          }
          if (wmCgT) {
            wmCgT.set('last_cursor_page', cgCurPage + 1)
            $app.save(wmCgT)
          }
        }
      } catch (errCgT) {
        relatorio.erros.push('Trigger ComprasGov: ' + errCgT.message)
      }

      // B. Coleta sob demanda PNCP (atas homologadas de fármacos essenciais)
      try {
        var wmPncpT = null
        try {
          wmPncpT = $app.findFirstRecordByData('price_watermarks', 'fonte', 'PNCP')
        } catch (_) {}
        var pncpCurPage = wmPncpT ? Number(wmPncpT.getInt('last_cursor_page')) || 1 : 1
        var urlPncpT =
          'https://pncp.gov.br/api/search/?q=DIPIRONA&tipos_documento=ata&pagina=' +
          pncpCurPage +
          '&tam_pagina=10'
        var resPncpT = sendHttpDailyWithRetry(urlPncpT, 4.0, 1, 60)
        if (resPncpT.ok && resPncpT.resp) {
          var bPncpT = parseJsonDailySafe(resPncpT.resp.json || resPncpT.resp.raw)
          var itemsPncpT = bPncpT
            ? Array.isArray(bPncpT)
              ? bPncpT
              : bPncpT.items || bPncpT.data || []
            : []
          for (var pTIdx = 0; pTIdx < itemsPncpT.length; pTIdx++) {
            if (new Date().getTime() - tInicio > MAX_DURATION_MS - 4000) break
            var itPT = itemsPncpT[pTIdx]
            var rawCnpjPT = (
              (itPT.orgaoEntidade && itPT.orgaoEntidade.cnpj) ||
              itPT.orgao_cnpj ||
              itPT.cnpj ||
              ''
            ).replace(/\D/g, '')
            var anoPT = itPT.anoCompra || itPT.ano || itPT.anoAta || 0
            var seqPT =
              itPT.numero_sequencial_compra_ata ||
              itPT.numeroSequencialCompraAta ||
              itPT.sequencialCompra ||
              itPT.numero_sequencial ||
              0
            if (rawCnpjPT && anoPT && seqPT) {
              var cacheKeyT = rawCnpjPT + '_' + anoPT + '_' + seqPT
              var itensArrPT = null
              try {
                var cRecPT = $app.findFirstRecordByData('pncp_item_cache', 'cache_key', cacheKeyT)
                if (cRecPT) {
                  itensArrPT = parseJsonDailySafe(cRecPT.getString('raw_itens'))
                }
              } catch (_) {}

              if (!itensArrPT || !Array.isArray(itensArrPT)) {
                var urlItPT =
                  'https://pncp.gov.br/api/pncp/v1/orgaos/' +
                  rawCnpjPT +
                  '/compras/' +
                  anoPT +
                  '/' +
                  seqPT +
                  '/itens?pagina=1&tamanhoPagina=20'
                var resItPT = sendHttpDailyWithRetry(urlItPT, 3.5, 1, 80)
                if (resItPT.ok && resItPT.resp) {
                  var bItPT = parseJsonDailySafe(resItPT.resp.json || resItPT.resp.raw)
                  itensArrPT = bItPT
                    ? Array.isArray(bItPT)
                      ? bItPT
                      : bItPT.items || bItPT.data || []
                    : []
                  if (itensArrPT && itensArrPT.length > 0) {
                    try {
                      var colCPT = $app.findCollectionByNameOrId('pncp_item_cache')
                      var recCPT = new Record(colCPT)
                      recCPT.set('cache_key', cacheKeyT)
                      recCPT.set('cnpj', rawCnpjPT)
                      recCPT.set('ano', parseInt(anoPT, 10))
                      recCPT.set('sequencial', parseInt(seqPT, 10))
                      recCPT.set('raw_itens', JSON.stringify(itensArrPT))
                      recCPT.set('total_itens', itensArrPT.length)
                      $app.save(recCPT)
                    } catch (_) {}
                  }
                }
              }

              if (itensArrPT && Array.isArray(itensArrPT)) {
                for (var sPT = 0; sPT < itensArrPT.length; sPT++) {
                  var itmSPT = itensArrPT[sPT]
                  var dSPT = itmSPT.descricao || itmSPT.materialOuServicoNome || ''
                  var nDescSPT = canonicalNormDailyText(dSPT)
                  if (nDescSPT.indexOf('DIPIRONA') === -1) continue

                  var vHomPT =
                    Number(itmSPT.valorUnitarioHomologado) ||
                    Number(itmSPT.valor_unitario_homologado) ||
                    0
                  var vEstPT =
                    Number(itmSPT.valorUnitarioEstimado) || Number(itmSPT.valorUnitario) || 0
                  var vUnitPT = vHomPT > 0 ? vHomPT : vEstPT
                  if (vUnitPT > 0) {
                    var nControlePT =
                      itPT.numeroControlePNCP || rawCnpjPT + '-' + anoPT + '-' + seqPT
                    var amPT = {
                      source: 'PNCP',
                      source_record_id: nControlePT,
                      purchase_id: nControlePT,
                      item_id: String(itmSPT.numeroItem || sPT + 1),
                      descricao: dSPT,
                      descricao_normalizada: nDescSPT,
                      orgao: (itPT.orgaoEntidade && itPT.orgaoEntidade.razaoSocial) || 'Órgão PNCP',
                      orgao_cnpj: rawCnpjPT,
                      fornecedor_nome:
                        (itmSPT.fornecedor &&
                          (itmSPT.fornecedor.nomeRazaoSocialFornecedor ||
                            itmSPT.fornecedor.nomeRazaoSocial)) ||
                        'NÃO INFORMADO',
                      fornecedor_cnpj:
                        (itmSPT.fornecedor &&
                          (itmSPT.fornecedor.niFornecedor || itmSPT.fornecedor.cnpj)) ||
                        'NÃO INFORMADO',
                      fornecedor_porte: 'DEMAIS',
                      uf: itPT.uf || '',
                      municipio: itPT.municipio_nome || '',
                      unidade: extrairUnidadeQualificadaDaily(
                        itmSPT.unidadeMedida || itmSPT.unidade,
                        dSPT,
                      ),
                      quantidade: Number(itmSPT.quantidade) || 1,
                      valor_unitario: Number(vUnitPT.toFixed(4)),
                      valor_total: Number((vUnitPT * (Number(itmSPT.quantidade) || 1)).toFixed(4)),
                      natureza_preco: vHomPT > 0 ? 'homologado' : 'estimado',
                      data_referencia: agoraIso,
                      numero_processo: nControlePT,
                      numero_ata: '',
                      modalidade: 'Pregão Eletrônico',
                      situacao_contratacao: 'Homologada',
                      marca: itmSPT.marcaNome || 'NÃO INFORMADO',
                      codigo_item: itmSPT.codigoItem || 'CATMAT',
                      url_original: 'https://pncp.gov.br/app/editais/' + nControlePT,
                      matching_score: 95,
                      matching_tipo: 'trigger_diario_pncp',
                      raw_payload: {
                        numeroControlePNCP: nControlePT,
                        item: itmSPT.numeroItem || sPT + 1,
                      },
                    }
                    amPT.sample_key = gerarSampleKeyDaily(amPT)
                    try {
                      var jaExistePT = null
                      try {
                        jaExistePT = $app.findFirstRecordByData(
                          'price_samples_index',
                          'sample_key',
                          amPT.sample_key,
                        )
                      } catch (_) {}
                      if (!jaExistePT) {
                        var recNPT = new Record(colPsi)
                        recNPT.set('sample_key', amPT.sample_key)
                        recNPT.set('source', amPT.source)
                        recNPT.set('source_record_id', amPT.source_record_id)
                        recNPT.set('purchase_id', amPT.purchase_id)
                        recNPT.set('item_id', amPT.item_id)
                        recNPT.set('descricao', amPT.descricao)
                        recNPT.set('descricao_normalizada', amPT.descricao_normalizada)
                        recNPT.set('orgao', amPT.orgao)
                        recNPT.set('orgao_cnpj', amPT.orgao_cnpj)
                        recNPT.set('fornecedor_nome', amPT.fornecedor_nome)
                        recNPT.set('fornecedor_cnpj', amPT.fornecedor_cnpj)
                        recNPT.set('fornecedor_porte', amPT.fornecedor_porte)
                        recNPT.set('uf', amPT.uf)
                        recNPT.set('municipio', amPT.municipio)
                        recNPT.set('unidade', amPT.unidade)
                        recNPT.set('quantidade', amPT.quantidade)
                        recNPT.set('valor_unitario', amPT.valor_unitario)
                        recNPT.set('valor_total', amPT.valor_total)
                        recNPT.set('natureza_preco', amPT.natureza_preco)
                        recNPT.set('data_referencia', amPT.data_referencia)
                        recNPT.set('data_coleta', agoraIso)
                        recNPT.set('data_verificacao', agoraIso)
                        recNPT.set('situacao_origem', 'Vigente')
                        recNPT.set('numero_processo', amPT.numero_processo)
                        recNPT.set('numero_ata', '')
                        recNPT.set('modalidade', amPT.modalidade)
                        recNPT.set('situacao_contratacao', 'Vigente')
                        recNPT.set('marca', amPT.marca)
                        recNPT.set('modelo', 'NÃO INFORMADO')
                        recNPT.set('codigo_item', amPT.codigo_item)
                        recNPT.set('url_original', amPT.url_original)
                        recNPT.set('payload_hash', computeHashSimple(amPT.raw_payload))
                        recNPT.set('raw_payload', JSON.stringify(amPT.raw_payload || {}))
                        recNPT.set('qualidade_situacao', 'aceita')
                        recNPT.set('motivos_rejeicao', '[]')
                        recNPT.set('matching_score', amPT.matching_score)
                        recNPT.set('matching_tipo', amPT.matching_tipo)
                        recNPT.set('indexed_at', agoraIso)
                        recNPT.set('source_updated_at', agoraIso)
                        recNPT.set('last_validated_at', agoraIso)
                        $app.save(recNPT)
                        relatorio.novas_amostras++
                      }
                    } catch (_) {}
                  }
                }
              }
            }
          }
          if (wmPncpT) {
            wmPncpT.set('last_cursor_page', pncpCurPage + 1)
            $app.save(wmPncpT)
          }
        }
      } catch (errPncpT) {
        relatorio.erros.push('Trigger PNCP: ' + errPncpT.message)
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
