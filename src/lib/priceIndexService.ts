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
  modalidade?: string
  natureza_preco?: string
  apenas_me_epp?: boolean
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
  // Validade do resumo original; a adaptação legada de hits pode sintetizar total.
  summary_valid?: boolean
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
  status_tarefa?: {
    id?: string
    task_key?: string
    status?: string
    ativa?: boolean
    pendentes_count?: number
    paginas_consultadas?: number
    itens_processados?: number
    amostras_inseridas?: number
    amostras_atualizadas?: number
    tentativas?: number
    updated?: string
  } | null
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

// Página de transporte: nenhum campo representa a população global ou suas estatísticas.
export interface PriceIndexPageResult {
  sucesso: true
  summary_included: false
  page: number
  limit: number
  hits: any[]
  duracao_ms: number
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
   * Normaliza o resultado da busca para um contrato único unificado.
   * Suporta tanto o formato real PLANO retornado por /backend/v1/prices/search
   * { total, hits: [...], aggregations: { total, por_fonte, ... } }
   * quanto o formato legado ANINHADO estilo Elasticsearch
   * { hits: { total, hits: [ { _source: ... } ] } }.
   * Zero válido não é ausência; erro não é zero.
   */
  public static normalizeSearchResult(raw: any, duracaoMs = 0): PriceIndexSearchResult {
    if (!raw || typeof raw !== 'object') {
      return {
        sucesso: false,
        summary_valid: false,
        total: 0,
        page: 1,
        limit: 50,
        pages: 0,
        duracao_ms: duracaoMs,
        took: duracaoMs,
        timed_out: false,
        hits: Object.assign([], { hits: [], total: 0, max_score: 0 }),
        aggregations: {
          preco_minimo: 0,
          preco_maximo: 0,
          preco_medio: 0,
          preco_mediana: 0,
          total: 0,
          por_fonte: {},
          por_uf: {},
          estatisticas: {
            n: 0,
            media: 0,
            mediana: 0,
            q1: 0,
            q3: 0,
            minimo: 0,
            maximo: 0,
            desvio_padrao: 0,
            iqr: 0,
            limite_inferior_iqr: 0,
            limite_superior_iqr: 0,
            regra_outlier: 'nenhuma',
          },
        },
        pagination: {
          paginaAtual: 1,
          tamanhoPagina: 50,
          totalPaginas: 0,
          totalRegistros: 0,
        },
      }
    }

    // 1. Extração segura dos hits (suporta plano ou aninhado)
    let rawHitsList: any[] = []
    if (Array.isArray(raw.hits)) {
      rawHitsList = raw.hits
    } else if (raw.hits && Array.isArray(raw.hits.hits)) {
      rawHitsList = raw.hits.hits
    } else if (Array.isArray(raw.items)) {
      rawHitsList = raw.items
    }

    // 2. Extração segura do total
    let totalItems = 0
    let totalInformado = true
    if (typeof raw.total === 'number' && !isNaN(raw.total)) {
      totalItems = raw.total
    } else if (raw.hits && typeof raw.hits.total === 'number' && !isNaN(raw.hits.total)) {
      totalItems = raw.hits.total
    } else if (typeof raw.totalItems === 'number' && !isNaN(raw.totalItems)) {
      totalItems = raw.totalItems
    } else if (raw.aggregations && typeof raw.aggregations.total === 'number') {
      totalItems = raw.aggregations.total
    } else {
      totalItems = rawHitsList.length
      totalInformado = false
    }
    // Não confundir o comprimento da página/adaptação legada com população informada.
    const summaryValid =
      totalInformado &&
      Number.isFinite(totalItems) &&
      totalItems >= 0 &&
      raw.sucesso !== false &&
      !raw.timed_out &&
      raw.summary_included !== false &&
      raw.summary_valid !== false

    // 3. Normalização de cada hit: cada elemento deve conter as propriedades diretas E ._source
    const normalizedHits: PriceIndexHit[] = rawHitsList.map((h: any, idx: number) => {
      const src: PriceIndexHitSource = h && typeof h === 'object' && h._source ? h._source : h || {}
      const unitPrice =
        typeof src.valor_unitario === 'number'
          ? src.valor_unitario
          : Number(src.valor_unitario) || 0
      const hitObj: PriceIndexHit = {
        _index: h?._index || 'price_samples_index',
        _id: String(h?._id || h?.id || src.id || src.sample_key || `hit-${idx}`),
        _score: typeof h?._score === 'number' ? h._score : 1.0,
        _source: src,
        sort: Array.isArray(h?.sort) ? h.sort : [unitPrice],
      }
      // Garante que o hitObj seja utilizável tanto por consumidores planos quanto legados
      Object.assign(hitObj, src)
      return hitObj
    })

    // Cria um array especial que também responde a .hits e .total (compatibilidade total)
    const hybridHitsArray: any = [...normalizedHits]
    hybridHitsArray.hits = normalizedHits
    hybridHitsArray.total = totalItems
    hybridHitsArray.max_score = 1.0

    // 4. Normalização de agregações
    const rawAgg = raw.aggregations || {}
    const porFonte = rawAgg.por_fonte || {}
    const porUf = rawAgg.por_uf || {}
    const stats = rawAgg.estatisticas || {
      n: totalItems,
      media: rawAgg.preco_medio || 0,
      mediana: rawAgg.preco_mediana || 0,
      q1: 0,
      q3: 0,
      minimo: rawAgg.preco_minimo || 0,
      maximo: rawAgg.preco_maximo || 0,
      desvio_padrao: 0,
      iqr: 0,
      limite_inferior_iqr: 0,
      limite_superior_iqr: 0,
      regra_outlier: 'nenhuma',
    }

    const aggregations: PriceIndexAggregations = {
      preco_minimo: typeof stats.minimo === 'number' ? stats.minimo : rawAgg.preco_minimo || 0,
      preco_maximo: typeof stats.maximo === 'number' ? stats.maximo : rawAgg.preco_maximo || 0,
      preco_medio: typeof stats.media === 'number' ? stats.media : rawAgg.preco_medio || 0,
      preco_mediana: typeof stats.mediana === 'number' ? stats.mediana : rawAgg.preco_mediana || 0,
      total: totalItems,
      por_fonte: porFonte,
      por_uf: porUf,
      estatisticas: stats,
      unidades: rawAgg.unidades || {},
      estados: rawAgg.estados || porUf,
      municipios: rawAgg.municipios || {},
    }

    const pAtual = raw.page || raw.pagination?.paginaAtual || 1
    const pTam =
      raw.limit ||
      raw.pagination?.tamanhoPagina ||
      (rawHitsList.length > 0 ? rawHitsList.length : 50)
    const pTotal = raw.pages || (pTam > 0 ? Math.ceil(totalItems / pTam) : 1)

    return {
      sucesso: raw.sucesso !== false,
      summary_valid: summaryValid,
      total: totalItems,
      page: pAtual,
      limit: pTam,
      pages: pTotal,
      duracao_ms: raw.duracao_ms ?? raw.took ?? duracaoMs,
      took: raw.took ?? raw.duracao_ms ?? duracaoMs,
      timed_out: Boolean(raw.timed_out),
      hits: hybridHitsArray,
      filtros_aplicados: raw.filtros_aplicados,
      aggregations,
      status_tarefa: raw.status_tarefa || null,
      frescor_sincronizacao: raw.frescor_sincronizacao || undefined,
      ciclo_diario: raw.ciclo_diario || null,
      metricas_consulta: raw.metricas_consulta || undefined,
      pagination: {
        paginaAtual: pAtual,
        tamanhoPagina: pTam,
        totalPaginas: pTotal,
        totalRegistros: totalItems,
      },
    }
  }

