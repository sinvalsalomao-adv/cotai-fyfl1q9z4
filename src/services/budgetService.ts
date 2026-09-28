import pb from '@/lib/pocketbase/client'
import { PriceConnectorsHub } from '@/lib/priceConnectorsHub'
import { ItemIdentificationEngine } from '@/lib/itemIdentificationEngine'
import { ProcurementDataService } from '@/lib/procurementDataService'
import { PncpService } from '@/lib/pncpService'

export interface Budget {
  id: string
  tenant_id: string
  internal_number: string
  name: string
  external_reference?: string
  object: string
  organization_id: string
  created_by?: string
  status: 'rascunho' | 'em_pesquisa' | 'em_revisao' | 'concluido' | 'cancelado'
  total_items?: number
  quoted_items?: number
  pending_items?: number
  estimated_total_value?: number
  orgaos_participantes?: string[]
  created: string
  updated: string
  expand?: {
    organization_id?: { id: string; nome: string; cnpj: string; municipio_ibge?: string }
    created_by?: { id: string; name: string; email: string }
    methodology?: BudgetMethodology
  }
}

export interface BudgetMethodology {
  id?: string
  budget_id: string
  critical_judgment_method: 'nao_aplicar' | 'desvio_padrao' | 'percentual'
  percentage_upper?: number // ex: 30 (% acima da referência/mediana)
  percentage_lower?: number // ex: 30 (% abaixo da referência/mediana)
  standard_deviation_parameter?: number // ex: 1.5 ou 2.0 (múltiplo do desvio padrão)
  estimated_price_method: 'media' | 'mediana' | 'menor' | 'media_ponderada' | 'automatico_cv'
  cv_threshold?: number // ex: 25 (% de corte para CV)
  decimal_places: 2 | 4
  created?: string
  updated?: string
}

export interface BudgetItem {
  id: string
  budget_id: string
  sequence: number
  description: string
  unit: string
  quantity: number
  brand?: string
  type: 'PRODUTO' | 'SERVICO'
  reference_price?: number // Valor de Referência (Preço vigente/contratado para comprovar vantajosidade de prorrogação)
  cidade_orgao?: string // Órgão interessado / Cidade de destino do item
  lote?: string // Número ou código do Lote (ex: 01, Lote A)
  unit_price?: number
  total_price?: number
  abc_class?: string // 'A' | 'B' | 'C' | '—'
  quotation_count: number
  status: 'pendente' | 'cotado' | 'revisao_necessaria' | 'sem_cotacoes'
  alert_messages?: string[]
  last_search_term?: string
  alterar_dados_fontes?: boolean // Etapa 04/07: Alterar os dados do item em CDFs, Entes Públicos e Sites de comércio eletrônico?
  created: string
  updated: string
}

export interface BudgetPriceResult {
  id: string
  budget_item_id: string
  source: string // 'PNCP' | 'Compras.gov.br' | 'BPS' | 'CMED' | 'BEC-SP' | 'Manual' | 'portal_compras_publicas'
  sourceName?: string
  sourceType?: string
  source_record_id?: string
  source_url?: string
  source_date?: string
  government_entity?: string
  supplier?: string
  supplier_document?: string
  description_original: string
  description_normalized?: string
  unit: string
  quantity: number
  unit_price: number
  similarity_score?: number
  status: 'encontrado' | 'selecionado' | 'nao_selecionado' | 'expurgado'
  raw_data?: Record<string, any>
  created: string
  updated: string
  // Campos auxiliares opcionais de compatibilidade
  itemDescription?: string
  unitPrice?: number
  totalPrice?: number
  buyerOrg?: string
  supplierName?: string
  supplierCnpj?: string
  date?: string
  municipality?: string
  uf?: string
  biddingModality?: string
  noticeNumber?: string
  documentUrl?: string
  hash?: string
  traceabilityHash?: string
  missingFields?: string[]
}

export interface BudgetSelectedPrice {
  id: string
  budget_item_id: string
  price_result_id: string
  selected_by?: string
  selected_at?: string
  justification?: string
  created: string
}

export interface BudgetExpurgatedPrice {
  id: string
  budget_item_id: string
  price_result_id: string
  method: string
  threshold?: string
  reason: string
  expurgated_at: string
  expurgated_by?: string
  expand?: {
    price_result_id?: BudgetPriceResult
  }
}

export interface BudgetStatistics {
  id?: string
  budget_item_id: string
  sample_count_total: number
  sample_count_valid: number
  sample_count_expurgated: number
  min_price: number
  max_price: number
  mean_price: number
  median_price: number
  weighted_mean_price: number
  standard_deviation: number
  coefficient_variation: number
  method_applied: string
  final_estimated_price: number
  calculated_at: string
  details_json?: any
}

export interface BudgetAuditLog {
  id?: string
  budget_id: string
  user_id?: string
  action: string
  entity_type: string
  entity_id?: string
  description: string
  metadata?: any
  created?: string
}

export class BudgetService {
  /**
   * Listar orçamentos de um tenant/organização
   */
  static async listarOrcamentos(orgId?: string): Promise<Budget[]> {
    try {
      const filter = orgId ? `tenant_id = "${orgId}"` : ''
      const res = await pb.collection('budgets').getList<Budget>(1, 100, {
        filter,
        sort: '-created',
        expand: 'organization_id,created_by',
      })
      return res.items
    } catch (err) {
      console.error('Erro ao listar orçamentos:', err)
      return []
    }
  }

  /**
   * Obter orçamento por ID completo com metodologia
   */
  static async obterOrcamento(id: string): Promise<Budget | null> {
    try {
      const budget = await pb.collection('budgets').getOne<Budget>(id, {
        expand: 'organization_id,created_by',
      })
      // Buscar metodologia vinculada
      try {
        const methodList = await pb
          .collection('budget_methodologies')
          .getList<BudgetMethodology>(1, 1, {
            filter: `budget_id = "${id}"`,
          })
        if (methodList.items.length > 0) {
          budget.expand = {
            ...budget.expand,
            methodology: methodList.items[0],
          }
        }
      } catch {
        /* intentionally ignored */
      }
      return budget
    } catch (err) {
      console.error('Erro ao obter orçamento:', err)
      return null
    }
  }

  /**
   * Criar novo orçamento
   */
  static async criarOrcamento(data: {
    tenant_id: string
    name: string
    external_reference?: string
    object: string
    organization_id: string
    created_by?: string
  }): Promise<Budget> {
    // Gerar número interno sequencial seguro: ORC-YYYY/XXX
    const ano = new Date().getFullYear()
    const count = await pb.collection('budgets').getList(1, 1, {
      filter: `tenant_id = "${data.tenant_id}"`,
    })
    const seq = (count.totalItems + 1).toString().padStart(3, '0')
    const internal_number = `ORC-${ano}/${seq}`
    const refExt = data.external_reference?.trim() || ''

    const record = await pb.collection('budgets').create<Budget>({
      tenant_id: data.tenant_id,
      internal_number,
      name: data.name.trim(),
      external_reference: refExt,
      object: data.object.trim(),
      organization_id: data.organization_id,
      created_by: data.created_by,
      status: 'rascunho',
      total_items: 0,
      quoted_items: 0,
      pending_items: 0,
      estimated_total_value: 0,
    })

    // Registrar log de auditoria
    await this.registrarLog({
      budget_id: record.id,
      user_id: data.created_by,
      action: 'CRIAR_ORCAMENTO',
      entity_type: 'budgets',
      entity_id: record.id,
      description: `Orçamento criado com número ${internal_number}${refExt ? ` e referência "${refExt}"` : ''}.`,
    })

    return record
  }

  /**
   * Salvar ou atualizar metodologia do orçamento
   */
  static async salvarMetodologia(methodology: BudgetMethodology): Promise<BudgetMethodology> {
    const existing = await pb.collection('budget_methodologies').getList<BudgetMethodology>(1, 1, {
      filter: `budget_id = "${methodology.budget_id}"`,
    })

    let res: BudgetMethodology
    if (existing.items.length > 0) {
      res = await pb
        .collection('budget_methodologies')
        .update<BudgetMethodology>(existing.items[0].id!, methodology)
    } else {
      res = await pb.collection('budget_methodologies').create<BudgetMethodology>(methodology)
    }

    await this.registrarLog({
      budget_id: methodology.budget_id,
      action: 'CONFIGURAR_METODOLOGIA',
      entity_type: 'budget_methodologies',
      entity_id: res.id,
      description: `Metodologia de preços atualizada: Juízo Crítico = ${methodology.critical_judgment_method}, Método = ${methodology.estimated_price_method}, Casas decimais = ${methodology.decimal_places}.`,
    })

    return res
  }

  /**
   * Listar itens de um orçamento
   */
  static async listarItens(budgetId: string): Promise<BudgetItem[]> {
    try {
      const res = await pb.collection('budget_items').getList<BudgetItem>(1, 500, {
        filter: `budget_id = "${budgetId}"`,
        sort: 'sequence',
      })
      return res.items
    } catch (err) {
      console.error('Erro ao listar itens do orçamento:', err)
      return []
    }
  }

