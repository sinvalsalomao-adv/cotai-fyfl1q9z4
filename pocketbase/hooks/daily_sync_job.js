// Daily scheduling and bounded local validity maintenance; collection belongs to the source worker.
// Every callback is self-contained: PocketBase serializes them into isolated JSVM contexts.
// Local maintenance and a scheduled cycle are never proof of an official source check.
cronAdd('daily_sync_job_cron', '0 6 * * *', function (e) {
  if (e && (!e.auth || !e.auth.id)) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
  var start = Date.now(),
    now = new Date().toISOString(),
    day = now.slice(0, 10)
  var requested = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
  var cycleId = 'CICLO_AUTONOMOUS_V1_' + day,
    recRun = null,
    errors = [],
    invalidated = 0
  var deadline = start + (e ? 25000 : 55000)

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
          active.checked_count === active.new_count + active.updated_count + active.unchanged_count
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
    $app.runInTransaction(function (tx) {
      try {
        recRun = tx.findFirstRecordByData('daily_sync_runs', 'ciclo_id', cycleId)
      } catch (_) {}
      if (recRun) {
        var existingDetails = dailyJson(recRun.getString('detalhes'))
        if (existingDetails.contract !== 'autonomous-daily-v1' || existingDetails.version !== 1)
          throw new Error('DAILY_STATE_VERSION')
        return
      }
      recRun = new Record(tx.findCollectionByNameOrId('daily_sync_runs'))
      recRun.set('ciclo_id', cycleId)
      recRun.set('data_ciclo', day)
      recRun.set('status', 'queued')
      recRun.set('iniciado_em', now)
      recRun.set('finalizado_em', '')
      recRun.set('duracao_ms', 0)
      recRun.set('novas_amostras', 0)
      recRun.set('amostras_validadas', 0)
      recRun.set('amostras_invalidadas', 0)
      recRun.set('termos_reabertos', 0)
      recRun.set(
        'detalhes',
        JSON.stringify({
          version: 1,
          contract: 'autonomous-daily-v1',
          requested_through: requested,
        }),
      )
      recRun.set('erros', '[]')
      tx.save(recRun)
    })
  } catch (errRun) {
    if (e) return e.json(500, { sucesso: false, error: 'DAILY_STATE_UNAVAILABLE' })
    console.log('[DAILY-SYNC] Failed to persist daily intent:', String(errRun.message || errRun))
    return
  }
  // Only the migration-owned versioned rows may receive intent. Merge the latest row in a transaction.
  ;['PNCP', 'Compras.gov.br'].forEach(function (source) {
    try {
      $app.runInTransaction(function (tx) {
        var rows = tx.findRecordsByFilter(
          'price_watermarks',
          'fonte = {:source} && cursor_tipo = "autonomous-v1"',
          '',
          2,
          0,
          { source: source },
        )
        if (rows.length !== 1) throw new Error('SOURCE_STATE_UNAVAILABLE')
        var rec = tx.findRecordById('price_watermarks', rows[0].id),
          raw = rec.getString('detalhes')
        if (!raw || raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
        var state = dailyJson(raw)
        if (
          state.version !== 1 ||
          state.source !== source ||
          !state.lanes ||
          typeof state.lanes !== 'object' ||
          Array.isArray(state.lanes)
        )
          throw new Error('SOURCE_STATE_VERSION')
        if (!state.requested_through || state.requested_through < requested) {
          state.requested_through = requested
          rec.set('detalhes', JSON.stringify(state))
          tx.save(rec)
        }
      })
    } catch (err) {
      errors.push(dailyPublicError(err.message || err))
    }
  })
  // Bounded local maintenance changes eligibility only, never official fetch/validation timestamps.
  try {
    var expired = arrayOf(new DynamicModel({ id: '' }))
    $app
      .db()
      .newQuery(
        "SELECT id FROM price_samples_index WHERE server_trust_version = 'server-v1' AND (" +
          "(qualidade_situacao = 'rejeitada' AND search_eligible = 1) OR " +
          "((qualidade_situacao != 'rejeitada' OR search_eligible = 1) AND (" +
          "(vigencia_fim != '' AND vigencia_fim < {:hoje}) OR LOWER(situacao_contratacao) LIKE '%cancelad%' OR " +
          "LOWER(situacao_contratacao) LIKE '%revogad%' OR LOWER(situacao_contratacao) LIKE '%rescindid%' OR LOWER(situacao_contratacao) LIKE '%anulad%'))) LIMIT 500",
      )
      .bind({ hoje: day })
      .all(expired)
    for (var i = 0; i < expired.length && Date.now() < deadline; i++) {
      try {
        $app.runInTransaction(function (tx) {
          var rec = tx.findRecordById('price_samples_index', expired[i].id)
          if (rec.getString('server_trust_version') !== 'server-v1') return
          var end = rec.getString('vigencia_fim'),
            situation = rec.getString('situacao_contratacao')
          var isExpired = end && end < day,
            revoked = /cancelad|revogad|rescindid|anulad/i.test(situation)
          if (!isExpired && !revoked && rec.getString('qualidade_situacao') !== 'rejeitada') return
          var reasons = dailyJson(rec.getString('motivos_rejeicao'))
          if (!Array.isArray(reasons)) reasons = []
          var reason = revoked
            ? 'origem revogada/cancelada: ' + situation
            : isExpired
              ? 'origem vencida: vigência expirada em ' + end
              : ''
          if (reason && reasons.indexOf(reason) < 0) reasons.push(reason)
          var changed =
            rec.getString('qualidade_situacao') !== 'rejeitada' ||
            rec.getInt('search_eligible') === 1
          rec.set('qualidade_situacao', 'rejeitada')
          rec.set('search_eligible', false)
          if (reason) {
            rec.set('situacao_origem', revoked ? 'Revogada' : 'Vencida')
            rec.set('motivos_rejeicao', JSON.stringify(reasons))
          }
          tx.save(rec)
          if (changed) invalidated++
        })
      } catch (errRow) {
        errors.push('DAILY_VALIDITY_FAILED')
      }
    }
  } catch (errExpiry) {
    errors.push('DAILY_VALIDITY_FAILED')
  }
  try {
    $app.runInTransaction(function (tx) {
      recRun = tx.findRecordById('daily_sync_runs', recRun.id)
      recRun.set('amostras_invalidadas', recRun.getInt('amostras_invalidadas') + invalidated)
      recRun.set('duracao_ms', recRun.getInt('duracao_ms') + Date.now() - start)
      recRun.set('erros', JSON.stringify(errors))
      var summary = dailyRunSummary(recRun)
      if (!summary) throw new Error('DAILY_STATE_VERSION')
      ;['status', 'finalizado_em', 'novas_amostras', 'amostras_validadas'].forEach(function (key) {
        recRun.set(key, summary[key])
      })
      tx.save(recRun)
    })
  } catch (errSave) {
    if (e) return e.json(500, { sucesso: false, error: 'DAILY_STATE_UNAVAILABLE' })
    console.log('[DAILY-SYNC] Failed to persist daily status:', String(errSave.message || errSave))
    return
  }
  var summary = dailyRunSummary(recRun)
  if (e)
    return e.json(200, {
      sucesso: true,
      mensagem: 'Intenção diária registrada; consulte o andamento da verificação oficial.',
      resultado: summary,
    })
})

