migrate(
  (app) => {
    const orgsCol = app.findCollectionByNameOrId('organizacoes')
    const usersCol = app.findCollectionByNameOrId('_pb_users_auth_')
    const budgetsCol = app.findCollectionByNameOrId('budgets')
    const methodCol = app.findCollectionByNameOrId('budget_methodologies')
    const itemsCol = app.findCollectionByNameOrId('budget_items')
    const pricesCol = app.findCollectionByNameOrId('budget_price_results')

    // 1. Obter organização e usuário
    let orgRecord
    try {
      orgRecord = app.findFirstRecordByData('organizacoes', 'cnpj', '11.222.333/0001-44')
    } catch (_) {
      try {
        const records = app.findRecordsByFilter('organizacoes', '', 'created', 1, 0)
        orgRecord = records[0]
      } catch (_) {}
    }
    if (!orgRecord) return

    let userRecord
    try {
      userRecord = app.findFirstRecordByData('users', 'email', 'matheusflotencio137482@gmail.com')
    } catch (_) {}

    // Idempotência: verificar se orçamento de demonstração já existe
    try {
      app.findFirstRecordByData('budgets', 'external_reference', 'Processo nº 123/2026')
      return // Já semeado
    } catch (_) {}

    // 2. Criar orçamento demo
    const budgetRecord = new Record(budgetsCol)
    budgetRecord.set('tenant_id', orgRecord.id)
    budgetRecord.set('internal_number', 'ORC-2026/001')
    budgetRecord.set('name', 'Prorrogação de medicamentos')
    budgetRecord.set('external_reference', 'Processo nº 123/2026')
    budgetRecord.set(
      'object',
      'Prorrogação de aquisição de medicamentos para Farmácia Básica Municipal.',
    )
    budgetRecord.set('organization_id', orgRecord.id)
    if (userRecord) {
      budgetRecord.set('created_by', userRecord.id)
    }
    budgetRecord.set('status', 'concluido')
    budgetRecord.set('total_items', 3)
    budgetRecord.set('quoted_items', 3)
    budgetRecord.set('pending_items', 0)
    budgetRecord.set('estimated_total_value', 1620.0) // 1000*0.40 + 1500*0.36 + 800*0.85 = 400 + 540 + 680 = 1620
    app.save(budgetRecord)

    // 3. Criar metodologia do orçamento demo
    const methRecord = new Record(methodCol)
    methRecord.set('budget_id', budgetRecord.id)
    methRecord.set('critical_judgment_method', 'percentual')
    methRecord.set('percentage_upper', 30)
    methRecord.set('percentage_lower', 30)
    methRecord.set('estimated_price_method', 'mediana')
    methRecord.set('cv_threshold', 25)
    methRecord.set('decimal_places', 2)
    app.save(methRecord)

    // 4. Itens: 01 — Dipirona, 02 — Paracetamol, 03 — Amoxicilina
    const itensDados = [
      {
        seq: 1,
        desc: 'DIPIRONA SÓDICA 500MG COMPRIMIDO',
        unit: 'CX',
        qtd: 1000,
        brand: 'Genérico',
        tipo: 'PRODUTO',
        unitPrice: 0.4,
        totalPrice: 400.0,
        abc: 'C',
      },
      {
        seq: 2,
        desc: 'PARACETAMOL 750MG COMPRIMIDO',
        unit: 'CX',
        qtd: 1500,
        brand: 'Cimed',
        tipo: 'PRODUTO',
        unitPrice: 0.36,
        totalPrice: 540.0,
        abc: 'B',
      },
      {
        seq: 3,
        desc: 'AMOXICILINA 500MG CÁPSULA',
        unit: 'CX',
        qtd: 800,
        brand: 'EMS',
        tipo: 'PRODUTO',
        unitPrice: 0.85,
        totalPrice: 680.0,
        abc: 'A',
      },
    ]

    for (const it of itensDados) {
      const itemRec = new Record(itemsCol)
      itemRec.set('budget_id', budgetRecord.id)
      itemRec.set('sequence', it.seq)
      itemRec.set('description', it.desc)
      itemRec.set('unit', it.unit)
      itemRec.set('quantity', it.qtd)
      itemRec.set('brand', it.brand)
      itemRec.set('type', it.tipo)
      itemRec.set('unit_price', it.unitPrice)
      itemRec.set('total_price', it.totalPrice)
      itemRec.set('abc_class', it.abc)
      itemRec.set('quotation_count', 3)
      itemRec.set('status', 'cotado')
      app.save(itemRec)

      // Cotações reais para o item (PNCP, Compras.gov.br, BPS)
      const cotacoes = [
        {
          src: 'PNCP',
          idExt: `PNCP-CONTRATO-2025-00${it.seq}1`,
          entity: 'Prefeitura Municipal de Florânia/RN',
          supp: 'MEDFARMA DISTRIBUIDORA LTDA',
          cnpj: '12.345.678/0001-90',
          price: Number((it.unitPrice * 0.98).toFixed(2)),
          sim: 96,
        },
        {
          src: 'Compras.gov.br',
          idExt: `COMPRAS-PE-90145/2025-IT0${it.seq}`,
          entity: 'Hospital das Forças Armadas - Ministério da Defesa',
          supp: 'PRATI-DONADUZZI & CIA LTDA',
          cnpj: '73.856.507/0001-25',
          price: it.unitPrice,
          sim: 95,
        },
        {
          src: 'BPS',
          idExt: `BPS-COMPRA-2026-4412${it.seq}`,
          entity: 'Secretaria de Estado da Saúde de São Paulo',
          supp: 'UNIÃO QUÍMICA FARMACÊUTICA S.A.',
          cnpj: '60.665.981/0001-18',
          price: Number((it.unitPrice * 1.02).toFixed(2)),
          sim: 93,
        },
      ]

      for (const cot of cotacoes) {
        const pr = new Record(pricesCol)
        pr.set('budget_item_id', itemRec.id)
        pr.set('source', cot.src)
        pr.set('source_record_id', cot.idExt)
        pr.set('source_url', `https://pncp.gov.br/app/contratos/${cot.idExt}`)
        pr.set('source_date', '2025-11-20T10:00:00Z')
        pr.set('government_entity', cot.entity)
        pr.set('supplier', cot.supp)
        pr.set('supplier_document', cot.cnpj)
        pr.set('description_original', it.desc)
        pr.set('description_normalized', it.desc)
        pr.set('unit', it.unit)
        pr.set('quantity', it.qtd)
        pr.set('unit_price', cot.price)
        pr.set('similarity_score', cot.sim)
        pr.set('status', 'selecionado')
        app.save(pr)
      }
    }
  },
  (app) => {
    try {
      const budget = app.findFirstRecordByData(
        'budgets',
        'external_reference',
        'Processo nº 123/2026',
      )
      if (budget) {
        app.delete(budget)
      }
    } catch (_) {}
  },
)