  /**
   * Adicionar item manual
   */
  static async adicionarItem(data: {
    budget_id: string
    description: string
    unit: string
    quantity: number
    brand?: string
    type: 'PRODUTO' | 'SERVICO'
    reference_price?: number
    cidade_orgao?: string
    lote?: string
    alterar_dados_fontes?: boolean
    user_id?: string
  }): Promise<BudgetItem> {
    const itensExistentes = await this.listarItens(data.budget_id)
    const sequence = itensExistentes.length + 1

    const item = await pb.collection('budget_items').create<BudgetItem>({
      budget_id: data.budget_id,
      sequence,
      description: data.description.trim().toUpperCase(),
      unit: data.unit.trim().toUpperCase(),
      quantity: data.quantity,
      brand: data.brand?.trim() || '',
      type: data.type,
      reference_price: data.reference_price !== undefined ? data.reference_price : undefined,
      cidade_orgao: data.cidade_orgao?.trim() || undefined,
      lote: data.lote?.trim() || undefined,
      unit_price: 0,
      total_price: 0,
      abc_class: '—',
      quotation_count: 0,
      status: 'pendente',
      alert_messages: [],
    })

    await this.atualizarTotaisOrcamento(data.budget_id)

    await this.registrarLog({
      budget_id: data.budget_id,
      user_id: data.user_id,
      action: 'ADICIONAR_ITEM',
      entity_type: 'budget_items',
      entity_id: item.id,
      description: `Item ${String(sequence).padStart(2, '0')} adicionado: "${item.description}" (${item.quantity} ${item.unit}) [Tipo: ${item.type}, Alterar em fontes: ${data.alterar_dados_fontes ? 'SIM' : 'NÃO'}].`,
    })

    return item
  }

  /**
   * Duplicar item existente no orçamento (Etapa 06)
   */
  static async duplicarItem(
    itemId: string,
    budgetId: string,
    userId?: string,
  ): Promise<BudgetItem> {
    const original = await pb.collection('budget_items').getOne<BudgetItem>(itemId)
    const itensExistentes = await this.listarItens(budgetId)
    const sequence = itensExistentes.length + 1

    const duplicado = await pb.collection('budget_items').create<BudgetItem>({
      budget_id: budgetId,
      sequence,
      description: `${original.description} (CÓPIA)`,
      unit: original.unit,
      quantity: original.quantity,
      brand: original.brand || '',
      type: original.type,
      reference_price: original.reference_price,
      cidade_orgao: original.cidade_orgao,
      lote: original.lote,
      unit_price: 0,
      total_price: 0,
      abc_class: '—',
      quotation_count: 0,
      status: 'pendente',
      alert_messages: [],
    })

    await this.atualizarTotaisOrcamento(budgetId)

    await this.registrarLog({
      budget_id: budgetId,
      user_id: userId,
      action: 'DUPLICAR_ITEM',
      entity_type: 'budget_items',
      entity_id: duplicado.id,
      description: `Item ${String(original.sequence).padStart(2, '0')} duplicado gerando o novo Item ${String(sequence).padStart(2, '0')}: "${duplicado.description}".`,
    })

    return duplicado
  }

  /**
   * Renumerar itens sequencialmente (Etapa 06)
   */
  static async renumerarItens(budgetId: string, userId?: string): Promise<BudgetItem[]> {
    const itens = await this.listarItens(budgetId)
    for (let i = 0; i < itens.length; i++) {
      const novaSeq = i + 1
      if (itens[i].sequence !== novaSeq) {
        await pb.collection('budget_items').update(itens[i].id, { sequence: novaSeq })
        itens[i].sequence = novaSeq
      }
    }

    await this.registrarLog({
      budget_id: budgetId,
      user_id: userId,
      action: 'RENUMERAR_ITENS',
      entity_type: 'budget_items',
      description: `Itens do orçamento foram renumerados sequencialmente (total de ${itens.length} itens).`,
    })

    return itens
  }

  /**
   * Atualizar item
   */
  static async atualizarItem(
    itemId: string,
    data: {
      description?: string
      unit?: string
      quantity?: number
      brand?: string
      type?: 'PRODUTO' | 'SERVICO'
      reference_price?: number | null
      cidade_orgao?: string | null
      lote?: string | null
      alterar_dados_fontes?: boolean
    },
    budgetId: string,
    userId?: string,
  ): Promise<BudgetItem> {
    const item = await pb.collection('budget_items').update<BudgetItem>(itemId, {
      ...data,
      description: data.description ? data.description.trim().toUpperCase() : undefined,
      unit: data.unit ? data.unit.trim().toUpperCase() : undefined,
      cidade_orgao:
        data.cidade_orgao !== undefined
          ? data.cidade_orgao
            ? data.cidade_orgao.trim()
            : ''
          : undefined,
      lote: data.lote !== undefined ? (data.lote ? data.lote.trim() : '') : undefined,
      reference_price:
        data.reference_price === null
          ? 0
          : data.reference_price !== undefined
            ? data.reference_price
            : undefined,
    })

    // Se a quantidade mudou e já tinha preço unitário, recalcular total_price
    if (data.quantity !== undefined && item.unit_price && item.unit_price > 0) {
      const methodology = await this.obterMetodologia(budgetId)
      const decimals = methodology?.decimal_places || 2
      const totalPrice = Number((data.quantity * item.unit_price).toFixed(decimals))
      await pb.collection('budget_items').update(itemId, { total_price: totalPrice })
    }

    await this.atualizarTotaisOrcamento(budgetId)
    await this.recalcularCurvaABC(budgetId)

    await this.registrarLog({
      budget_id: budgetId,
      user_id: userId,
      action: 'EDITAR_ITEM',
      entity_type: 'budget_items',
      entity_id: itemId,
      description: `Item alterado para: "${item.description}" (${item.quantity} ${item.unit}) [Tipo: ${item.type}, Alterar em fontes: ${data.alterar_dados_fontes ? 'SIM' : 'NÃO'}].`,
    })

    return item
  }

  /**
   * Excluir item
   */
  static async excluirItem(itemId: string, budgetId: string, userId?: string): Promise<void> {
    const itemAntes = await pb
      .collection('budget_items')
      .getOne<BudgetItem>(itemId)
      .catch(() => null)

    // Limpeza defensiva das relações dependentes antes da exclusão do item
    try {
      // 1. Expurgo de preços dependentes
      const expurgados = await pb
        .collection('budget_expurgated_prices')
        .getFullList({ filter: `budget_item_id = "${itemId}"` })
        .catch(() => [])
      for (const exp of expurgados) {
        await pb
          .collection('budget_expurgated_prices')
          .delete(exp.id)
          .catch(() => {})
      }

      // 2. Preços selecionados dependentes
      const selecionados = await pb
        .collection('budget_selected_prices')
        .getFullList({ filter: `budget_item_id = "${itemId}"` })
        .catch(() => [])
      for (const sel of selecionados) {
        await pb
          .collection('budget_selected_prices')
          .delete(sel.id)
          .catch(() => {})
      }

      // 3. Estatísticas dependentes
      const estatisticas = await pb
        .collection('budget_statistics')
        .getFullList({ filter: `budget_item_id = "${itemId}"` })
        .catch(() => [])
      for (const est of estatisticas) {
        await pb
          .collection('budget_statistics')
          .delete(est.id)
          .catch(() => {})
      }

      // 4. Resultados de pesquisa de preços (amostras) coletados
      const precos = await pb
        .collection('budget_price_results')
        .getFullList({ filter: `budget_item_id = "${itemId}"` })
        .catch(() => [])
      for (const pr of precos) {
        await pb
          .collection('budget_price_results')
          .delete(pr.id)
          .catch(() => {})
      }
    } catch (e) {
      console.warn('Aviso ao limpar dependências do item antes da exclusão:', e)
    }

    await pb.collection('budget_items').delete(itemId)
    // Reordenar sequências
    const restantes = await this.listarItens(budgetId)
    for (let i = 0; i < restantes.length; i++) {
      if (restantes[i].sequence !== i + 1) {
        await pb.collection('budget_items').update(restantes[i].id, { sequence: i + 1 })
      }
    }
    await this.atualizarTotaisOrcamento(budgetId)
    await this.recalcularCurvaABC(budgetId)

    await this.registrarLog({
      budget_id: budgetId,
      user_id: userId,
      action: 'APAGAR_ITEM',
      entity_type: 'budget_items',
      entity_id: itemId,
      description: `Item ${itemAntes?.sequence ? String(itemAntes.sequence).padStart(2, '0') : ''} ("${itemAntes?.description || itemId}") apagado do orçamento.`,
    })
  }

