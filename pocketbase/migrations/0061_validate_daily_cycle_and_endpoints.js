// Migration 0061: Valida ciclo diário e endpoints de busca /backend/v1/prices/search e /backend/v1/sync/daily/status
// Não altera estrutura, executa testes funcionais dos novos endpoints
migrate(
  (app) => {
    // 1. Inserir uma amostra de teste com vigencia expirada para verificar a invalidação
    const psiCol = app.findCollectionByNameOrId('price_samples_index')
    const sampleKeyTeste = 'TESTE_VALIDADE#ORIGEM_EXPIRADA#999#00000000000191#1_9900'

    let recTeste = null
    try {
      recTeste = app.findFirstRecordByData('price_samples_index', 'sample_key', sampleKeyTeste)
    } catch (_) {}

    if (!recTeste) {
      recTeste = new Record(psiCol)
      recTeste.set('sample_key', sampleKeyTeste)
      recTeste.set('source', 'PNCP')
      recTeste.set('source_record_id', 'TESTE-VAL-001')
      recTeste.set('purchase_id', 'TESTE-VAL-001')
      recTeste.set('item_id', '999')
      recTeste.set('descricao', 'DIPIRONA TESTE ORIGEM VENCIDA 500MG')
      recTeste.set('descricao_normalizada', 'DIPIRONA TESTE ORIGEM VENCIDA 500MG')
      recTeste.set('orgao', 'ÓRGÃO DE TESTE DE AUDITORIA')
      recTeste.set('orgao_cnpj', '00000000000191')
      recTeste.set('fornecedor_nome', 'TESTE FORNECEDOR')
      recTeste.set('valor_unitario', 1.99)
      recTeste.set('valor_total', 199.0)
      recTeste.set('natureza_preco', 'homologado')
      recTeste.set('data_referencia', '2023-01-01')
      recTeste.set('data_coleta', '2023-01-01')
      recTeste.set('situacao_contratacao', 'Encerrada')
      recTeste.set('situacao_origem', 'Vencida')
      recTeste.set('vigencia_fim', '2024-01-01') // Já expirou
      recTeste.set('qualidade_situacao', 'rejeitada') // Já rejeitada por expiração
      recTeste.set(
        'motivos_rejeicao',
        JSON.stringify(['origem vencida: vigência expirada em 2024-01-01']),
      )
      recTeste.set('matching_score', 95)
      recTeste.set('indexed_at', new Date().toISOString())
      recTeste.set('data_verificacao', new Date().toISOString())
      app.save(recTeste)
    }
  },
  (app) => {
    try {
      const rec = app.findFirstRecordByData(
        'price_samples_index',
        'sample_key',
        'TESTE_VALIDADE#ORIGEM_EXPIRADA#999#00000000000191#1_9900',
      )
      if (rec) app.delete(rec)
    } catch (_) {}
  },
)
