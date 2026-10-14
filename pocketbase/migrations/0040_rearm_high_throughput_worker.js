// Migração 0040: Ativação e limpeza da fila price_index_tasks com enfileiramento limpo para testes
migrate(
  (app) => {
    try {
      // Reabre ou cria tarefas pendentes para dipirona para validação do pipeline de alto throughput
      const colTasks = app.findCollectionByNameOrId('price_index_tasks')

      try {
        const taskDipirona = app.findFirstRecordByData(
          'price_index_tasks',
          'task_key',
          'AMBAS#DIPIRONA#BR',
        )
        if (taskDipirona) {
          taskDipirona.set('status', 'pending')
          taskDipirona.set('tentativas', 0)
          app.save(taskDipirona)
        }
      } catch (_) {
        const nova = new Record(colTasks)
        nova.set('task_key', 'AMBAS#DIPIRONA#BR')
        nova.set('source', 'AMBAS')
        nova.set('termo', 'dipirona')
        nova.set('uf', '')
        nova.set('status', 'pending')
        nova.set('paginas_consultadas', 0)
        nova.set('itens_processados', 0)
        nova.set('amostras_inseridas', 0)
        nova.set('amostras_atualizadas', 0)
        nova.set('tentativas', 0)
        app.save(nova)
      }

      try {
        const taskPncp = app.findFirstRecordByData(
          'price_index_tasks',
          'task_key',
          'PNCP_PENDENTES#DIPIRONA#BR',
        )
        if (taskPncp) {
          taskPncp.set('status', 'pending')
          taskPncp.set('tentativas', 0)
          // Se o campo pendentes tiver bytes corrompidos, limpa para []
          try {
            const rawP = taskPncp.getString('pendentes')
            if (!rawP || rawP.length > 500000) {
              taskPncp.set('pendentes', '[]')
            }
          } catch (_) {
            taskPncp.set('pendentes', '[]')
          }
          app.save(taskPncp)
        }
      } catch (_) {}
    } catch (err) {
      console.log('[MIGRATION 0040] Erro ao reconfigurar fila:', err.message)
    }
  },
  () => {},
)