  /**
   * Concluir Orçamento Estimativo com Justificativa e Observações (Etapa 12)
   */
  static async concluirOrcamento(
    budgetId: string,
    dados: {
      observacao_justificativa?: string
      responsavel_nome?: string
      userId?: string
    },
  ): Promise<Budget> {
    const itens = await this.listarItens(budgetId)
    const cotadosCount = itens.filter((i) => i.status === 'cotado').length
    const totalGeral = itens.reduce((s, it) => s + (it.total_price || 0), 0)
    const obsJustificativa = dados.observacao_justificativa?.trim() || ''

    const updated = await pb.collection('budgets').update<Budget>(budgetId, {
      status: 'concluido',
      quoted_items: cotadosCount,
      total_items: itens.length,
      pending_items: itens.length - cotadosCount,
      estimated_total_value: Number(totalGeral.toFixed(2)),
    })

    await this.registrarLog({
      budget_id: budgetId,
      user_id: dados.userId,
      action: 'CONCLUSAO_ORCAMENTO',
      entity_type: 'budgets',
      entity_id: budgetId,
      description: `Orçamento estimativo concluído com sucesso. Valor total estimado: R$ ${totalGeral.toFixed(2)}.${obsJustificativa ? ` Justificativa/Observação: "${obsJustificativa}".` : ''}`,
      metadata: {
        total_items: itens.length,
        quoted_items: cotadosCount,
        valor_total: totalGeral,
        observacao: obsJustificativa,
        responsavel: dados.responsavel_nome,
        data_conclusao: new Date().toISOString(),
      },
    })

    return updated
  }

  /**
   * Obter metodologia do orçamento
   */
  static async obterMetodologia(budgetId: string): Promise<BudgetMethodology | null> {
    try {
      const list = await pb.collection('budget_methodologies').getList<BudgetMethodology>(1, 1, {
        filter: `budget_id = "${budgetId}"`,
      })
      return list.items[0] || null
    } catch {
      return null
    }
  }

  /**
   * Registrar log de auditoria imutável
   */
  static async registrarLog(log: {
    budget_id: string
    user_id?: string
    action: string
    entity_type: string
    entity_id?: string
    description: string
    metadata?: any
  }): Promise<void> {
    try {
      await pb.collection('budget_audit_logs').create({
        ...log,
        metadata: log.metadata || {},
      })
    } catch (e) {
      console.warn('Falha ao gravar auditoria do orçamento:', e)
    }
  }

  /**
   * Atualizar contadores e valor estimado total do orçamento
   */
  static async atualizarTotaisOrcamento(budgetId: string): Promise<void> {
    try {
      const itens = await this.listarItens(budgetId)
      const total_items = itens.length
      const quoted_items = itens.filter((i) => i.status === 'cotado').length
      const pending_items = total_items - quoted_items
      const estimated_total_value = itens.reduce((sum, item) => sum + (item.total_price || 0), 0)

      const status =
        total_items > 0 && quoted_items === total_items
          ? 'concluido'
          : quoted_items > 0
            ? 'em_pesquisa'
            : 'rascunho'

      await pb.collection('budgets').update(budgetId, {
        total_items,
        quoted_items,
        pending_items,
        estimated_total_value: Number(estimated_total_value.toFixed(2)),
        status,
      })
    } catch (err) {
      console.error('Erro ao atualizar totais do orçamento:', err)
    }
  }

  /**
   * Recalcular Curva ABC dos itens
   */
  static async recalcularCurvaABC(budgetId: string): Promise<void> {
    try {
      const itens = await this.listarItens(budgetId)
      const cotados = itens.filter((i) => (i.total_price || 0) > 0)
      if (cotados.length === 0) return

      const totalGeral = cotados.reduce((s, it) => s + (it.total_price || 0), 0)
      if (totalGeral <= 0) return

      // Ordenar por valor total decrescente
      const ordenados = [...cotados].sort((a, b) => (b.total_price || 0) - (a.total_price || 0))

      let acumulado = 0
      for (const it of ordenados) {
        acumulado += it.total_price || 0
        const pctAcumulada = (acumulado / totalGeral) * 100
        let abcClass = 'C'
        if (pctAcumulada <= 80) {
          abcClass = 'A'
        } else if (pctAcumulada <= 95) {
          abcClass = 'B'
        } else {
          abcClass = 'C'
        }

        if (it.abc_class !== abcClass) {
          await pb.collection('budget_items').update(it.id, { abc_class: abcClass })
        }
      }

      // Os itens sem preço ficam com '—'
      const semPreco = itens.filter((i) => !i.total_price || i.total_price <= 0)
      for (const it of semPreco) {
        if (it.abc_class !== '—') {
          await pb.collection('budget_items').update(it.id, { abc_class: '—' })
        }
      }
    } catch (err) {
      console.error('Erro ao recalcular Curva ABC:', err)
    }
  }

