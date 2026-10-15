/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Migration 0065: Saneamento do price_samples_index
    // 1. Purgar amostras que entraram indevidamente como falso-positivo na busca de 'picolé'
    //    (ex.: contratação de serviços com "kit guloseimas/eventos festivos" de Itambé ou que não são picolé).
    // 2. Limpar a string literal "CATMAT" do campo codigo_item, deixando vazio quando não houver número de CATMAT.

    try {
      console.log('[Migration 0065] Saneando price_samples_index...')

      // 1. Purgar o falso-positivo específico apontado na tarefa (Município de Itambé / kit guloseimas)
      // e quaisquer falsos-positivos associados ao processo 31483079000182
      app
        .db()
        .newQuery(
          `DELETE FROM price_samples_index 
           WHERE id = 'hc7cfzv5hygvcae'
              OR (orgao_cnpj = '31483079000182' AND descricao_normalizada LIKE '%KIT GULOSEIMAS%')
              OR (descricao_normalizada LIKE '%KIT GULOSEIMA%' AND descricao_normalizada NOT LIKE '%PICOLE%')`,
        )
        .execute()

      // 2. Limpar campo codigo_item onde está exatamente o literal 'CATMAT' sem número
      app
        .db()
        .newQuery(
          `UPDATE price_samples_index 
           SET codigo_item = '' 
           WHERE TRIM(codigo_item) = 'CATMAT'`,
        )
        .execute()

      console.log('[Migration 0065] Saneamento concluído com sucesso!')
    } catch (err) {
      console.log('[Migration 0065] Erro durante saneamento:', err.message)
      throw err
    }
  },
  (app) => {
    // Rollback no-op
  },
)
