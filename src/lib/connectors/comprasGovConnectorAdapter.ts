/**
 * Compras.gov.br: official CNBS discovery and independent typed code/page work.
 * Catalog metadata never becomes a price sample.
 */
import { BasePriceConnectorAdapter } from './baseConnectorAdapter'
import type {
  SourceMetadata, ConnectorSearchParams, ConnectorPageResult, ConnectorSearchResult,
  AmostraPreco, PaginationInfo, ObservabilidadeFonte,
} from './types'
import { executarFilaCompras } from './comprasWorkQueue'
import type { TrabalhoCompras, PaginacaoCompras } from './comprasWorkQueue'
import pb from '../pocketbase/client'
import { PriceIndexService } from '../priceIndexService'

export class ComprasGovConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'compras_gov'
  public readonly nome = 'Compras.gov.br (Dados Abertos Federais)'

  constructor() {
    super()
    this.versaoConector = '3.0.0-cnbs'
    this.maxRetries = 1
    this.retryDelayBaseMs = 300
    this.timeoutPorPaginaMs = 10000
  }

  public getSourceMetadata(): SourceMetadata {
    return {
      id: this.id, nome: this.nome, sigla: 'COMPRAS.GOV', tipo: 'OFICIAL_GOV',
      status: 'ATIVA', descricao: 'Catálogo oficial CNBS e preços públicos por CATMAT/CATSER.',
      urlPortal: 'https://dadosabertos.compras.gov.br', suportaPaginacaoCompleta: true,
      maxTamanhoPaginaPermitido: 500, rateLimitRequisicoesPorSegundo: 5,
      concorrenciaMaximaRecomendada: 3, requerCredencial: false,
      credencialConfigurada: true, isDemo: false,
    }
  }

  public normalize(raw: any, _index: number, metadata?: {
    tipo?: string; codigo?: string; consultaOficial?: boolean;
    pagina?: number; tamanhoPagina?: number; estado?: string; dataInicial?: string; dataFinal?: string;
  }): AmostraPreco | null {
    if (!raw || typeof raw !== 'object') return null
    const valor = Number(raw.precoUnitarioHomologado ?? raw.valorUnitario ??
      raw.precoUnitario ?? raw.precoPraticado)
    if (!Number.isFinite(valor) || valor <= 0) return null
    const tipo = metadata?.tipo ||
      (raw.tipoItem === 'SERVICO' || raw.codigoCatser ? 'servico' : 'material')
    const namespace = tipo === 'servico' ? 'CATSER' : 'CATMAT'
    const codigo = String(metadata?.codigo || raw.codigoItemCatalogo ||
      (tipo === 'servico' ? raw.codigoCatser : raw.codigoCatmat) || '')
    const compra = String(raw.idCompra ?? raw.codigoCompra ?? raw.id ?? '')
    const item = String(raw.idItemCompra ?? raw.numeroItemCompra ?? raw.numeroItem ?? raw.id ?? '')
    if (!compra && !raw.idItemCompra) return null
    const data = String(raw.dataResultado ?? raw.dataCompra ?? raw.dataAssinatura ??
      raw.data_resultado ?? raw.data_compra ?? '')
    const supplier = String(raw.cnpjFornecedor ?? raw.cpfCnpjFornecedor ?? raw.niFornecedor ??
      raw.nomeFornecedor ?? raw.razaoSocial ?? '')
    // Source identity excludes array position and monetary values.
    const identidade = [namespace, compra, item, data, supplier].map(encodeURIComponent).join('#')
    const unidade = String(raw.unidadeMedida || raw.siglaUnidadeFornecimento ||
      raw.siglaUnidadeMedida || raw.unidadeFornecimento || raw.nomeUnidadeFornecimento ||
      raw.unidade || '').trim()
    const quantidadeFonte = Number(raw.quantidade ?? raw.quantidadeItem ??
      raw.quantidadeTotal ?? raw.quantidadeHomologada)
    const quantidade = Number.isFinite(quantidadeFonte) && quantidadeFonte > 0 ? quantidadeFonte : 0
    const totalFonte = Number(raw.valorTotal ?? raw.precoTotal)
    const valorTotal = Number.isFinite(totalFonte) && totalFonte > 0 ? totalFonte
      : quantidade > 0 ? valor * quantidade : undefined
    const descricao = String(raw.descricaoItem || raw.descricao || raw.item || 'NÃO INFORMADO')
    let fallback = codigo ? (tipo === 'servico'
      ? 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?codigoItemCatalogo=' + encodeURIComponent(codigo)
      : 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=' + encodeURIComponent(codigo)) : ''
    if (fallback && metadata?.pagina) fallback += '&pagina=' + metadata.pagina
    if (fallback && metadata?.tamanhoPagina) fallback += '&tamanhoPagina=' + metadata.tamanhoPagina
    if (fallback && metadata?.estado) fallback += '&estado=' + encodeURIComponent(metadata.estado)
    if (fallback && metadata?.dataInicial) fallback += '&dataInicial=' + encodeURIComponent(metadata.dataInicial)
    if (fallback && metadata?.dataFinal) fallback += '&dataFinal=' + encodeURIComponent(metadata.dataFinal)
    let url = ''
    for (const candidate of [raw.linkEditalOuCompra, raw.link_resultado, raw.url]) {
      if (typeof candidate !== 'string') continue
      try {
        const parsed = new URL(candidate)
        if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.gov.br') &&
          parsed.hostname !== 'catalogo.compras.gov.br') { url = candidate; break }
      } catch { /* Missing evidence stays explicit. */ }
    }
    const fornecedorNome = String(raw.nomeFornecedor || raw.razaoSocial ||
      (typeof raw.fornecedor === 'string' ? raw.fornecedor : '') || 'NÃO INFORMADO')
    const campoUnitario = ['precoUnitarioHomologado', 'valorUnitario', 'precoUnitario', 'precoPraticado']
      .find((field) => raw[field] != null)!
    const campoData = ['dataResultado', 'dataCompra', 'dataAssinatura', 'data_resultado', 'data_compra']
      .find((field) => raw[field] != null)
    const verificada = metadata?.consultaOficial === true && !!codigo &&
      !!(raw.idCompra ?? raw.codigoCompra) && !!(raw.idItemCompra ?? raw.numeroItemCompra ?? raw.numeroItem) &&
      !!supplier && !!data && Number.isFinite(Date.parse(data)) && !!(url || fallback) &&
      raw.isDemo !== true && raw.is_demo !== true
    const natureza = raw.precoUnitarioHomologado != null ? 'homologado' : 'contratado'
    return {
      id: 'CGOV#' + identidade, idExterno: identidade,
      fonte: 'Compras.gov.br', fonteNomeExibicao: this.nome,
      urlOriginal: url || fallback, dataPublicacaoOuContrato: data,
      produto: descricao, descricaoCompleta: descricao,
      descricaoNormalizada: descricao.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(),
      orgaoComprador: String(raw.orgaoComprador || raw.nomeOrgao || raw.nomeUasg || 'NÃO INFORMADO'),
      orgaoCnpj: String(raw.cnpjOrgao || raw.cnpj || ''),
      municipio: raw.municipio, uf: raw.uf || raw.estado || raw.siglaUf,
      fornecedorNome, fornecedorCnpjOuCpf: String(raw.cnpjFornecedor || raw.cpfCnpjFornecedor || raw.niFornecedor || ''),
      fornecedorPorte: raw.porteFornecedor || 'NÃO INFORMADO',
      unidade: unidade || 'NÃO INFORMADO', quantidade, valorUnitario: valor, valorTotal,
      modalidadeLicitacao: raw.modalidadeCompra || raw.modalidade || '',
      numeroProcessoOuContrato: String(raw.numeroProcesso || compra),
      marca: raw.marca || 'NÃO INFORMADO', fabricante: raw.fabricante || 'NÃO INFORMADO',
      codigoCatalogo: codigo ? namespace + ' ' + codigo : namespace,
      hashRastreabilidade: raw.hashRastreabilidade || identidade,
      natureza,
      isDemo: false,
      detalhesAdicionais: {
        idCompra: compra, idItemCompra: raw.idItemCompra, numeroItemCompra: raw.numeroItemCompra ?? raw.numeroItem,
        numeroItem: raw.numeroItemCompra ?? raw.numeroItem,
        codigo_item: codigo, tipoCatalogo: namespace,
        dataResultado: raw.dataResultado, quantidadeInformada: quantidade > 0,
        unidadeOriginal: unidade, evidencia_tipo: url ? 'url_oficial_retornada' : fallback ? 'consulta_precos_por_codigo' : 'nao_informada',
        proveniencia_preco: {
          versao: 1, status: verificada ? 'verificada' : 'nao_verificada', fonte: 'Compras.gov.br',
          campo_unitario: campoUnitario, valor_unitario: valor, natureza,
          url_evidencia: url || fallback,
          identidade: { tipo, codigoCatalogo: codigo, idCompra: raw.idCompra ?? raw.codigoCompra,
            idItemCompra: raw.idItemCompra, numeroItemCompra: raw.numeroItemCompra ?? raw.numeroItem,
            fornecedor: supplier },
          registro_oficial: { ...raw }, data_oficial: data || null, campo_data: campoData || null,
          contexto_consulta: { tipo, codigo, pagina: metadata?.pagina,
            tamanhoPagina: metadata?.tamanhoPagina, estado: metadata?.estado,
            dataInicial: metadata?.dataInicial, dataFinal: metadata?.dataFinal },
        },
        ncm: raw.ncm || raw.ncm_nbs || raw.codigoNcm,
        criterio_julgamento: raw.criterioJulgamento || raw.criterio,
        data_vigencia_inicio: raw.dataVigenciaInicio,
        data_vigencia_fim: raw.dataVigenciaFim || raw.vigenciaFim,
      },
    }
  }

  private validWork(value: any): value is TrabalhoCompras {
    const code = (v: any) => typeof v === 'string' && /^\d{1,12}$/.test(v) && Number(v) > 0
    if (!value || typeof value !== 'object') return false
    if (value.etapa === 'catalogo') return ['material', 'servico'].includes(value.tipo) &&
      typeof value.termo === 'string' && value.termo.trim().length >= 2
    if (value.etapa === 'pdm') return code(value.codigoPdm)
    return value.etapa === 'precos' && ['material', 'servico'].includes(value.tipo) &&
      code(value.codigo) && Number.isInteger(value.pagina) && value.pagina >= 1
  }

  private initialWork(params: ConnectorSearchParams): TrabalhoCompras[] {
    if (params.continuacoesCompras !== undefined) {
      if (!Array.isArray(params.continuacoesCompras) || !params.continuacoesCompras.every((w) => this.validWork(w))) {
        throw new TypeError('Continuação Compras inválida.')
      }
      return params.continuacoesCompras
    }
    const tasks: TrabalhoCompras[] = []
    const addCodes = (value: string | undefined, tipo: 'material' | 'servico') => {
      if (!value) return
      for (const code of value.split(/[,;\s]+/).filter(Boolean)) {
        const task: TrabalhoCompras = { etapa: 'precos', tipo, codigo: code, pagina: params.pagina || 1 }
        if (!this.validWork(task)) throw new TypeError('Código explícito de catálogo inválido.')
        tasks.push(task)
      }
    }
    addCodes(params.catmatOuCodigo, 'material')
    addCodes(params.catserOuCodigo, 'servico')
    if (tasks.length) return tasks
    const prefix = params.termo.trim().match(/^(CATMAT|CATSER)\s*[:#-]?\s*(\d{1,12})$/i)
    if (prefix) {
      addCodes(prefix[2], prefix[1].toUpperCase() === 'CATSER' ? 'servico' : 'material')
      return tasks
    }
    const tipo = params.tipoCatalogo?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    if (tipo && tipo !== 'material' && tipo !== 'servico') throw new TypeError('Tipo de catálogo inválido.')
    if (params.termo.trim().length < 2) throw new TypeError('Informe ao menos dois caracteres.')
    return (tipo ? [tipo] : ['material', 'servico']).map((kind) => ({
      etapa: 'catalogo', tipo: kind as 'material' | 'servico', termo: params.termo.trim(),
    }))
  }

  private async proxyJson(path: string, query: URLSearchParams, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutPorPaginaMs)
    try {
      const token = pb.authStore?.token || ''
      const response = await fetch((pb.baseUrl || '') + path + '?' + query.toString(), {
        method: 'GET', headers: { Accept: 'application/json', ...(token ? { Authorization: token } : {}) },
        signal: controller.signal,
      })
      // The deadline stays active through JSON consumption, as in native v138.
      const body = await response.json()
      if (signal?.aborted) throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
      if (timedOut) throw Object.assign(new Error('Prazo do proxy Compras excedido.'), { status: 408 })
      if (!response.ok || body?.sucesso === false) {
        throw Object.assign(new Error(body?.erro?.mensagem || body?.message ||
          (typeof body?.erro === 'string' ? body.erro : '') || 'Falha na resposta oficial do proxy Compras.'),
        { status: response.ok ? 502 : response.status })
      }
      return body
    } catch (error: any) {
      if (signal?.aborted) throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
      if (timedOut) throw Object.assign(new Error('Timeout do proxy Compras.'), { status: 408 })
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  public async fetchPage(params: ConnectorSearchParams, pagina: number): Promise<ConnectorPageResult> {
    if (params.signal?.aborted) throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
    const tamanho = Math.min(500, Math.max(10, params.tamanhoPagina || 500))
    const tipo = params.catserOuCodigo ? 'servico' : 'material'
    const codigo = params.catserOuCodigo || params.catmatOuCodigo || ''
    const empty: PaginationInfo = { paginaAtual: pagina, tamanhoPagina: tamanho,
      totalRegistrosInformadoApi: 0, totalPaginasInformadoApi: 0, temMaisPaginas: false }
    if (!/^\d{1,12}$/.test(codigo)) return { sucesso: false, amostras: [], pagination: empty,
      statusHttp: 400, tempoMs: 0, erro: 'fetchPage exige um código explícito por requisição.' }
    const result = await this.fetchPageWithRetry(params, pagina, async () => {
      const start = performance.now()
      try {
        const query = new URLSearchParams({ termo: params.termo, tipo_catalogo: tipo,
          pagina: String(pagina), tam_pagina: String(tamanho) })
        query.set(tipo === 'servico' ? 'catser' : 'codigo_item', codigo)
        if (params.uf) query.set('uf', params.uf)
        if (params.dataInicio) query.set('data_inicio', params.dataInicio)
        if (params.dataFim) query.set('data_fim', params.dataFim)
        const data = await this.proxyJson('/backend/v1/cotai/comprasgov-search', query, params.signal)
        const raw = data.dados?.resultado ?? data.dados?.items ?? (Array.isArray(data.dados) ? data.dados : null)
        const total = Number(data.dados?.totalRegistros ?? data.totalEncontrados)
        const paginas = Number(data.dados?.totalPaginas ?? data.totalPaginas)
        const actualPage = Number(data.paginaAtual ?? pagina)
        const actualSize = Number(data.tamPagina ?? tamanho)
        if (!Array.isArray(raw) || !Number.isInteger(total) || total < 0 ||
          !Number.isInteger(paginas) || paginas < 0 || actualPage !== pagina ||
          !Number.isInteger(actualSize) || actualSize <= 0) {
          throw Object.assign(new Error('Metadados de paginação Compras incompatíveis.'), { status: 502 })
        }
        const amostras = raw.map((r: any, index: number) => this.normalize(r, index, {
          tipo, codigo, consultaOficial: true, pagina: actualPage, tamanhoPagina: actualSize,
          estado: params.uf?.trim().toUpperCase(),
          dataInicial: params.dataInicio?.replace(/-/g, ''), dataFinal: params.dataFim?.replace(/-/g, ''),
        }))
          .filter((r: AmostraPreco | null): r is AmostraPreco => r !== null)
        return { sucesso: true, amostras, registrosRecebidos: raw.length,
          pagination: { paginaAtual: actualPage, tamanhoPagina: actualSize,
            totalRegistrosInformadoApi: total, totalPaginasInformadoApi: paginas,
            temMaisPaginas: pagina < paginas, tipoCatalogo: tipo, codigoCatalogo: codigo },
          tempoMs: performance.now() - start, statusHttp: 200 }
      } catch (error: any) {
        if (params.signal?.aborted) throw error
        return { sucesso: false, amostras: [], pagination: empty, tempoMs: performance.now() - start,
          erro: error?.message || 'Falha no proxy Compras.', statusHttp: error?.status || 502,
          isIndisponivel: true }
      }
    })
    if (params.signal?.aborted) throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
    return result
  }

  public override async search(
    params: ConnectorSearchParams,
    onProgress?: (novasAmostras: AmostraPreco[], info: PaginationInfo) => void,
  ): Promise<ConnectorSearchResult> {
    if (params.signal?.aborted) throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
    const start = performance.now()
    const initial = this.initialWork(params)
    // The inherited array-only cache loses typed continuations and metadata.
    // This override deliberately does not read or write that cache.
    const samples = new Map<string, AmostraPreco>()
    const ledger = new Map<string, PaginacaoCompras>()
    let successful = 0
    const obs: ObservabilidadeFonte = {
      fonte: this.id, tempoTotalMs: 0, quantidadeInformadaApi: 0,
      quantidadeRecebidaBruta: 0, quantidadeProcessadaValida: 0, quantidadeEntregue: 0,
      quantidadeDescartadaAntiContaminacao: 0, quantidadeDuplicidadesInternas: 0,
      paginasProcessadas: 0, totalPaginasApi: 0, retriesExecutados: 0, statusHttpFinal: 200,
      timeoutsCount: 0, errosEncontrados: [], circuitBreakerAcionado: false, cacheHit: false,
    }
    const queue = await executarFilaCompras<AmostraPreco>({
      trabalhos: initial, signal: params.signal, deadlineAtMs: params.deadlineAtMs, concorrencia: 3,
      executar: async (job, signal) => {
        if (job.etapa !== 'precos') {
          const query = job.etapa === 'pdm'
            ? new URLSearchParams({ codigo_pdm: job.codigoPdm })
            : new URLSearchParams({ tipo: job.tipo, termo: job.termo })
          const data = await this.rateLimiter.execute(() =>
            this.proxyJson('/backend/v1/comprasgov/catalogo', query, signal))
          if (!Array.isArray(data.candidatos) || !Array.isArray(data.trabalhos) ||
            !data.trabalhos.every((w: any) => this.validWork(w) && w.etapa !== 'catalogo')) {
            throw new Error('Contrato do catálogo CNBS incompatível.')
          }
          successful++
          return { amostras: [], continuacoes: data.trabalhos }
        }
        const page = await this.fetchPage({ ...params, signal, tipoCatalogo: job.tipo,
          catmatOuCodigo: job.tipo === 'material' ? job.codigo : undefined,
          catserOuCodigo: job.tipo === 'servico' ? job.codigo : undefined,
        }, job.pagina)
        obs.retriesExecutados += Math.max(0, (page.tentativasRealizadas || 1) - 1)
        obs.statusHttpFinal = page.statusHttp || 200
        if (!page.sucesso) {
          if (page.statusHttp === 408) obs.timeoutsCount++
          throw new Error(page.erro || 'Falha de página Compras.')
        }
        successful++
        obs.paginasProcessadas++
        obs.quantidadeRecebidaBruta += page.registrosRecebidos ?? page.amostras.length
        const p: PaginacaoCompras = { tipo: job.tipo, codigo: job.codigo, pagina: job.pagina,
          tamanho: page.pagination.tamanhoPagina, total: page.pagination.totalRegistrosInformadoApi,
          paginas: page.pagination.totalPaginasInformadoApi }
        const key = job.tipo + '#' + job.codigo
        const previous = ledger.get(key)
        ledger.set(key, { ...p, pagina: Math.max(previous?.pagina || 0, p.pagina) })
        return { amostras: page.amostras,
          continuacoes: page.pagination.temMaisPaginas
            ? [{ ...job, pagina: job.pagina + 1 }] : [], paginacao: p }
      },
      onBatch: (batch, job) => {
        if (params.signal?.aborted || job.etapa !== 'precos') return
        const fresh = batch.filter((item) => {
          if (samples.has(item.id)) { obs.quantidadeDuplicidadesInternas++; return false }
          samples.set(item.id, item)
          return true
        })
        if (!fresh.length) return
        if (obs.tempoAtePrimeiroResultadoMs === undefined) obs.tempoAtePrimeiroResultadoMs = performance.now() - start
        PriceIndexService.persistirAmostras(fresh).catch(() => {})
        const p = ledger.get(job.tipo + '#' + job.codigo)!
        onProgress?.(fresh, { paginaAtual: p.pagina, tamanhoPagina: p.tamanho,
          totalRegistrosInformadoApi: p.total, totalPaginasInformadoApi: p.paginas,
          temMaisPaginas: p.pagina < p.paginas, tipoCatalogo: job.tipo, codigoCatalogo: job.codigo,
          paginacaoCompras: Array.from(ledger.values()) })
      },
    })
    const result = Array.from(samples.values())
    const errors = queue.falhas.map((f) => f.erro instanceof Error ? f.erro.message : String(f.erro))
    obs.tempoTotalMs = performance.now() - start
    obs.quantidadeInformadaApi = queue.paginacao.reduce((sum, p) => sum + p.total, 0)
    obs.totalPaginasApi = queue.paginacao.reduce((sum, p) => sum + p.paginas, 0)
    obs.quantidadeProcessadaValida = result.length
    obs.quantidadeEntregue = result.length
    obs.errosEncontrados = errors
    obs.circuitBreakerAcionado = this.circuitBreaker.isOpen()
    obs.continuacoesCompras = queue.pendencias
    obs.paginacaoCompras = queue.paginacao
    const status = queue.concluida ? 'CONCLUIDA'
      : successful || !queue.falhas.length ? 'CONCLUIDA_PARCIAL' : 'FALHA_TOTAL'
    return {
      sucesso: status !== 'FALHA_TOTAL', fonte: this.id, fonteNomeExibicao: this.nome,
      amostras: result, totalAmostrasRecuperadas: result.length,
      totalRegistrosInformadosApi: obs.quantidadeInformadaApi,
      paginasProcessadas: obs.paginasProcessadas, tempoMs: obs.tempoTotalMs, status,
      erro: errors.length ? errors.join('; ') : undefined, observabilidade: obs,
      continuacoesCompras: queue.pendencias, paginacaoCompras: queue.paginacao,
    }
  }
}