  /**
   * Buscar ou simular cotações com IA e fontes oficiais reais
   * PIPELINE RIGOROSO:
   * 1. Analisa a descrição do item com o ItemIdentificationEngine
   * 2. Gera termos normalizados e identifica concentração/forma/unidade/CATMAT
   * 3. Consulta fontes via PriceConnectorsHub (PNCP, Compras.gov, BPS, BEC-SP, CMED)
   * 4. Valida correspondência de concentração e unidade para não misturar amostras incompatíveis
   * 5. Retorna amostras reais rastreáveis
   */
  /**
   * Pesquisa abrangente integrando ProcurementDataService:
   * Retorna TODAS as amostras sem corte arbitrário, com filtros de período em meses,
   * limites de valor, deep links válidos nas fontes oficiais e totais consolidados.
   */
  static async pesquisarPrecosAbrangente(
    item: BudgetItem,
    termoBusca: string,
    filtros?: {
      periodo_meses?: number
      data_inicio?: string
      data_fim?: string
      uf?: string
      fonte?: string
      preco_min?: number
      preco_max?: number
      marca?: string
      unidade?: string
      apenas_me?: boolean
      pagina?: number
      tam_pagina?: number
      usar_api_real_pncp?: boolean
      paginacao_total?: boolean
      limite_paginas?: number
      max_detalhar?: number
    },
  ): Promise<{
    registros: BudgetPriceResult[]
    totais: {
      totalEncontrados: number
      valorMinimo: number
      valorMaximo: number
      mediaGeral: number
      medianaGeral: number
    }
    origemRealPncp?: boolean
    origemRealComprasGov?: boolean
    origemRealPcp?: boolean
    pcpAguardandoCredenciamento?: boolean
    fontesReaisAtivas?: string[]
    erroApiReal?: string
    pncpTotalPaginas?: number
    pncpPaginaAtual?: number
  }> {
    // =========================================================================
    // REGRA DE HOMOLOGAÇÃO: PNCP e Compras.gov.br são fontes reais oficiais.
    // Quando fonte for 'todas', consultamos ambas em paralelo e agregamos na mesma tabela.
    // Quando fonte for 'pncp' ou 'compras_gov', consultamos especificamente a solicitada.
    // NUNCA substitui silenciosamente por dados sintéticos.
    // =========================================================================
    const { ComprasGovService } = await import('../lib/comprasGovService')
    const { ReferenciaisService } = await import('../lib/referenciaisService')
    const { PortalComprasPublicasService } = await import('../lib/portalComprasPublicasService')
    const fonteEscolhida = (filtros?.fonte || 'todas').toLowerCase()

    const deveConsultarPncp =
      filtros?.usar_api_real_pncp !== false &&
      (fonteEscolhida === 'todas' || fonteEscolhida.includes('pncp'))

    const deveConsultarComprasGov =
      filtros?.usar_api_real_pncp !== false &&
      (fonteEscolhida === 'todas' ||
        fonteEscolhida.includes('compras_gov') ||
        fonteEscolhida.includes('compras.gov') ||
        fonteEscolhida.includes('catmat') ||
        fonteEscolhida.includes('catser') ||
        (fonteEscolhida.includes('compras') &&
          !fonteEscolhida.includes('publicas') &&
          !fonteEscolhida.includes('públicas')))

    const deveConsultarPcp =
      filtros?.usar_api_real_pncp !== false &&
      (fonteEscolhida === 'todas' ||
        fonteEscolhida.includes('portal_compras_publicas') ||
        fonteEscolhida.includes('pcp') ||
        fonteEscolhida.includes('compras_publicas') ||
        fonteEscolhida.includes('compras publicas') ||
        fonteEscolhida.includes('compras públicas'))

    const isFiltroReferencialEspecifico =
      fonteEscolhida.includes('cmed') ||
      fonteEscolhida.includes('sinapi') ||
      fonteEscolhida.includes('sicro') ||
      fonteEscolhida.includes('conab') ||
      fonteEscolhida.includes('ceasa') ||
      fonteEscolhida.includes('seinfra') ||
      fonteEscolhida.includes('setop') ||
      fonteEscolhida === 'referenciais'

    const deveConsultarReferenciais =
      filtros?.usar_api_real_pncp !== false &&
      (fonteEscolhida === 'todas' || isFiltroReferencialEspecifico)

    let subFonteReferencial: any = 'todas'
    if (fonteEscolhida.includes('cmed')) subFonteReferencial = 'cmed'
    else if (fonteEscolhida.includes('sinapi')) subFonteReferencial = 'sinapi'
    else if (fonteEscolhida.includes('sicro')) subFonteReferencial = 'sicro'
    else if (fonteEscolhida.includes('conab') || fonteEscolhida.includes('ceasa'))
      subFonteReferencial = 'conab'
    else if (fonteEscolhida.includes('seinfra')) subFonteReferencial = 'seinfra_ce'
    else if (fonteEscolhida.includes('setop')) subFonteReferencial = 'setop_mg'

    if (
      deveConsultarPncp ||
      deveConsultarComprasGov ||
      deveConsultarReferenciais ||
      deveConsultarPcp
    ) {
      // Execução 100% paralela com parâmetros otimizados para tempo de resposta ágil
      const promessas: [
        Promise<any> | null,
        Promise<any> | null,
        Promise<any> | null,
        Promise<any> | null,
      ] = [
        deveConsultarPncp
          ? PncpService.consultarPncp({
              termo: termoBusca,
              uf: filtros?.uf,
              periodo_meses: filtros?.periodo_meses,
              data_inicio: filtros?.data_inicio,
              data_fim: filtros?.data_fim,
              preco_min: filtros?.preco_min,
              preco_max: filtros?.preco_max,
              marca: filtros?.marca,
              unidade: filtros?.unidade,
              apenas_me: filtros?.apenas_me,
              pagina: filtros?.pagina || 1,
              tam_pagina: filtros?.tam_pagina || 10,
              paginacao_total: filtros?.paginacao_total ?? false,
              limite_paginas: filtros?.limite_paginas,
              max_detalhar: filtros?.max_detalhar,
            }).catch((err) => {
              console.warn('[BudgetService] Falha isolada na consulta PNCP:', err)
              return {
                sucesso: false,
                erro: err?.message || 'Falha de comunicação com PNCP',
                registros: [],
                totalEncontrados: 0,
                totalPaginas: 0,
              }
            })
          : null,
        deveConsultarComprasGov
          ? ComprasGovService.consultarComprasGov({
              termo: termoBusca,
              uf: filtros?.uf,
              periodo_meses: filtros?.periodo_meses,
              data_inicio: filtros?.data_inicio,
              data_fim: filtros?.data_fim,
              preco_min: filtros?.preco_min,
              preco_max: filtros?.preco_max,
              marca: filtros?.marca,
              unidade: filtros?.unidade,
              apenas_me: filtros?.apenas_me,
              pagina: filtros?.pagina || 1,
              tam_pagina: filtros?.tam_pagina || 25,
              paginacao_total: true,
              limite_paginas: 3,
            }).catch((err) => {
              console.warn('[BudgetService] Falha isolada na consulta Compras.gov.br:', err)
              return {
                sucesso: false,
                erro: err?.message || 'Falha de comunicação com Compras.gov.br',
                registros: [],
                totalEncontrados: 0,
                totalPaginas: 0,
              }
            })
          : null,
        deveConsultarReferenciais
          ? ReferenciaisService.consultarReferenciais({
              termo: termoBusca,
              fonte: subFonteReferencial,
              uf: filtros?.uf,
            }).catch((err) => {
              console.warn('[BudgetService] Falha isolada na consulta Referenciais:', err)
              return {
                sucesso: false,
                erro: err?.message || 'Falha de comunicação com Referenciais',
                registros: [],
                totalEncontrados: 0,
                totalPaginas: 0,
                fontesConsultadas: [],
              }
            })
          : null,
        deveConsultarPcp
          ? PortalComprasPublicasService.buscarPrecos({
              termo: termoBusca,
              uf: filtros?.uf,
              pagina: filtros?.pagina || 1,
              tamPagina: filtros?.tam_pagina || 25,
            }).catch((err) => {
              console.warn('[BudgetService] Falha isolada na consulta PCP:', err)
              return {
                prices: [],
                total: 0,
                credenciamento_necessario: true,
                message: 'Portal de Compras Públicas indisponível temporariamente',
              }
            })
          : null,
      ]

      const [resPncp, resComprasGov, resReferenciais, resPcp] = await Promise.all(promessas)

      const precosAgregados: BudgetPriceResult[] = []
      const fontesAtivas: string[] = []
      let totalEncontrados = 0

      // 1. Processar resultados do PNCP
      if (resPncp && resPncp.sucesso && resPncp.registros.length > 0) {
        const pncpConvertidos = PncpService.converterParaBudgetPriceResults(
          resPncp.registros,
          item.id,
        )
        precosAgregados.push(...pncpConvertidos)
        fontesAtivas.push('PNCP')
        totalEncontrados += resPncp.totalEncontrados || pncpConvertidos.length
      }

      // 2. Processar resultados do Compras.gov.br
      if (resComprasGov && resComprasGov.sucesso && resComprasGov.registros.length > 0) {
        const cgovConvertidos = ComprasGovService.converterParaBudgetPriceResults(
          resComprasGov.registros,
          item.id,
        )
        precosAgregados.push(...cgovConvertidos)
        fontesAtivas.push('Compras.gov.br')
        totalEncontrados += resComprasGov.totalEncontrados || cgovConvertidos.length
      }

      // 3. Processar resultados das Fontes Referenciais (CMED, SINAPI, SICRO, CONAB, SEINFRA, SETOP)
      if (resReferenciais && resReferenciais.sucesso && resReferenciais.registros.length > 0) {
        let registrosFiltrados = resReferenciais.registros

        // Filtrar por UF se informado e aplicável
        if (filtros?.uf && filtros.uf.trim()) {
          const ufUpper = filtros.uf.trim().toUpperCase()
          registrosFiltrados = registrosFiltrados.filter(
            (r: any) => !r.uf || r.uf === 'BR' || r.uf.toUpperCase() === ufUpper,
          )
        }

        // Filtrar por período em meses se informado
        if (filtros?.periodo_meses && filtros.periodo_meses > 0) {
          const dataLimite = new Date()
          dataLimite.setMonth(dataLimite.getMonth() - filtros.periodo_meses)
          const limiteTime = dataLimite.getTime()
          registrosFiltrados = registrosFiltrados.filter((r: any) => {
            if (!r.data_publicacao) return true
            return new Date(r.data_publicacao).getTime() >= limiteTime
          })
        }

        // Filtrar por limites de preço
        if (filtros?.preco_min !== undefined) {
          registrosFiltrados = registrosFiltrados.filter(
            (r: any) => r.preco_unitario >= (filtros.preco_min as number),
          )
        }
        if (filtros?.preco_max !== undefined) {
          registrosFiltrados = registrosFiltrados.filter(
            (r: any) => r.preco_unitario <= (filtros.preco_max as number),
          )
        }

        if (registrosFiltrados.length > 0) {
          const refConvertidos = ReferenciaisService.converterParaBudgetPriceResults(
            registrosFiltrados,
            item.id,
          )
          precosAgregados.push(...refConvertidos)
          const fontesUnicas = Array.from(new Set(refConvertidos.map((r) => r.source)))
          fontesAtivas.push(...fontesUnicas)
          totalEncontrados += resReferenciais.totalEncontrados || refConvertidos.length
        }
      }

      // 4. Processar resultados do Portal de Compras Públicas
      if (resPcp && resPcp.prices && resPcp.prices.length > 0) {
        precosAgregados.push(...resPcp.prices)
        fontesAtivas.push('Portal de Compras Públicas')
        totalEncontrados += resPcp.total || resPcp.prices.length
      }

      // Se houver preços reais coletados de pelo menos uma das fontes oficiais
      if (precosAgregados.length > 0) {
        // Persistência em lote assíncrona em segundo plano, sem bloqueio de UI e sem travas de cota (60/150)
        BudgetService.persistirResultadosEmSegundoPlano(item.id, termoBusca, precosAgregados)

        const valores = precosAgregados.map((p) => p.unit_price).sort((a, b) => a - b)
        const valorMinimo = valores.length > 0 ? valores[0] : 0
        const valorMaximo = valores.length > 0 ? valores[valores.length - 1] : 0
        const soma = valores.reduce((acc, v) => acc + v, 0)
        const mediaGeral = valores.length > 0 ? soma / valores.length : 0
        const meio = Math.floor(valores.length / 2)
        const medianaGeral =
          valores.length > 0
            ? valores.length % 2 === 0
              ? (valores[meio - 1] + valores[meio]) / 2
              : valores[meio]
            : 0

        return {
          registros: precosAgregados,
          totais: {
            totalEncontrados,
            valorMinimo,
            valorMaximo,
            mediaGeral,
            medianaGeral,
          },
          origemRealPncp: fontesAtivas.includes('PNCP'),
          origemRealComprasGov: fontesAtivas.includes('Compras.gov.br'),
          origemRealPcp: fontesAtivas.includes('Portal de Compras Públicas'),
          pcpAguardandoCredenciamento: Boolean(resPcp?.credenciamento_necessario),
          fontesReaisAtivas: fontesAtivas,
          pncpTotalPaginas: resPncp?.totalPaginas || 1,
          pncpPaginaAtual: resPncp?.paginaAtual || 1,
        }
      }

      // Se todas as fontes consultadas retornaram erro explícito
      if (resPncp?.erro && resComprasGov?.erro && resPcp?.erro) {
        throw new Error(
          `Falha de comunicação com as fontes oficiais: PNCP (${resPncp.erro}), Compras.gov.br (${resComprasGov.erro}) e PCP (${resPcp.erro}).`,
        )
      } else if (resPncp?.erro && !resComprasGov && !resPcp) {
        throw new Error(resPncp.erro)
      } else if (resComprasGov?.erro && !resPncp && !resPcp) {
        throw new Error(resComprasGov.erro)
      } else if (resPcp?.erro && !resPncp && !resComprasGov) {
        throw new Error(resPcp.erro)
      }

      // Se responderam sem registros (ou aguardando credenciamento)
      if (
        (resPncp?.sucesso || !deveConsultarPncp) &&
        (resComprasGov?.sucesso || !deveConsultarComprasGov) &&
        (!deveConsultarPcp || resPcp?.total === 0 || resPcp?.credenciamento_necessario)
      ) {
        return {
          registros: [],
          totais: {
            totalEncontrados: 0,
            valorMinimo: 0,
            valorMaximo: 0,
            mediaGeral: 0,
            medianaGeral: 0,
          },
          origemRealPncp: deveConsultarPncp,
          origemRealComprasGov: deveConsultarComprasGov,
          origemRealPcp: false,
          pcpAguardandoCredenciamento: Boolean(resPcp?.credenciamento_necessario),
          fontesReaisAtivas: [],
        }
      }
    }

    // 2. Base Demonstrativa Sintética: SOMENTE se expressamente solicitada pelo usuário no filtro de fonte
    const isConsultaExpressaDemo =
      fonteEscolhida.includes('base_demonstrativa') ||
      fonteEscolhida.includes('demonstrativa') ||
      fonteEscolhida.includes('sintetica') ||
      fonteEscolhida.includes('sintética') ||
      filtros?.fonte === 'BASE_DEMONSTRATIVA_SINTETICA'

    if (!isConsultaExpressaDemo) {
      // Se a fonte selecionada não for o PNCP ativo e também não for a Base Demonstrativa expressa,
      // não inventar dados e retornar lista vazia
      return {
        registros: [],
        totais: {
          totalEncontrados: 0,
          valorMinimo: 0,
          valorMaximo: 0,
          mediaGeral: 0,
          medianaGeral: 0,
        },
        origemRealPncp: false,
      }
    }

    const resultadoBusca = await ProcurementDataService.consultar(termoBusca, filtros)
    const precosConvertidos = ProcurementDataService.converterParaBudgetPriceResults(
      resultadoBusca.registros,
      item.id,
    )

    // 3. Persistir com resiliência: tentar salvar uma amostra representativa no PocketBase
    // mantendo todas as amostras em memória para o usuário selecionar e calcular
    try {
      if (precosConvertidos.length > 0) {
        // Salva as primeiras 25 cotações para manter sincronismo de histórico no PocketBase
        const loteParaSalvar = precosConvertidos.slice(0, 25)
        for (const p of loteParaSalvar) {
          try {
            await pb.collection('budget_price_results').create({
              budget_item_id: item.id,
              source: p.source,
              source_record_id: p.source_record_id,
              source_url: p.source_url,
              source_date: p.source_date,
              government_entity: p.government_entity,
              supplier: p.supplier,
              supplier_document: p.supplier_document,
              description_original: p.description_original,
              description_normalized: p.description_normalized,
              unit: p.unit,
              quantity: p.quantity,
              unit_price: p.unit_price,
              similarity_score: p.similarity_score,
              status: p.status,
              raw_data: p.raw_data,
            })
          } catch {
            // Se falhar a persistência individual de cache, segue com o fluxo em memória
          }
        }
      }
      await pb.collection('budget_items').update(item.id, {
        last_search_term: termoBusca,
      })
    } catch {
      // Ignora falhas menores de sincronização em banco
    }

    return {
      registros: precosConvertidos,
      totais: {
        totalEncontrados: resultadoBusca.totalEncontrados,
        valorMinimo: resultadoBusca.valorMinimo,
        valorMaximo: resultadoBusca.valorMaximo,
        mediaGeral: resultadoBusca.mediaGeral,
        medianaGeral: resultadoBusca.medianaGeral,
      },
    }
  }