  /**
   * Helper para extrair a lista canônica de hits independentemente da forma recebida
   */
  public static extractHits(result: PriceIndexSearchResult | any): any[] {
    if (!result) return []
    if (Array.isArray(result.hits)) return result.hits
    if (result.hits && Array.isArray(result.hits.hits)) return result.hits.hits
    if (Array.isArray(result)) return result
    return []
  }

  /**
   * Consulta a base persistente de amostras via endpoint de alta performance
   */
  public static async searchIndex(
    params: PriceIndexSearchParams,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<PriceIndexSearchResult> {
    const t0 = performance.now()
    const timeout = options?.timeoutMs || 8000
    try {
      const response = await this.requisitarBuscaIndice(params, options, true)
      if (response.timed_out) {
        return this.normalizeSearchResult(
          { sucesso: false, timed_out: true, total: 0, hits: [] },
          response.duracao_ms,
        )
      }
      if (response.ok) return this.normalizeSearchResult(response.body, response.duracao_ms)
    } catch (error: any) {
      if (options?.signal?.aborted || error?.name === 'AbortError' || error?.code === 20) {
        throw error?.name === 'AbortError'
          ? error
          : new DOMException('Busca abortada.', 'AbortError')
      }
      console.warn('[PriceIndexService] Falha de conexão com índice; tentando fallback SDK.')
    }
    if (options?.signal?.aborted) throw new DOMException('Busca abortada.', 'AbortError')
    return this.searchIndexFallbackSdk(params, {
      signal: options?.signal,
      timeoutMs: Math.max(1000, timeout - Math.round(performance.now() - t0)),
    })
  }

  public static async searchIndexPage(
    params: PriceIndexSearchParams,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<PriceIndexPageResult> {
    const page = Number(params.page || params.pagina || 1)
    if (!Number.isInteger(page) || page < 2)
      throw new Error('Página sem resumo requer página posterior à primeira.')
    const response = await this.requisitarBuscaIndice(params, options, false)
    if (response.timed_out) throw { timed_out: true }
    if (!response.ok) throw { status: response.status }
    const body = response.body
    if (
      body?.sucesso !== true ||
      body.summary_included !== false ||
      body.page !== page ||
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > 200 ||
      !Array.isArray(body.hits) ||
      body.hits.length > body.limit
    ) {
      throw new Error('Resposta de página do índice incompatível.')
    }
    return {
      sucesso: true,
      summary_included: false,
      page: body.page,
      limit: body.limit,
      hits: body.hits,
      duracao_ms: response.duracao_ms,
    }
  }

  // O mesmo transporte mantém o prazo ativo até o JSON terminar, em ambos os contratos.
  private static async requisitarBuscaIndice(
    params: PriceIndexSearchParams,
    options: { signal?: AbortSignal; timeoutMs?: number } | undefined,
    includeSummary: boolean,
  ): Promise<{ ok: boolean; status: number; body?: any; timed_out?: boolean; duracao_ms: number }> {
    const t0 = performance.now()
    const baseUrl = pb.baseUrl || ''
    const endpoint = baseUrl ? `${baseUrl}/backend/v1/prices/search` : `/backend/v1/prices/search`
    const authToken = pb.authStore?.token || ''

    if (options?.signal?.aborted) {
      throw new DOMException('Busca abortada pelo usuário.', 'AbortError')
    }

    const timeout = options?.timeoutMs || 8000
    const controller = new AbortController()
    let timeoutId: any = null
    let localTimedOut = false

    const onUserAbort = () => controller.abort()
    if (options?.signal) {
      options.signal.addEventListener('abort', onUserAbort)
    }

    timeoutId = setTimeout(() => {
      localTimedOut = true
      controller.abort()
    }, timeout)

    // Normalização canônica do payload de parâmetros para o backend
    const normalizedBody = {
      ...params,
      termo: (params.termo || params.q || params.palavra_chave || '').trim(),
      q: (params.q || params.termo || params.palavra_chave || '').trim(),
      palavra_chave: (params.palavra_chave || params.termo || params.q || '').trim(),
      page: params.page || params.pagina || 1,
      pagina: params.pagina || params.page || 1,
      limit: params.limit || params.tamanho_pagina || 50,
      tamanho_pagina: params.tamanho_pagina || params.limit || 50,
      sort: params.sort || params.ordenar || 'valor_unitario:asc',
      ordenar: params.ordenar || params.sort || 'valor_unitario:asc',
      sources:
        params.sources ||
        (params.fonte && params.fonte !== 'todas' && params.fonte !== 'ambas'
          ? [params.fonte]
          : undefined),
      fonte: params.fonte || undefined,
      uf: params.uf || undefined,
      periodo: params.periodo || params.periodo_meses || undefined,
      periodo_meses: params.periodo_meses || params.periodo || undefined,
      modalidade: params.modalidade || undefined,
      natureza_preco: params.natureza_preco || undefined,
      apenas_me_epp: params.apenas_me_epp || undefined,
      include_summary: includeSummary,
    }

    try {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(authToken ? { Authorization: authToken } : {}),
          },
          body: JSON.stringify(normalizedBody),
          signal: controller.signal,
        })

        if (resp.ok) {
          // Timeout permanece ativo durante a leitura do stream JSON
          const json = await resp.json()
          if (options?.signal?.aborted) throw new DOMException('Busca abortada.', 'AbortError')
          clearTimeout(timeoutId)
          const duracao = Math.round(performance.now() - t0)
          return { ok: true, status: resp.status, body: json, duracao_ms: duracao }
        }
        return { ok: false, status: resp.status, duracao_ms: Math.round(performance.now() - t0) }
      } catch (fetchErr: any) {
        clearTimeout(timeoutId)
        // Caller cancellation remains distinct from this request's own deadline.
        if (options?.signal?.aborted) {
          throw fetchErr?.name === 'AbortError'
            ? fetchErr
            : new DOMException('Busca abortada.', 'AbortError')
        }
        // Se foi timeout do índice identificado pela flag local
        if (localTimedOut) {
          console.warn(
            `[PriceIndexService] Timeout de ${timeout}ms no endpoint /backend/v1/prices/search`,
          )
          // Se o próprio endpoint expirou o timeout configurado, não gasta mais tempo em fallback
          return {
            ok: false,
            status: 0,
            timed_out: true,
            duracao_ms: Math.round(performance.now() - t0),
          }
        }
        // An unrelated AbortError must still propagate, without SDK fallback.
        if (fetchErr?.name === 'AbortError' || fetchErr?.code === 20) {
          throw fetchErr?.name === 'AbortError'
            ? fetchErr
            : new DOMException('Busca abortada.', 'AbortError')
        }
        throw fetchErr
      }
    } finally {
      clearTimeout(timeoutId)
      if (options?.signal) {
        options.signal.removeEventListener('abort', onUserAbort)
      }
    }
  }

  /**
   * Fallback de consulta via SDK PocketBase
   */
  private static async searchIndexFallbackSdk(
    params: PriceIndexSearchParams,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<PriceIndexSearchResult> {
    if (options?.signal?.aborted) {
      throw new DOMException('Busca abortada pelo usuário.', 'AbortError')
    }

    const t0 = performance.now()
    const sdkTimeoutMs = options?.timeoutMs || 5000
    const sdkController = new AbortController()
    let sdkTimeoutId: any = null
    let sdkTimedOut = false

    const onSdkUserAbort = () => sdkController.abort()
    if (options?.signal) {
      options.signal.addEventListener('abort', onSdkUserAbort)
    }
    sdkTimeoutId = setTimeout(() => {
      sdkTimedOut = true
      sdkController.abort()
    }, sdkTimeoutMs)
    const pAtual = params.pagina || 1
    const pTam = params.tamanho_pagina || 50
    const termoNorm = this.canonicalNormalize(params.palavra_chave)

    const filters: string[] = ['valor_unitario > 0']

    if (termoNorm) {
      // Modo "Contendo as palavras": quando não for palavra_exata e houver múltiplos tokens,
      // busca tokens significativos individualmente com ~ em qualquer posição/ordem.
      if (!params.palavra_exata) {
        const tokensTermo = termoNorm.split(/\s+/).filter((t) => t.length >= 2)
        if (tokensTermo.length > 1) {
          const subClauses = tokensTermo.map((t) => `descricao_normalizada ~ "${t}"`)
          filters.push(`(${subClauses.join(' && ')})`)
        } else {
          filters.push(`descricao_normalizada ~ "${termoNorm}"`)
        }
      } else {
        filters.push(`descricao_normalizada ~ "${termoNorm}"`)
      }
    }
    if (params.uf) {
      filters.push(`uf = "${params.uf.toUpperCase()}"`)
    }
    if (params.fonte && params.fonte !== 'todas' && params.fonte !== 'ambas') {
      const fonteUpper = String(params.fonte).toUpperCase()
      const fonteCanon = fonteUpper.includes('PNCP')
        ? 'PNCP'
        : fonteUpper.includes('COMPRAS')
          ? 'Compras.gov.br'
          : params.fonte.trim()
      filters.push(`source = "${fonteCanon}"`)
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
        signal: sdkController.signal,
      })

      clearTimeout(sdkTimeoutId)

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
          quantidade: it.quantidade || 0,
          valor_unitario: it.valor_unitario,
          valor_total: it.valor_total || 0,
          natureza_preco: it.natureza_preco || '',
          data: it.data_referencia,
          raw_payload: it.raw_payload,
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
    } catch (sdkErr: any) {
      clearTimeout(sdkTimeoutId)
      if (
        options?.signal?.aborted ||
        (!sdkTimedOut && (sdkErr?.name === 'AbortError' || sdkErr?.code === 20))
      ) {
        throw sdkErr?.name === 'AbortError'
          ? sdkErr
          : new DOMException('Busca abortada.', 'AbortError')
      }
      return {
        sucesso: false,
        took: Math.round(performance.now() - t0),
        duracao_ms: Math.round(performance.now() - t0),
        timed_out: sdkTimedOut,
        hits: Object.assign([], { hits: [], total: 0, max_score: 0 }),
        aggregations: {
          preco_minimo: 0,
          preco_maximo: 0,
          preco_medio: 0,
          preco_mediana: 0,
          total: 0,
          por_fonte: {},
          por_uf: {},
          estatisticas: {
            n: 0,
            media: 0,
            mediana: 0,
            q1: 0,
            q3: 0,
            minimo: 0,
            maximo: 0,
            desvio_padrao: 0,
            iqr: 0,
            limite_inferior_iqr: 0,
            limite_superior_iqr: 0,
            regra_outlier: 'nenhuma',
          },
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
    } finally {
      clearTimeout(sdkTimeoutId)
      if (options?.signal) {
        options.signal.removeEventListener('abort', onSdkUserAbort)
      }
    }
  }

  /**
   * Persiste uma lista de AmostraPreco na base indexada de forma IDEMPOTENTE
   * Reconhece existentes por sample_key e atualiza apenas se necessário.
   */
  // Shared by all callers: overlapping source pages must not flood PocketBase.
  private static filaPersistencia: Promise<void> = Promise.resolve()

  public static persistirAmostras(
    amostras: AmostraPreco[],
  ): Promise<{ inseridas: number; atualizadas: number; ignoradas: number }> {
    const trabalho = this.filaPersistencia.then(() => this.persistirLotes(amostras))
    this.filaPersistencia = trabalho.then(
      () => undefined,
      () => undefined,
    )
    return trabalho
  }

  private static async persistirLotes(
    amostras: AmostraPreco[],
  ): Promise<{ inseridas: number; atualizadas: number; ignoradas: number }> {
    let inseridas = 0
    let atualizadas = 0
    let ignoradas = 0

    if (!amostras || amostras.length === 0) {
      return { inseridas, atualizadas, ignoradas }
    }

    const agora = new Date().toISOString()
    const payloads = []

    for (const a of amostras) {
      if (
        typeof a.valorUnitario !== 'number' ||
        !Number.isFinite(a.valorUnitario) ||
        a.valorUnitario <= 0
      ) {
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
      const prova = (a.detalhesAdicionais as any)?.proveniencia_preco
      // The adapter's display date may be publication metadata, not the price's date.
      const dataPreco =
        typeof prova?.data_oficial === 'string' &&
        prova.campo_data &&
        String(prova.registro_oficial?.[prova.campo_data] ?? '') === prova.data_oficial &&
        Number.isFinite(Date.parse(prova.data_oficial))
          ? prova.data_oficial
          : ''

      const payload = {
        sample_key: sampleKey,
        source: a.fonte,
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
        unidade: a.unidade || 'NÃO INFORMADO',
        quantidade: a.quantidade || 0,
        valor_unitario: a.valorUnitario,
        valor_total: a.valorTotal,
        natureza_preco:
          a.natureza === 'estimado'
            ? 'estimado'
            : a.natureza === 'homologado' || a.natureza === 'contratado'
              ? 'homologado'
              : '',
        data_referencia: dataPreco,
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

      payloads.push(payload)
    }

    for (let offset = 0; offset < payloads.length; offset += 100) {
      const lote = payloads.slice(offset, offset + 100)
      const controller = new AbortController()
      let timedOut = false
      let status = 0
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, 10000)
      try {
        const response = await fetch(
          `${pb.baseUrl.replace(/\/$/, '')}/backend/v1/cotai/index-batch`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: pb.authStore.token },
            body: JSON.stringify({ amostras: lote }),
            signal: controller.signal,
          },
        )
        status = response.status
        if (!response.ok) throw new Error('batch_http')
        const result = await response.json()
        const counts = [result.inseridas, result.atualizadas, result.ignoradas]
        if (
          result.sucesso !== true ||
          result.recebidas !== lote.length ||
          !counts.every((count) => Number.isInteger(count) && count >= 0) ||
          counts.reduce((total, count) => total + count, 0) !== lote.length
        ) {
          throw new Error('batch_contract')
        }
        inseridas += result.inseridas
        atualizadas += result.atualizadas
        ignoradas += result.ignoradas
      } catch {
        // Never retry per row or expose remote/raw error details. Earlier chunks may have committed.
        throw Object.assign(new Error('Persistência do índice interrompida.'), {
          code: 'INDEX_BATCH_FAILED',
          status,
          timed_out: timedOut,
          parcial: { inseridas, atualizadas, ignoradas },
        })
      } finally {
        clearTimeout(timeout)
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
    const rawFonte = String(hitSource.fonte || hitSource.source || 'PNCP').toUpperCase()
    const isComprasGov = rawFonte.includes('COMPRAS')
    const fonteCanon: 'PNCP' | 'Compras.gov.br' = isComprasGov ? 'Compras.gov.br' : 'PNCP'
    let raw: any = hitSource.raw_payload || {}
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch {
        raw = { rawStr: raw }
      }
    }
    const prova = raw.proveniencia_preco
    const identidade = prova?.identidade
    const campos = [
      'valorUnitarioHomologado',
      'valor_unitario_homologado',
      'valorUnitarioEstimado',
      'valor_unitario_estimado',
      'valorUnitario',
      'valor_unitario',
    ]
    const identidadeValida =
      /^\d{14}$/.test(String(identidade?.cnpj || '')) &&
      Number(identidade?.ano) > 0 &&
      Number(identidade?.sequencial) > 0 &&
      Number(identidade?.numeroItem) > 0
    const urlItem = identidadeValida
      ? `https://pncp.gov.br/api/pncp/v1/orgaos/${identidade.cnpj}/compras/${identidade.ano}/${identidade.sequencial}/itens/${identidade.numeroItem}`
      : ''
    const provaValida =
      !isComprasGov &&
      prova?.status === 'verificada' &&
      prova.fonte === 'PNCP' &&
      campos.includes(prova.campo_unitario) &&
      Number.isFinite(valor) &&
      valor > 0 &&
      Number(prova.valor_unitario) === valor &&
      Number(prova.registro_oficial?.[prova.campo_unitario]) === valor &&
      Boolean(urlItem) &&
      (prova.url_evidencia === urlItem || prova.url_evidencia === `${urlItem}/resultados`)
    const dataLegada =
      hitSource.data ||
      hitSource.data_publicacao ||
      hitSource.data_compra ||
      hitSource.data_resultado ||
      hitSource.homologacao ||
      hitSource.data_referencia ||
      ''
    const dataProva =
      provaValida &&
      prova.campo_data &&
      (prova.registro_data || prova.registro_oficial)?.[prova.campo_data] === prova.data_oficial
        ? prova.data_oficial
        : ''

    return {
      id: idUnico,
      fonte: fonteCanon,
      fonteNomeExibicao: isComprasGov
        ? 'Compras.gov.br (dadosabertos.compras.gov.br)'
        : 'PNCP (Portal Nacional de Contratações Públicas)',
      idExterno:
        hitSource.identificador || hitSource.compra_id || hitSource.source_record_id || idUnico,
      urlOriginal:
        hitSource.link_oficial ||
        hitSource.url_original ||
        (hitSource.link_compra ? hitSource.link_compra : ''),
      dataPublicacaoOuContrato: isComprasGov ? dataLegada : dataProva,
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
      quantidade: Number(hitSource.quantidade) || 0,
      valorUnitario: valor,
      valorTotal: Number(hitSource.valor_total) || 0,
      modalidadeLicitacao: hitSource.modalidade || hitSource.numero || 'Pregão Eletrônico',
      numeroProcessoOuContrato: hitSource.numero_processo || hitSource.numero || '',
      marca: hitSource.marca || 'NÃO INFORMADO',
      codigoCatalogo: hitSource.codigo_item || 'CATMAT',
      hashRastreabilidade: hitSource.payload_hash || idUnico,
      scoreSimilaridade: Number(hitSource.matching_score) || 100,
      natureza:
        !isComprasGov && !provaValida
          ? 'referencial'
          : (provaValida ? prova.natureza : hitSource.natureza_preco) === 'estimado'
            ? 'estimado'
            : 'contratado',
      isDemo: false,
      detalhesAdicionais: {
        ...raw,
        ...(!isComprasGov
          ? {
              proveniencia_preco: provaValida
                ? prova
                : { ...prova, versao: 1, fonte: 'PNCP', status: 'nao_verificada' },
              data_legada_nao_verificada: dataProva ? undefined : dataLegada,
            }
          : {}),
        qualidade_situacao: hitSource.qualidade_situacao || 'aceita',
        motivos_rejeicao: hitSource.motivos_rejeicao,
        matching_tipo: hitSource.matching_tipo || 'texto_normalizado',
      },
    }
  }

  private static turnosImediatos = new Map<
    string,
    Promise<{
      tarefa_id: string
      status: string
      fonte_processada: string
      cobertura_parcial: boolean
      amostras: AmostraPreco[]
      amostras_resposta_parcial: boolean
      aviso?: string
    }>
  >()

  /** One targeted PNCP turn, shared by concurrent searches in this page. */
  public static async processarTarefaImediata(
    tarefaId: string,
    options?: { signal?: AbortSignal; deadlineAtMs?: number },
  ): Promise<{
    tarefa_id: string
    status: string
    fonte_processada: string
    cobertura_parcial: boolean
    amostras: AmostraPreco[]
    amostras_resposta_parcial: boolean
    aviso?: string
  }> {
    if (
      options?.signal?.aborted ||
      (options?.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
    ) {
      throw new DOMException('Turno PNCP interrompido.', 'AbortError')
    }
    const existente = this.turnosImediatos.get(tarefaId)
    if (existente) return existente
    const controller = new AbortController()
    const abortar = () => controller.abort()
    options?.signal?.addEventListener('abort', abortar, { once: true })
    // Server turn is 20s with network finishing by 15s; allow transport another 5s.
    const timeout = setTimeout(
      abortar,
      Math.min(25000, Math.max(0, (options?.deadlineAtMs ?? Infinity) - Date.now())),
    )
    const turno = (async () => {
      // SDK carries the existing authentication and closes the request on cancellation.
      const response = await pb.send('/backend/v1/tasks/process', {
        method: 'POST',
        body: { tarefa_id: tarefaId },
        signal: controller.signal,
        requestKey: null,
      })
      if (
        controller.signal.aborted ||
        options?.signal?.aborted ||
        (options?.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
      ) {
        throw new DOMException('Turno PNCP interrompido.', 'AbortError')
      }
      const result = response?.resultado
      if (
        response?.sucesso !== true ||
        result?.tarefa_id !== tarefaId ||
        !['pending', 'running', 'completed', 'failed'].includes(result?.status) ||
        result?.fonte_processada !== 'PNCP' ||
        typeof result?.cobertura_parcial !== 'boolean'
      ) {
        throw new Error('Resposta inválida do turno imediato PNCP.')
      }
      return {
        ...result,
        amostras: Array.isArray(result.amostras)
          ? result.amostras.map((hit: PriceIndexHitSource) => this.hitToAmostraPreco(hit))
          : [],
        amostras_resposta_parcial: result.amostras_resposta_parcial === true,
      }
    })()
    this.turnosImediatos.set(tarefaId, turno)
    try {
      return await turno
    } finally {
      clearTimeout(timeout)
      options?.signal?.removeEventListener('abort', abortar)
      if (this.turnosImediatos.get(tarefaId) === turno) this.turnosImediatos.delete(tarefaId)
    }
  }

  /**
   * Registra ou atualiza tarefa na fila persistente price_index_tasks
   */
  public static async registrarTarefaAtualizacao(
    termo: string,
    source: string,
    uf?: string,
    options?: { signal?: AbortSignal; deadlineAtMs?: number },
  ): Promise<{ id: string; termo: string; status: string }> {
    const taskKey = `${source.toUpperCase()}#${this.canonicalNormalize(termo)}#${(uf || 'ALL').toUpperCase()}`
    const agora = new Date().toISOString()
    const controller = new AbortController()
    const abortar = () => controller.abort()
    const verificarAtiva = () => {
      if (
        controller.signal.aborted ||
        options?.signal?.aborted ||
        (options?.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
      ) {
        throw new DOMException('Registro da tarefa PNCP interrompido.', 'AbortError')
      }
    }
    verificarAtiva()
    let rejeitarInterrupcao!: () => void
    const interrompido = new Promise<never>((_resolve, reject) => {
      rejeitarInterrupcao = () =>
        reject(new DOMException('Registro da tarefa PNCP interrompido.', 'AbortError'))
    })
    controller.signal.addEventListener('abort', rejeitarInterrupcao, { once: true })
    options?.signal?.addEventListener('abort', abortar, { once: true })
    const timeout = Number.isFinite(options?.deadlineAtMs)
      ? setTimeout(abortar, Math.max(0, options!.deadlineAtMs! - Date.now()))
      : undefined
    const requestOptions = { signal: controller.signal, requestKey: null }
    const registrar = async (): Promise<{ id: string; termo: string; status: string }> => {
      try {
        const existente = await pb
          .collection('price_index_tasks')
          .getFirstListItem(`task_key = "${taskKey}"`, requestOptions)
        verificarAtiva()
        if (existente) {
          if (existente.status === 'completed' || existente.status === 'failed') {
            let pendentes: any = existente.pendentes
            try {
              if (typeof pendentes === 'string') pendentes = JSON.parse(pendentes)
            } catch {
              pendentes = []
            }
            const possuiTrabalhoAcionavel =
              Array.isArray(pendentes) &&
              pendentes.some((p) => {
                if (!p) return false
                if (p._pncp_discovery) {
                  const esgotados = p._pncp_discovery.esgotados || {}
                  return !(esgotados.ata && esgotados.edital && esgotados.contrato)
                }
                return (
                  (p.c || p.cnpj) &&
                  (p.a || p.ano) &&
                  (p.s || p.sequencial) &&
                  (Number(p.r) || 0) < 4
                )
              })
            if (!possuiTrabalhoAcionavel) {
              return { id: existente.id, termo, status: existente.status }
            }
          }
          // Só retoma tarefas terminais com páginas/contratações ainda acionáveis.
          if (existente.status === 'completed' || existente.status === 'failed') {
            await pb.collection('price_index_tasks').update(
              existente.id,
              {
                status: 'pending',
                tentativas: 0,
              },
              requestOptions,
            )
            verificarAtiva()
            return { id: existente.id, termo, status: 'pending' }
          }
          return { id: existente.id, termo, status: existente.status }
        }
      } catch {
        // Cancellation/expiry must never fall through to creating another task.
        verificarAtiva()
        // cria se não existe
      }

      try {
        verificarAtiva()
        const nova = await pb.collection('price_index_tasks').create(
          {
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
          },
          requestOptions,
        )
        verificarAtiva()
        return { id: nova.id, termo, status: 'pending' }
      } catch (errCreate: any) {
        verificarAtiva()
        console.error('[PriceIndexService] Erro ao registrar tarefa de indexação:', errCreate)
        throw errCreate
      }
    }
    try {
      return await Promise.race([registrar(), interrompido])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      options?.signal?.removeEventListener('abort', abortar)
      controller.signal.removeEventListener('abort', rejeitarInterrupcao)
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
