/// <reference path="../pb_data/types.d.ts" />

// O índice contém apenas linhas validadas e seladas por hooks do servidor.
// Clientes autenticados podem consultar o acervo, mas nunca criar, alterar ou excluir linhas.
migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId('price_samples_index')
    collection.createRule = null
    collection.updateRule = null
    collection.deleteRule = null
    app.save(collection)
  },
  (_app) => {
    // Não reabrir escritas de cliente em rollback: esta é uma barreira de integridade.
  },
)