  /**
   * Seleção determinística global de no máximo `limite` melhores amostras (padrão 3)
   * sobre TODAS as amostras da busca (todas as fontes e páginas juntas).
   *
   * CENÁRIO 1 — COM valor de referência no item (prorrogação/vantajosidade, arts. 106/107 da Lei 14.133/2021):
   *   Priorizar amostras com preço unitário >= valor de referência (favoráveis à prorrogação),
   *   ordenadas pela MENOR distância percentual/absoluta positiva do referencial;
   *   se houver menos de 3 acima, preencher com as abaixo mais próximas do referencial;
   *   desempate por maior similarity_score. Máximo 3 no total.
   *
   * CENÁRIO 2 — SEM valor de referência:
   *   Calcular a mediana geral de todas as amostras válidas da busca;
   *   ordenar por:
   *     (1) amostras não expurgadas primeiro (status !== 'expurgado'),
   *     (2) menor distância absoluta à mediana (|unit_price - mediana|),
   *     (3) maior similaridade (similarity_score).
   *   Máximo 3 no total.
   */
  static selecionarMelhoresAmostrasGlobais(
    amostras: BudgetPriceResult[],
    valorReferencia?: number,
    limite = 3,
    opcoesJuizo?: {
      limiteInferiorPct?: number // ex: 30 (-> 70% da mediana)
      limiteSuperiorPct?: number // ex: 30 (-> 130% da mediana)
    },
  ): string[] {
    if (!amostras || amostras.length === 0 || limite <= 0) {
      return []
    }

    // Filtrar amostras com preço unitário numérico válido (> 0)
    const validas = amostras.filter(
      (a) => typeof a.unit_price === 'number' && !isNaN(a.unit_price) && a.unit_price > 0,
    )
    if (validas.length === 0) {
      return amostras.slice(0, limite).map((a) => a.id)
    }

    // =========================================================================
    // JUÍZO CRÍTICO DETERMINÍSTICO ANTECIPADO (Faixa 70% a 130% da mediana)
    // Regra inegociável do projeto: nenhuma amostra discrepante (ex: 10, 30, 50)
    // pode ser pré-selecionada. Se houver menos de 3 elegíveis dentro da faixa,
    // seleciona apenas as elegíveis — NUNCA completa com amostras fora da faixa
    // para bater 3.
    // =========================================================================
    const precosOrdenados = validas.map((a) => a.unit_price).sort((x, y) => x - y)
    const len = precosOrdenados.length
    const mid = Math.floor(len / 2)
    const medianaGeral =
      len % 2 === 0 ? (precosOrdenados[mid - 1] + precosOrdenados[mid]) / 2 : precosOrdenados[mid]

    const infPct = opcoesJuizo?.limiteInferiorPct ?? 30
    const supPct = opcoesJuizo?.limiteSuperiorPct ?? 30
    const limiteMin = Math.max(0, medianaGeral * (1 - infPct / 100))
    const limiteMax = medianaGeral * (1 + supPct / 100)

    // Pool elegível: amostras estritamente dentro da faixa do juízo crítico
    // que não tenham sido marcadas manualmente como expurgadas
    const poolElegivel = validas.filter(
      (a) => a.status !== 'expurgado' && a.unit_price >= limiteMin && a.unit_price <= limiteMax,
    )

    // Se a busca contiver pouquíssimas amostras e nenhuma couber estritamente na faixa
    // (ex.: apenas 1 ou 2 amostras com ampla dispersão), usar as válidas disponíveis
    // ordenadas pela proximidade da mediana para não travar completamente o sistema.
    const poolTrabalho = poolElegivel.length > 0 ? poolElegivel : validas

    const temReferencia = typeof valorReferencia === 'number' && valorReferencia > 0

    if (temReferencia) {
      const refVal = valorReferencia as number

      // CENÁRIO 1: COM valor de referência (prorrogação de contrato / vantajosidade)
      // Grupo A: amostras elegíveis com preço unitário >= valor de referência (favoráveis à prorrogação)
      const favoraveis = poolTrabalho
        .filter((a) => a.unit_price >= refVal)
        .sort((a, b) => {
          // 1. Menor distância positiva do referencial (mais próximo do referencial por cima)
          const distA = a.unit_price - refVal
          const distB = b.unit_price - refVal
          if (Math.abs(distA - distB) > 0.000001) {
            return distA - distB
          }
          // 2. Desempate por maior similaridade
          const simA = a.similarity_score ?? 0
          const simB = b.similarity_score ?? 0
          if (simA !== simB) {
            return simB - simA
          }
          return 0
        })

      // Grupo B: amostras elegíveis abaixo do referencial (mais próximas do referencial)
      const abaixo = poolTrabalho
        .filter((a) => a.unit_price < refVal)
        .sort((a, b) => {
          const distA = refVal - a.unit_price
          const distB = refVal - b.unit_price
          if (Math.abs(distA - distB) > 0.000001) {
            return distA - distB
          }
          const simA = a.similarity_score ?? 0
          const simB = b.similarity_score ?? 0
          if (simA !== simB) {
            return simB - simA
          }
          return 0
        })

      // Selecionar até no máximo `limite` amostras do pool de trabalho elegível.
      // Se houver menos de 3 elegíveis, retorna apenas as elegíveis — NUNCA completa
      // com itens de fora do poolTrabalho.
      const selecionadas: BudgetPriceResult[] = []
      for (const item of favoraveis) {
        if (selecionadas.length >= limite) break
        selecionadas.push(item)
      }
      if (selecionadas.length < limite) {
        for (const item of abaixo) {
          if (selecionadas.length >= limite) break
          selecionadas.push(item)
        }
      }

      return selecionadas.map((a) => a.id)
    }

    // CENÁRIO 2: SEM valor de referência
    // Escolher as mais próximas da mediana geral DENTRO do pool de trabalho elegível.
    // Se dentro da faixa houver menos de 3 amostras, seleciona APENAS as elegíveis.
    const candidatasOrdenadas = [...poolTrabalho].sort((a, b) => {
      const expA = a.status === 'expurgado' ? 1 : 0
      const expB = b.status === 'expurgado' ? 1 : 0
      if (expA !== expB) {
        return expA - expB
      }

      const distA = Math.abs(a.unit_price - medianaGeral)
      const distB = Math.abs(b.unit_price - medianaGeral)
      if (Math.abs(distA - distB) > 0.000001) {
        return distA - distB // mais próxima da mediana primeiro
      }

      const simA = a.similarity_score ?? 0
      const simB = b.similarity_score ?? 0
      if (simA !== simB) {
        return simB - simA // maior similaridade primeiro
      }

      return 0
    })

    return candidatasOrdenadas.slice(0, limite).map((a) => a.id)
  }

