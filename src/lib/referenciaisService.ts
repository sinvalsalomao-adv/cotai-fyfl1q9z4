import pb from './pocketbase/client'
import type { BudgetPriceResult } from '@/services/budgetService'

export interface ReferencialSearchParams {
  termo: string
  fonte?:
    | 'cmed'
    | 'sinapi'
    | 'sicro'
    | 'conab'
    | 'ceasa'
    | 'seinfra'
    | 'seinfra_ce'
    | 'setop'
    | 'setop_mg'
    | 'todas'
  uf?: string
}

export interface ReferencialItemResult {
  id: string
  fonte_codigo: string
  fonte_nome: string
  origem_badge: string
  natureza_preco: 'regulatorio_tabela' | 'cotacao_mercado'
  tipo_referencial: string
  is_regulatorio: boolean
  codigo_registro: string
  descricao_original: string
  laboratorio_fabricante: string
  cnpj_fabricante: string
  unidade: string
  quantidade: number
  preco_unitario: number
  detalhes_precos: Record<string, any>
  data_publicacao: string
  edicao_referencia: string
  uf: string
  url_oficial: string
  hash: string
}

export interface ReferencialSearchResult {
  sucesso: boolean
  termo: string
  fonte_solicitada: string
  totalEncontrados: number
  registros: ReferencialItemResult[]
  aviso_normativo?: string
  erro?: string
}

export class ReferenciaisService {
  /**
   * Consulta o hook seguro de tabelas referenciais no backend
   */
  static async consultarReferenciais(
    params: ReferencialSearchParams,
  ): Promise<ReferencialSearchResult> {
    try {
      if (!pb.authStore.isValid) {
        return {
          sucesso: false,
          termo: params.termo,
          fonte_solicitada: params.fonte || 'todas',
          totalEncontrados: 0,
          registros: [],
          erro: 'Sessão expirada ou não autenticada. Faça login novamente.',
        }
      }

      const q = new URLSearchParams()
      q.set('termo', params.termo)
      if (params.fonte) q.set('fonte', params.fonte)
      if (params.uf) q.set('uf', params.uf)

      const baseUrl = pb.baseUrl || ''
      const url = baseUrl
        ? `${baseUrl}/backend/v1/cotai/referenciais-search?${q.toString()}`
        : `/backend/v1/cotai/referenciais-search?${q.toString()}`
      const authToken = pb.authStore?.token || ''

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3500)

      const rawResp = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: authToken } : {}),
        },
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      let res: any = null
      if (rawResp.ok) {
        res = await rawResp.json()
      } else {
        try {
          res = await rawResp.json()
        } catch {
          res = { sucesso: false, erro: `HTTP ${rawResp.status}` }
        }
      }

      return {
        sucesso: res.sucesso !== false,
        termo: res.termo || params.termo,
        fonte_solicitada: res.fonte_solicitada || params.fonte || 'todas',
        totalEncontrados: res.totalEncontrados || (res.registros ? res.registros.length : 0),
        registros: res.registros || [],
        aviso_normativo: res.aviso_normativo,
      }
    } catch (err: any) {
      console.warn('[REFERENCIAIS-SERVICE] Erro na requisição:', err)
      const msg =
        err?.response?.message ||
        err?.message ||
        'Não foi possível consultar a base referencial no momento.'
      return {
        sucesso: false,
        termo: params.termo,
        fonte_solicitada: params.fonte || 'todas',
        totalEncontrados: 0,
        registros: [],
        erro: msg,
      }
    }
  }

  /**
   * Converte itens referenciais em BudgetPriceResult para a grade unificada
   */
  static converterParaBudgetPriceResults(
    itens: ReferencialItemResult[],
    budgetItemId: string,
  ): BudgetPriceResult[] {
    return itens.map((item) => {
      // Normalização de badge de exibição para a coluna FONTE
      let sourceDisplayName = 'CMED'
      if (item.fonte_codigo === 'sinapi') sourceDisplayName = 'SINAPI'
      else if (item.fonte_codigo === 'sicro') sourceDisplayName = 'SICRO'
      else if (item.fonte_codigo === 'conab' || item.fonte_codigo === 'ceasa')
        sourceDisplayName = 'CONAB'
      else if (item.fonte_codigo === 'seinfra_ce') sourceDisplayName = 'SEINFRA/CE'
      else if (item.fonte_codigo === 'setop_mg') sourceDisplayName = 'SETOP/MG'

      const timestamp = item.data_publicacao
        ? `${item.data_publicacao}T12:00:00Z`
        : new Date().toISOString()

      return {
        id: `ref_${item.id}_${budgetItemId}`,
        budget_item_id: budgetItemId,
        source: sourceDisplayName,
        source_record_id: item.codigo_registro || 'NÃO INFORMADO',
        source_url: item.url_oficial,
        source_date: timestamp,
        government_entity: item.is_regulatorio
          ? 'ANVISA / Câmara de Regulação do Mercado de Medicamentos'
          : item.laboratorio_fabricante || 'NÃO INFORMADO',
        supplier: item.laboratorio_fabricante || 'NÃO INFORMADO',
        supplier_document: item.cnpj_fabricante || 'NÃO INFORMADO',
        description_original: item.descricao_original,
        description_normalized: item.descricao_original.toUpperCase(),
        unit: item.unidade || 'UN',
        quantity: item.quantidade || 1,
        unit_price: item.preco_unitario,
        similarity_score: 95,
        status: 'encontrado',
        raw_data: {
          is_real_api: true,
          is_referencial: true,
          is_regulatorio: item.is_regulatorio,
          origem_badge: item.origem_badge,
          tipo_referencial: item.tipo_referencial,
          edicao_referencia: item.edicao_referencia,
          detalhes_precos: item.detalhes_precos,
          hash: item.hash,
          uf: item.uf,
        },
        created: timestamp,
        updated: timestamp,
      }
    })
  }
}