routerAdd(
  'POST',
  '/backend/v1/sync/daily/trigger',
  function (e) {
    if (e && (!e.auth || !e.auth.id)) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
    var start = Date.now(),
      now = new Date().toISOString(),
      day = now.slice(0, 10)
    var requested = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
    var cycleId = 'CICLO_AUTONOMOUS_V1_' + day,
      recRun = null,
      errors = [],
      invalidated = 0
    var deadline = start + (e ? 25000 : 55000)

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
      $app.runInTransaction(function (tx) {
        try {
          recRun = tx.findFirstRecordByData('daily_sync_runs', 'ciclo_id', cycleId)
        } catch (_) {}
        if (recRun) {
          var existingDetails = dailyJson(recRun.getString('detalhes'))
          if (existingDetails.contract !== 'autonomous-daily-v1' || existingDetails.version !== 1)
            throw new Error('DAILY_STATE_VERSION')
          return
        }
        recRun = new Record(tx.findCollectionByNameOrId('daily_sync_runs'))
        recRun.set('ciclo_id', cycleId)
        recRun.set('data_ciclo', day)
        recRun.set('status', 'queued')
        recRun.set('iniciado_em', now)
        recRun.set('finalizado_em', '')
        recRun.set('duracao_ms', 0)
        recRun.set('novas_amostras', 0)
        recRun.set('amostras_validadas', 0)
        recRun.set('amostras_invalidadas', 0)
        recRun.set('termos_reabertos', 0)
        recRun.set(
          'detalhes',
          JSON.stringify({
            version: 1,
            contract: 'autonomous-daily-v1',
            requested_through: requested,
          }),
        )
        recRun.set('erros', '[]')
        tx.save(recRun)
      })
    } catch (errRun) {
      if (e) return e.json(500, { sucesso: false, error: 'DAILY_STATE_UNAVAILABLE' })
      console.log('[DAILY-SYNC] Failed to persist daily intent:', String(errRun.message || errRun))
      return
    }
    // Only the migration-owned versioned rows may receive intent. Merge the latest row in a transaction.
    ;['PNCP', 'Compras.gov.br'].forEach(function (source) {
      try {
        $app.runInTransaction(function (tx) {
          var rows = tx.findRecordsByFilter(
            'price_watermarks',
            'fonte = {:source} && cursor_tipo = "autonomous-v1"',
            '',
            2,
            0,
            { source: source },
          )
          if (rows.length !== 1) throw new Error('SOURCE_STATE_UNAVAILABLE')
          var rec = tx.findRecordById('price_watermarks', rows[0].id),
            raw = rec.getString('detalhes')
          if (!raw || raw.length > 64000) throw new Error('SOURCE_STATE_SIZE')
          var state = dailyJson(raw)
          if (
            state.version !== 1 ||
            state.source !== source ||
            !state.lanes ||
            typeof state.lanes !== 'object' ||
            Array.isArray(state.lanes)
          )
            throw new Error('SOURCE_STATE_VERSION')
          if (!state.requested_through || state.requested_through < requested) {
            state.requested_through = requested
            rec.set('detalhes', JSON.stringify(state))
            tx.save(rec)
          }
        })
      } catch (err) {
        errors.push(dailyPublicError(err.message || err))
      }
    })
    // Bounded local maintenance changes eligibility only, never official fetch/validation timestamps.
    try {
      var expired = arrayOf(new DynamicModel({ id: '' }))
      $app
        .db()
        .newQuery(
          "SELECT id FROM price_samples_index WHERE server_trust_version = 'server-v1' AND (" +
            "(qualidade_situacao = 'rejeitada' AND search_eligible = 1) OR " +
            "((qualidade_situacao != 'rejeitada' OR search_eligible = 1) AND (" +
            "(vigencia_fim != '' AND vigencia_fim < {:hoje}) OR LOWER(situacao_contratacao) LIKE '%cancelad%' OR " +
            "LOWER(situacao_contratacao) LIKE '%revogad%' OR LOWER(situacao_contratacao) LIKE '%rescindid%' OR LOWER(situacao_contratacao) LIKE '%anulad%'))) LIMIT 500",
        )
        .bind({ hoje: day })
        .all(expired)
      for (var i = 0; i < expired.length && Date.now() < deadline; i++) {
        try {
          $app.runInTransaction(function (tx) {
            var rec = tx.findRecordById('price_samples_index', expired[i].id)
            if (rec.getString('server_trust_version') !== 'server-v1') return
            var end = rec.getString('vigencia_fim'),
              situation = rec.getString('situacao_contratacao')
            var isExpired = end && end < day,
              revoked = /cancelad|revogad|rescindid|anulad/i.test(situation)
            if (!isExpired && !revoked && rec.getString('qualidade_situacao') !== 'rejeitada')
              return
            var reasons = dailyJson(rec.getString('motivos_rejeicao'))
            if (!Array.isArray(reasons)) reasons = []
            var reason = revoked
              ? 'origem revogada/cancelada: ' + situation
              : isExpired
                ? 'origem vencida: vigência expirada em ' + end
                : ''
            if (reason && reasons.indexOf(reason) < 0) reasons.push(reason)
            var changed =
              rec.getString('qualidade_situacao') !== 'rejeitada' ||
              rec.getInt('search_eligible') === 1
            rec.set('qualidade_situacao', 'rejeitada')
            rec.set('search_eligible', false)
            if (reason) {
              rec.set('situacao_origem', revoked ? 'Revogada' : 'Vencida')
              rec.set('motivos_rejeicao', JSON.stringify(reasons))
            }
            tx.save(rec)
            if (changed) invalidated++
          })
        } catch (errRow) {
          errors.push('DAILY_VALIDITY_FAILED')
        }
      }
    } catch (errExpiry) {
      errors.push('DAILY_VALIDITY_FAILED')
    }
    try {
      $app.runInTransaction(function (tx) {
        recRun = tx.findRecordById('daily_sync_runs', recRun.id)
        recRun.set('amostras_invalidadas', recRun.getInt('amostras_invalidadas') + invalidated)
        recRun.set('duracao_ms', recRun.getInt('duracao_ms') + Date.now() - start)
        recRun.set('erros', JSON.stringify(errors))
        var summary = dailyRunSummary(recRun)
        if (!summary) throw new Error('DAILY_STATE_VERSION')
        ;['status', 'finalizado_em', 'novas_amostras', 'amostras_validadas'].forEach(
          function (key) {
            recRun.set(key, summary[key])
          },
        )
        tx.save(recRun)
      })
    } catch (errSave) {
      if (e) return e.json(500, { sucesso: false, error: 'DAILY_STATE_UNAVAILABLE' })
      console.log(
        '[DAILY-SYNC] Failed to persist daily status:',
        String(errSave.message || errSave),
      )
      return
    }
    var summary = dailyRunSummary(recRun)
    if (e)
      return e.json(200, {
        sucesso: true,
        mensagem: 'Intenção diária registrada; consulte o andamento da verificação oficial.',
        resultado: summary,
      })
  },
  $apis.requireAuth(),
)