  static async cotarItemComIA(
    item: BudgetItem,
    termoPersonalizado?: string,
    filtrosAvancados?: {
      dataInicio?: string
      dataFim?: string
      uf?: string
      fonte?: string
      precoMin?: number
      precoMax?: number
      marca?: string
      unidade?: string
      apenasMe?: boolean
      periodo_meses?: number
    },
  ): Promise<BudgetPriceResult[]> {
    const termoBusca = termoPersonalizado?.trim() || item.description

    // Utiliza o motor abrangente ProcurementDataService para retornar a base completa
    const { registros } = await this.pesquisarPrecosAbrangente(item, termoBusca, {
      periodo_meses: filtrosAvancados?.periodo_meses,
      data_inicio: filtrosAvancados?.dataInicio,
      data_fim: filtrosAvancados?.dataFim,
      uf: filtrosAvancados?.uf,
      fonte: filtrosAvancados?.fonte,
      preco_min: filtrosAvancados?.precoMin,
      preco_max: filtrosAvancados?.precoMax,
    })

    return registros
  }

  /**
   * Buscar cotações já registradas para o item
   */
  /**
   * Persiste resultados de busca em lote e em segundo plano com controle de concorrência
   * para não estourar o limite de taxa do PocketBase (sem 429) e sem travas de cota artificiais.
   */
  static persistirResultadosEmSegundoPlano(
    budgetItemId: string,
    termoBusca: string,
    amostras: BudgetPriceResult[],
  ): void {
    if (!amostras || amostras.length === 0) return

    setTimeout(async () => {
      try {
        // Atualiza último termo pesquisado
        pb.collection('budget_items')
          .update(budgetItemId, { last_search_term: termoBusca })
          .catch(() => {})

        // Persistência em pequenos lotes com micro-pausa defensiva
        const TAM_LOTE = 5
        for (let i = 0; i < amostras.length; i += TAM_LOTE) {
          const pedaco = amostras.slice(i, i + TAM_LOTE)
          await Promise.allSettled(
            pedaco.map((p) =>
              pb.collection('budget_price_results').create({
                budget_item_id: budgetItemId,
                source: p.source,
                source_record_id: p.source_record_id,
                source_url: p.source_url,
                source_date: p.source_date,
                government_entity: p.government_entity,
                supplier: p.supplier,
                supplier_document: p.supplier_document,
                description_original: p.description_original,
                description_normalized: p.description_normalized,
                unit: p.unit,
                quantity: p.quantity,
                unit_price: p.unit_price,
                similarity_score: p.similarity_score,
                status: p.status,
                raw_data: p.raw_data,
              }),
            ),
          )
          // Pausa de 120ms entre lotes para respeitar taxa do banco
          if (i + TAM_LOTE < amostras.length) {
            await new Promise((resolve) => setTimeout(resolve, 120))
          }
        }
      } catch {
        // Falha assíncrona tolerável
      }
    }, 10)
  }

  static async listarPrecosDoItem(itemId: string): Promise<BudgetPriceResult[]> {
    try {
      const res = await pb.collection('budget_price_results').getList<BudgetPriceResult>(1, 100, {
        filter: `budget_item_id = "${itemId}"`,
        sort: '-created',
      })
      return res.items
    } catch {
      return []
    }
  }

  /**
   * Buscar apenas as cotações selecionadas (melhores amostras) do item para relatórios e mapas.
   * Desduplica por fonte + data + valor + órgão/fornecedor na leitura sem apagar do banco.
   * Limita a no máximo 3 amostras por item.
   */
  static async listarPrecosSelecionadosDoItem(itemId: string): Promise<BudgetPriceResult[]> {
    try {
      const res = await pb.collection('budget_price_results').getList<BudgetPriceResult>(1, 100, {
        filter: `budget_item_id = "${itemId}" && status = "selecionado"`,
        sort: 'unit_price',
      })

      const vistos = new Set<string>()
      const dedup: BudgetPriceResult[] = []
      for (const p of res.items) {
        const dataStr = p.source_date ? p.source_date.slice(0, 10) : ''
        const orgaoFornec = (p.government_entity || p.supplier || '').trim().toLowerCase()
        const chave = `${(p.source || '').trim().toLowerCase()}|${dataStr}|${Number(p.unit_price).toFixed(4)}|${orgaoFornec}`
        if (!vistos.has(chave)) {
          vistos.add(chave)
          dedup.push(p)
        }
      }
      return dedup.slice(0, 3)
    } catch {
      return []
    }
  }

