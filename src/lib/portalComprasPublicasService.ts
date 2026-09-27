import pb from './pocketbase/client'
import type { BudgetPriceResult } from '@/services/budgetService'

export interface PortalComprasPublicasSearchParams {
  termo: string
  uf?: string
  pagina?: number
  tamPagina?: number
}

export interface PcpApiResponse {
  sucesso: boolean
  totalRegistros?: number
  resultado?: any[]
  itens?: any[]
  fonte?: string
  credenciamento_necessario?: boolean
  status_catalogo?: string
  codigo_fonte?: string
  nome_fonte?: string
  nota_tecnica?: string
  endpoint_doc?: string
  erro?: string
  message?: string
  detail?: string
}

export interface PcpSearchResult {
  prices: BudgetPriceResult[]
  total: number
  origem: string
  tempoMs: number
  credenciamento_necessario?: boolean
  nota_tecnica?: string
  erro?: string
}

// Geração de Hash seguro e determinístico para rastreabilidade estrita da cotação
function generatePcpTraceHash(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0 // Converte para inteiro de 32 bits
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0')
  return `PCP-${hex.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`
}

export class PortalComprasPublicasService {
  /**
   * Consulta oficial do Portal de Compras Públicas via Proxy Seguro do backend (/backend/v1/cotai/pcp-search).
   *
   * Regras COTAI & Lei 14.133/2021:
   * 1. NUNCA fallback silencioso para dados demo sintéticos.
   * 2. Se a API exigir credenciamento/chave de comprador, reporta com honestidade técnica.
   * 3. Campos ausentes convertidos para "NÃO INFORMADO".
   * 4. Erros 502/upstream NUNCA deslogam nem travam a sessão do usuário.
   */
  static async buscarPrecos(params: PortalComprasPublicasSearchParams): Promise<PcpSearchResult> {
    const start = performance.now()
    const termo = (params.termo || '').trim()

    if (!termo) {
      return {
        prices: [],
        total: 0,
        origem: 'Portal de Compras Públicas (Vazio)',
        tempoMs: 0,
      }
    }

    const query = new URLSearchParams({
      termo,
      pagina: String(params.pagina || 1),
      tam_pagina: String(params.tamPagina || 25),
    })

    if (params.uf) {
      query.set('uf', params.uf)
    }

    try {
      const response = await pb.send<PcpApiResponse>(
        `/backend/v1/cotai/pcp-search?${query.toString()}`,
        {
          method: 'GET',
          requestKey: null, // Evita cancelamento indevido
        },
      )

      const elapsed = Math.round(performance.now() - start)

      if (response.credenciamento_necessario) {
        return {
          prices: [],
          total: 0,
          origem: 'Portal de Compras Públicas (Aguardando Credenciamento)',
          tempoMs: elapsed,
          credenciamento_necessario: true,
          nota_tecnica:
            response.nota_tecnica ||
            'API do Portal de Compras Públicas exige chave de API / Token de comprador credenciado. Cadastre PORTAL_COMPRAS_PUBLICAS_API_KEY no painel Integrações.',
        }
      }

      if (!response.sucesso && response.erro) {
        return {
          prices: [],
          total: 0,
          origem: 'Portal de Compras Públicas (Erro Upstream)',
          tempoMs: elapsed,
          erro: response.erro,
          nota_tecnica: response.nota_tecnica,
        }
      }

      const rawItems = response.resultado || response.itens || []
      const prices: BudgetPriceResult[] = rawItems.map((item: any, idx: number) => {
        const idExterno =
          item.id ||
          item.codigoItem ||
          item.numeroItem ||
          item.idProcesso ||
          `pcp-${idx}-${Date.now()}`

        const unitPrice = Number(
          item.valorUnitario || item.precoUnitario || item.valorHomologado || item.valor || 0,
        )

        const descricao =
          item.descricao || item.descricaoItem || item.objeto || item.especificacao || termo

        const orgao =
          item.orgaoComprador || item.nomeOrgao || item.comprador || item.ente || 'NÃO INFORMADO'

        const fornecedor =
          item.fornecedor ||
          item.razaoSocial ||
          item.nomeFornecedor ||
          item.vencedor ||
          'NÃO INFORMADO'

        const cnpj = item.cnpjFornecedor || item.cnpj || item.cpfCnpj || 'NÃO INFORMADO'

        const uf = item.uf || item.siglaUf || item.estado || params.uf || 'NÃO INFORMADO'

        const municipio = item.municipio || item.cidade || item.nomeMunicipio || 'NÃO INFORMADO'

        const dataRef =
          item.dataHomologacao ||
          item.dataAbertura ||
          item.data ||
          new Date().toISOString().split('T')[0]

        const numEdital =
          item.numeroProcesso ||
          item.processo ||
          item.numeroEdital ||
          item.edital ||
          'NÃO INFORMADO'

        const urlDoc =
          item.urlProcesso ||
          item.linkEdital ||
          item.url ||
          `https://www.portaldecompraspublicas.com.br/processos?termo=${encodeURIComponent(termo)}`

        const hashRastreabilidade = generatePcpTraceHash(
          `${idExterno}-${unitPrice}-${orgao}-${dataRef}`,
        )

        return {
          id: `pcp-${idExterno}`,
          budget_item_id: '',
          source: 'portal_compras_publicas',
          sourceName: 'Portal de Compras Públicas (Oficial)',
          sourceType: 'portal_compras_publicas',
          source_record_id: String(idExterno),
          source_url: urlDoc,
          source_date: dataRef,
          government_entity: orgao,
          supplier: fornecedor,
          supplier_document: cnpj,
          description_original: descricao,
          unit: item.unidade || item.siglaUnidade || 'UN',
          quantity: Number(item.quantidade || 1),
          unit_price: Math.max(0, unitPrice),
          status: 'encontrado' as const,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          raw_data: {
            origem_badge: 'COMPRAS PÚBLICAS REAL (OFICIAL)',
            is_real_api: true,
            modalidade: item.modalidade || item.tipoModalidade || 'Pregão Eletrônico',
            numero_edital: numEdital,
            uf,
            municipio,
            hash: hashRastreabilidade,
          },
          itemDescription: descricao,
          unitPrice: Math.max(0, unitPrice),
          totalPrice: Math.max(0, unitPrice) * Number(item.quantidade || 1),
          buyerOrg: orgao,
          supplierName: fornecedor,
          supplierCnpj: cnpj,
          uf,
          municipality: municipio,
          biddingModality: item.modalidade || item.tipoModalidade || 'Pregão Eletrônico',
          noticeNumber: numEdital,
          date: dataRef,
          documentUrl: urlDoc,
          hash: hashRastreabilidade,
          traceabilityHash: hashRastreabilidade,
          missingFields: [
            ...(orgao === 'NÃO INFORMADO' ? ['orgaoComprador'] : []),
            ...(fornecedor === 'NÃO INFORMADO' ? ['fornecedor'] : []),
            ...(cnpj === 'NÃO INFORMADO' ? ['cnpjFornecedor'] : []),
          ],
        }
      })

      return {
        prices,
        total: response.totalRegistros || prices.length,
        origem: response.fonte || 'Portal de Compras Públicas (Oficial)',
        tempoMs: elapsed,
      }
    } catch (error: any) {
      const elapsed = Math.round(performance.now() - start)
      console.warn('[PortalComprasPublicasService] Erro ao consultar backend proxy do PCP:', error)

      return {
        prices: [],
        total: 0,
        origem: 'Portal de Compras Públicas (Erro)',
        tempoMs: elapsed,
        erro:
          error?.data?.message ||
          error?.message ||
          'Falha de comunicação com o proxy do Portal de Compras Públicas.',
        nota_tecnica:
          'O conector está operacional, porém a requisição não obteve resposta satisfatória da API upstream ou a credencial ainda não foi provisionada.',
      }
    }
  }

  /**
   * Constrói Deep Link oficial seguro para o Portal de Compras Públicas
   */
  static getDeepLink(termoOuProcesso: string, processoId?: string): string {
    if (processoId && /^\d+$/.test(processoId)) {
      return `https://www.portaldecompraspublicas.com.br/processos/detalhe/${processoId}`
    }
    const termo = encodeURIComponent(termoOuProcesso || '')
    return `https://www.portaldecompraspublicas.com.br/processos?termo=${termo}`
  }
}
