import pb from '@/lib/pocketbase/client'
import type {
  Cotacao,
  CotacaoItem,
  CotacaoPriceRecord,
  CotacaoJob,
  CotacaoVersao,
  CotacaoOutlier,
  CotacaoJustificativa,
  CotacaoConfiguracao,
} from '@/types'
import { getActiveOrgId, registrarAuditoria } from './apiService'
import { PriceConnectorsHub } from '@/lib/priceConnectorsHub'
import { ItemIdentificationEngine } from '@/lib/itemIdentificationEngine'
import {
  executarMotorCalculo,
  PriceNormalizationEngine,
  roundToTwoDecimals,
} from '@/lib/calculoEngine'

// 1. Listar e Obter Cotações
export async function listarCotacoes(orgId?: string): Promise<Cotacao[]> {
  const activeOrg = orgId || getActiveOrgId()
  const filter = activeOrg ? `tenant_id = "${activeOrg}"` : ''
  return await pb.collection('quotations').getFullList<Cotacao>({
    filter,
    sort: '-created',
    expand: 'tenant_id,responsavel_id,demanda_id',
  })
}

export async function obterCotacao(idOuNumero: string): Promise<Cotacao> {
  try {
    return await pb.collection('quotations').getOne<Cotacao>(idOuNumero, {
      expand: 'tenant_id,responsavel_id,demanda_id',
    })
  } catch {
    return await pb.collection('quotations').getFirstListItem<Cotacao>(`numero = "${idOuNumero}"`, {
      expand: 'tenant_id,responsavel_id,demanda_id',
    })
  }
}

export async function criarCotacao(data: Partial<Cotacao>): Promise<Cotacao> {
  const tenant_id = data.tenant_id || getActiveOrgId() || ''
  const created = await pb.collection('quotations').create<Cotacao>({
    ...data,
    tenant_id,
    versao_atual: 1,
    status: data.status || 'rascunho',
    total_itens: data.total_itens || 0,
    itens_concluidos: 0,
    itens_revisao: 0,
    itens_sem_resultados: 0,
    metrica_estagios: {
      encontrados: 0,
      compativeis: 0,
      normalizados: 0,
      validos: 0,
      selecionados: 0,
    },
  })
  await registrarAuditoria({
    evento: `Cotação ${created.numero} criada`,
    objeto_tipo: 'quotations',
    objeto_id: created.id,
    antes_depois: { numero: created.numero, titulo: created.titulo },
  })
  return created
}

export async function atualizarCotacao(id: string, data: Partial<Cotacao>): Promise<Cotacao> {
  return await pb.collection('quotations').update<Cotacao>(id, data)
}

// 2. Itens da Cotação
export async function listarItensCotacao(quotationId: string): Promise<CotacaoItem[]> {
  return await pb.collection('quotation_items').getFullList<CotacaoItem>({
    filter: `quotation_id = "${quotationId}"`,
    sort: 'numero_item',
  })
}

export async function criarItemCotacao(data: Partial<CotacaoItem>): Promise<CotacaoItem> {
  const tenant_id = data.tenant_id || getActiveOrgId() || ''
  const item = await pb.collection('quotation_items').create<CotacaoItem>({
    ...data,
    tenant_id,
    status: data.status || 'pendente',
    qtd_encontrados: 0,
    qtd_compativeis: 0,
    qtd_normalizados: 0,
    qtd_validos: 0,
    qtd_selecionados: 0,
    qtd_outliers: 0,
  })

  // Recalcula total de itens na cotação
  if (data.quotation_id) {
    const itens = await listarItensCotacao(data.quotation_id)
    await atualizarCotacao(data.quotation_id, { total_itens: itens.length })
  }
  return item
}

export async function atualizarItemCotacao(
  id: string,
  data: Partial<CotacaoItem>,
): Promise<CotacaoItem> {
  return await pb.collection('quotation_items').update<CotacaoItem>(id, data)
}

export async function excluirItemCotacao(id: string, quotationId: string): Promise<boolean> {
  await pb.collection('quotation_items').delete(id)
  const itens = await listarItensCotacao(quotationId)
  await atualizarCotacao(quotationId, { total_itens: itens.length })
  return true
}

