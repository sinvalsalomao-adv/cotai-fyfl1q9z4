/**
 * PriceIndexService
 * Centraliza a gestão da base persistente e pesquisável de amostras normalizadas
 * (coleção 'price_samples_index' e fila 'price_index_tasks').
 *
 * Funcionalidades:
 * 1. Persistência idempotente de amostras das fontes oficiais (PNCP e Compras.gov.br)
 * 2. Consulta de alta performance via endpoint /backend/v1/prices/search ou fallback SDK
 * 3. Estatísticas e agregações globais calculadas sobre o conjunto completo filtrado
 * 4. Fila persistente de atualização por escopo/termo/UF
 * 5. Deduplicação por identidade real de item na origem
 */

import pb from './pocketbase/client'
import { AmostraPreco } from './connectors/types'

export interface PriceIndexSearchParams {
  palavra_chave?: string
  termo?: string
  q?: string
  palavra_exata?: boolean
  cnpj?: string
  ordenar?: string // padrão: 'valor_unitario:asc'
  sort?: string
  periodo?: string // ex.: 'MESES_12'
  periodo_meses?: number
  data_inicio?: string
  data_fim?: string
  fonte?: 'PNCP' | 'Compras.gov.br' | 'todas' | string
  sources?: string[]
  uf?: string
  unidade?: string
  marca?: string
  porte?: 'ME_EPP' | 'DEMAIS' | string
  preco_min?: number
  preco_max?: number
  pagina?: number
  tamanho_pagina?: number
  page?: number
  limit?: number
}

export interface PriceIndexHitSource {
  id?: string
  sample_key: string
  compra_id?: string
  item_id?: string
  descricao: string
  descricao_texto?: string
  descricao_normalizada?: string
  fonte: string
  orgao?: string
  orgao_cnpj?: string
  for_nome?: string
  for_cnpj?: string
  for_porte?: string
  unidade: string
  quantidade: number
  valor_unitario: number
  valor_total?: number
  natureza_preco: 'homologado' | 'estimado' | string
  data?: string
  homologacao?: string
  identificador?: string
  link_oficial?: string
  uf?: string
  municipio?: string
  numero?: string
  marca?: string
  codigo_item?: string
  raw_payload?: any
}

export interface PriceIndexHit {
  _index: string
  _id: string
  _score: number
  _source: PriceIndexHitSource
  sort: number[]
}

export interface PriceIndexAggregations {
  preco_minimo?: number
  preco_maximo?: number
  preco_medio?: number
  preco_mediana?: number
  total?: number
  por_fonte?: Record<string, number>
  por_uf?: Record<string, number>
  estatisticas?: {
    n: number
    media: number
    mediana: number
    q1: number
    q3: number
    minimo: number
    maximo: number
    desvio_padrao: number
    iqr: number
    limite_inferior_iqr: number
    limite_superior_iqr: number
    regra_outlier: string
  }
  unidades?: Record<string, number>
  estados?: Record<string, number>
  municipios?: Record<string, number>
}

export interface PriceIndexSearchResult {
  sucesso?: boolean
  total?: number
  page?: number
  limit?: number
  pages?: number
  duracao_ms?: number
  took?: number
  timed_out?: boolean
  hits?: any
  filtros_aplicados?: any
  aggregations?: PriceIndexAggregations
  frescor_sincronizacao?: Record<
    string,
    {
      ultima_data_sincronizada: string
      status: string
      total_coletadas_watermark: number
      ultima_atualizacao: string
    }
  >
  ciclo_diario?: {
    ciclo_id?: string
    data_ciclo?: string
    status?: string
    data_hora?: string
    novas_amostras?: number
    amostras_validadas?: number
    amostras_invalidadas?: number
    duracao_ms?: number
  } | null
  metricas_consulta?: {
    took_ms: number
    amostras_avaliadas: number
    origem_consulta: string
    chamadas_externas_disparadas: number
    protocolo_auditoria?: string
  }
  pagination?: {
    paginaAtual: number
    tamanhoPagina: number
    totalPaginas: number
    totalRegistros: number
  }
}