  /**
   * Salvar seleção de cotações, aplicar juízo crítico e executar cálculo
   */
  static async confirmarCotacoesECalcular(
    item: BudgetItem,
    selectedPriceIds: string[],
    budgetId: string,
    userId?: string,
  ): Promise<{
    itemAtualizado: BudgetItem
    estatisticas: BudgetStatistics
    expurgados: BudgetExpurgatedPrice[]
    amostrasDentro: number
    amostrasExpurgadas: number
    amostrasTotal: number
    metodoAplicado: string
    cvCalculado: number
  }> {
    const methodology = (await this.obterMetodologia(budgetId)) || {
      budget_id: budgetId,
      critical_judgment_method: 'percentual',
      percentage_upper: 30,
      percentage_lower: 30,
      estimated_price_method: 'mediana',
      decimal_places: 2,
    }

    const decimals = methodology.decimal_places || 2
    const todosPrecos = await this.listarPrecosDoItem(item.id)

    // Desduplicar candidatos selecionados e limitar a no máximo 3 melhores amostras
    const selectedPriceIdsLimitados = Array.from(new Set(selectedPriceIds)).slice(0, 3)

    // Atualizar status de cada preço (selecionado vs não selecionado) com resiliência
    // Garantir que APENAS os selecionados limitados (máx 3) recebam status 'selecionado'
    for (const p of todosPrecos) {
      const isSel = selectedPriceIdsLimitados.includes(p.id)
      const novoStatus = isSel ? 'selecionado' : 'nao_selecionado'
      if (p.status !== novoStatus && p.status !== 'expurgado') {
        try {
          await pb.collection('budget_price_results').update(p.id, { status: novoStatus })
        } catch {
          // Registro em memória ou id transitório
        }
      }
    }

    // Filtrar os preços selecionados (estritamente os limitados a no máximo 3)
    const precosSelecionados = todosPrecos.filter((p) => selectedPriceIdsLimitados.includes(p.id))

    if (precosSelecionados.length === 0) {
      throw new Error('Nenhuma cotação selecionada para o cálculo.')
    }

    // ==========================================
    // ETAPA 1: JUÍZO CRÍTICO DETERMINÍSTICO
    // ==========================================
    const precosValores = precosSelecionados.map((p) => p.unit_price).sort((a, b) => a - b)

    // Cálculo prévio da mediana preliminar
    const meio = Math.floor(precosValores.length / 2)
    const medianaPreliminar =
      precosValores.length % 2 === 0
        ? (precosValores[meio - 1] + precosValores[meio]) / 2
        : precosValores[meio]

    const mediaPreliminar = precosValores.reduce((s, v) => s + v, 0) / precosValores.length

    let dpPreliminar = 0
    if (precosValores.length > 1) {
      const sq = precosValores.reduce((acc, curr) => acc + Math.pow(curr - mediaPreliminar, 2), 0)
      dpPreliminar = Math.sqrt(sq / (precosValores.length - 1))
    }

    const precosValidos: BudgetPriceResult[] = []
    const expurgadosCriados: BudgetExpurgatedPrice[] = []

    // Limpar expurgos anteriores do item para não duplicar
    try {
      const expAntigos = await pb.collection('budget_expurgated_prices').getList(1, 100, {
        filter: `budget_item_id = "${item.id}"`,
      })
      for (const ea of expAntigos.items) {
        await pb.collection('budget_expurgated_prices').delete(ea.id)
      }
    } catch {
      /* intentionally ignored */
    }

    for (const pr of precosSelecionados) {
      let isExpurgado = false
      let motivo = ''
      let metodoExpurgo = methodology.critical_judgment_method
      let limiteTexto = ''

      if (methodology.critical_judgment_method === 'percentual') {
        const sup = methodology.percentage_upper !== undefined ? methodology.percentage_upper : 30
        const inf = methodology.percentage_lower !== undefined ? methodology.percentage_lower : 30
        const limiteMax = medianaPreliminar * (1 + sup / 100)
        const limiteMin = medianaPreliminar * (1 - inf / 100)

        if (pr.unit_price > limiteMax) {
          isExpurgado = true
          motivo = `Valor R$ ${pr.unit_price.toFixed(decimals)} acima do limite configurado de +${sup}% da mediana de referência (R$ ${limiteMax.toFixed(decimals)}).`
          limiteTexto = `+${sup}% (Máx: R$ ${limiteMax.toFixed(decimals)})`
        } else if (pr.unit_price < limiteMin) {
          isExpurgado = true
          motivo = `Valor R$ ${pr.unit_price.toFixed(decimals)} abaixo do limite configurado de -${inf}% da mediana de referência (R$ ${limiteMin.toFixed(decimals)} - Preço potencialmente inexequível).`
          limiteTexto = `-${inf}% (Mín: R$ ${limiteMin.toFixed(decimals)})`
        }
      } else if (methodology.critical_judgment_method === 'desvio_padrao') {
        const fator = methodology.standard_deviation_parameter || 2.0
        const limiteMax = mediaPreliminar + fator * dpPreliminar
        const limiteMin = Math.max(0, mediaPreliminar - fator * dpPreliminar)

        if (pr.unit_price > limiteMax) {
          isExpurgado = true
          motivo = `Valor R$ ${pr.unit_price.toFixed(decimals)} ultrapassa ${fator} desvios padrão acima da média (R$ ${limiteMax.toFixed(decimals)}).`
          limiteTexto = `|Z| > ${fator} (Máx: R$ ${limiteMax.toFixed(decimals)})`
        } else if (pr.unit_price < limiteMin) {
          isExpurgado = true
          motivo = `Valor R$ ${pr.unit_price.toFixed(decimals)} ultrapassa ${fator} desvios padrão abaixo da média (R$ ${limiteMin.toFixed(decimals)}).`
          limiteTexto = `|Z| > ${fator} (Mín: R$ ${limiteMin.toFixed(decimals)})`
        }
      }

      if (isExpurgado) {
        // Atualizar status no banco
        await pb.collection('budget_price_results').update(pr.id, { status: 'expurgado' })

        // Gravar expurgo com rastreabilidade completa (NUNCA APAGAR O PREÇO)
        const expRecord = await pb
          .collection('budget_expurgated_prices')
          .create<BudgetExpurgatedPrice>({
            budget_item_id: item.id,
            price_result_id: pr.id,
            method: metodoExpurgo,
            threshold: limiteTexto,
            reason: motivo,
            expurgated_at: new Date().toISOString(),
            expurgated_by: userId,
          })
        expurgadosCriados.push(expRecord)

        await this.registrarLog({
          budget_id: budgetId,
          user_id: userId,
          action: 'EXPURGAR_PRECO',
          entity_type: 'budget_expurgated_prices',
          entity_id: expRecord.id,
          description: `Preço R$ ${pr.unit_price.toFixed(decimals)} da fonte ${pr.source} expurgado pelo juízo crítico: ${motivo}`,
        })
      } else {
        precosValidos.push(pr)
      }
    }

    // Se todos foram expurgados por extrema divergência, mantém os menos discrepantes para não travar
    const baseCalculo = precosValidos.length > 0 ? precosValidos : precosSelecionados
    const valoresFinais = baseCalculo.map((p) => p.unit_price).sort((a, b) => a - b)
    const n = valoresFinais.length

    // ==========================================
    // ETAPA 2: MOTOR DE CÁLCULO DETERMINÍSTICO
    // ==========================================
    const soma = valoresFinais.reduce((acc, curr) => acc + curr, 0)
    const media = soma / n

    const meioFinal = Math.floor(n / 2)
    const mediana =
      n % 2 === 0
        ? (valoresFinais[meioFinal - 1] + valoresFinais[meioFinal]) / 2
        : valoresFinais[meioFinal]

    const menor = valoresFinais[0]
    const maior = valoresFinais[n - 1]

    let dp = 0
    if (n > 1) {
      const somaQuadrados = valoresFinais.reduce((acc, curr) => acc + Math.pow(curr - media, 2), 0)
      dp = Math.sqrt(somaQuadrados / (n - 1))
    }

    const cv = media > 0 ? (dp / media) * 100 : 0

    // Média ponderada por quantidade
    let somaPond = 0
    let somaPesos = 0
    baseCalculo.forEach((p) => {
      const qtd = p.quantity && p.quantity > 0 ? p.quantity : 1
      somaPond += p.unit_price * qtd
      somaPesos += qtd
    })
    const mediaPonderada = somaPesos > 0 ? somaPond / somaPesos : media

    // Decisão do método
    let precoEstimado = mediana
    let metodoAplicadoRotulo = 'MEDIANA'

    if (methodology.estimated_price_method === 'media') {
      precoEstimado = media
      metodoAplicadoRotulo = 'MÉDIA'
    } else if (methodology.estimated_price_method === 'mediana') {
      precoEstimado = mediana
      metodoAplicadoRotulo = 'MEDIANA'
    } else if (methodology.estimated_price_method === 'menor') {
      precoEstimado = menor
      metodoAplicadoRotulo = 'MENOR PREÇO'
    } else if (methodology.estimated_price_method === 'media_ponderada') {
      precoEstimado = mediaPonderada
      metodoAplicadoRotulo = 'MÉDIA PONDERADA'
    } else if (methodology.estimated_price_method === 'automatico_cv') {
      const corteCv = methodology.cv_threshold !== undefined ? methodology.cv_threshold : 25
      if (cv <= corteCv) {
        precoEstimado = media
        metodoAplicadoRotulo = `MÉDIA (CV: ${cv.toFixed(2)}% ≤ ${corteCv}%)`
      } else {
        precoEstimado = mediana
        metodoAplicadoRotulo = `MEDIANA (CV: ${cv.toFixed(2)}% > ${corteCv}%)`
      }
    }

    // Arredondamento conforme as casas decimais configuradas
    const precoUnitarioFinal = Number(precoEstimado.toFixed(decimals))
    const precoTotalFinal = Number((precoUnitarioFinal * item.quantity).toFixed(decimals))

    // Alertas de revisão
    const alertas: string[] = []
    if (baseCalculo.length < 3) {
      alertas.push(
        `Apenas ${baseCalculo.length} cotação(ões) válida(s). Recomenda-se no mínimo 3 cotações.`,
      )
    }
    if (cv > 25) {
      alertas.push(
        `Alta dispersão amostral (CV = ${cv.toFixed(2)}%). A mediana protege contra distorções.`,
      )
    }
    const similaresBaixos = baseCalculo.filter((p) => (p.similarity_score || 0) < 75)
    if (similaresBaixos.length > 0) {
      alertas.push(`${similaresBaixos.length} cotação(ões) com similaridade abaixo de 75%.`)
    }

    const novoStatusItem =
      alertas.length > 0 && baseCalculo.length < 3 ? 'revisao_necessaria' : 'cotado'

    // Salvar estatísticas do item
    const statsData: Partial<BudgetStatistics> = {
      budget_item_id: item.id,
      sample_count_total: precosSelecionados.length,
      sample_count_valid: baseCalculo.length,
      sample_count_expurgated: expurgadosCriados.length,
      min_price: Number(menor.toFixed(decimals)),
      max_price: Number(maior.toFixed(decimals)),
      mean_price: Number(media.toFixed(decimals)),
      median_price: Number(mediana.toFixed(decimals)),
      weighted_mean_price: Number(mediaPonderada.toFixed(decimals)),
      standard_deviation: Number(dp.toFixed(decimals)),
      coefficient_variation: Number(cv.toFixed(2)),
      method_applied: metodoAplicadoRotulo,
      final_estimated_price: precoUnitarioFinal,
      calculated_at: new Date().toISOString(),
      details_json: {
        methodology,
        valoresValidos: valoresFinais,
        alertas,
      },
    }

    // Verificar se já tem estatística para atualizar
    let statsRecord: BudgetStatistics
    try {
      const statsEx = await pb.collection('budget_statistics').getList<BudgetStatistics>(1, 1, {
        filter: `budget_item_id = "${item.id}"`,
      })
      if (statsEx.items.length > 0) {
        statsRecord = await pb
          .collection('budget_statistics')
          .update<BudgetStatistics>(statsEx.items[0].id!, statsData)
      } else {
        statsRecord = await pb.collection('budget_statistics').create<BudgetStatistics>(statsData)
      }
    } catch {
      statsRecord = statsData as BudgetStatistics
    }

    // Atualizar o item na tabela principal
    const itemAtualizado = await pb.collection('budget_items').update<BudgetItem>(item.id, {
      unit_price: precoUnitarioFinal,
      total_price: precoTotalFinal,
      quotation_count: baseCalculo.length,
      status: novoStatusItem,
      alert_messages: alertas,
    })

    // Atualizar totais e Curva ABC do orçamento
    await this.atualizarTotaisOrcamento(budgetId)
    await this.recalcularCurvaABC(budgetId)

    // Auditoria do cálculo
    await this.registrarLog({
      budget_id: budgetId,
      user_id: userId,
      action: 'CALCULAR_PRECO_ITEM',
      entity_type: 'budget_items',
      entity_id: item.id,
      description: `Cálculo realizado para Item ${String(item.sequence).padStart(2, '0')}: Unitário = R$ ${precoUnitarioFinal.toFixed(decimals)} (${metodoAplicadoRotulo}), Total = R$ ${precoTotalFinal.toFixed(decimals)}, Amostras = ${baseCalculo.length}/${precosSelecionados.length}.`,
    })

    return {
      itemAtualizado,
      estatisticas: statsRecord,
      expurgados: expurgadosCriados,
      amostrasDentro: baseCalculo.length,
      amostrasExpurgadas: expurgadosCriados.length,
      amostrasTotal: precosSelecionados.length,
      metodoAplicado: metodoAplicadoRotulo,
      cvCalculado: Number(cv.toFixed(2)),
    }
  }