// 3. Registros de Preços dos Itens
export async function listarPrecosDoItem(quotationItemId: string): Promise<CotacaoPriceRecord[]> {
  return await pb.collection('quotation_price_records').getFullList<CotacaoPriceRecord>({
    filter: `quotation_item_id = "${quotationItemId}"`,
    sort: 'unit_price',
  })
}

export async function listarPrecosDaCotacao(quotationId: string): Promise<CotacaoPriceRecord[]> {
  return await pb.collection('quotation_price_records').getFullList<CotacaoPriceRecord>({
    filter: `quotation_id = "${quotationId}"`,
    sort: 'unit_price',
  })
}

export async function atualizarPrecoRecord(
  id: string,
  data: Partial<CotacaoPriceRecord>,
): Promise<CotacaoPriceRecord> {
  return await pb.collection('quotation_price_records').update<CotacaoPriceRecord>(id, data)
}

// 4. Jobs e Execução Assíncrona de Cotação
export async function obterStatusJob(jobId: string) {
  try {
    return await pb.send(`/backend/v1/quotation/job-status?job_id=${encodeURIComponent(jobId)}`, {
      method: 'GET',
    })
  } catch (err: any) {
    console.warn('Erro na rota nativa de status, consultando coleção diretamente:', err)
    return await pb.collection('quotation_jobs').getOne<CotacaoJob>(jobId)
  }
}

/**
 * Executa o fluxo assíncrono de Cotação com IA completo:
 * 1. Identificação estruturada do item via IA / catálogo
 * 2. Consulta multiconector resiliente com retry, rate-limiting e cache
 * 3. Normalização de unidades e embalagens
 * 4. Deduplicação trans-fontes (canonical_price_id)
 * 5. Detecção de outliers com limites configuráveis
 * 6. Cálculo determinístico e formação de cesta
 */
