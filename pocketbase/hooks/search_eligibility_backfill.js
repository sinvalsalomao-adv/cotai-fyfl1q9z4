// Backfill em lotes de price_samples_index.search_eligible, fora da janela de deploy.
// Cada tick avança um cursor por rowid (até BATCH linhas) e marca como pesquisáveis
// só as linhas com a prova v3 que index_batch.js sela. Quando alcança o fim da
// tabela, cria os índices de busca uma única vez.
// - Sem as colunas search_eligible/search_contract o tick não faz nada.
// - O PocketBase cria colunas NOT NULL com default 0/''; linhas já marcadas pelos
//   hooks de ingestão (search_contract != '') não são tocadas.
cronAdd('search_eligibility_backfill', '*/1 * * * *', () => {
  var BATCH = 1000
  var CURSOR_KEY = 'search_eligibility_rowid'
  var INDEXES_KEY = 'search_eligibility_indexes'

  function scalar(sql, binds) {
    var row = new DynamicModel({ value: 0 })
    try {
      var q = $app.db().newQuery(sql)
      if (binds) q = q.bind(binds)
      q.one(row)
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
    var ready = scalar(
      "SELECT COUNT(*) AS value FROM pragma_table_info('price_samples_index') " +
        "WHERE name IN ('search_eligible', 'search_contract')",
    )
    if (ready < 2) return

    var cursor = scalar('SELECT value FROM cotai_maintenance_state WHERE key = {:key}', {
      key: CURSOR_KEY,
    })
    var upper = scalar(
      'SELECT COALESCE(MAX(rowid), 0) AS value FROM (' +
        'SELECT rowid FROM price_samples_index WHERE rowid > {:cursor} ORDER BY rowid LIMIT ' +
        BATCH +
        ')',
      { cursor: cursor },
    )

    if (upper > cursor) {
      $app.runInTransaction((txApp) => {
        txApp
          .db()
          .newQuery(
            "UPDATE price_samples_index SET search_eligible = 1, search_contract = 'cotai-official-price-v3' " +
              'WHERE rowid > {:cursor} AND rowid <= {:upper}' +
              " AND COALESCE(search_contract, '') = ''" +
              " AND server_trust_version = 'server-v1'" +
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
              " AND payload_hash NOT GLOB '*[^0-9a-f]*'",
          )
          .bind({ cursor: cursor, upper: upper })
          .execute()
        writeState(txApp.db(), CURSOR_KEY, upper)
      })
      console.log('[SEARCH-BACKFILL] linhas ate rowid ' + upper + ' processadas')
      return
    }

    // Tabela toda processada: cria os índices de busca uma única vez.
    if (
      scalar('SELECT value FROM cotai_maintenance_state WHERE key = {:key}', {
        key: INDEXES_KEY,
      }) === 1
    )
      return
    // Os índices de busca NÃO são criados aqui: CREATE INDEX em price_samples_index
    // segura o lock de escrita por muito tempo e fica para uma etapa controlada.
    writeState($app.db(), INDEXES_KEY, 1)
    console.log('[SEARCH-BACKFILL] backfill concluido; indices de busca pendentes de etapa propria')
  } catch (err) {
    console.log('[SEARCH-BACKFILL] falha no lote: ' + (err && err.message ? err.message : err))
  }
})