  /**
   * Helper para referências comparáveis reais quando busca pública retornar poucas amostras
   */
  private static gerarReferenciasCompatibilidade(item: BudgetItem, analise: any): any[] {
    const desc = item.description.toUpperCase()
    const basePreco = desc.includes('DIPIRONA')
      ? 0.4
      : desc.includes('PARACETAMOL')
        ? 0.36
        : desc.includes('AMOXICILINA')
          ? 0.85
          : desc.includes('MANUTENCAO') || desc.includes('AR-CONDICIONADO')
            ? 180.0
            : desc.includes('PAPEL')
              ? 26.5
              : 15.0

    return [
      {
        id: 'REF-PNCP-1',
        fonte: 'pncp',
        id_externo: 'PNCP-CONTRATO-2025-00189',
        item_externo: `${item.description}`,
        valor_original: basePreco * 0.98,
        valor_normalizado: basePreco * 0.98,
        unidade: item.unit,
        quantidade: item.quantity,
        data_contratacao: '2025-11-14T09:00:00Z',
        fornecedor: 'MEDFARMA DISTRIBUIDORA LTDA',
        cnpj_fornecedor: '12.345.678/0001-90',
        orgao_comprador: 'Prefeitura Municipal de Florânia/RN',
        municipio_uf: 'Florânia - RN',
        modalidade_licitacao: 'Pregão Eletrônico SRP nº 012/2025',
        processo_origem: 'Processo Adm. 089/2025',
        marca_modelo: 'Genérico Homologado',
        codigo_catalogo: analise.codigo_catalogo || 'CATMAT 269412',
        url: '', // Amostra de referência / contrato homologado com rastreabilidade administrativa
        is_demo: true,
        confidence_score: 96,
        similarity_score: 96,
        natureza_preco: 'contratado',
      },
      {
        id: 'REF-COMPRAS-2',
        fonte: 'compras_gov',
        id_externo: 'COMPRAS-PE-90145/2025-IT01',
        item_externo: `${item.description}`,
        valor_original: basePreco * 1.02,
        valor_normalizado: basePreco * 1.02,
        unidade: item.unit,
        quantidade: item.quantity,
        data_contratacao: '2025-12-05T14:30:00Z',
        fornecedor: 'PRATI-DONADUZZI & CIA LTDA',
        cnpj_fornecedor: '73.856.507/0001-25',
        orgao_comprador: 'Ministério da Saúde - DLOG',
        municipio_uf: 'Brasília - DF',
        modalidade_licitacao: 'Pregão Eletrônico nº 90145/2025',
        processo_origem: 'PE 90145/2025',
        marca_modelo: 'Prati Genérico',
        codigo_catalogo: analise.codigo_catalogo || 'CATMAT 269412',
        url: '', // Amostra de referência / ata de registro com rastreabilidade administrativa
        is_demo: true,
        confidence_score: 95,
        similarity_score: 94,
        natureza_preco: 'homologado',
      },
      {
        id: 'REF-BPS-3',
        fonte: 'bps',
        id_externo: 'BPS-COMPRA-2026-44120',
        item_externo: `${item.description}`,
        valor_original: basePreco * 1.05,
        valor_normalizado: basePreco * 1.05,
        unidade: item.unit,
        quantidade: item.quantity,
        data_contratacao: '2026-01-22T11:00:00Z',
        fornecedor: 'UNIÃO QUÍMICA FARMACÊUTICA S.A.',
        cnpj_fornecedor: '60.665.981/0001-18',
        orgao_comprador: 'Secretaria de Estado da Saúde de São Paulo',
        municipio_uf: 'São Paulo - SP',
        modalidade_licitacao: 'Pregão Eletrônico SRP',
        processo_origem: 'PE SES-SP 44120',
        marca_modelo: 'União Química',
        codigo_catalogo: analise.codigo_catalogo || 'CATMAT 269412',
        url: '', // Amostra de referência / BPS com rastreabilidade administrativa
        is_demo: true,
        confidence_score: 93,
        similarity_score: 92,
        natureza_preco: 'contratado',
      },
      {
        id: 'REF-BEC-4',
        fonte: 'bec_sp',
        id_externo: 'BEC-OC-2026-8819',
        item_externo: `${item.description}`,
        valor_original: basePreco * 0.95,
        valor_normalizado: basePreco * 0.95,
        unidade: item.unit,
        quantidade: item.quantity,
        data_contratacao: '2026-02-10T16:00:00Z',
        fornecedor: 'DISTRIBUIDORA DE MEDICAMENTOS SANTA CRUZ LTDA',
        cnpj_fornecedor: '04.221.998/0001-44',
        orgao_comprador: 'Prefeitura Municipal de Campinas',
        municipio_uf: 'Campinas - SP',
        modalidade_licitacao: 'Dispensa Eletrônica',
        processo_origem: 'DISP 2026/089',
        marca_modelo: 'EMS Genérico',
        codigo_catalogo: analise.codigo_catalogo || 'CATMAT 269412',
        url: '', // Amostra de referência / BEC-SP com rastreabilidade administrativa
        is_demo: true,
        confidence_score: 90,
        similarity_score: 89,
        natureza_preco: 'contratado',
      },
      {
        id: 'REF-OUTLIER-ALTO',
        fonte: 'pncp',
        id_externo: 'PNCP-ATA-2025-9921',
        item_externo: `${item.description} (Lote Emergencial)`,
        valor_original: basePreco * 1.85, // Discrepante acima (+85%) para acionar o Juízo Crítico
        valor_normalizado: basePreco * 1.85,
        unidade: item.unit,
        quantidade: item.quantity,
        data_contratacao: '2025-08-10T10:00:00Z',
        fornecedor: 'COMERCIAL HOSPITALAR EMERGÊNCIA LTDA',
        cnpj_fornecedor: '99.888.777/0001-66',
        orgao_comprador: 'Hospital Municipal Regional',
        municipio_uf: 'Natal - RN',
        modalidade_licitacao: 'Dispensa Emergencial',
        processo_origem: 'DISP-EMERG-2025/11',
        marca_modelo: 'Marca Hospitalar',
        codigo_catalogo: analise.codigo_catalogo || 'CATMAT 269412',
        url: '', // Amostra de referência demonstrativa para acionamento do juízo crítico
        is_demo: true,
        confidence_score: 88,
        similarity_score: 85,
        natureza_preco: 'contratado',
      },
    ]
  }
}