routerAdd(
  'GET',
  '/backend/v1/sync/daily/status',
  function (e) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })

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
      var latest = $app.findRecordsByFilter(
        'daily_sync_runs',
        'ciclo_id ~ "CICLO_AUTONOMOUS_V1_"',
        '-data_ciclo',
        1,
        0,
      )
      var summary = latest.length ? dailyRunSummary(latest[0]) : null
      var sources = summary
        ? summary.fontes
        : { PNCP: dailySource('PNCP'), 'Compras.gov.br': dailySource('Compras.gov.br') }
      var active = null,
        rejected = null
      try {
        var inventory = arrayOf(new DynamicModel({ qualidade_situacao: '', cnt: 0 }))
        $app
          .db()
          .newQuery(
            "SELECT CASE WHEN search_eligible = 1 AND COALESCE(qualidade_situacao,'') != 'rejeitada' THEN 'aceita' ELSE 'rejeitada' END AS qualidade_situacao, COUNT(*) AS cnt FROM price_samples_index " +
              "WHERE server_trust_version = 'server-v1' AND source IN ('PNCP','Compras.gov.br') AND valor_unitario > 0 AND search_contract = 'cotai-official-price-v3' GROUP BY search_eligible, qualidade_situacao",
          )
          .all(inventory)
        active = 0
        rejected = 0
        inventory.forEach(function (row) {
          if (row.qualidade_situacao === 'aceita') active += Number(row.cnt) || 0
          else rejected += Number(row.cnt) || 0
        })
      } catch (_) {}
      return e.json(200, {
        sucesso: true,
        job_cron: '0 6 * * * (03:00 Horário de Brasília)',
        ultimo_ciclo: summary,
        frescor_sincronizacao: sources,
        amostras_totais: { ativas_elegiveis: active, invalidadas_rejeitadas: rejected },
        coverage: 'partial',
        servico: 'COTAI Gestão de Validade e Ciclo Diário',
        normativa: 'Art. 23 Lei 14.133/2021',
      })
    } catch (err) {
      return e.json(500, { sucesso: false, error: 'DAILY_STATUS_UNAVAILABLE' })
    }
  },
  $apis.requireAuth(),
)
