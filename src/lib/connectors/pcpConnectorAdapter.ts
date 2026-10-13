/**
 * Portal de Compras Públicas (PCP) Connector Adapter
 * Conector para o ecossistema municipal do Portal de Compras Públicas.
 * Trata status CREDECIAL_NECESSARIA / INDISPONÍVEL com transparência (RF-010..014).
 */

import { BasePriceConnectorAdapter } from './baseConnectorAdapter'
import { SourceMetadata, ConnectorSearchParams, ConnectorPageResult, AmostraPreco } from './types'
import { PortalComprasPublicasService } from '../portalComprasPublicasService'

export class PortalComprasPublicasConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'portal_compras_publicas'
  public readonly nome = 'Portal de Compras Públicas (PCP)'

  constructor() {
    super()
    this.versaoConector = '1.0.0'
    this.maxRetries = 1
  }

  public getSourceMetadata(): SourceMetadata {
    return {
      id: this.id,
      nome: this.nome,
      sigla: 'PCP',
      tipo: 'SISTEMA_COMPRAS',
      status: 'CREDENCIAL_NECESSARIA',
      descricao:
        'Portal de compras com grande capilaridade em prefeituras e consórcios municipais.',
      urlPortal: 'https://portaldecompraspublicas.com.br',
      suportaPaginacaoCompleta: true,
      maxTamanhoPaginaPermitido: 25,
      rateLimitRequisicoesPorSegundo: 3,
      concorrenciaMaximaRecomendada: 2,
      requerCredencial: true,
      credencialConfigurada: false,
      isDemo: false,
    }
  }

  public normalize(rawItem: any, index: number, metadata?: any): AmostraPreco | null {
    if (!rawItem) return null
    const valorUnitario = Number(rawItem.unit_price) || Number(rawItem.valor_unitario) || 0
    if (isNaN(valorUnitario) || valorUnitario <= 0) {
      console.info(
        '[PortalComprasPublicasConnectorAdapter] Amostra descartada: sem preço unitário',
        {
          id: rawItem.id || rawItem.source_record_id,
          item: rawItem.description_original || rawItem.descricao,
          motivo: 'sem preço unitário',
        },
      )
      return null
    }

    const id = rawItem.id || `PCP-${index}`
    const desc = rawItem.description_original || rawItem.descricao || 'Item PCP'

    return {
      id: `PCP-${id}-${index}-${valorUnitario.toFixed(4).replace('.', '_')}`,
      fonte: 'Portal de Compras Públicas',
      fonteNomeExibicao: 'Portal de Compras Públicas (PCP)',
      idExterno: String(rawItem.source_record_id || id),
      urlOriginal: rawItem.source_url || 'https://portaldecompraspublicas.com.br',
      dataPublicacaoOuContrato: rawItem.source_date || new Date().toISOString(),
      produto: desc.trim().toUpperCase(),
      descricaoCompleta: desc.trim().toUpperCase(),
      descricaoNormalizada: desc.trim().toUpperCase(),
      orgaoComprador: rawItem.government_entity || 'Órgão Municipal PCP',
      orgaoCnpj: 'NÃO INFORMADO',
      uf: rawItem.uf,
      fornecedorNome: rawItem.supplier || 'NÃO INFORMADO',
      fornecedorCnpjOuCpf: rawItem.supplier_document || 'NÃO INFORMADO',
      fornecedorPorte: 'DEMAIS',
      unidade: (rawItem.unit || 'UN').trim().toUpperCase(),
      quantidade: Number(rawItem.quantity) || 1,
      valorUnitario,
      valorTotal: valorUnitario * (Number(rawItem.quantity) || 1),
      modalidadeLicitacao: 'Pregão Eletrônico',
      numeroProcessoOuContrato: String(id),
      marca: rawItem.marca || 'NÃO INFORMADO',
      codigoCatalogo: 'PCP',
      hashRastreabilidade: `pcp_${id}_${valorUnitario}`,
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
      try {
        const res = await PortalComprasPublicasService.buscarPrecos({
          termo: params.termo,
          uf: params.uf,
          pagina,
          tamPagina: params.tamanhoPagina || 25,
        })

        if (res.credenciamento_necessario) {
          return {
            sucesso: true,
            amostras: [],
            pagination: {
              paginaAtual: pagina,
              tamanhoPagina: params.tamanhoPagina || 25,
              totalRegistrosInformadoApi: 0,
              totalPaginasInformadoApi: 0,
              temMaisPaginas: false,
            },
            tempoMs: Math.round(performance.now() - t0),
            statusHttp: 200,
            aviso: 'Portal de Compras Públicas aguardando credenciamento de token de acesso.',
          }
        }

        const amostras: AmostraPreco[] = []
        for (let i = 0; i < (res.prices || []).length; i++) {
          const norm = this.normalize(res.prices[i], i)
          if (norm) amostras.push(norm)
        }

        return {
          sucesso: true,
          amostras,
          pagination: {
            paginaAtual: pagina,
            tamanhoPagina: params.tamanhoPagina || 25,
            totalRegistrosInformadoApi: res.total || amostras.length,
            totalPaginasInformadoApi: Math.max(
              1,
              Math.ceil((res.total || amostras.length) / (params.tamanhoPagina || 25)),
            ),
            temMaisPaginas: false,
          },
          tempoMs: Math.round(performance.now() - t0),
          statusHttp: 200,
        }
      } catch (err: any) {
        return {
          sucesso: false,
          amostras: [],
          pagination: {
            paginaAtual: pagina,
            tamanhoPagina: params.tamanhoPagina || 25,
            totalRegistrosInformadoApi: 0,
            totalPaginasInformadoApi: 0,
            temMaisPaginas: false,
          },
          tempoMs: Math.round(performance.now() - t0),
          statusHttp: 503,
          isIndisponivel: true,
          erro: err?.message || 'Falha na conexão com Portal de Compras Públicas',
        }
      }
    })
  }
}
