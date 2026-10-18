// Authenticated admission to the private server-owned worker queue.
routerAdd(
  'POST',
  '/backend/v1/cotai/index-task',
  function (e) {
    if (!e.auth || !e.auth.id) return e.json(401, { sucesso: false, error: 'AUTH_REQUIRED' })
    var body
    try {
      body = e.requestInfo().body || {}
    } catch (_) {
      return e.json(400, { sucesso: false, error: 'INVALID_BODY' })
    }
    var termo = typeof body.termo === 'string' ? body.termo.trim() : ''
    var source = typeof body.source === 'string' ? body.source.trim().toUpperCase() : ''
    var uf = typeof body.uf === 'string' ? body.uf.trim().toUpperCase() : ''
    if (
      termo.length < 2 ||
      termo.length > 200 ||
      (source !== 'PNCP' && source !== 'AMBAS') ||
      (uf && !/^[A-Z]{2}$/.test(uf))
    )
      return e.json(400, { sucesso: false, error: 'INVALID_TASK' })

    function normalize(value) {
      return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }
    var normalizedTerm = normalize(termo)
    if (normalizedTerm.length < 2) return e.json(400, { sucesso: false, error: 'INVALID_TASK' })
    var legacyTaskKey = source + '#' + normalizedTerm + '#' + (uf || 'ALL')
    // Queue state is private to its authenticated owner. Keeping the owner in the
    // unique key prevents one tenant from monopolising a term/UF for every other
    // tenant while the requested_by ACL remains strict.
    var taskKey = legacyTaskKey + '#OWNER#' + String(e.auth.id)
    function pncpControl(value, namespace) {
      var match =
        typeof value === 'string' && /^(\d{14})-([123])-(\d{6})\/(20\d{2}|21\d{2})$/.exec(value)
      if (!match || Number(match[3]) < 1 || (namespace && match[2] !== String(namespace)))
        return null
      return {
        c: match[1],
        n: match[2],
        s: Number(match[3]),
        a: Number(match[4]),
        controle: value,
      }
    }
    function validIdentity(p) {
      var c = String(p.c || p.cnpj || '')
      var a = Number(p.a || p.ano)
      var s = Number(p.s || p.sequencial)
      if (
        !/^\d{14}$/.test(c) ||
        !Number.isInteger(a) ||
        a < 2000 ||
        a > 2199 ||
        !Number.isInteger(s) ||
        s < 1 ||
        s > 999999
      )
        return null
      return { c: c, a: a, s: s }
    }
    function verifiedPurchase(p, identity) {
      var direct = pncpControl(p.numeroControlePNCP, 1)
      if (direct && direct.c === identity.c && direct.a === identity.a && direct.s === identity.s)
        return true
      var proof = p._pncp_compra
      var buy = proof && pncpControl(proof.controle, 1)
      if (
        !buy ||
        proof.v !== 1 ||
        !proof.prova ||
        proof.prova.compraControle !== buy.controle ||
        !proof.origem ||
        buy.c !== identity.c ||
        buy.a !== identity.a ||
        buy.s !== identity.s
      )
        return false
      var origin = pncpControl(proof.origem.controle)
      return (
        !!origin &&
        (proof.origem.tipo !== 'contrato' ||
          (origin.n === '2' && proof.prova.contratoControle === origin.controle))
      )
    }
    function relationRecoveryActionable(p, identity, nowMs) {
      if (p.t !== 'contrato' || p._pncp_compra || p.j !== undefined) return false
      if (Number(p.b || 0) !== 0 || Number(p.i || 0) !== 0) return false
      var expected = identity.c + '-2-' + String(identity.s).padStart(6, '0') + '/' + identity.a
      if (p.numeroControlePNCP && p.numeroControlePNCP !== expected) return false
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
        Object.keys(p).some(function (key) {
          return allowed.indexOf(key) < 0
        }) ||
        JSON.stringify(p).length > 2000
      )
        return false
      var op = p._pncp_relacao
      if (!op || op.v !== 1) return false
      var failures = Number(op.falhas)
      if (
        !Number.isInteger(failures) ||
        failures < 0 ||
        failures >= 4 ||
        op.quarentena === true ||
        (op.claim && Number(op.ate) > nowMs) ||
        Number(op.cooldown_ate || op.retry_after || 0) > nowMs
      )
        return false
      if (op.lastStatus === 'campos_compra_invalidos')
        return (
          Number(p.r || 0) === 0 &&
          Number(p.b || 0) === 0 &&
          Number(p.i || 0) === 0 &&
          failures === 0 &&
          p.numeroControlePNCP === expected
        )
      return (
        [
          'relacao_ausente',
          'contrato_http',
          'origem_nao_comprovada',
          'adiado',
          'resolvendo',
        ].indexOf(op.lastStatus) >= 0
      )
    }
    function discoveryActionable(p) {
      if (
        !p ||
        typeof p !== 'object' ||
        Array.isArray(p) ||
        Object.keys(p).length !== 1 ||
        !p._pncp_discovery ||
        typeof p._pncp_discovery !== 'object' ||
        Array.isArray(p._pncp_discovery)
      )
        return false
      var discovery = p._pncp_discovery
      if (!Object.prototype.hasOwnProperty.call(discovery, 'esgotados')) return false
      if (
        Object.keys(discovery).some(function (key) {
          return key !== 'esgotados'
        })
      )
        return false
      var exhausted = discovery.esgotados || {}
      if (!exhausted || typeof exhausted !== 'object' || Array.isArray(exhausted)) return false
      if (
        Object.keys(exhausted).some(function (key) {
          return (
            ['ata', 'edital', 'contrato'].indexOf(key) < 0 ||
            (exhausted[key] !== true && exhausted[key] !== false)
          )
        })
      )
        return false
      return !(exhausted.ata === true && exhausted.edital === true && exhausted.contrato === true)
    }
    function pendingEntryActionable(p, nowMs) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return false
      if (p._pncp_discovery) return discoveryActionable(p)
      var identity = validIdentity(p)
      if (!identity) return false
      var retries = p.r === undefined ? 0 : Number(p.r)
      if (!Number.isInteger(retries) || retries < 0 || retries >= 4) return false
      if (p.i !== undefined && (!Number.isInteger(Number(p.i)) || Number(p.i) < 0)) return false
      if (p.b !== undefined && (!Number.isInteger(Number(p.b)) || Number(p.b) < 0)) return false
      var operation = p._pncp_relacao
      if (operation) {
        var failures = Number(operation.falhas)
        if (
          operation.v !== 1 ||
          !Number.isInteger(failures) ||
          failures < 0 ||
          failures >= 4 ||
          operation.quarentena === true ||
          (operation.claim && Number(operation.ate) > nowMs) ||
          Number(operation.cooldown_ate || operation.retry_after || 0) > nowMs
        )
          return false
      }
      if (p.t === 'contrato' && !verifiedPurchase(p, identity))
        return relationRecoveryActionable(p, identity, nowMs)
      return ['ata', 'edital', 'contrato'].indexOf(String(p.t || 'ata')) >= 0
    }
    function hasActionablePending(raw, nowMs) {
      var pending
      try {
        pending = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch (_) {
        return false
      }
      // The durable queue admits at most 300 purchases and the worker appends one discovery
      // marker, so 301 is the largest legitimate persisted backlog.
      if (!Array.isArray(pending) || pending.length < 1 || pending.length > 301) return false
      return pending.some(function (entry) {
        return pendingEntryActionable(entry, nowMs)
      })
    }
    var result
    var rejection = null
    try {
      $app.runInTransaction(function (tx) {
        var record = null
        var legacyKeyMigrated = false
        try {
          record = tx.findFirstRecordByData('price_index_tasks', 'task_key', taskKey)
        } catch (_) {}
        // Compatibility for trusted tasks admitted before owner-qualified keys.
        // Only the recorded owner may migrate that row; ownerless or foreign rows
        // remain untouched and cannot prevent this caller from creating a new job.
        if (!record) {
          try {
            var legacyRecord = tx.findFirstRecordByData(
              'price_index_tasks',
              'task_key',
              legacyTaskKey,
            )
            if (
              legacyRecord.getString('server_trust_version') === 'server-v1' &&
              legacyRecord.getString('requested_by') === String(e.auth.id)
            ) {
              legacyRecord.set('task_key', taskKey)
              record = legacyRecord
              legacyKeyMigrated = true
            }
          } catch (_) {}
        }
        var trusted = record && record.getString('server_trust_version') === 'server-v1'

        // Idempotent reuse is deliberately evaluated before quota: refreshing or observing the
        // same normalized source/term/UF never creates additional queue work. A terminal task is
        // only rearmed by its owner (or when it is a legacy server-owned task) and only when its
        // preserved PNCP backlog is still valid and actionable.
        if (record && !trusted) {
          rejection = {
            status: 409,
            error: 'TASK_KEY_CONFLICT',
          }
          return
        }
        if (trusted) {
          var currentStatus = record.getString('status')
          var owner = record.getString('requested_by')
          if (!owner || owner !== String(e.auth.id)) {
            rejection = {
              status: 403,
              error: 'TASK_FORBIDDEN',
            }
            return
          }
          if (
            (currentStatus === 'failed' || currentStatus === 'completed') &&
            hasActionablePending(record.getString('pendentes'), new Date().getTime())
          ) {
            record.set('status', 'pending')
            tx.save(record)
            legacyKeyMigrated = false
            currentStatus = 'pending'
          }
          if (legacyKeyMigrated) tx.save(record)
          result = {
            id: record.id,
            termo: record.getString('termo'),
            status: currentStatus,
          }
          return
        }

        var now = new Date()
        var admittedAt = now.toISOString()
        var cutoff = new Date(now.getTime() - 60 * 1000).toISOString()
        function admissionCount(sql, params) {
          var row = new DynamicModel({ total: 0 })
          tx.db().newQuery(sql).bind(params).one(row)
          return Number(row.total) || 0
        }
        var recent = admissionCount(
          "SELECT COUNT(*) AS total FROM price_index_tasks WHERE server_trust_version = 'server-v1' " +
            'AND requested_by = {:user} AND julianday(admitted_at) >= julianday({:cutoff})',
          { user: String(e.auth.id), cutoff: cutoff },
        )
        if (recent >= 12) {
          rejection = {
            error: 'TASK_RATE_LIMITED',
            retry_after_seconds: 60,
          }
          return
        }
        var active = admissionCount(
          "SELECT COUNT(*) AS total FROM price_index_tasks WHERE server_trust_version = 'server-v1' " +
            "AND requested_by = {:user} AND status IN ('pending', 'running')",
          { user: String(e.auth.id) },
        )
        if (active >= 50) {
          rejection = {
            error: 'TASK_ACTIVE_QUOTA_EXCEEDED',
            retry_after_seconds: 60,
          }
          return
        }

        if (!record) record = new Record(tx.findCollectionByNameOrId('price_index_tasks'))
        record.set('task_key', taskKey)
        record.set('source', source)
        record.set('termo', termo)
        record.set('uf', uf)
        record.set('status', 'pending')
        record.set('pendentes', '[]')
        record.set('paginas_consultadas', 0)
        record.set('itens_processados', 0)
        record.set('amostras_inseridas', 0)
        record.set('amostras_atualizadas', 0)
        record.set('tentativas', 0)
        record.set('erros', '[]')
        record.set('started_at', '')
        record.set('finished_at', '')
        record.set('ultimo_erro', '')
        record.set('progress_at', null)
        record.set('requested_by', String(e.auth.id))
        record.set('admitted_at', admittedAt)
        record.set('server_trust_version', 'server-v1')
        tx.save(record)
        result = {
          id: record.id,
          termo: record.getString('termo'),
          status: record.getString('status'),
        }
      })
    } catch (_) {
      return e.json(503, { sucesso: false, error: 'TASK_ADMISSION_UNAVAILABLE' })
    }
    if (rejection)
      return e.json(rejection.status || 429, {
        sucesso: false,
        error: rejection.error,
        retry_after_seconds: rejection.retry_after_seconds || undefined,
      })
    return e.json(200, { sucesso: true, tarefa: result })
  },
  $apis.requireAuth(),
  $apis.bodyLimit(32 * 1024),
)
