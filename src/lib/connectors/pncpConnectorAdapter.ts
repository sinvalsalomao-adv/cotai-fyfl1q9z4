// COTAI_PNCP_LOCAL_CAPACITY_V1 b903e72: local proxy 429/503 preserve work without official circuit failures.
/**
 * PNCP Connector Adapter
 * Implementa o contrato IPriceConnectorAdapter para a API do PNCP (Portal Nacional de Contratações Públicas).
 * Suporta paginação completa sem limite artificial, descompactação de atas com múltiplos itens,
 * enriquecimento e anti-contaminação semântica.
 */

import { BasePriceConnectorAdapter } from './baseConnectorAdapter'
import { SourceMetadata, ConnectorSearchParams, ConnectorPageResult, AmostraPreco } from './types'
import pb from '../pocketbase/client'
import { PncpService } from '../pncpService'
import { PriceIndexService } from '../priceIndexService'
import { obterCodigosCatmatDoTermo } from '../catalogoOficialCanonico'

export class PncpConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'pncp'
  public readonly nome = 'PNCP (Portal Nacional de Contratações Públicas)'
  private retryAtMs = 0

  protected pendenciaPagina(
    params: ConnectorSearchParams,
    pagina: number,
  ): ConnectorPageResult | undefined {
    const prazo = super.pendenciaPagina(params, pagina)
    if (prazo) return prazo
    if (Date.now() >= this.retryAtMs) return
    return {
      sucesso: false,
      amostras: [],
      tempoMs: 0,
      statusHttp: 429,
      retryAtMs: this.retryAtMs,
      circuitOpen: this.circuitBreaker.isOpen(),
      erro: 'Quota PNCP: aguardando o prazo da fonte para retomar a página.',
      pagination: {
        paginaAtual: pagina,
        tamanhoPagina: Math.min(50, params.tamanhoPagina || 50),
        totalRegistrosInformadoApi: 0,
        totalPaginasInformadoApi: pagina,
        temMaisPaginas: true,
        proximoCursor: `pncp-page-${pagina}`,
      },
    }
  }

  constructor() {
    super()
    this.versaoConector = '2.5.0-cache-detail-partial'
    this.maxRetries = 1
    this.retryDelayBaseMs = 300
    this.timeoutPorPaginaMs = 10000
  }

  public getSourceMetadata(): SourceMetadata {
    return {
      id: this.id,
      nome: this.nome,
      sigla: 'PNCP',
      tipo: 'OFICIAL_GOV',
      status: 'ATIVA',
      descricao:
        'Base oficial nacional unificada da Lei 14.133/2021 com atas de registro de preços e editais de todos os entes federativos.',
      urlPortal: 'https://pncp.gov.br',
      suportaPaginacaoCompleta: true,
      maxTamanhoPaginaPermitido: 50,
      rateLimitRequisicoesPorSegundo: 5,
      concorrenciaMaximaRecomendada: 3,
      requerCredencial: false,
      credencialConfigurada: true,
      isDemo: false,
    }
  }

  public normalize(rawItem: any, index: number, metadata?: any): AmostraPreco | null {
    if (!rawItem) return null

    // Somente campo unitário explícito do item. Total/quantidade não é evidência.
    const quantidade = Number(rawItem.quantidade) > 0 ? Number(rawItem.quantidade) : 0
    const camposUnitarios = [
      'valorUnitarioHomologado',
      'valor_unitario_homologado',
      'valorUnitarioEstimado',
      'valor_unitario_estimado',
      'valorUnitario',
      'valor_unitario',
    ]
    const campoUnitario = camposUnitarios.find(
      (campo) => Number.isFinite(Number(rawItem[campo])) && Number(rawItem[campo]) > 0,
    )
    const valorUnitario = campoUnitario ? Number(rawItem[campoUnitario]) : 0
    const temHomologado = /homologado/i.test(campoUnitario || '')

    const naturezaPreco: 'contratado' | 'estimado' = temHomologado ? 'contratado' : 'estimado'

    // Diretriz: "O preço unitário de todos os itens tem que aparecer. Se não houver preços, não deve constar."
    // Amostras com preço unitário apurado <= 0, NaN ou nulo são descartadas sumariamente.
    // Preserva a precisão unitária oficial, inclusive valores subcentavo.
    if (isNaN(valorUnitario) || valorUnitario <= 0) {
      console.info('[PncpConnectorAdapter] Amostra descartada: sem preço unitário apurado', {
        id_externo:
          rawItem.id_externo || rawItem.numeroControlePNCP || rawItem.numero_controle_pncp,
        item: rawItem.item_externo || rawItem.descricao || rawItem.descricaoItem,
        motivo: 'sem preço unitário válido',
      })
      return null
    }

    // Não arredonda valores oficiais pequenos para zero.
    const valorEfetivo = valorUnitario
    if (isNaN(valorEfetivo) || valorEfetivo <= 0) {
      return null
    }

    const orgaoNome =
      rawItem.orgao_comprador ||
      rawItem.orgaoEntidade?.razaoSocial ||
      rawItem.orgao_nome ||
      'Órgão Público PNCP'

    const orgaoCnpj =
      rawItem.orgao_cnpj || rawItem.orgaoEntidade?.cnpj || rawItem.cnpj || 'NÃO INFORMADO'

    const idExterno =
      rawItem.id_externo || rawItem.numeroControlePNCP || rawItem.numero_controle_pncp || ''

    const controle = String(rawItem.numeroControlePNCP || rawItem.numero_controle_pncp || idExterno)
    const partes = controle.match(/^(\d{14})-\d+-(\d+)\/(\d{4})$/)
    const cnpjCompra =
      partes?.[1] || String(rawItem.orgaoEntidade?.cnpj || rawItem.orgao_cnpj || rawItem.cnpj || '')
    const anoCompra = Number(partes?.[3] || rawItem.anoCompra || rawItem.ano)
    const sequencialCompra = Number(partes?.[2] || rawItem.sequencialCompra || rawItem.sequencial)
    const numeroItem = Number(rawItem.numeroItem || rawItem.numero_item) || 0
    const urlCompra =
      /^\d{14}$/.test(cnpjCompra) && anoCompra > 0 && sequencialCompra > 0
        ? `https://pncp.gov.br/app/editais/${cnpjCompra}/${anoCompra}/${sequencialCompra}`
        : ''
    const prova = rawItem.proveniencia_preco || rawItem.detalhesAdicionais?.proveniencia_preco
    const idProva = prova?.identidade
    const urlItem =
      urlCompra && numeroItem > 0
        ? `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpjCompra}/compras/${anoCompra}/${sequencialCompra}/itens/${numeroItem}`
        : ''
    const provaValida =
      prova?.status === 'verificada' &&
      prova.fonte === 'PNCP' &&
      camposUnitarios.includes(prova.campo_unitario) &&
      Number(prova.registro_oficial?.[prova.campo_unitario]) === valorEfetivo &&
      Number(prova.valor_unitario) === valorEfetivo &&
      Boolean(urlItem) &&
      (prova.url_evidencia === urlItem || prova.url_evidencia === `${urlItem}/resultados`) &&
      String(idProva?.cnpj) === cnpjCompra &&
      Number(idProva?.ano) === anoCompra &&
      Number(idProva?.sequencial) === sequencialCompra &&
      Number(idProva?.numeroItem) === numeroItem
    const proveniencia = provaValida
      ? prova
      : {
          ...prova,
          versao: 1,
          fonte: 'PNCP',
          status: 'nao_verificada',
        }
    const registroResultado = provaValida ? prova.registro_oficial : rawItem
    const sequencialResultado = registroResultado?.sequencialResultado || ''
    const fornecedorIdentidade = String(
      registroResultado?.niFornecedor ||
        rawItem.cnpj_fornecedor ||
        rawItem.fornecedor_cnpj ||
        rawItem.fornecedor?.niFornecedor ||
        '',
    ).replace(/\D/g, '')
    const identidadeItem =
      urlCompra && numeroItem > 0
        ? `${cnpjCompra}/${anoCompra}/${sequencialCompra}/itens/${numeroItem}` +
          (sequencialResultado ? `/resultados/${sequencialResultado}` : '') +
          (fornecedorIdentidade ? `/fornecedor/${fornecedorIdentidade}` : '')
        : ''

    const descricao =
      rawItem.item_externo ||
      rawItem.descricao ||
      rawItem.descricaoItem ||
      rawItem.objeto ||
      'Item PNCP'

    // Unidade é fato da fonte; embalagem na descrição não autoriza substituí-la.
    const unidade =
      [rawItem.unidade, rawItem.unidadeMedida].find(
        (valor) => typeof valor === 'string' && valor.trim().length > 0,
      ) || 'NÃO INFORMADO'
    const dataContrato =
      (provaValida && prova.data_oficial) ||
      rawItem.dataResultado ||
      rawItem.data_contratacao ||
      rawItem.dataPublicacaoPncp ||
      rawItem.dataAssinatura ||
      rawItem.dataPublicacao ||
      rawItem.data_publicacao ||
      undefined

    const fornecedorNome =
      (typeof rawItem.fornecedor === 'string' ? rawItem.fornecedor : '') ||
      rawItem.fornecedor_nome ||
      rawItem.fornecedor?.nomeRazaoSocialFornecedor ||
      'NÃO INFORMADO'

    const fornecedorCnpj =
      rawItem.cnpj_fornecedor ||
      rawItem.fornecedor_cnpj ||
      rawItem.fornecedor?.niFornecedor ||
      'NÃO INFORMADO'

    const hash =
      rawItem.hash ||
      PncpService.gerarHashRastreabilidade({
        fonte: 'pncp',
        id_externo: idExterno,
        cnpj_orgao: orgaoCnpj,
        valor: valorEfetivo,
        data: dataContrato,
        item: descricao,
      })

    const detalhamentoPendente = Boolean(rawItem._detalhamento_pendente)
    const receiptIndex = Number(rawItem._cotai_ingestion_receipt_index || 0)
    const receipt = Array.isArray(metadata?.ingestionReceipts)
      ? metadata.ingestionReceipts[receiptIndex]
      : metadata?.ingestionReceipt
    const claimKey = rawItem._cotai_ingestion_claim
    const indexRow = rawItem._cotai_index_row
    const receiptValid =
      receipt?.source === 'PNCP' &&
      typeof receipt.token === 'string' &&
      /^[A-Za-z0-9]{32,128}$/.test(receipt.token) &&
      typeof receipt.query_hash === 'string' &&
      /^[0-9a-f]{64}$/.test(receipt.query_hash) &&
      typeof receipt.expires_at === 'string' &&
      Number.isFinite(Date.parse(receipt.expires_at)) &&
      typeof claimKey === 'string' &&
      /^[0-9a-f]{64}$/.test(claimKey) &&
      !!indexRow &&
      typeof indexRow === 'object' &&
      !Array.isArray(indexRow)

    return {
      id: identidadeItem ? `PNCP-${identidadeItem}` : '',
      fonte: 'PNCP',
      fonteNomeExibicao: 'PNCP (Portal Nacional de Contratações Públicas)',
      idExterno: identidadeItem,
      urlOriginal: urlCompra,
      dataPublicacaoOuContrato: dataContrato || '',
      produto: descricao.trim().toUpperCase(),
      descricaoCompleta: descricao.trim().toUpperCase(),
      descricaoNormalizada: descricao.trim().toUpperCase(),
      orgaoComprador: orgaoNome,
      orgaoCnpj,
      municipio: rawItem.municipio_nome || rawItem.municipio,
      uf: rawItem.uf || rawItem.municipio_uf?.split('-')[1]?.trim(),
      fornecedorNome,
      fornecedorCnpjOuCpf: fornecedorCnpj,
      fornecedorPorte:
        fornecedorNome.includes('ME') || fornecedorNome.includes('EPP') ? 'ME_EPP' : 'DEMAIS',
      unidade,
      quantidade,
      valorUnitario: valorEfetivo,
      valorTotal: Number(
        (provaValida ? prova.registro_oficial : rawItem)?.valorTotalHomologado ||
          (provaValida ? prova.registro_oficial : rawItem)?.valorTotal ||
          0,
      ),
      modalidadeLicitacao: rawItem.modalidade_licitacao || 'Pregão Eletrônico',
      numeroProcessoOuContrato: rawItem.processo_origem || idExterno,
      marca: rawItem.marca_modelo || rawItem.marcaNome || 'NÃO INFORMADO',
      codigoCatalogo: rawItem.codigo_catalogo || 'CATMAT',
      hashRastreabilidade: hash,
      scoreSimilaridade: rawItem.similarity_score || 95,
      natureza: naturezaPreco,
      isDemo: false,
      detalhesAdicionais: {
        numeroItem,
        numeroControlePNCP: controle,
        quantidade_informada: quantidade > 0,
        proveniencia_preco: proveniencia,
        ncm: rawItem.ncm || rawItem.ncm_nbs || rawItem.codigoNcm || rawItem.codigo_ncm,
        criterio_julgamento:
          rawItem.criterio_julgamento ||
          rawItem.criterioJulgamentoNome ||
          rawItem.criterioJulgamento ||
          'Menor preço',
        data_vigencia_inicio:
          rawItem.dataVigenciaInicio ||
          rawItem.data_inicio_vigencia ||
          rawItem.dataAssinatura ||
          dataContrato,
        data_vigencia_fim:
          rawItem.dataVigenciaFim ||
          rawItem.data_fim_vigencia ||
          rawItem.dataTerminoVigencia ||
          rawItem.vigenciaFim,
        detalhamento_pendente: detalhamentoPendente,
        nao_informado: false,
      },
      ...(provaValida && receiptValid
        ? {
            ingestionReceipt: {
              token: receipt.token as string,
              queryHash: receipt.query_hash as string,
              claimKey,
              source: 'PNCP' as const,
              expiresAt: receipt.expires_at as string,
              indexRow,
            },
          }
        : {}),
    }
  }

  public async fetchPage(
    params: ConnectorSearchParams,
    pagina: number,
  ): Promise<ConnectorPageResult> {
    if (params.signal?.aborted)
      throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
    const pendencia = this.pendenciaPagina(params, pagina)
    if (pendencia) return pendencia
    const inicio = performance.now()
    const tipos = ['ata', 'edital', 'contrato'] as const
    // Each document branch acquires the same instance limiter inside the Base
    // retry path. An outer acquisition would deadlock concurrent page windows.
    const settled = await Promise.allSettled(
      tipos.map((tipo) => this.fetchDocumentPage(params, pagina, tipo)),
    )
    const resultados = settled.map((resultado): ConnectorPageResult => {
      if (resultado.status === 'fulfilled') return resultado.value
      if (resultado.reason?.name === 'AbortError') throw resultado.reason
      return {
        sucesso: false,
        amostras: [],
        pagination: {
          paginaAtual: pagina,
          tamanhoPagina: Math.min(50, params.tamanhoPagina || 50),
          totalRegistrosInformadoApi: 0,
          totalPaginasInformadoApi: 0,
          temMaisPaginas: false,
        },
        tempoMs: 0,
        erro: resultado.reason?.message || 'Falha de consulta ao PNCP',
      }
    })
    const falhas = resultados.filter((resultado) => !resultado.sucesso)
    const sucesso = falhas.length === 0
    // Only a fully acknowledged branch can contribute rows; normalize/persist
    // remains local to its response and its receipt array.
    const unicas = new Map<string, AmostraPreco>()
    for (const resultado of resultados) {
      if (!resultado.sucesso) continue
      for (const amostra of resultado.amostras) {
        const indexRow = amostra.ingestionReceipt?.indexRow
        const sampleKey = indexRow?.sample_key
        // Item identity alone omits the official price. Prefer the ACKed
        // server key; older rows retain the exact price-aware Base identity.
        const chaveCanonica =
          indexRow?.source === amostra.fonte &&
          typeof sampleKey === 'string' &&
          sampleKey.trim().length > 0
            ? `${amostra.fonte}#${sampleKey}`
            : `${amostra.fonte}#${amostra.idExterno}#${amostra.orgaoComprador}#${amostra.fornecedorNome}#${amostra.valorUnitario.toFixed(4)}`
        if (!unicas.has(chaveCanonica)) unicas.set(chaveCanonica, amostra)
      }
    }
    const metadatas = resultados.map(
      (resultado) =>
        (resultado as ConnectorPageResult & { metadata?: Record<string, any> }).metadata || {},
    )
    const metadata: Record<string, any> = {
      pncp_document_fanout: true,
      cobertura_parcial: !sucesso || metadatas.some((meta) => meta.cobertura_parcial === true),
      descoberta_parcial: metadatas.some((meta) => meta.descoberta_parcial === true),
      erro_fila:
        metadatas.find((meta) => typeof meta.erro_fila === 'string' && meta.erro_fila)?.erro_fila ||
        null,
    }
    // These are snapshots of the shared canonical queue, not disjoint counts.
    const camposContagem = [
      'itens_pendentes',
      'itens_fila_pendente',
      'itens_nao_enfileirados',
      'itens_congelados',
    ]
    const maxContagem = (valores: any[]) =>
      Math.max(0, ...valores.filter((valor) => Number.isSafeInteger(valor) && valor >= 0))
    for (const campo of camposContagem) {
      metadata[campo] = maxContagem(metadatas.map((meta) => meta[campo]))
    }
    const filasPersistidas = metadatas.filter((meta) => typeof meta.fila_persistida === 'boolean')
    if (filasPersistidas.length > 0) {
      metadata.fila_persistida = filasPersistidas.every((meta) => meta.fila_persistida)
    }
    metadata.detalhamento_paralelo = {}
    for (const campo of [
      ...camposContagem,
      'total_encontrado',
      'total_detalhado',
      'cache_hits',
      'amostras_extraidas',
    ]) {
      metadata.detalhamento_paralelo[campo] = maxContagem(
        metadatas.map((meta) => meta.detalhamento_paralelo?.[campo]),
      )
    }
    const totalPaginas = Math.max(
      sucesso ? 1 : pagina,
      ...resultados.map((r) => r.pagination.totalPaginasInformadoApi),
    )
    const retryAtMs = Math.max(0, ...falhas.map((resultado) => resultado.retryAtMs || 0))
    return {
      sucesso,
      amostras: [...unicas.values()].sort((a, b) => a.valorUnitario - b.valorUnitario),
      pagination: {
        paginaAtual: pagina,
        tamanhoPagina: Math.min(50, params.tamanhoPagina || 50),
        totalRegistrosInformadoApi: Math.max(
          0,
          ...resultados.map((r) => r.pagination.totalRegistrosInformadoApi),
        ),
        totalPaginasInformadoApi: totalPaginas,
        temMaisPaginas: !sucesso || pagina < totalPaginas,
        ...(!sucesso ? { proximoCursor: `pncp-page-${pagina}` } : {}),
      },
      tempoMs: Math.round(performance.now() - inicio),
      statusHttp: falhas[0]?.statusHttp || (sucesso ? 200 : 500),
      isIndisponivel: falhas.some((resultado) => resultado.isIndisponivel),
      circuitOpen: falhas.some((resultado) => resultado.circuitOpen),
      ...(retryAtMs > 0 ? { retryAtMs } : {}),
      tentativasRealizadas:
        1 +
        resultados.reduce(
          (total, resultado) => total + Math.max(0, (resultado.tentativasRealizadas || 1) - 1),
          0,
        ),
      erro: sucesso
        ? undefined
        : resultados
            .map((resultado, index) =>
              !resultado.sucesso ? `${tipos[index]}: ${resultado.erro || 'Falha de consulta'}` : '',
            )
            .filter(Boolean)
            .join('; '),
      aviso:
        metadata.itens_fila_pendente > 0
          ? `itens_fila_pendente:${metadata.itens_fila_pendente}`
          : undefined,
      metadata,
    } as ConnectorPageResult
  }

  private async fetchDocumentPage(
    params: ConnectorSearchParams,
    pagina: number,
    tipo: 'ata' | 'edital' | 'contrato',
  ): Promise<ConnectorPageResult> {
    return this.fetchPageWithRetry(params, pagina, async () => {
      const t0 = performance.now()
      // CORREÇÃO 2 (v0.0.77): Subir tam_pagina até 50 conforme Swagger oficial do PNCP
      const tamPagina = Math.min(50, params.tamanhoPagina || 50)

      // 1. Tentar consultar via endpoint proxy do PocketBase
      const baseUrl = pb.baseUrl || ''
      const queryParams = new URLSearchParams()
      queryParams.set('q', params.termo)
      queryParams.set('pagina', String(pagina))
      queryParams.set('tam_pagina', String(tamPagina))
      queryParams.set('tipos_documento', tipo)
      if (params.uf) queryParams.set('uf', params.uf)

      // Se há códigos CATMAT canônicos associados (ex.: 462776 para picolé), informa o backend
      const codigosCatmat =
        params.catmatOuCodigo ||
        (obterCodigosCatmatDoTermo(params.termo).length > 0
          ? obterCodigosCatmatDoTermo(params.termo).join(',')
          : undefined)
      if (codigosCatmat) {
        queryParams.set('catmat', codigosCatmat)
      }

      // Item detail is cache-only in the interactive proxy; missing results are
      // persisted for the existing worker. No ignored max_detalhar hint is sent.
      const endpoint = baseUrl
        ? `${baseUrl}/backend/v1/pncp/search?${queryParams.toString()}`
        : `/backend/v1/pncp/search?${queryParams.toString()}`

      const authToken = pb.authStore?.token || ''
      const controller = new AbortController()
      let timedOut = false
      const timeoutMs = Math.min(
        this.timeoutPorPaginaMs,
        Math.max(0, (params.deadlineAtMs ?? Infinity) - Date.now()),
      )
      const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)

      const onUserAbort = () => controller.abort()
      if (params.signal) {
        if (params.signal.aborted) {
          clearTimeout(timeoutId)
          throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
        }
        params.signal.addEventListener('abort', onUserAbort)
      }

      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(authToken ? { Authorization: authToken } : {}),
          },
          signal: controller.signal,
        })

        if (!response.ok) {
          const status = response.status
          let erroMsg = `Erro HTTP ${status} retornado pelo proxy PNCP`
          let retrySeconds: unknown
          let localCapacity = false
          try {
            const errData = await response.json()
            erroMsg = errData.message || errData.error || erroMsg
            retrySeconds = errData.retry_after_seconds
            // Only these exact authenticated proxy responses reject before
            // official HTTP; unknown and genuine upstream errors stay failures.
            localCapacity =
              new URL(endpoint, 'https://pncp-proxy.invalid').pathname ===
                '/backend/v1/pncp/search' &&
              errData.sucesso === false &&
              ((status === 429 && errData.error === 'SOURCE_RATE_LIMITED') ||
                (status === 503 && errData.error === 'SOURCE_RATE_LIMIT_UNAVAILABLE'))
          } catch {
            /* intentionally ignored */
          } finally {
            clearTimeout(timeoutId)
          }

          if (status === 429) {
            const agora = Date.now()
            const header = response.headers?.get('Retry-After')?.trim()
            const segundos = Number(retrySeconds)
            const corpoPrazo =
              (typeof retrySeconds === 'number' || typeof retrySeconds === 'string') &&
              Number.isFinite(segundos) &&
              segundos > 0
                ? agora + segundos * 1000
                : 0
            const headerSegundos = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN
            const headerPrazo =
              Number.isFinite(headerSegundos) && headerSegundos > 0
                ? agora + headerSegundos * 1000
                : header && !Number.isFinite(headerSegundos)
                  ? Date.parse(header)
                  : 0
            const prazo = Math.max(
              Number.isFinite(corpoPrazo) && corpoPrazo > agora ? corpoPrazo : 0,
              Number.isFinite(headerPrazo) && headerPrazo > agora ? headerPrazo : 0,
            )
            this.retryAtMs = Math.max(
              this.retryAtMs,
              prazo || agora + 60000,
              localCapacity ? agora + 60000 : 0,
            )
          }
          if (localCapacity) {
            erroMsg =
              status === 429
                ? 'Limite local de consultas PNCP atingido; aguardando capacidade para retomar.'
                : 'Controle local de capacidade PNCP temporariamente indisponível; trabalho preservado.'
            if (status === 503) this.retryAtMs = Math.max(this.retryAtMs, Date.now() + 20000)
          }

          return {
            sucesso: false,
            amostras: [],
            pagination: {
              paginaAtual: pagina,
              tamanhoPagina: tamPagina,
              totalRegistrosInformadoApi: 0,
              totalPaginasInformadoApi: 0,
              temMaisPaginas: false,
            },
            tempoMs: Math.round(performance.now() - t0),
            statusHttp: status,
            ...(status === 429 || localCapacity ? { retryAtMs: this.retryAtMs } : {}),
            ...(localCapacity ? { localCooldown: true } : {}),
            isIndisponivel:
              !localCapacity &&
              (status === 502 || status === 503 || status === 504 || status === 429),
            erro: erroMsg,
          }
        }

        // Mantém timeout ativo durante a leitura do stream JSON
        const data = await response.json()
        clearTimeout(timeoutId)
        const rawItems = data.items || data.resultado || (Array.isArray(data) ? data : [])
        const totalRegistros = data.totalRegistros || data.total || rawItems.length
        const totalPaginas = data.totalPaginas || Math.max(1, Math.ceil(totalRegistros / tamPagina))

        // Captura detalhamento_paralelo e itens_fila_pendente retornados pelo hook pncp_search.js
        const detalhamento = data.detalhamento_paralelo || {}
        const filaPendente =
          typeof detalhamento.itens_fila_pendente === 'number'
            ? detalhamento.itens_fila_pendente
            : typeof data.itens_fila_pendente === 'number'
              ? data.itens_fila_pendente
              : 0

        const amostras: AmostraPreco[] = []

        // Descompactar atas e seus subitens
        for (let i = 0; i < rawItems.length; i++) {
          const entry = rawItems[i]
          if (Array.isArray(entry.itensAta) && entry.itensAta.length > 0) {
            for (let j = 0; j < entry.itensAta.length; j++) {
              const sub = entry.itensAta[j]
              const subQtd = Number(sub.quantidade) > 0 ? Number(sub.quantidade) : 0

              const subMapeado = {
                ...entry,
                ...sub,
                valorUnitarioHomologado:
                  sub.valorUnitarioHomologado ?? sub.valor_unitario_homologado,
                valor_unitario_homologado: sub.valor_unitario_homologado,
                valorUnitarioEstimado: sub.valorUnitarioEstimado ?? sub.valor_unitario_estimado,
                valor_unitario_estimado: sub.valor_unitario_estimado,
                valorUnitario: sub.valorUnitario,
                valor_unitario: sub.valor_unitario,
                proveniencia_preco: sub.proveniencia_preco,
                id_externo: entry.numeroControlePNCP || entry.numero_controle_pncp || entry.id,
                item_externo: sub.descricao || sub.materialOuServicoNome,
                unidade: sub.unidade || sub.unidadeMedida || 'NÃO INFORMADO',
                quantidade: subQtd,
                fornecedor:
                  sub.fornecedor?.nomeRazaoSocial ||
                  sub.fornecedor?.nomeRazaoSocialFornecedor ||
                  entry.fornecedor?.nomeRazaoSocialFornecedor ||
                  entry.fornecedor?.nomeRazaoSocial ||
                  'NÃO INFORMADO',
                cnpj_fornecedor:
                  sub.fornecedor?.niFornecedor ||
                  sub.fornecedor?.cnpj ||
                  entry.fornecedor?.niFornecedor ||
                  entry.fornecedor?.cnpj ||
                  'NÃO INFORMADO',
              }
              const norm = this.normalize(subMapeado, i * 100 + j, {
                ingestionReceipt: data.ingestion_receipt,
                ingestionReceipts: data.ingestion_receipts,
              })
              if (norm?.ingestionReceipt) {
                // Não descarta automaticamente: todas as amostras com preço unitário são preservadas
                // Diferenças e categorias de risco são sinalizadas para juízo crítico humano
                amostras.push(norm)
              }
            }
          } else {
            // Se não veio itensAta, só aceita a amostra se entry tiver preço unitário real do item
            // (e NUNCA aceita contratação global sem detalhamento com preço sintético)
            if (!entry._detalhamento_pendente && !entry._is_contratacao_sem_item) {
              const norm = this.normalize(entry, i, {
                ingestionReceipt: data.ingestion_receipt,
                ingestionReceipts: data.ingestion_receipts,
              })
              if (norm?.ingestionReceipt) {
                amostras.push(norm)
              }
            }
          }
        }

        // Ordenação estrita crescente pelo menor preço unitário numérico
        amostras.sort((a, b) => a.valorUnitario - b.valorUnitario)

        // Uma página só pode ser publicada/avançada depois que o índice confirmar
        // aceitação integral. Assim, falha ou timeout preserva a mesma página para retry.
        if (amostras.length > 0 && !params.signal?.aborted) {
          let persisted: { inseridas: number; atualizadas: number; ignoradas: number }
          try {
            persisted = await PriceIndexService.persistirAmostras(amostras)
          } catch (error: any) {
            const persistenceTimedOut = error?.timed_out === true
            throw Object.assign(
              new Error(error?.message || 'Persistência do índice interrompida.'),
              {
                code: error?.code || 'INDEX_BATCH_FAILED',
                status: persistenceTimedOut
                  ? 408
                  : Number.isInteger(error?.status) && error.status >= 400
                    ? error.status
                    : 502,
                timed_out: persistenceTimedOut,
                parcial: error?.parcial,
              },
            )
          }
          const counts = [persisted.inseridas, persisted.atualizadas, persisted.ignoradas]
          const accepted = persisted.inseridas + persisted.atualizadas
          if (
            !counts.every((count) => Number.isInteger(count) && count >= 0) ||
            persisted.ignoradas !== 0 ||
            accepted !== amostras.length
          ) {
            throw Object.assign(
              new Error(
                'Persistência do índice com aceitação parcial; página preservada para nova tentativa.',
              ),
              {
                code: 'INDEX_BATCH_PARTIAL_ACCEPTANCE',
                status: 502,
                parcial: persisted,
              },
            )
          }
        }
        if (params.signal?.aborted) {
          throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
        }

        const temMais = pagina < totalPaginas

        return {
          sucesso: true,
          amostras,
          pagination: {
            paginaAtual: pagina,
            tamanhoPagina: tamPagina,
            totalRegistrosInformadoApi: totalRegistros,
            totalPaginasInformadoApi: totalPaginas,
            temMaisPaginas: temMais,
          },
          tempoMs: Math.round(performance.now() - t0),
          statusHttp: 200,
          aviso: filaPendente > 0 ? `itens_fila_pendente:${filaPendente}` : undefined,
          metadata: {
            cobertura_parcial: detalhamento.cobertura_parcial === true || filaPendente > 0,
            descoberta_parcial: detalhamento.descoberta_parcial,
            fila_persistida: detalhamento.fila_persistida,
            itens_pendentes: detalhamento.itens_pendentes,
            itens_fila_pendente: filaPendente,
            itens_nao_enfileirados: detalhamento.itens_nao_enfileirados,
            itens_congelados: detalhamento.itens_congelados,
            erro_fila: detalhamento.erro_fila,
            detalhamento_paralelo: detalhamento,
            diagnostico_fluxo: data.diagnostico_fluxo,
          },
        }
      } catch (err: any) {
        clearTimeout(timeoutId)
        if (params.signal?.aborted) {
          throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
        }
        const isTimeout =
          timedOut ||
          err?.timed_out === true ||
          (err?.name === 'AbortError' && !params.signal?.aborted)
        const errMsg = err?.message || ''
        const reportedStatus = Number.isInteger(err?.status) && err.status >= 400 ? err.status : 500
        const statusHttp = isTimeout ? 408 : reportedStatus
        const isNetworkError =
          isTimeout ||
          statusHttp === 429 ||
          statusHttp === 502 ||
          statusHttp === 503 ||
          statusHttp === 504 ||
          errMsg.includes('Failed to fetch') ||
          errMsg.includes('NetworkError') ||
          errMsg.includes('ECONNREFUSED')
        return {
          sucesso: false,
          amostras: [],
          pagination: {
            paginaAtual: pagina,
            tamanhoPagina: tamPagina,
            totalRegistrosInformadoApi: 0,
            totalPaginasInformadoApi: 0,
            temMaisPaginas: false,
          },
          tempoMs: Math.round(performance.now() - t0),
          statusHttp,
          isIndisponivel: isNetworkError,
          erro: isTimeout
            ? `Timeout de ${this.timeoutPorPaginaMs}ms excedido na consulta ao PNCP`
            : err?.message || 'Falha de conexão com PNCP',
        }
      } finally {
        clearTimeout(timeoutId)
        if (params.signal) {
          params.signal.removeEventListener('abort', onUserAbort)
        }
      }
    })
  }
}
