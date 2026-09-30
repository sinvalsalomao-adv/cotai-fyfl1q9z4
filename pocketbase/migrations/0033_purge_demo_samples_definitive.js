/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  // Purga Definitiva e Idempotente de Amostras de Demonstração Sintéticas
  // Detecta e purga apenas amostras sintéticas preservando coletas reais (PNCP, Compras.gov.br, BPS contingência, referenciais)

  function isSyntheticSample(data) {
    if (!data) return false
    const sourceRecordId = String(data.source_record_id || data.source_identifier || '').trim()
    const sourceUrl = String(data.source_url || data.link_oficial || '').trim()
    const govEntity = String(data.government_entity || data.orgao_comprador || '').trim()
    const supplierDoc = String(data.supplier_document || data.supplier_cnpj || '').trim()
    const rawDataStr =
      typeof data.raw_data === 'string' ? data.raw_data : JSON.stringify(data.raw_data || {})
    const source = String(data.source || data.fonte || '').trim()

    // 1. Identificadores sintéticos fabricados:
    // PNCP-CONTRATO-ANO-NUM ou BPS-COMPRA-ANO-NUM ou COMPRAS-PE-90145 / COMPRAS-PE-90210 / COMPRAS-PE-90412
    // BEC-OC-2025-11094 etc.
    const syntheticIdPatterns = [
      /^PNCP-CONTRATO-\d{4}-\d+/i,
      /^BPS-COMPRA-\d{4}-\d+/i,
      /^COMPRAS-PE-90\d{3}\/\d{4}-IT\d+/i,
      /^BEC-OC-\d{4}-\d+/i,
      /^DEMO-/i,
      /^FAKE-/i,
      /^SINTETICO-/i,
    ]
    for (const pat of syntheticIdPatterns) {
      if (pat.test(sourceRecordId)) return true
    }

    // 2. URLs / Deep links sintéticos fabricados:
    // Ex: pncp.gov.br/app/contratos/alcool-70-ype, cimed-paracetamol-750, 17870172000104/2025/882194
    // dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90145...
    // bps.saude.gov.br/consultas/contrato/449102 ou /331200
    // bec.sp.gov.br/bec_pregao_ui/contrato/11094
    const syntheticUrlPatterns = [
      /pncp\.gov\.br\/app\/contratos\/(?:COMPRAS-PE|BPS-COMPRA|alcool-70|cimed-paracetamol)/i,
      /pncp\.gov\.br\/app\/contratos\/\d{14}\/\d{4}\/882194/i,
      /dadosabertos\.compras\.gov\.br\/modulo-pesquisa-preco\/item\/90\d{3}-/i,
      /bps\.saude\.gov\.br\/consultas\/contrato\/(?:449102|331200)/i,
      /bec\.sp\.gov\.br\/bec_pregao_ui\/contrato\/11094/i,
    ]
    for (const pat of syntheticUrlPatterns) {
      if (pat.test(sourceUrl)) return true
    }

    // 3. CNPJs sintéticos de demonstração declarados:
    if (supplierDoc === '12.345.678/0001-90' || supplierDoc === '99.888.777/0001-66') {
      return true
    }

    // 4. Origem marcada explicitamente como demonstrativa/sintética:
    if (
      source === 'BASE_DEMONSTRATIVA_SINTETICA' ||
      source === 'DEMO' ||
      rawDataStr.includes('"is_demo":true') ||
      rawDataStr.includes('BASE_DEMONSTRATIVA_SINTETICA')
    ) {
      return true
    }

    // 5. Entidades governamentais com processos fabricados das seeds 0004/0006/0008:
    if (
      (govEntity.includes('Hospital das Forças Armadas') && sourceRecordId.includes('90145')) ||
      (govEntity.includes('Secretaria de Estado da Saúde de São Paulo') &&
        (sourceRecordId.includes('44121') ||
          sourceRecordId.includes('44122') ||
          sourceRecordId.includes('44123') ||
          sourceRecordId.includes('11094'))) ||
      (govEntity.includes('Ribeirão Preto') && sourceRecordId.includes('882194')) ||
      (govEntity.includes('Campinas') && sourceRecordId.includes('449102')) ||
      (govEntity.includes('Belo Horizonte') && sourceRecordId.includes('776100')) ||
      (govEntity.includes('Comando do Exército') && sourceRecordId.includes('90210')) ||
      (govEntity.includes('Santos') && sourceRecordId.includes('331200')) ||
      (govEntity.includes('Curitiba') &&
        (sourceRecordId.includes('992100') || sourceUrl.includes('alcool-70'))) ||
      (govEntity.includes('UNIFESP') && sourceRecordId.includes('90412'))
    ) {
      return true
    }

    return false
  }

  // Coleções a purgar
  let purgedBudgetPriceResults = 0
  let purgedQuotationPriceRecords = 0
  let purgedExpurgatedRefs = 0
  let purgedSelectedRefs = 0

  const affectedBudgetItemIds = new Set()

  // 1. Purgar de budget_price_results
  try {
    const budgetPrices = app.findRecordsByFilter(
      'budget_price_results',
      'id != ""',
      '-created',
      500,
      0,
    )

    for (const record of budgetPrices) {
      const data = {
        source_record_id: record.get('source_record_id'),
        source_url: record.get('source_url'),
        government_entity: record.get('government_entity'),
        supplier_document: record.get('supplier_document'),
        raw_data: record.get('raw_data'),
        source: record.get('source'),
      }

      if (isSyntheticSample(data)) {
        const recordId = record.id
        const budgetItemId = record.get('budget_item_id')
        if (budgetItemId) {
          affectedBudgetItemIds.add(budgetItemId)
        }

        // Remover referências em budget_selected_prices
        try {
          const selected = app.findRecordsByFilter(
            'budget_selected_prices',
            `price_result_id = "${recordId}"`,
            '',
            100,
            0,
          )
          for (const s of selected) {
            app.delete(s)
            purgedSelectedRefs++
          }
        } catch (_) {}

        // Remover referências em budget_expurgated_prices
        try {
          const expurgated = app.findRecordsByFilter(
            'budget_expurgated_prices',
            `price_result_id = "${recordId}"`,
            '',
            100,
            0,
          )
          for (const e of expurgated) {
            app.delete(e)
            purgedExpurgatedRefs++
          }
        } catch (_) {}

        app.delete(record)
        purgedBudgetPriceResults++
      }
    }
  } catch (err) {
    console.warn('Erro ao processar budget_price_results:', err)
  }

  // 2. Purgar de quotation_price_records
  try {
    const quotationPrices = app.findRecordsByFilter(
      'quotation_price_records',
      'id != ""',
      '-created',
      500,
      0,
    )

    for (const record of quotationPrices) {
      const data = {
        source_identifier: record.get('source_identifier'),
        source_record_id: record.get('source_record_id'),
        source_url: record.get('source_url'),
        orgao_comprador: record.get('orgao_comprador'),
        supplier_cnpj: record.get('supplier_cnpj'),
        original_payload: record.get('original_payload'),
        fonte: record.get('fonte'),
      }

      if (isSyntheticSample(data)) {
        app.delete(record)
        purgedQuotationPriceRecords++
      }
    }
  } catch (err) {
    console.warn('Erro ao processar quotation_price_records:', err)
  }

  // 3. Recalcular e sanear budget_statistics dos itens afetados
  for (const budgetItemId of affectedBudgetItemIds) {
    try {
      // Buscar amostras remanescentes para o item
      const remainingPrices = app.findRecordsByFilter(
        'budget_price_results',
        `budget_item_id = "${budgetItemId}"`,
        'unit_price',
        200,
        0,
      )

      const statsRecords = app.findRecordsByFilter(
        'budget_statistics',
        `budget_item_id = "${budgetItemId}"`,
        '-created',
        10,
        0,
      )

      if (remainingPrices.length === 0) {
        // Se zerou as amostras, deleta estatística para não quebrar com amostras fantasmas
        for (const st of statsRecords) {
          app.delete(st)
        }
      } else {
        // Recalcular métricas básicas com as amostras reais que sobraram
        const prices = remainingPrices
          .map((r) => Number(r.get('unit_price') || 0))
          .sort((a, b) => a - b)
        const count = prices.length
        const minPrice = prices[0]
        const maxPrice = prices[count - 1]
        const sum = prices.reduce((acc, p) => acc + p, 0)
        const meanPrice = sum / count
        const mid = Math.floor(count / 2)
        const medianPrice = count % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2

        for (const st of statsRecords) {
          st.set('sample_count_total', count)
          st.set('sample_count_valid', count)
          st.set('sample_count_expurgated', 0)
          st.set('min_price', Math.round(minPrice * 100) / 100)
          st.set('max_price', Math.round(maxPrice * 100) / 100)
          st.set('mean_price', Math.round(meanPrice * 100) / 100)
          st.set('median_price', Math.round(medianPrice * 100) / 100)
          st.set('final_estimated_price', Math.round(medianPrice * 100) / 100)
          app.save(st)
        }
      }
    } catch (err) {
      console.warn(`Erro ao atualizar estatísticas do item ${budgetItemId}:`, err)
    }
  }

  console.log(
    `[PURGA DEMO COMPLETA] budget_price_results purgadas: ${purgedBudgetPriceResults}, quotation_price_records purgadas: ${purgedQuotationPriceRecords}, expurgos limpos: ${purgedExpurgatedRefs}, seleções limpas: ${purgedSelectedRefs}, itens recalculados: ${affectedBudgetItemIds.size}`,
  )
})
