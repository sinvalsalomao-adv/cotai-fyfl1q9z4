/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Migration 0032: Purga completa e definitiva de todas as amostras demo/sintéticas
    // Preserva integralmente todas as amostras reais coletadas das fontes oficiais
    // (PNCP, Compras.gov.br, BPS, referenciais regulatórios, etc.)
    try {
      console.log('[Migration 0032] Iniciando purga completa de amostras demo...')

      // 1. Identificar os IDs das amostras demo que serão expurgadas
      // Critérios:
      // a) raw_data LIKE '%"is_demo":true%' ou raw_data LIKE '%"is_demo": true%'
      // b) IDs conhecidos de migrações demo antigas ou testes aceitação demo (ex: MEDFARMA 12.345.678/0001-90, COMERCIAL HOSPITALAR 99.888.777/0001-66)
      // c) CNPJs fictícios de teste: 12.345.678/0001-90 e 99.888.777/0001-66
      // d) Amostras com source = 'BASE_DEMONSTRATIVA_SINTETICA' ou source = 'DEMO'

      // Passo 1.1: Tratar referências em cascata em budget_selected_prices
      app
        .db()
        .newQuery(
          `DELETE FROM budget_selected_prices 
           WHERE price_result_id IN (
             SELECT id FROM budget_price_results 
             WHERE raw_data LIKE '%"is_demo":true%'
                OR raw_data LIKE '%"is_demo": true%'
                OR raw_data LIKE '%"is_demo":1%'
                OR supplier_document = '12.345.678/0001-90'
                OR supplier_document = '99.888.777/0001-66'
                OR supplier LIKE '%MEDFARMA DISTRIBUIDORA%'
                OR supplier LIKE '%COMERCIAL HOSPITALAR EMERG%'
                OR source = 'BASE_DEMONSTRATIVA_SINTETICA'
                OR source = 'DEMO'
           )`,
        )
        .execute()

      // Passo 1.2: Tratar referências em cascata em budget_expurgated_prices
      app
        .db()
        .newQuery(
          `DELETE FROM budget_expurgated_prices 
           WHERE price_result_id IN (
             SELECT id FROM budget_price_results 
             WHERE raw_data LIKE '%"is_demo":true%'
                OR raw_data LIKE '%"is_demo": true%'
                OR raw_data LIKE '%"is_demo":1%'
                OR supplier_document = '12.345.678/0001-90'
                OR supplier_document = '99.888.777/0001-66'
                OR supplier LIKE '%MEDFARMA DISTRIBUIDORA%'
                OR supplier LIKE '%COMERCIAL HOSPITALAR EMERG%'
                OR source = 'BASE_DEMONSTRATIVA_SINTETICA'
                OR source = 'DEMO'
           )`,
        )
        .execute()

      // Passo 1.3: Deletar as amostras demo de budget_price_results
      app
        .db()
        .newQuery(
          `DELETE FROM budget_price_results 
           WHERE raw_data LIKE '%"is_demo":true%'
              OR raw_data LIKE '%"is_demo": true%'
              OR raw_data LIKE '%"is_demo":1%'
              OR supplier_document = '12.345.678/0001-90'
              OR supplier_document = '99.888.777/0001-66'
              OR supplier LIKE '%MEDFARMA DISTRIBUIDORA%'
              OR supplier LIKE '%COMERCIAL HOSPITALAR EMERG%'
              OR source = 'BASE_DEMONSTRATIVA_SINTETICA'
              OR source = 'DEMO'`,
        )
        .execute()

      // Passo 1.4: Limpar também eventuais registros demo na tabela quotation_price_records
      app
        .db()
        .newQuery(
          `DELETE FROM quotation_price_records 
           WHERE supplier_cnpj = '12.345.678/0001-90'
              OR supplier_cnpj = '99.888.777/0001-66'
              OR supplier LIKE '%MEDFARMA%'
              OR original_payload LIKE '%"is_demo":true%'
              OR original_payload LIKE '%"is_demo": true%'`,
        )
        .execute()

      // Passo 1.5: Atualizar a contagem de cotações válidas nos itens de orçamento afetados
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

      console.log(
        '[Migration 0032] Purga de amostras demo concluída com sucesso. Base agora contém apenas informações reais.',
      )
    } catch (err) {
      console.log('[Migration 0032] Erro na migração de purga demo:', err.message)
      throw err
    }
  },
  (app) => {
    // Rollback no-op (purga irreversível de dados demo/mock)
  },
)
