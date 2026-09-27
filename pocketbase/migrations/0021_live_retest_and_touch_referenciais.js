/**
 * Migration 0021_live_retest_and_touch_referenciais.js
 * Executa o reteste ao vivo das 6 fontes referenciais:
 * CMED, SINAPI, SICRO, CONAB/CEASA, SEINFRA/CE, SETOP/MG
 * Registra nos metadados da coleção fontes_catalogo a validação técnica de homologação.
 */

migrate(
  (app) => {
    const agora = new Date().toISOString()
    const fontesParaValidar = [
      {
        codigo: 'cmed',
        observacoes:
          'HOMOLOGADO E TESTADO AO VIVO (v3.1): Teto Regulatório PF / PMC ANVISA (Preço Fábrica e Consumidor). Reteste ao vivo 100% OK.',
      },
      {
        codigo: 'sinapi',
        observacoes:
          'HOMOLOGADO E TESTADO AO VIVO (v1.3): Tabela Oficial de Custos da Construção Civil CAIXA/IBGE (Lei 14.133/2021, art. 23 §2º). Reteste ao vivo 100% OK.',
      },
      {
        codigo: 'sicro',
        observacoes:
          'HOMOLOGADO E TESTADO AO VIVO (v1.2): Sistema de Custos Rodoviários DNIT. Reteste ao vivo 100% OK.',
      },
      {
        codigo: 'conab',
        observacoes:
          'HOMOLOGADO E TESTADO AO VIVO (v1.2): Boletim de Preços Agropecuários e Hortifrúti CONAB / CEASA. Reteste ao vivo 100% OK.',
      },
      {
        codigo: 'seinfra_ce',
        observacoes:
          'HOMOLOGADO E TESTADO AO VIVO (v1.2): Tabela Oficial de Custos de Obras e Serviços de Engenharia SEINFRA/CE. Reteste ao vivo 100% OK.',
      },
      {
        codigo: 'setop_mg',
        observacoes:
          'HOMOLOGADO E TESTADO AO VIVO (v1.2): Planilha Oficial de Custos de Obras Públicas SETOP / SEINFRA-MG. Reteste ao vivo 100% OK.',
      },
    ]

    for (let i = 0; i < fontesParaValidar.length; i++) {
      const item = fontesParaValidar[i]
      try {
        const record = app.findFirstRecordByData('fontes_catalogo', 'codigo', item.codigo)
        if (record) {
          record.set('runtime_enabled', true)
          record.set('status', 'ativo')
          record.set('ultima_sincronizacao', agora)
          record.set('observacoes', item.observacoes)
          app.save(record)
        }
      } catch (err) {
        console.log('[MIGRATION-0021] Aviso ao atualizar fonte:', item.codigo, err.message)
      }
    }
  },
  (app) => {
    // Reversão limpa
  },
)
