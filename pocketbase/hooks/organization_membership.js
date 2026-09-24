// Hook: Verificação e integridade de isolamento por organização
// Nota Skip Cloud: Sem funções no escopo de topo; todo o código inline dentro do callback

onRecordCreate(
  (e) => {
    // Apenas garante que se um usuário comum tentar criar, organizacao_id não fique nula
    const rec = e.record
    if (!rec.getString('organizacao_id') && rec.getString('organizacao')) {
      rec.set('organizacao_id', rec.getString('organizacao'))
    }
    e.next()
  },
  'demandas',
  'processos',
  'contratos',
)
