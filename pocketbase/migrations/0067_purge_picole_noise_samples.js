/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Migration 0067: Expurgo e rejeição idempotente de amostras de natureza errada
    // (serviços como palhaço 'Picolé', acessórios como palito de picolé/madeira, formas e pirulitos)
    // Diretriz (2): Excluir da grade amostras de natureza errada: serviços (unidade SERVIÇO, ex. "palhaço Picolé")
    // e itens acessórios/derivados (palito de picolé, pirulito tipo picolé), mesmo contendo o termo no texto.
    // Marcar como qualidade_situacao = 'rejeitada' com motivo apropriado ou deletar registros incompatíveis.

    try {
      console.log(
        '[Migration 0067] Iniciando expurgo de ruídos de picolé (palhaço, palito, pirulito, serviços)...',
      )

      // 1. Marcar como rejeitadas no price_samples_index
      app
        .db()
        .newQuery(
          `UPDATE price_samples_index 
           SET qualidade_situacao = 'rejeitada',
               motivos_rejeicao = '["NATUREZA_INCOMPATIVEL_SERVICO_PALHACO"]'
           WHERE (descricao_normalizada LIKE '%PALHACO%' OR descricao_normalizada LIKE '%PALHAÇO%' OR descricao_normalizada LIKE '%CIRCENSE%' OR descricao_normalizada LIKE '%ESPETACULO%')`,
        )
        .execute()

      app
        .db()
        .newQuery(
          `UPDATE price_samples_index 
           SET qualidade_situacao = 'rejeitada',
               motivos_rejeicao = '["NATUREZA_INCOMPATIVEL_ACESSORIO_PALITO"]'
           WHERE (
             descricao_normalizada LIKE '%PALITO DE PICOLE%' 
             OR descricao_normalizada LIKE '%PALITO P PICOLE%' 
             OR descricao_normalizada LIKE '%PALITO PARA PICOLE%' 
             OR descricao_normalizada LIKE '%PALITOS DE PICOLE%' 
             OR descricao_normalizada LIKE '%PALITO DE MADEIRA%'
           )`,
        )
        .execute()

      app
        .db()
        .newQuery(
          `UPDATE price_samples_index 
           SET qualidade_situacao = 'rejeitada',
               motivos_rejeicao = '["NATUREZA_INCOMPATIVEL_DERIVADO_PIRULITO"]'
           WHERE descricao_normalizada LIKE '%PIRULITO%'`,
        )
        .execute()

      app
        .db()
        .newQuery(
          `UPDATE price_samples_index 
           SET qualidade_situacao = 'rejeitada',
               motivos_rejeicao = '["NATUREZA_INCOMPATIVEL_UNIDADE_SERVICO"]'
           WHERE UPPER(TRIM(COALESCE(unidade, ''))) IN ('SERVICO', 'SERVIÇO', 'SERVICOS', 'SERVIÇOS', 'SV', 'SRV', 'HORA', 'H', 'HR', 'HRS', 'DIARIA', 'DIÁRIA', 'MES', 'MÊS', 'POSTO')
             AND (descricao_normalizada LIKE '%PICOLE%' OR codigo_item LIKE '%462776%' OR codigo_item LIKE '%462772%')`,
        )
        .execute()

      // 2. Limpar também do budget_price_results se houver sido importado anteriormente
      try {
        app
          .db()
          .newQuery(
            `UPDATE budget_price_results
             SET is_active = false
             WHERE (
               description_normalized LIKE '%PALHACO%'
               OR description_normalized LIKE '%PALHAÇO%'
               OR description_normalized LIKE '%PALITO DE PICOLE%'
               OR description_normalized LIKE '%PALITO P PICOLE%'
               OR description_normalized LIKE '%PALITO PARA PICOLE%'
               OR description_normalized LIKE '%PALITOS DE PICOLE%'
               OR description_normalized LIKE '%PALITO DE MADEIRA%'
               OR description_normalized LIKE '%PIRULITO%'
               OR (unit IN ('SERVICO', 'SERVIÇO', 'SERVICOS', 'SERVIÇOS', 'SV', 'SRV') AND description_normalized LIKE '%PICOLE%')
             )`,
          )
          .execute()
      } catch (eBudget) {
        console.log('[Migration 0067] Aviso na tabela budget_price_results:', eBudget.message)
      }

      console.log('[Migration 0067] Expurgo concluído com sucesso!')
    } catch (err) {
      console.log('[Migration 0067] Erro durante expurgo:', err.message)
      throw err
    }
  },
  (app) => {
    // Rollback no-op
  },
)