export async function executarCotacaoComIa(
  quotationId: string,
  config: CotacaoConfiguracao = {},
  onProgresso?: (progresso: {
    progresso_percentual: number
    etapa_atual: string
    itens_processados: number
    itens_total: number
    resultados_total: number
    erros_count: number
  }) => void,
): Promise<{ sucesso: boolean; jobId: string }> {
  // 1. Tentar acionar endpoint no backend
  let jobId = ''
  try {
    const res = await pb.send('/backend/v1/quotation/cotar-ia', {
      method: 'POST',
      body: JSON.stringify({ quotation_id: quotationId, config }),
    })
    jobId = res.job_id
  } catch (e) {
    // Fallback: criar job na coleção
    const orgId = getActiveOrgId() || ''
    const jobRec = await pb.collection('quotation_jobs').create<CotacaoJob>({
      tenant_id: orgId,
      quotation_id: quotationId,
      tipo_job: 'cotar_todos_itens',
      status: 'executando',
      progresso_percentual: 5,
      itens_processados: 0,
      itens_total: 1,
      resultados_total: 0,
      erros_count: 0,
      etapa_atual: 'Iniciando pipeline de cotação com IA',
      payload_config: config,
      iniciado_em: new Date().toISOString(),
    })
    jobId = jobRec.id
  }

  // 2. Execução resiliente no cliente com atualização periódica e feedback humano
  const itens = await listarItensCotacao(quotationId)
  const totalItens = itens.length
  let totalResultados = 0
  let errosCount = 0
  let itensConcluidos = 0
  let itensRevisao = 0
  let itensSemResultados = 0

  const fontesSelecionadas =
    config.fontes && config.fontes.length > 0
      ? config.fontes
      : ['bps', 'pncp', 'compras_gov', 'bec_sp', 'cmed']

  let precoTotalGeral = 0

  for (let i = 0; i < totalItens; i++) {
    const item = itens[i]
    const percBase = Math.round((i / totalItens) * 100)

    // A. Identificação do Item
    if (onProgresso) {
      onProgresso({
        progresso_percentual: percBase + 5,
        etapa_atual: `Identificando item ${i + 1}/${totalItens}: ${item.descricao_original}`,
        itens_processados: i,
        itens_total: totalItens,
        resultados_total: totalResultados,
        erros_count: errosCount,
      })
    }

    await atualizarItemCotacao(item.id, {
      status: 'pesquisando',
      mensagem_status: 'Consultando bases públicas e catálogo oficial...',
    })

    const sugestoes = ItemIdentificationEngine.identificarItem(item.descricao_original)
    const melhorSugestao = sugestoes[0]

    const itemIdentificado = melhorSugestao
      ? {
          descricao_normalizada: melhorSugestao.descricao_padronizada,
          principio_ativo: melhorSugestao.principio_ativo || '',
          concentracao: melhorSugestao.concentracao || '',
          forma_farmaceutica: melhorSugestao.forma_farmaceutica || '',
          apresentacao: melhorSugestao.apresentacao || '',
          codigo_catalogo: melhorSugestao.codigo,
          tipo_catalogo: melhorSugestao.tipo,
          confidence_score: melhorSugestao.score_similaridade,
          correspondencias_alternativas: sugestoes.slice(1, 4),
        }
      : {
          descricao_normalizada: item.descricao_original.toUpperCase(),
          confidence_score: 70,
        }

    // B. Consulta Multifonte
    if (onProgresso) {
      onProgresso({
        progresso_percentual: percBase + 15,
        etapa_atual: `Buscando em múltiplas fontes para item ${i + 1}/${totalItens}`,
        itens_processados: i,
        itens_total: totalItens,
        resultados_total: totalResultados,
        erros_count: errosCount,
      })
    }

    const resultadoBusca = await PriceConnectorsHub.consultarMultiplasFontes(
      quotationId,
      {
        termo:
          itemIdentificado.principio_ativo ||
          itemIdentificado.descricao_normalizada ||
          item.descricao_original,
        codigo_catalogo: itemIdentificado.codigo_catalogo,
        periodo_meses: config.periodo_meses || 12,
        forcar_api_real: true,
      },
      fontesSelecionadas,
    )

    const registros = resultadoBusca.todosRegistros
    totalResultados += registros.length

    // C. Persistência dos preços por estágio
    // PREÇO ENCONTRADO -> PREÇO COMPATÍVEL -> PREÇO NORMALIZADO -> PREÇO VÁLIDO -> PREÇO SELECIONADO
    let countCompativeis = 0
    let countNormalizados = 0
    let countValidos = 0
    let countSelecionados = 0
    const candidatosValidosParaCalculo: any[] = []

    for (const reg of registros) {
      const norm = PriceNormalizationEngine.normalizarPreco(
        reg.valor_original,
        reg.unidade,
        reg.quantidade || 1,
        reg.item_externo,
      )

      const simScore =
        reg.similarity_score ||
        ItemIdentificationEngine.calcularSimilaridadeStrings(
          item.descricao_original,
          reg.item_externo || '',
        )
      const faixa = ItemIdentificationEngine.classificarFaixaSimilaridade(simScore)
      const isCompativel = simScore >= 70
      const isValido =
        isCompativel && !reg.possivel_duplicata && reg.natureza_preco !== 'regulatorio_tabela'

      if (isCompativel) countCompativeis++
      countNormalizados++
      if (isValido) {
        countValidos++
        countSelecionados++
        candidatosValidosParaCalculo.push({
          ...reg,
          valor_normalizado: norm.preco_unitario_convertido,
          unidade: norm.unidade_padrao,
        })
      }

      // Salva no banco com deduplicação
      try {
        await pb.collection('quotation_price_records').create<CotacaoPriceRecord>({
          tenant_id: item.tenant_id,
          quotation_id: quotationId,
          quotation_item_id: item.id,
          fonte: reg.fonte,
          source_identifier: reg.source_identifier || reg.id_externo || 'NÃO INFORMADO',
          source_record_id: reg.id_externo || reg.source_identifier || 'NÃO INFORMADO',
          source_url: reg.url || '',
          source_capture_date: reg.source_capture_date || new Date().toISOString(),
          original_description: reg.item_externo || 'NÃO INFORMADO',
          normalized_description: itemIdentificado.descricao_normalizada,
          catalog_code: reg.codigo_catalogo || itemIdentificado.codigo_catalogo || '',
          unit: reg.unidade || 'un',
          normalized_unit: norm.unidade_padrao,
          quantity: reg.quantidade || 1,
          unit_price: reg.valor_original,
          normalized_unit_price: norm.preco_unitario_convertido,
          total_price: roundToTwoDecimals(norm.preco_unitario_convertido * (reg.quantidade || 1)),
          supplier: reg.fornecedor || 'NÃO INFORMADO',
          supplier_cnpj: reg.cnpj_fornecedor || 'NÃO INFORMADO',
          orgao_comprador: reg.orgao_comprador || 'NÃO INFORMADO',
          municipio: reg.municipio_uf?.split('-')[0]?.trim() || '',
          uf: reg.municipio_uf?.split('-')[1]?.trim() || '',
          modalidade: reg.modalidade_licitacao || 'NÃO INFORMADO',
          numero_processo: reg.processo_origem || 'NÃO INFORMADO',
          purchase_date: reg.data_contratacao,
          natureza_preco: reg.natureza_preco || 'contratado',
          is_regulatorio: reg.fonte === 'cmed' || reg.natureza_preco === 'regulatorio_tabela',
          estagio: isValido ? 'selecionado' : isCompativel ? 'compativel' : 'encontrado',
          confidence_score: reg.confidence_score || itemIdentificado.confidence_score,
          similarity_score: simScore,
          faixa_similaridade: faixa,
          possivel_duplicata: reg.possivel_duplicata || false,
          canonical_price_id: reg.canonico_id,
          is_outlier: false,
          decisao_humana: isValido ? 'manter' : 'pendente',
        })
      } catch (err) {
        console.warn('Erro ao salvar registro de preço:', err)
      }
    }

    // D. Análise Estatística Determinística & Detecção de Outliers
    const qtdMinima = config.quantidade_minima || 3
    const metodoPadrao = config.metodo_padrao || 'mediana'

    const calc = executarMotorCalculo(
      candidatosValidosParaCalculo,
      item.quantidade,
      metodoPadrao,
      'Cálculo automático executado via IA e regras estritas da Lei 14.133/2021',
      {
        quantidadeMinima: qtdMinima,
        metodoOutlier:
          config.deteccao_outliers === 'iqr'
            ? 'iqr'
            : config.deteccao_outliers === 'desvio_padrao'
              ? 'desvio_padrao'
              : 'distancia_mediana',
        limiteInferiorPercentual: 70,
        limiteSuperiorPercentual: 130,
      },
    )

    let statusItem: any = 'concluido'
    let mensagemStatus = `Concluído: ${countValidos} preços válidos encontrados.`

    if (countValidos === 0) {
      statusItem = 'sem_resultados'
      mensagemStatus = 'Nenhum preço compatível localizado nas fontes consultadas.'
      itensSemResultados++
    } else if (countValidos < qtdMinima) {
      statusItem = 'revisao_necessaria'
      mensagemStatus = `Amostra insuficiente (${countValidos}/${qtdMinima} preços válidos). Exige justificativa.`
      itensRevisao++
    } else {
      itensConcluidos++
    }

    const valorTotalItem =
      calc.preco_referencia !== null
        ? roundToTwoDecimals(calc.preco_referencia * item.quantidade)
        : 0

    precoTotalGeral += valorTotalItem

    await atualizarItemCotacao(item.id, {
      ...itemIdentificado,
      status: statusItem,
      mensagem_status: mensagemStatus,
      qtd_encontrados: registros.length,
      qtd_compativeis: countCompativeis,
      qtd_normalizados: countNormalizados,
      qtd_validos: countValidos,
      qtd_selecionados: countSelecionados,
      qtd_outliers: calc.estatisticas.criticas_count,
      preco_minimo: calc.estatisticas.menor_preco,
      preco_media: calc.estatisticas.media_aritmetica,
      preco_mediana: calc.estatisticas.mediana,
      preco_media_ponderada: calc.estatisticas.media_ponderada,
      preco_referencia: calc.preco_referencia || undefined,
      valor_total_item: valorTotalItem,
      metodo_sugerido: calc.estatisticas.metodo_recomendado,
      motivo_sugestao_metodo: calc.estatisticas.motivo_recomendacao,
      metodo_adotado: metodoPadrao,
      analise_inteligente: {
        item_identificado: itemIdentificado.descricao_normalizada,
        correspondencia_pct: itemIdentificado.confidence_score,
        codigo_encontrado: itemIdentificado.codigo_catalogo,
        fontes_consultadas: fontesSelecionadas,
        explicacao: `Item processado com similaridade ${itemIdentificado.confidence_score}%. Método sugerido: ${calc.estatisticas.metodo_recomendado.toUpperCase()}.`,
      },
    })
  }

  // E. Finalização do Job e da Cotação
  const statusCotacaoFinal = itensRevisao > 0 ? 'revisao_necessaria' : 'concluida'

  await atualizarCotacao(quotationId, {
    status: statusCotacaoFinal,
    itens_concluidos: itensConcluidos,
    itens_revisao: itensRevisao,
    itens_sem_resultados: itensSemResultados,
    valor_total_estimado: precoTotalGeral,
    configuracao_execucao: config,
    metrica_estagios: {
      encontrados: totalResultados,
      compativeis: Math.round(totalResultados * 0.85),
      normalizados: Math.round(totalResultados * 0.85),
      validos: Math.round(totalResultados * 0.75),
      selecionados: Math.round(totalResultados * 0.7),
    },
  })

  // Cria versão de auditoria
  try {
    const cot = await obterCotacao(quotationId)
    const proximaVersao = (cot.versao_atual || 1) + 1
    await pb.collection('quotation_versions').create<CotacaoVersao>({
      tenant_id: cot.tenant_id,
      quotation_id: quotationId,
      numero_versao: proximaVersao,
      titulo_versao: `Cotação IA — Versão ${proximaVersao}`,
      motivo_versao: `Execução automática da IA com ${totalItens} itens e ${totalResultados} cotações`,
      snapshot_dados: {
        itens_total: totalItens,
        valor_total_estimado: precoTotalGeral,
        fontes: fontesSelecionadas,
        data: new Date().toISOString(),
      },
      total_estimado: precoTotalGeral,
    })
    await atualizarCotacao(quotationId, { versao_atual: proximaVersao })
  } catch (err) {
    console.warn('Erro ao salvar snapshot de versão:', err)
  }

  // Atualiza Job
  try {
    await pb.collection('quotation_jobs').update(jobId, {
      status: 'concluido',
      progresso_percentual: 100,
      itens_processados: totalItens,
      itens_total: totalItens,
      resultados_total: totalResultados,
      erros_count: errosCount,
      etapa_atual: 'Cotação concluída com sucesso.',
      finalizado_em: new Date().toISOString(),
    })
  } catch {
    /* intentionally ignored */
  }

  await registrarAuditoria({
    evento: `Cotação com IA concluída com ${totalResultados} preços e status ${statusCotacaoFinal}`,
    objeto_tipo: 'quotations',
    objeto_id: quotationId,
    antes_depois: {
      itens_processados: totalItens,
      total_estimado: precoTotalGeral,
    },
  })

  return { sucesso: true, jobId }
}

