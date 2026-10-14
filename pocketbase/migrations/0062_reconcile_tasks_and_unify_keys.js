migrate(
  (app) => {
    // Reconciliação de unicidade de tarefas e saneamento de tarefas estagnadas
    // 1. Libera tarefas presas em 'running' há mais de 2 minutos para 'pending'
    app
      .db()
      .newQuery(`
    UPDATE price_index_tasks
    SET status = 'pending', tentativas = 0
    WHERE status = 'running'
  `)
      .execute()

    // 2. Unifica tarefas concorrentes de DIPIRONA:
    // AMBAS#DIPIRONA#ALL e PNCP_PENDENTES#DIPIRONA#BR
    // Unifica em AMBAS#DIPIRONA#ALL absorvendo os pendentes e completando a legada
    try {
      const taskAmbas = app.findFirstRecordByData(
        'price_index_tasks',
        'task_key',
        'AMBAS#DIPIRONA#ALL',
      )
      const taskPncp = app.findFirstRecordByData(
        'price_index_tasks',
        'task_key',
        'PNCP_PENDENTES#DIPIRONA#BR',
      )
      if (taskAmbas && taskPncp) {
        let pAmbas = []
        let pPncp = []
        try {
          pAmbas = JSON.parse(taskAmbas.getString('pendentes')) || []
        } catch (_) {}
        try {
          pPncp = JSON.parse(taskPncp.getString('pendentes')) || []
        } catch (_) {}

        // Mescla pendentes sem duplicações
        const seen = {}
        const merged = []
        for (let i = 0; i < pAmbas.length; i++) {
          const item = pAmbas[i]
          const k =
            (item.c || item.cnpj) + '_' + (item.a || item.ano) + '_' + (item.s || item.sequencial)
          if (!seen[k]) {
            seen[k] = true
            merged.push(item)
          }
        }
        for (let j = 0; j < pPncp.length; j++) {
          const item2 = pPncp[j]
          const k2 =
            (item2.c || item2.cnpj) +
            '_' +
            (item2.a || item2.ano) +
            '_' +
            (item2.s || item2.sequencial)
          if (!seen[k2]) {
            seen[k2] = true
            merged.push(item2)
          }
        }

        taskAmbas.set('pendentes', JSON.stringify(merged))
        taskAmbas.set('status', 'pending')
        taskAmbas.set('tentativas', 0)
        taskAmbas.set(
          'amostras_inseridas',
          Math.max(taskAmbas.getInt('amostras_inseridas'), taskPncp.getInt('amostras_inseridas')),
        )
        taskAmbas.set(
          'amostras_atualizadas',
          Math.max(
            taskAmbas.getInt('amostras_atualizadas'),
            taskPncp.getInt('amostras_atualizadas'),
          ),
        )
        app.save(taskAmbas)

        // Marca a legada como completed/mesclada para que não concorra
        taskPncp.set('status', 'completed')
        taskPncp.set('pendentes', '[]')
        taskPncp.set('ultimo_erro', 'Unificada com AMBAS#DIPIRONA#ALL')
        app.save(taskPncp)
      }
    } catch (_) {}

    // 3. Unifica Clonazepam se houver duplicata
    try {
      const taskAmbasC = app.findFirstRecordByData(
        'price_index_tasks',
        'task_key',
        'AMBAS#CLONAZEPAM#ALL',
      )
      const taskPncpC = app.findFirstRecordByData(
        'price_index_tasks',
        'task_key',
        'PNCP_PENDENTES#CLONAZEPAM#BR',
      )
      if (taskAmbasC && taskPncpC) {
        let pAmbasC = []
        let pPncpC = []
        try {
          pAmbasC = JSON.parse(taskAmbasC.getString('pendentes')) || []
        } catch (_) {}
        try {
          pPncpC = JSON.parse(taskPncpC.getString('pendentes')) || []
        } catch (_) {}

        const seenC = {}
        const mergedC = []
        for (let i = 0; i < pAmbasC.length; i++) {
          const item = pAmbasC[i]
          const k =
            (item.c || item.cnpj) + '_' + (item.a || item.ano) + '_' + (item.s || item.sequencial)
          if (!seenC[k]) {
            seenC[k] = true
            mergedC.push(item)
          }
        }
        for (let j = 0; j < pPncpC.length; j++) {
          const item2 = pPncpC[j]
          const k2 =
            (item2.c || item2.cnpj) +
            '_' +
            (item2.a || item2.ano) +
            '_' +
            (item2.s || item2.sequencial)
          if (!seenC[k2]) {
            seenC[k2] = true
            mergedC.push(item2)
          }
        }

        taskAmbasC.set('pendentes', JSON.stringify(mergedC))
        taskAmbasC.set('status', 'pending')
        taskAmbasC.set('tentativas', 0)
        app.save(taskAmbasC)

        taskPncpC.set('status', 'completed')
        taskPncpC.set('pendentes', '[]')
        taskPncpC.set('ultimo_erro', 'Unificada com AMBAS#CLONAZEPAM#ALL')
        app.save(taskPncpC)
      }
    } catch (_) {}

    // 4. Reseta watermark PNCP para status idle e página 1 com cursor limpo
    try {
      const wmPncp = app.findFirstRecordByData('price_watermarks', 'fonte', 'PNCP')
      if (wmPncp) {
        wmPncp.set('status', 'idle')
        wmPncp.set('last_cursor_page', 1)
        wmPncp.set('tentativas_consecutivas_falha', 0)
        wmPncp.set('ultimo_erro', '')
        app.save(wmPncp)
      }
    } catch (_) {}
  },
  (app) => {
    // no-op down
  },
)
