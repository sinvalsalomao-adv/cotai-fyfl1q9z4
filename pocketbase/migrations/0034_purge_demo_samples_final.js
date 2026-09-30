/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Migration 0034: PURGA DEFINITIVA DE TODAS AS AMOSTRAS DEMO / SINTÉTICAS
    // Executa via SQL direto (app.db().newQuery(...).execute()), 100% da base, sem paginação de memória.
    // Preserva integralmente todas as amostras reais oficiais (PNCP real com CNPJ no edital,
    // Compras.gov.br real, BPS real e referenciais como CMED, SINAPI, SICRO, CONAB).

    try {
      console.log('[Migration 0034] Iniciando purga definitiva de amostras demo sintéticas...')

      // Expressão WHERE comum para identificar budget_price_results sintéticos
      const whereBudgetSynthetic = `
        source_record_id LIKE 'PNCP-CONTRATO-%'
        OR source_record_id LIKE 'BPS-COMPRA-%'
        OR source_record_id LIKE 'COMPRAS-PE-%'
        OR source_record_id LIKE 'BEC-OC-%'
        OR source_record_id LIKE 'DEMO-%'
        OR source_record_id LIKE 'FAKE-%'
        OR source_record_id LIKE 'SINTETICO-%'
        OR source_url LIKE '%pncp.gov.br/app/contratos/%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90145-%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90210-%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90333-%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90412-%'
        OR source_url LIKE '%bps.saude.gov.br/consultas/contrato/449102%'
        OR source_url LIKE '%bps.saude.gov.br/consultas/contrato/331200%'
        OR source_url LIKE '%bps.saude.gov.br/consultas/contrato/4412%'
        OR source_url LIKE '%bec.sp.gov.br/bec_pregao_ui/contrato/11094%'
        OR supplier_document = '12.345.678/0001-90'
        OR supplier_document = '99.888.777/0001-66'
        OR source = 'BASE_DEMONSTRATIVA_SINTETICA'
        OR source = 'DEMO'
        OR raw_data LIKE '%"is_demo":true%'
        OR raw_data LIKE '%"is_demo": true%'
        OR raw_data LIKE '%"is_demo":1%'
        OR raw_data LIKE '%"BASE_DEMONSTRATIVA_SINTETICA"%'
      `

      // 1. Limpar tabela de seleções (budget_selected_prices) apontando para amostras sintéticas
      app
        .db()
        .newQuery(
          `DELETE FROM budget_selected_prices 
           WHERE price_result_id IN (
             SELECT id FROM budget_price_results WHERE ${whereBudgetSynthetic}
           )
           OR price_result_id NOT IN (
             SELECT id FROM budget_price_results
           )`,
        )
        .execute()

      // 2. Limpar tabela de expurgos (budget_expurgated_prices) apontando para amostras sintéticas
      app
        .db()
        .newQuery(
          `DELETE FROM budget_expurgated_prices 
           WHERE price_result_id IN (
             SELECT id FROM budget_price_results WHERE ${whereBudgetSynthetic}
           )
           OR price_result_id NOT IN (
             SELECT id FROM budget_price_results
           )`,
        )
        .execute()

      // 3. Deletar definitivamente os registros sintéticos de budget_price_results
      app
        .db()
        .newQuery(
          `DELETE FROM budget_price_results 
           WHERE ${whereBudgetSynthetic}`,
        )
        .execute()

      // 4. Limpar tabela quotation_price_records de registros sintéticos
      const whereQuotationSynthetic = `
        source_record_id LIKE 'PNCP-CONTRATO-%'
        OR source_record_id LIKE 'BPS-COMPRA-%'
        OR source_record_id LIKE 'COMPRAS-PE-%'
        OR source_record_id LIKE 'BEC-OC-%'
        OR source_record_id LIKE 'DEMO-%'
        OR source_record_id LIKE 'FAKE-%'
        OR source_record_id LIKE 'SINTETICO-%'
        OR source_identifier LIKE 'PNCP-CONTRATO-%'
        OR source_identifier LIKE 'BPS-COMPRA-%'
        OR source_identifier LIKE 'COMPRAS-PE-%'
        OR source_identifier LIKE 'BEC-OC-%'
        OR source_identifier LIKE 'DEMO-%'
        OR source_identifier LIKE 'FAKE-%'
        OR source_identifier LIKE 'SINTETICO-%'
        OR source_identifier LIKE 'REF-ECOM-%'
        OR source_url LIKE '%pncp.gov.br/app/contratos/%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90145-%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90210-%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90333-%'
        OR source_url LIKE '%dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90412-%'
        OR source_url LIKE '%bps.saude.gov.br/consultas/contrato/449102%'
        OR source_url LIKE '%bps.saude.gov.br/consultas/contrato/331200%'
        OR source_url LIKE '%bps.saude.gov.br/consultas/contrato/4412%'
        OR supplier_cnpj = '12.345.678/0001-90'
        OR supplier_cnpj = '99.888.777/0001-66'
        OR supplier LIKE '%MEDFARMA%'
        OR fonte = 'BASE_DEMONSTRATIVA_SINTETICA'
        OR fonte = 'DEMO'
        OR original_payload LIKE '%"is_demo":true%'
        OR original_payload LIKE '%"is_demo": true%'
        OR original_payload LIKE '%"is_demo":1%'
      `

      app
        .db()
        .newQuery(
          `DELETE FROM quotation_price_records 
           WHERE ${whereQuotationSynthetic}`,
        )
        .execute()

      // 5. Limpar referências em quotation_outliers órfãs
      app
        .db()
        .newQuery(
          `DELETE FROM quotation_outliers 
           WHERE price_record_id NOT IN (
             SELECT id FROM quotation_price_records
           )`,
        )
        .execute()

      // 6. Atualizar a contagem de cotações válidas em budget_items
      app
        .db()
        .newQuery(
          `UPDATE budget_items 
           SET quotation_count = (
             SELECT COUNT(*) FROM budget_price_results 
             WHERE budget_price_results.budget_item_id = budget_items.id
           )`,
        )
        .execute()

      // 7. Atualizar status dos budget_items: se ficou com 0 cotações, marcar 'sem_cotacoes' ou 'pendente'
      app
        .db()
        .newQuery(
          `UPDATE budget_items 
           SET status = 'sem_cotacoes'
           WHERE quotation_count = 0 AND status = 'cotado'`,
        )
        .execute()

      // 8. Limpar estatísticas órfãs de itens que ficaram sem nenhuma amostra
      app
        .db()
        .newQuery(
          `DELETE FROM budget_statistics 
           WHERE budget_item_id IN (
             SELECT id FROM budget_items WHERE quotation_count = 0
           )`,
        )
        .execute()

      console.log('[Migration 0034] Purga definitiva de amostras demo executada com sucesso!')
    } catch (err) {
      console.log('[Migration 0034] Erro na execução da purga:', err.message)
      throw err
    }
  },
  (app) => {
    // Rollback no-op (purga irreversível de dados demo/sintéticos)
  },
)
