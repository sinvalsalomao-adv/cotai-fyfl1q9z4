/**
 * Compras.gov.br Connector Adapter
 * Implementa o contrato IPriceConnectorAdapter para a API do Compras.gov.br (v2.2.0).
 * Híbrido: CATMAT + busca textual + módulo ARP + Lei 14.133.
 */

import { BasePriceConnectorAdapter } from './baseConnectorAdapter'
import { SourceMetadata, ConnectorSearchParams, ConnectorPageResult, AmostraPreco } from './types'
import { pb } from '../pocketbase/client'
import { ComprasGovService } from '../comprasGovService'

export class ComprasGovConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'compras_gov'
  public readonly nome = 'Compras.gov.br (Dados Abertos Federais)'

  constructor() {
    super()
    this.versaoConector = '2.2.0'
    this.maxRetries = 2
    this.retryDelayBaseMs = 400
  }

  public getSourceMetadata(): SourceMetadata {
    return {
      id: this.id,
      nome: this.nome,
      sigla: 'COMPRAS.GOV',
      tipo: 'OFICIAL_GOV',
      status: 'ATIVA',
      descricao:
        'Dados abertos oficiais do Governo Federal brasileiro (Comprasnet / Compras.gov.br) com módulo de pesquisa de preços, atas e contratações Lei 14.133.',
      urlPortal: 'https://compras.dados.gov.br',
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

    const valorUnitario =
      Number(rawItem.valorUnitario) ||
      Number(rawItem.precoUnitarioHomologado) ||
      Number(rawItem.precoUnitario) ||
      Number(rawItem.precoPraticado) ||
      0

    if (isNaN(valorUnitario) || valorUnitario <= 0) return null

    const id = rawItem.id || rawItem.codigoItem || `CGOV-${index}`
    const descricao =
      rawItem.descricaoItem || rawItem.descricao || rawItem.item || 'Item Compras.gov.br'
    const unidade = (rawItem.unidadeMedida || rawItem.unidade || 'UN').trim().toUpperCase()
    const quantidade = Number(rawItem.quantidade) || 1
    const dataCompra =
      rawItem.dataCompra ||
      rawItem.dataResultado ||
      rawItem.dataAssinatura ||
      new Date().toISOString()

    const orgaoNome = rawItem.orgaoComprador || rawItem.nomeOrgao || 'Órgão Federal Compras.gov.br'
    const cnpjOrgao = rawItem.cnpjOrgao || rawItem.cnpj || 'NÃO INFORMADO'
    const uasg = rawItem.uasg || rawItem.codigoUasg || 'NÃO INFORMADO'

    const fornecedorNome =
      rawItem.nomeFornecedor || rawItem.fornecedor || rawItem.razaoSocial || 'NÃO INFORMADO'
    const fornecedorCnpj =
      rawItem.cnpjFornecedor || rawItem.cpfCnpjFornecedor || rawItem.niFornecedor || 'NÃO INFORMADO'

    const catmat = rawItem.codigoCatmat || rawItem.codigoItemCatalogo || ''
    const hash =
      rawItem.hashRastreabilidade ||
      `cgov_${cnpjOrgao}_${uasg}_${id}_${valorUnitario}_${dataCompra}`

    return {
      id: `CGOV-${id}-${index}-${valorUnitario.toFixed(4).replace('.', '_')}`,
      fonte: 'Compras.gov.br',
      fonteNomeExibicao: 'Compras.gov.br (Dados Abertos Federais)',
      idExterno: String(id),
      urlOriginal:
        rawItem.linkEditalOuCompra ||
        ComprasGovService.construirLinkCatmat(catmat) ||
        'https://dadosabertos.compras.gov.br',
      dataPublicacaoOuContrato: dataCompra,
      produto: descricao.trim().toUpperCase(),
      descricaoCompleta: descricao.trim().toUpperCase(),
      descricaoNormalizada: descricao.trim().toUpperCase(),
      orgaoComprador: orgaoNome,
      orgaoCnpj: cnpjOrgao,
      municipio: rawItem.municipio,
      uf: rawItem.uf,
      fornecedorNome,
      fornecedorCnpjOuCpf: fornecedorCnpj,
      fornecedorPorte:
        rawItem.porteFornecedor ||
        (fornecedorNome.includes('ME') || fornecedorNome.includes('EPP') ? 'ME_EPP' : 'DEMAIS'),
      unidade,
      quantidade,
      valorUnitario,
      valorTotal: valorUnitario * quantidade,
      modalidadeLicitacao: rawItem.modalidadeCompra || 'Pregão Eletrônico',
      numeroProcessoOuContrato: rawItem.numeroProcesso || String(id),
      marca: rawItem.marca || 'NÃO INFORMADO',
      fabricante: rawItem.fabricante || 'NÃO INFORMADO',
      codigoCatalogo: catmat ? `CATMAT ${catmat}` : 'CATMAT',
      hashRastreabilidade: hash,
      scoreSimilaridade: 95,
      natureza: 'homologado',
      isDemo: false,
    }
  }

  public async fetchPage(
    params: ConnectorSearchParams,
    pagina: number,
  ): Promise<ConnectorPageResult> {
    return this.fetchPageWithRetry(params, pagina, async () => {
      const t0 = performance.now()
      const tamPagina = Math.min(50, params.tamanhoPagina || 25)

      const baseUrl = pb.baseUrl || ''
      const queryParams = new URLSearchParams()
      queryParams.set('termo', params.termo)
      queryParams.set('pagina', String(pagina))
      queryParams.set('tam_pagina', String(tamPagina))
      if (params.catmatOuCodigo) queryParams.set('catmat', params.catmatOuCodigo)
      if (params.uf) queryParams.set('uf', params.uf)
      if (params.dataInicio) queryParams.set('data_inicio', params.dataInicio)
      if (params.dataFim) queryParams.set('data_fim', params.dataFim)

      const endpoint = baseUrl
        ? `${baseUrl}/backend/v1/cotai/comprasgov-search?${queryParams.toString()}`
        : `/backend/v1/cotai/comprasgov-search?${queryParams.toString()}`

      const authToken = pb.authStore?.token || ''
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutPorPaginaMs)

      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(authToken ? { Authorization: authToken } : {}),
          },
          signal: controller.signal,
        })
        clearTimeout(timeoutId)

        if (!response.ok) {
          const status = response.status
          let erroMsg = `Erro HTTP ${status} retornado pelo proxy Compras.gov.br`
          try {
            const errData = await response.json()
            erroMsg = errData.message || errData.error || erroMsg
          } catch {
            /* intentionally ignored */
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
            isIndisponivel: status === 502 || status === 503 || status === 504 || status === 429,
            erro: erroMsg,
          }
        }

        const data = await response.json()
        const rawItems =
          data.dados?.resultado ||
          data.dados?.items ||
          (Array.isArray(data.dados) ? data.dados : [])
        const totalRegistros =
          data.dados?.totalRegistros || data.totalEncontrados || rawItems.length
        const totalPaginas =
          data.dados?.totalPaginas ||
          data.totalPaginas ||
          Math.max(1, Math.ceil(totalRegistros / tamPagina))

        const amostras: AmostraPreco[] = []
        for (let i = 0; i < rawItems.length; i++) {
          const norm = this.normalize(rawItems[i], i)
          if (norm) amostras.push(norm)
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
        }
      } catch (err: any) {
        clearTimeout(timeoutId)
        const isAbort = err?.name === 'AbortError'
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
          statusHttp: isAbort ? 408 : 500,
          isIndisponivel: true,
          erro: isAbort
            ? `Timeout de ${this.timeoutPorPaginaMs}ms excedido na consulta ao Compras.gov.br`
            : err?.message || 'Falha de conexão com Compras.gov.br',
        }
      }
    })
  }
}