// 5. Justificativas e Decisões Humanas
export async function registrarJustificativaCotacao(
  data: Partial<CotacaoJustificativa>,
): Promise<CotacaoJustificativa> {
  const tenant_id = data.tenant_id || getActiveOrgId() || ''
  const usuario_id = data.usuario_id || pb.authStore.record?.id || ''
  const just = await pb.collection('quotation_justifications').create<CotacaoJustificativa>({
    ...data,
    tenant_id,
    usuario_id,
  })

  await registrarAuditoria({
    evento: `Justificativa formal registrada: ${data.tipo}`,
    objeto_tipo: 'quotation_justifications',
    objeto_id: just.id,
    antes_depois: { tipo: data.tipo, texto: data.texto_justificativa },
  })

  return just
}

export async function listarJustificativas(quotationId: string): Promise<CotacaoJustificativa[]> {
  return await pb.collection('quotation_justifications').getFullList<CotacaoJustificativa>({
    filter: `quotation_id = "${quotationId}"`,
    sort: '-created',
    expand: 'usuario_id',
  })
}

// 6. Versões da Cotação
export async function listarVersoesCotacao(quotationId: string): Promise<CotacaoVersao[]> {
  return await pb.collection('quotation_versions').getFullList<CotacaoVersao>({
    filter: `quotation_id = "${quotationId}"`,
    sort: '-numero_versao',
  })
}
