// Backfill em lotes de price_samples_index.search_eligible, fora da janela de deploy.
// A migration 1741634526 só cria as colunas; aqui cada tick marca até BATCH linhas
// antigas (rowid > cursor) e, quando alcança o fim da tabela, cria os índices de busca.
// Linhas novas já chegam marcadas pelos hooks de ingestão e não são tocadas
// (o UPDATE só altera search_eligible IS NULL). Lote de 1000 linhas por minuto.
cronAdd('search_eligibility_backfill', '*/1 * * * *', () => {
  var BATCH = 1000
  var CURSOR_KEY = 'search_eligibility_rowid'
  var INDEXES_KEY = 'search_eligibility_indexes'

  function readState(key) {
    var row = new DynamicModel({ value: 0 })
    try {
      $app
        .db()
        .newQuery('SELECT value FROM cotai_maintenance_state WHERE key = {:key}')
        .bind({ key: key })
        .one(row)
      return row.value
    } catch (_) {
      return 0
    }
  }
  function writeState(db, key, value) {
    db.newQuery(
      'INSERT INTO cotai_maintenance_state (key, value) VALUES ({:key}, {:value}) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
      .bind({ key: key, value: value })
      .execute()
  }

  try {
    var cursor = readState(CURSOR_KEY)
    var upper = new DynamicModel({ value: 0 })
    $app
      .db()
      .newQuery(
        'SELECT COALESCE(MAX(rowid), 0) AS value FROM (' +
          'SELECT rowid FROM price_samples_index WHERE rowid > {:cursor} ORDER BY rowid LIMIT ' +
          BATCH +
          ')',
      )
      .bind({ cursor: cursor })
      .one(upper)

    if (upper.value > cursor) {
      $app.runInTransaction((txApp) => {
        // Mesma prova v3 que index_batch.js sela: só linhas confiáveis e assinadas.
        var eligible =
          "server_trust_version = 'server-v1'" +
          " AND source IN ('PNCP', 'Compras.gov.br')" +
          ' AND valor_unitario > 0' +
          " AND COALESCE(qualidade_situacao, '') != 'rejeitada'" +
          ' AND json_valid(raw_payload)' +
          " AND json_extract(raw_payload, '$.proveniencia_preco.status') = 'verificada'" +
          " AND json_extract(raw_payload, '$.proveniencia_preco.fonte') = source" +
          " AND CAST(json_extract(raw_payload, '$.proveniencia_preco.valor_unitario') AS REAL) = valor_unitario" +
          " AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.contrato') = 'cotai-official-price-v3'" +
          " AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.fonte') = source" +
          " AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.sample_key') = sample_key" +
          " AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.source_record_id') = source_record_id" +
          " AND json_extract(raw_payload, '$.proveniencia_preco.validacao_indice.assinatura') = payload_hash" +
          ' AND length(payload_hash) = 64' +
          ' AND lower(payload_hash) = payload_hash' +
          " AND payload_hash NOT GLOB '*[^0-9a-f]*'"
        txApp
          .db()
          .newQuery(
            'UPDATE price_samples_index SET ' +
              'search_eligible = CASE WHEN ' +
              eligible +
              ' THEN 1 ELSE 0 END, ' +
              'search_contract = CASE WHEN ' +
              eligible +
              " THEN 'cotai-official-price-v3' ELSE '' END " +
              'WHERE rowid > {:cursor} AND rowid <= {:upper} AND search_eligible IS NULL',
          )
          .bind({ cursor: cursor, upper: upper.value })
          .execute()
        writeState(txApp.db(), CURSOR_KEY, upper.value)
      })
      console.log('[SEARCH-BACKFILL] linhas ate rowid ' + upper.value + ' processadas')
      return
    }

    // Tabela toda processada: cria os índices de busca uma única vez.
    if (readState(INDEXES_KEY) === 1) return
    var statements = [
      'CREATE INDEX IF NOT EXISTS idx_psi_searchable_source_value ON price_samples_index(search_eligible, search_contract, source, valor_unitario, id)',
      'CREATE INDEX IF NOT EXISTS idx_psi_searchable_uf_value ON price_samples_index(search_eligible, search_contract, uf, valor_unitario, id)',
      'CREATE INDEX IF NOT EXISTS idx_psi_searchable_date ON price_samples_index(search_eligible, search_contract, data_referencia DESC, id)',
    ]
    for (var i = 0; i < statements.length; i++) $app.db().newQuery(statements[i]).execute()
    writeState($app.db(), INDEXES_KEY, 1)
    console.log('[SEARCH-BACKFILL] backfill concluido e indices de busca criados')
  } catch (err) {
    console.log('[SEARCH-BACKFILL] falha no lote: ' + (err && err.message ? err.message : err))
  }
})
