/**
 * Compras.gov.br Connector Adapter
 * Implementa o contrato IPriceConnectorAdapter para a API do Compras.gov.br (v2.2.0).
 * Híbrido: CATMAT + busca textual + módulo ARP + Lei 14.133.
 */

import { BasePriceConnectorAdapter } from './baseConnectorAdapter'
import { SourceMetadata, ConnectorSearchParams, ConnectorPageResult, AmostraPreco } from './types'
import pb from '../pocketbase/client'
import { ComprasGovService } from '../comprasGovService'

export class ComprasGovConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'compras_gov'
  public readonly nome = 'Compras.gov.br (Dados Abertos Federais)'

  constructor() {
    super()
    this.versaoConector = '2.3.0'
    this.maxRetries = 1
    this.retryDelayBaseMs = 300
    this.timeoutPorPaginaMs = 10000
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

    if (isNaN(valorUnitario) || valorUnitario <= 0) {
      console.info('[ComprasGovConnectorAdapter] Amostra descartada: sem preço unitário', {
        id: rawItem.id || rawItem.codigoItem,
        item: rawItem.descricaoItem || rawItem.descricao || rawItem.item,
        motivo: 'sem preço unitário',
      })
      return null
    }

    const id = rawItem.id || rawItem.codigoItem || `CGOV-${index}`
    const descricao =
      rawItem.descricaoItem || rawItem.descricao || rawItem.item || 'Item Compras.gov.br'

    // Extração da unidade de fornecimento real da fonte (campo unidadeMedida/sigla e descrição)
    // Se a descrição indicar embalagem coletiva (caixa com N, frasco, envelope, etc.), preservar
    // a unidade qualificada da fonte (ex.: "CX 250 UN", "CX", "FR") sem fallback cego para "UN"
    // e sem inventar divisão de preço por quantidade inferida.
    const extrairUnidadeQualificada = (uBruta?: string, dBruta?: string): string => {
      const u = (uBruta || '').trim().toUpperCase()
      const d = (dBruta || '').trim().toUpperCase()

      const matchCxCom = d.match(
        /\b(?:CAIXA|CX|PCT|PACOTE|ENVELOPE|BLISTER|FARDO)\s*(?:COM|C\/)?\s*(\d+)\s*(?:COMPRIMIDOS?|COMP?|UNIDADES?|UN|CAPSULAS?|AMPOLAS?|FLACONETES?|SACHES?|FL)?\b/i,
      )
      const matchCxSimples = d.match(/\b(?:CAIXA|CX)\s*(?:C\/|COM)?\s*(\d+)\b/i)
      const matchAbrev = d.match(/\bCX\s*(\d+)\b/i)

      const qtdColetiva = matchCxCom?.[1] || matchCxSimples?.[1] || matchAbrev?.[1]
      const tipoEmbalagem = d.includes('ENVELOPE')
        ? 'ENV'
        : d.includes('BLISTER')
          ? 'BLIST'
          : d.includes('FARDO')
            ? 'FARDO'
            : d.includes('PACOTE') || d.includes('PCT')
              ? 'PCT'
              : 'CX'

      if (qtdColetiva && parseInt(qtdColetiva, 10) > 1) {
        return `${tipoEmbalagem} ${parseInt(qtdColetiva, 10)} UN`
      }

      if (u && u !== 'UN' && u !== 'UND' && u !== 'UNIDADE') {
        return u
      }

      if (/\b(?:FRASCO|FR)\b/i.test(d)) return 'FRASCO'
      if (/\b(?:AMPOLA|AMP)\b/i.test(d)) return 'AMPOLA'
      if (/\b(?:ENVELOPE|ENV)\b/i.test(d)) return 'ENVELOPE'
      if (/\b(?:BLISTER|BLIST)\b/i.test(d)) return 'BLISTER'
      if (/\b(?:BISNAGA|BISN)\b/i.test(d)) return 'BISNAGA'
      if (/\b(?:COMPRIMIDO|COMP)\b/i.test(d)) return 'COMPRIMIDO'
      if (/\b(?:CAIXA|CX)\b/i.test(d)) return 'CX'

      return u || 'UN'
    }

    const unidade = extrairUnidadeQualificada(rawItem.unidadeMedida || rawItem.unidade, descricao)
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
      detalhesAdicionais: {
        ncm: rawItem.ncm || rawItem.ncm_nbs || rawItem.codigoNcm,
        criterio_julgamento: rawItem.criterioJulgamento || rawItem.criterio || 'Menor preço',
        data_vigencia_inicio: rawItem.dataVigenciaInicio || dataCompra,
        data_vigencia_fim: rawItem.dataVigenciaFim || rawItem.vigenciaFim,
      },
    }
  }

  public async fetchPage(
    params: ConnectorSearchParams,
    pagina: number,
  ): Promise<ConnectorPageResult> {
    return this.fetchPageWithRetry(params, pagina, async () => {
      const t0 = performance.now()
      // Usar tamanho máximo oficialmente permitido (50 registros)
      const tamPagina = Math.min(50, params.tamanhoPagina || 50)

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