export interface PriceIndexTask {
  id?: string
  task_key: string
  source: string
  termo: string
  uf?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  paginas_consultadas: number
  itens_processados: number
  amostras_inseridas: number
  amostras_atualizadas: number
  erros?: string[]
  pendentes?: any
  started_at?: string
  finished_at?: string
}

export class PriceIndexService {
  /**
   * Normalização canônica para buscas textuais
   */
  public static canonicalNormalize(s: string): string {
    if (!s) return ''
    return s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Gera uma chave única e estável para a amostra na base indexada
   */
  public static gerarSampleKey(amostra: {
    fonte: string
    idExterno: string
    orgaoCnpj?: string
    fornecedorCnpjOuCpf?: string
    numeroItem?: number | string
    valorUnitario: number
  }): string {
    const f = (amostra.fonte || 'PNCP').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const idExt = String(amostra.idExterno || '').replace(/[^A-Z0-9_-]/gi, '')
    const itemNum = String(amostra.numeroItem || '1')
    const cnpj = String(amostra.orgaoCnpj || amostra.fornecedorCnpjOuCpf || '').replace(/\D/g, '')
    const v = amostra.valorUnitario.toFixed(4).replace('.', '_')
    return `${f}#${idExt}#${itemNum}#${cnpj}#${v}`
  }

  /**
   * Consulta a base persistente de amostras via endpoint de alta performance
   */
  public static async searchIndex(params: PriceIndexSearchParams): Promise<PriceIndexSearchResult> {
    const baseUrl = pb.baseUrl || ''
    const endpoint = baseUrl ? `${baseUrl}/backend/v1/prices/search` : `/backend/v1/prices/search`

    const authToken = pb.authStore?.token || ''

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(authToken ? { Authorization: authToken } : {}),
        },
        body: JSON.stringify(params),
      })

      if (resp.ok) {
        return (await resp.json()) as PriceIndexSearchResult
      }
    } catch (fetchErr) {
      console.warn(
        '[PriceIndexService] Falha ao consultar endpoint /backend/v1/prices/search, tentando fallback SDK:',
        fetchErr,
      )
    }

    // Fallback via PocketBase SDK caso o endpoint customizado falhe
    return this.searchIndexFallbackSdk(params)
  }

  /**
   * Fallback de consulta via SDK PocketBase
   */
  private static async searchIndexFallbackSdk(
    params: PriceIndexSearchParams,
  ): Promise<PriceIndexSearchResult> {
    const t0 = performance.now()
    const pAtual = params.pagina || 1
    const pTam = params.tamanho_pagina || 50
    const termoNorm = this.canonicalNormalize(params.palavra_chave)

    const filters: string[] = ['valor_unitario > 0']

    if (termoNorm) {
      filters.push(`descricao_normalizada ~ "${termoNorm}"`)
    }
    if (params.uf) {
      filters.push(`uf = "${params.uf.toUpperCase()}"`)
    }
    if (params.fonte && params.fonte !== 'todas' && params.fonte !== 'ambas') {
      filters.push(`source = "${params.fonte}"`)
    }
    if (params.preco_min && params.preco_min > 0) {
      filters.push(`valor_unitario >= ${params.preco_min}`)
    }
    if (params.preco_max && params.preco_max > 0) {
      filters.push(`valor_unitario <= ${params.preco_max}`)
    }
    if (params.periodo_meses && params.periodo_meses > 0) {
      const d = new Date()
      d.setMonth(d.getMonth() - params.periodo_meses)
      filters.push(`data_referencia >= "${d.toISOString()}"`)
    }

    const filterStr = filters.join(' && ')
    let sortStr = 'valor_unitario'
    if (params.ordenar === 'valor_unitario:desc') sortStr = '-valor_unitario'
    if (params.ordenar === 'data:desc') sortStr = '-data_referencia'

    try {
      const list = await pb.collection('price_samples_index').getList(pAtual, pTam, {
        filter: filterStr,
        sort: sortStr,
      })

      const hits: PriceIndexHit[] = list.items.map((it: any) => ({
        _index: 'price_samples_index',
        _id: it.id,
        _score: 1.0,
        _source: {
          id: it.id,
          sample_key: it.sample_key,
          compra_id: it.purchase_id,
          item_id: it.item_id,
          descricao: it.descricao,
          descricao_texto: it.descricao,
          descricao_normalizada: it.descricao_normalizada,
          fonte: it.source,
          orgao: it.orgao,
          orgao_cnpj: it.orgao_cnpj,
          for_nome: it.fornecedor_nome,
          for_cnpj: it.fornecedor_cnpj,
          for_porte: it.fornecedor_porte,
          unidade: it.unidade || 'UN',
          quantidade: it.quantidade || 1,
          valor_unitario: it.valor_unitario,
          valor_total: it.valor_total || it.valor_unitario * (it.quantidade || 1),
          natureza_preco: it.natureza_preco || 'homologado',
          data: it.data_referencia,
          homologacao: it.data_referencia,
          identificador: it.source_record_id || it.purchase_id,
          link_oficial: it.url_original,
          uf: it.uf,
          municipio: it.municipio,
          numero: it.numero_processo || it.numero_ata,
          marca: it.marca,
          codigo_item: it.codigo_item,
        },
        sort: [it.valor_unitario],
      }))

      const vals = list.items.map((i: any) => i.valor_unitario).filter((v: number) => v > 0)
      const minVal = vals.length > 0 ? Math.min(...vals) : 0
      const maxVal = vals.length > 0 ? Math.max(...vals) : 0
      const medVal =
        vals.length > 0 ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : 0

      return {
        took: Math.round(performance.now() - t0),
        timed_out: false,
        hits: {
          total: list.totalItems,
          max_score: 1.0,
          hits,
        },
        aggregations: {
          preco_minimo: minVal,
          preco_maximo: maxVal,
          preco_medio: Number(medVal.toFixed(4)),
          preco_mediana: Number(medVal.toFixed(4)),
          unidades: {},
          estados: {},
          municipios: {},
        },
        pagination: {
          paginaAtual: list.page,
          tamanhoPagina: list.perPage,
          totalPaginas: list.totalPages,
          totalRegistros: list.totalItems,
        },
      }
    } catch {
      return {
        took: Math.round(performance.now() - t0),
        timed_out: false,
        hits: { total: 0, max_score: 0, hits: [] },
        aggregations: {
          preco_minimo: 0,
          preco_maximo: 0,
          preco_medio: 0,
          preco_mediana: 0,
          unidades: {},
          estados: {},
          municipios: {},
        },
        pagination: {
          paginaAtual: pAtual,
          tamanhoPagina: pTam,
          totalPaginas: 1,
          totalRegistros: 0,
        },
      }
    }
  }

  /**
   * Persiste uma lista de AmostraPreco na base indexada de forma IDEMPOTENTE
   * Reconhece existentes por sample_key e atualiza apenas se necessário.
   */
  public static async persistirAmostras(
    amostras: AmostraPreco[],
  ): Promise<{ inseridas: number; atualizadas: number; ignoradas: number }> {
    let inseridas = 0
    let atualizadas = 0
    let ignoradas = 0

    if (!amostras || amostras.length === 0) {
      return { inseridas, atualizadas, ignoradas }
    }

    const agora = new Date().toISOString()

    for (const a of amostras) {
      if (typeof a.valorUnitario !== 'number' || isNaN(a.valorUnitario) || a.valorUnitario <= 0) {
        ignoradas++
        continue
      }

      const sampleKey = this.gerarSampleKey({
        fonte: a.fonte,
        idExterno: a.idExterno,
        orgaoCnpj: a.orgaoCnpj,
        fornecedorCnpjOuCpf: a.fornecedorCnpjOuCpf,
        numeroItem: (a.detalhesAdicionais as any)?.numeroItem || 1,
        valorUnitario: a.valorUnitario,
      })

      const descNorm = this.canonicalNormalize(a.descricaoCompleta || a.produto)

      const payload = {
        sample_key: sampleKey,
        source: a.fonte.toUpperCase().includes('COMPRAS') ? 'Compras.gov.br' : 'PNCP',
        source_record_id: a.idExterno,
        purchase_id: a.idExterno,
        item_id: String((a.detalhesAdicionais as any)?.numeroItem || '1'),
        descricao: (a.descricaoCompleta || a.produto || '').trim(),
        descricao_normalizada: descNorm,
        orgao: a.orgaoComprador || 'Órgão Público',
        orgao_cnpj: a.orgaoCnpj || '',
        fornecedor_nome: a.fornecedorNome || 'NÃO INFORMADO',
        fornecedor_cnpj: a.fornecedorCnpjOuCpf || '',
        fornecedor_porte: a.fornecedorPorte || 'DEMAIS',
        uf: a.uf || '',
        municipio: a.municipio || '',
        unidade: a.unidade || 'UN',
        quantidade: a.quantidade || 1,
        valor_unitario: Number(a.valorUnitario.toFixed(4)),
        valor_total: Number((a.valorUnitario * (a.quantidade || 1)).toFixed(4)),
        natureza_preco: a.natureza === 'estimado' ? 'estimado' : 'homologado',
        data_referencia: a.dataPublicacaoOuContrato || agora,
        numero_processo: a.numeroProcessoOuContrato || '',
        numero_ata: '',
        modalidade: a.modalidadeLicitacao || '',
        marca: a.marca || 'NÃO INFORMADO',
        codigo_item: a.codigoCatalogo || '',
        url_original: a.urlOriginal || '',
        raw_payload: a.detalhesAdicionais || {},
        indexed_at: agora,
        source_updated_at: agora,
        last_validated_at: agora,
      }

      try {
        // Tenta buscar existente pela chave estável
        const existente = await pb
          .collection('price_samples_index')
          .getFirstListItem(`sample_key = "${sampleKey}"`)
        if (existente) {
          // Atualiza dados e validação
          await pb.collection('price_samples_index').update(existente.id, {
            valor_unitario: payload.valor_unitario,
            valor_total: payload.valor_total,
            last_validated_at: agora,
            raw_payload: payload.raw_payload,
          })
          atualizadas++
        }
      } catch {
        // Não existe -> insere novo
        try {
          await pb.collection('price_samples_index').create(payload)
          inseridas++
        } catch {
          ignoradas++
        }
      }
    }

    return { inseridas, atualizadas, ignoradas }
  }

  /**
   * Converte um registro indexado (PriceIndexHitSource) para o modelo canônico AmostraPreco
   */
  public static hitToAmostraPreco(hitSource: any): AmostraPreco {
    const valor = Number(hitSource.valor_unitario) || 0
    const idUnico = hitSource.sample_key || `IDX-${hitSource.id || Math.random()}`
    const rawFonte = hitSource.fonte || hitSource.source || 'PNCP'
    const isComprasGov = String(rawFonte).toUpperCase().includes('COMPRAS')

    return {
      id: idUnico,
      fonte: isComprasGov ? 'Compras.gov.br' : 'PNCP',
      fonteNomeExibicao: isComprasGov
        ? 'Compras.gov.br (dadosabertos.compras.gov.br)'
        : 'PNCP (Portal Nacional de Contratações Públicas)',
      idExterno:
        hitSource.identificador || hitSource.compra_id || hitSource.source_record_id || idUnico,
      urlOriginal: hitSource.link_oficial || hitSource.url_original || '',
      dataPublicacaoOuContrato:
        hitSource.data ||
        hitSource.homologacao ||
        hitSource.data_referencia ||
        new Date().toISOString(),
      produto: hitSource.descricao || '',
      descricaoCompleta: hitSource.descricao || '',
      descricaoNormalizada: hitSource.descricao_normalizada || hitSource.descricao || '',
      orgaoComprador: hitSource.orgao || 'Órgão Público',
      orgaoCnpj: hitSource.orgao_cnpj || '',
      municipio: hitSource.municipio || '',
      uf: hitSource.uf || '',
      fornecedorNome: hitSource.for_nome || hitSource.fornecedor_nome || 'NÃO INFORMADO',
      fornecedorCnpjOuCpf: hitSource.for_cnpj || hitSource.fornecedor_cnpj || '',
      fornecedorPorte: (hitSource.for_porte || hitSource.fornecedor_porte || 'DEMAIS') as any,
      unidade: hitSource.unidade || 'UN',
      quantidade: Number(hitSource.quantidade) || 1,
      valorUnitario: valor,
      valorTotal: Number(hitSource.valor_total) || valor * (Number(hitSource.quantidade) || 1),
      modalidadeLicitacao: hitSource.modalidade || hitSource.numero || 'Pregão Eletrônico',
      numeroProcessoOuContrato: hitSource.numero_processo || hitSource.numero || '',
      marca: hitSource.marca || 'NÃO INFORMADO',
      codigoCatalogo: hitSource.codigo_item || 'CATMAT',
      hashRastreabilidade: hitSource.payload_hash || idUnico,
      scoreSimilaridade: Number(hitSource.matching_score) || 100,
      natureza: hitSource.natureza_preco === 'estimado' ? 'estimado' : 'contratado',
      isDemo: false,
      detalhesAdicionais: {
        ...(typeof hitSource.raw_payload === 'string'
          ? { rawStr: hitSource.raw_payload }
          : hitSource.raw_payload || {}),
        qualidade_situacao: hitSource.qualidade_situacao || 'aceita',
        motivos_rejeicao: hitSource.motivos_rejeicao,
        matching_tipo: hitSource.matching_tipo || 'texto_normalizado',
      },
    }
  }

  /**
   * Registra ou atualiza tarefa na fila persistente price_index_tasks
   */
  public static async registrarTarefaAtualizacao(
    termo: string,
    source: string,
    uf?: string,
  ): Promise<{ id: string; termo: string; status: string }> {
    const taskKey = `${source.toUpperCase()}#${this.canonicalNormalize(termo)}#${(uf || 'ALL').toUpperCase()}`
    const agora = new Date().toISOString()

    try {
      const existente = await pb
        .collection('price_index_tasks')
        .getFirstListItem(`task_key = "${taskKey}"`)
      if (existente) {
        // Se a tarefa já estava concluída ou falhou, reabre com status pending para continuar drenando páginas e contratações
        if (existente.status === 'completed' || existente.status === 'failed') {
          await pb.collection('price_index_tasks').update(existente.id, {
            status: 'pending',
            tentativas: 0,
          })
          return { id: existente.id, termo, status: 'pending' }
        }
        return { id: existente.id, termo, status: existente.status }
      }
    } catch {
      // cria se não existe
    }

    try {
      const nova = await pb.collection('price_index_tasks').create({
        task_key: taskKey,
        source,
        termo,
        uf: uf || '',
        status: 'pending',
        paginas_consultadas: 0,
        itens_processados: 0,
        amostras_inseridas: 0,
        amostras_atualizadas: 0,
        created_at: agora,
      })
      return { id: nova.id, termo, status: 'pending' }
    } catch (errCreate: any) {
      console.error('[PriceIndexService] Erro ao registrar tarefa de indexação:', errCreate)
      throw errCreate
    }
  }

  /**
   * Atualiza status da tarefa na fila
   */
  public static async atualizarTarefa(
    taskIdOrKey: string,
    updates: Partial<PriceIndexTask>,
  ): Promise<void> {
    try {
      let recordId = taskIdOrKey
      if (taskIdOrKey.includes('#')) {
        const item = await pb
          .collection('price_index_tasks')
          .getFirstListItem(`task_key = "${taskIdOrKey}"`)
        recordId = item.id
      }
      await pb.collection('price_index_tasks').update(recordId, updates)
    } catch (errUpdate: any) {
      console.error('[PriceIndexService] Erro ao atualizar tarefa na fila:', errUpdate)
      throw errUpdate
    }
  }
}
export default PriceIndexService
