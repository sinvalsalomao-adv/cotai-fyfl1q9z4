/**
 * BPS Connector Adapter
 * Implementa o contrato IPriceConnectorAdapter para a API do BPS (Banco de Preços em Saúde - Ministério da Saúde).
 * Dados abertos oficiais para medicamentos e insumos hospitalares.
 */

import { BasePriceConnectorAdapter } from './baseConnectorAdapter'
import { SourceMetadata, ConnectorSearchParams, ConnectorPageResult, AmostraPreco } from './types'
import { pb } from '../pocketbase/client'
import { BpsService } from '../bpsService'

export class BpsConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'bps'
  public readonly nome = 'BPS (Banco de Preços em Saúde - MS)'

  constructor() {
    super()
    this.versaoConector = '2.0.0'
    this.maxRetries = 2
    this.retryDelayBaseMs = 400
  }

  public getSourceMetadata(): SourceMetadata {
    return {
      id: this.id,
      nome: this.nome,
      sigla: 'BPS/MS',
      tipo: 'DADOS_ABERTOS',
      status: 'ATIVA',
      descricao:
        'Base de dados oficial aberta do Ministério da Saúde para preços praticados no Sistema Único de Saúde (SUS) em medicamentos e materiais médico-hospitalares.',
      urlPortal: 'https://dadosabertos.saude.gov.br/dataset/bps',
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
      Number(rawItem.precoUnitario) ||
      Number(rawItem.valor_unitario) ||
      0

    if (isNaN(valorUnitario) || valorUnitario <= 0) return null

    const id = rawItem.id || rawItem.codigoItem || `BPS-${index}`
    const descricao =
      rawItem.descricaoItem || rawItem.descricao || rawItem.descricaoMaterial || 'Item BPS'
    const unidade = (rawItem.unidadeMedida || rawItem.unidade || 'UN').trim().toUpperCase()
    const quantidade = Number(rawItem.quantidade) || 1
    const dataCompra =
      rawItem.dataCompra || rawItem.dataRegistro || rawItem.data || new Date().toISOString()

    const orgaoNome = rawItem.orgaoComprador || 'Órgão SUS (BPS/MS)'
    const cnpjOrgao = rawItem.cnpjOrgao || 'NÃO INFORMADO'
    const fornecedorNome = rawItem.nomeFornecedor || rawItem.fornecedor || 'NÃO INFORMADO'
    const fornecedorCnpj = rawItem.cnpjFornecedor || 'NÃO INFORMADO'
    const catmat = rawItem.codigoCatmat || ''

    const hash =
      rawItem.hashRastreabilidade || `bps_${cnpjOrgao}_${id}_${valorUnitario}_${dataCompra}`

    return {
      id: `BPS-${id}-${index}-${valorUnitario.toFixed(4).replace('.', '_')}`,
      fonte: 'BPS',
      fonteNomeExibicao: 'BPS (Banco de Preços em Saúde - MS)',
      idExterno: String(id),
      urlOriginal: rawItem.linkEditalOuCompra || 'https://dadosabertos.saude.gov.br/dataset/bps',
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
      natureza: 'contratado',
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

      const endpoint = baseUrl
        ? `${baseUrl}/backend/v1/cotai/bps-search?${queryParams.toString()}`
        : `/backend/v1/cotai/bps-search?${queryParams.toString()}`

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
          let erroMsg = `Erro HTTP ${status} retornado pelo proxy BPS`
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
          data.dados?.items ||
          data.dados?.resultado ||
          (Array.isArray(data.dados) ? data.dados : [])
        const totalRegistros = data.dados?.totalRegistros || data.totalRegistros || rawItems.length
        const totalPaginas = Math.max(1, Math.ceil(totalRegistros / tamPagina))

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
            ? `Timeout de ${this.timeoutPorPaginaMs}ms excedido na consulta ao BPS`
            : err?.message || 'Falha de conexão com BPS',
        }
      }
    })
  }
}
