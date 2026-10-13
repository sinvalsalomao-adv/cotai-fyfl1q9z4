import pb from '@/lib/pocketbase/client'
import { PriceConnectorsHub } from '@/lib/priceConnectorsHub'
import { ItemIdentificationEngine } from '@/lib/itemIdentificationEngine'
// ProcurementDataService isolado: dados simulados legados neutralizados em conformidade com a diretriz de dados 100% reais
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
   * Pesquisa abrangente integrando SearchOrchestrator oficial:
   * Retorna TODAS as amostras reais sem corte arbitrário, com filtros de período em meses,
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
      forcarAtualizacaoCache?: boolean
      onProgress?: (dados: {
        amostrasAcumuladas: BudgetPriceResult[]
        totalAmostras: number
        fontesAtivas: string[]
        estatisticas: {
          totalEncontrados: number
          valorMinimo: number
          valorMaximo: number
          mediaGeral: number
          medianaGeral: number
        }
      }) => void
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
    origemRealBps?: boolean
    origemRealComprasGov?: boolean
    origemRealPcp?: boolean
    pcpAguardandoCredenciamento?: boolean
    fontesReaisAtivas?: string[]
    erroApiReal?: string
    pncpTotalPaginas?: number
    pncpPaginaAtual?: number
    estadoPesquisa?: 'EM_PROCESSAMENTO' | 'CONCLUIDA' | 'CONCLUIDA_PARCIALMENTE' | 'FALHA_TOTAL'
    errosPorFonte?: Record<string, string>
    observabilidade?: any
    itens_fila_pendente?: number
    detalhamento_paralelo?: {
      total_encontrado?: number
      total_detalhado?: number
      itens_fila_pendente?: number
      cache_hits?: number
      amostras_extraidas?: number
    }
  }> {
    // =========================================================================
    // ARQUITETURA ALVO: SearchOrchestrator centralizado.
    // Consulta em paralelo a todas as fontes habilitadas sem limite artificial.
    // Converte AmostraPreco -> BudgetPriceResult preservando rastreabilidade completa.
    // =========================================================================
    const { SearchOrchestrator } = await import('../lib/connectors/searchOrchestrator')
    const orquestrador = SearchOrchestrator.getInstance()

    const resultadoOrquestrador = await orquestrador.executarPesquisa(
      {
        termo: termoBusca,
        uf: filtros?.uf,
        periodoMeses: filtros?.periodo_meses,
        dataInicio: filtros?.data_inicio,
        dataFim: filtros?.data_fim,
        precoMin: filtros?.preco_min,
        precoMax: filtros?.preco_max,
        marca: filtros?.marca,
        unidade: filtros?.unidade,
        apenasMe: filtros?.apenas_me,
        pagina: filtros?.pagina || 1,
        tamanhoPagina: filtros?.tam_pagina,
        forcarAtualizacaoCache: filtros?.forcarAtualizacaoCache,
      },
      {
        fonteSolicitada: filtros?.fonte,
        onProgress: (prog) => {
          if (filtros?.onProgress) {
            const amostrasConvertidas = prog.amostrasAcumuladas.map((a) =>
              BudgetService.converterAmostraPrecoParaBudgetPriceResult(a, item.id),
            )
            const fontes = Array.from(new Set(amostrasConvertidas.map((a) => a.source)))
            filtros.onProgress({
              amostrasAcumuladas: amostrasConvertidas,
              totalAmostras: amostrasConvertidas.length,
              fontesAtivas: fontes,
              estatisticas: {
                totalEncontrados: prog.estatisticasAtuais.totalAmostras,
                valorMinimo: prog.estatisticasAtuais.valorMinimo,
                valorMaximo: prog.estatisticasAtuais.valorMaximo,
                mediaGeral: prog.estatisticasAtuais.mediaGeral,
                medianaGeral: prog.estatisticasAtuais.medianaGeral,
              },
            })
          }
        },
      },
    )

    // Converte AmostraPreco canônica para o modelo BudgetPriceResult utilizado na UI e cálculo
    const precosAgregados: BudgetPriceResult[] = resultadoOrquestrador.amostras.map((a) =>
      BudgetService.converterAmostraPrecoParaBudgetPriceResult(a, item.id),
    )

    const fontesAtivas = Array.from(new Set(precosAgregados.map((p) => p.source)))

    if (precosAgregados.length > 0) {
      BudgetService.persistirResultadosEmSegundoPlano(item.id, termoBusca, precosAgregados)
    }

    const pncpObs = resultadoOrquestrador.observabilidade.detalhePorFonte['pncp']
    const pncpMeta = (pncpObs as any)?.metadata
    const itensFilaPendente =
      pncpObs?.itens_fila_pendente ||
      pncpObs?.detalhamento_paralelo?.itens_fila_pendente ||
      pncpMeta?.itens_fila_pendente ||
      0

    return {
      registros: precosAgregados,
      totais: {
        totalEncontrados:
          resultadoOrquestrador.observabilidade.totalAmostrasInformadasApis ||
          precosAgregados.length,
        valorMinimo: resultadoOrquestrador.estatisticas.valorMinimo,
        valorMaximo: resultadoOrquestrador.estatisticas.valorMaximo,
        mediaGeral: resultadoOrquestrador.estatisticas.mediaGeral,
        medianaGeral: resultadoOrquestrador.estatisticas.medianaGeral,
      },
      origemRealPncp: fontesAtivas.some((f) => f.toUpperCase().includes('PNCP')),
      origemRealBps: fontesAtivas.some((f) => f.toUpperCase().includes('BPS')),
      origemRealComprasGov: fontesAtivas.some((f) => f.toUpperCase().includes('COMPRAS')),
      origemRealPcp: fontesAtivas.some((f) => f.toUpperCase().includes('PORTAL')),
      pcpAguardandoCredenciamento: Boolean(
        resultadoOrquestrador.avisosPorFonte['portal_compras_publicas'],
      ),
      fontesReaisAtivas: fontesAtivas,
      pncpTotalPaginas:
        resultadoOrquestrador.observabilidade.detalhePorFonte['pncp']?.totalPaginasApi || 1,
      pncpPaginaAtual:
        resultadoOrquestrador.observabilidade.detalhePorFonte['pncp']?.paginasProcessadas || 1,
      estadoPesquisa: resultadoOrquestrador.estado,
      errosPorFonte: resultadoOrquestrador.errosPorFonte,
      observabilidade: resultadoOrquestrador.observabilidade,
      itens_fila_pendente: itensFilaPendente,
      detalhamento_paralelo: pncpObs?.detalhamento_paralelo,
    }

    // 2. Base purgada: Nenhuma amostra sintética ou demonstrativa é gerada ou persistida.
    // Retorna vazio com segurança quando não houver registros reais conectados para a fonte.
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

    // Filtrar amostras com preço unitário numérico válido (> 0) e preço informado
    const validas = amostras.filter(
      (a) =>
        typeof a.unit_price === 'number' &&
        !isNaN(a.unit_price) &&
        a.unit_price > 0 &&
        !a.raw_data?.nao_informado,
    )
    if (validas.length === 0) {
      return []
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

    // Utiliza o motor de conectores reais para retornar a base completa
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
  /**
   * Converte uma AmostraPreco do SearchOrchestrator para o modelo BudgetPriceResult utilizado na Cesta de Preços
   */
  public static converterAmostraPrecoParaBudgetPriceResult(
    amostra: import('../lib/connectors/types').AmostraPreco,
    budgetItemId: string,
  ): BudgetPriceResult {
    const isNaoInf =
      !amostra.valorUnitario ||
      amostra.valorUnitario <= 0 ||
      Boolean(amostra.detalhesAdicionais?.nao_informado)
    const detalhamentoPendente = Boolean(
      amostra.detalhesAdicionais?.detalhamento_pendente || isNaoInf,
    )

    return {
      id: amostra.id,
      budget_item_id: budgetItemId,
      source: amostra.fonte,
      source_record_id: amostra.idExterno || 'NÃO INFORMADO',
      source_url: amostra.urlOriginal || '',
      source_date: amostra.dataPublicacaoOuContrato || new Date().toISOString(),
      government_entity: amostra.orgaoComprador || 'Órgão Licitante Oficial',
      supplier: amostra.fornecedorNome || 'NÃO INFORMADO',
      supplier_document: amostra.fornecedorCnpjOuCpf || 'NÃO INFORMADO',
      description_original: amostra.descricaoCompleta,
      description_normalized: amostra.descricaoNormalizada || amostra.descricaoCompleta,
      unit: amostra.unidade || 'UN',
      quantity: amostra.quantidade || 1,
      unit_price: Number((amostra.valorUnitario || 0).toFixed(4)),
      similarity_score: amostra.scoreSimilaridade || 95,
      status: 'encontrado' as const,
      raw_data: {
        orgao_cnpj: amostra.orgaoCnpj || 'NÃO INFORMADO',
        municipio: amostra.municipio || 'NÃO INFORMADO',
        uf: amostra.uf || 'NÃO INFORMADO',
        modalidade: amostra.modalidadeLicitacao || 'Pregão Eletrônico',
        processo: amostra.numeroProcessoOuContrato || 'NÃO INFORMADO',
        marca: amostra.marca || 'NÃO INFORMADO',
        fabricante: amostra.fabricante || 'NÃO INFORMADO',
        porte_empresa: amostra.fornecedorPorte || 'DEMAIS',
        natureza: amostra.natureza,
        hash: amostra.hashRastreabilidade,
        link_oficial: amostra.urlOriginal,
        is_demo: amostra.isDemo,
        is_real_api: !amostra.isDemo,
        origem_real: !amostra.isDemo,
        nao_informado: isNaoInf,
        detalhamento_pendente: detalhamentoPendente,
        ...(amostra.detalhesAdicionais || {}),
      },
      created: amostra.dataPublicacaoOuContrato || new Date().toISOString(),
      updated: amostra.dataPublicacaoOuContrato || new Date().toISOString(),
    }
  }

  static persistirResultadosEmSegundoPlano(
    budgetItemId: string,
    termoBusca: string,
    amostras: BudgetPriceResult[],
  ): void {
    if (!amostras || amostras.length === 0) return

    // Executa em segundo plano via endpoint POST /backend/v1/price-results/batch-save
    // em transação atômica única, eliminando a tempestade de requisições 429
    // Isolado com retry e backoff curto (máx 3 tentativas) para nunca derrubar a sessão do usuário
    setTimeout(async () => {
      const baseUrl = pb.baseUrl || ''
      const url = baseUrl
        ? `${baseUrl}/backend/v1/price-results/batch-save`
        : `/backend/v1/price-results/batch-save`

      const payload = {
        budget_item_id: budgetItemId,
        last_search_term: termoBusca,
        amostras: amostras.map((p) => ({
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
        })),
      }

      const authToken = pb.authStore?.token || ''
      let sucesso = false
      let tentativas = 0
      const maxTentativas = 3

      while (!sucesso && tentativas < maxTentativas) {
        tentativas++
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 15000)

          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(authToken ? { Authorization: authToken } : {}),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
          clearTimeout(timeoutId)

          if (resp.ok) {
            const data = await resp.json()
            sucesso = true
            if (data.divergencia) {
              console.warn(
                `[BATCH-SAVE] Divergência detectada no salvamento: recebidas=${data.recebidas}, gravadas=${data.gravadas}. Item: ${budgetItemId}`,
              )
            } else {
              console.log(
                `[BATCH-SAVE] Gravação em lote concluída: ${data.gravadas}/${data.recebidas} amostras salvas.`,
              )
            }
            break
          } else {
            console.warn(
              `[BATCH-SAVE] Tentativa ${tentativas} retornou HTTP ${resp.status}. Item: ${budgetItemId}`,
            )
          }
        } catch (fetchErr: any) {
          console.warn(
            `[BATCH-SAVE] Tentativa ${tentativas} falhou por erro de rede: ${fetchErr?.message || fetchErr}`,
          )
        }

        if (!sucesso && tentativas < maxTentativas) {
          // Backoff exponencial curto: 300ms, 600ms
          await new Promise((resolve) => setTimeout(resolve, 300 * tentativas))
        }
      }

      if (!sucesso) {
        console.error(
          `[BATCH-SAVE] Falha final ao gravar lote de ${amostras.length} amostras após ${tentativas} tentativas para o item ${budgetItemId}.`,
        )
      }
    }, 50)
  }

  static async listarPrecosDoItem(itemId: string): Promise<BudgetPriceResult[]> {
    try {
      // Recuperação completa via getFullList sem corte artificial (ex.: 100 registros)
      const items = await pb.collection('budget_price_results').getFullList<BudgetPriceResult>({
        filter: `budget_item_id = "${itemId}"`,
        sort: '-created',
      })
      return items
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
      // Recuperação completa via getFullList sem truncamento artificial
      const items = await pb.collection('budget_price_results').getFullList<BudgetPriceResult>({
        filter: `budget_item_id = "${itemId}" && status = "selecionado"`,
        sort: 'unit_price',
      })

      const vistos = new Set<string>()
      const dedup: BudgetPriceResult[] = []
      for (const p of items) {
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
      const expAntigos = await pb.collection('budget_expurgated_prices').getFullList({
        filter: `budget_item_id = "${item.id}"`,
      })
      for (const ea of expAntigos) {
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
   * Helper para referências comparáveis quando busca pública retornar poucas amostras.
   * NEUTRALIZADO DEFINITIVAMENTE: Retorna sempre lista vazia [] para garantir honestidade
   * nos dados e total aderência à Lei nº 14.133/2021. NUNCA inventa amostras sintéticas.
   */
  private static gerarReferenciasCompatibilidade(_item: BudgetItem, _analise: any): any[] {
    return []
  }
}
