/**
 * Referenciais Connector Adapter
 * Implementa o contrato IPriceConnectorAdapter para as bases públicas referenciais oficiais:
 * CMED (Anvisa/medicamentos), SINAPI (CEF/obras), SICRO (DNIT/infraestrutura),
 * CONAB/CEASA (agricultura/alimentação), SEINFRA/CE e SETOP/MG.
 */

import { BasePriceConnectorAdapter } from './baseConnectorAdapter'
import { SourceMetadata, ConnectorSearchParams, ConnectorPageResult, AmostraPreco } from './types'
import { ReferenciaisService, ReferencialItemResult } from '../referenciaisService'

export class ReferenciaisConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'referenciais'
  public readonly nome = 'Tabelas e Painéis Referenciais Oficiais (CMED, SINAPI, SICRO, CONAB)'

  constructor() {
    super()
    this.versaoConector = '1.5.0'
    this.maxRetries = 1
  }

  public getSourceMetadata(): SourceMetadata {
    return {
      id: this.id,
      nome: this.nome,
      sigla: 'TABELAS_OFICIAIS',
      tipo: 'TABELA_REFERENCIAL',
      status: 'ATIVA',
      descricao:
        'Sistemas referenciais oficiais de preços previstos em lei: CMED (Preço Máximo ao Consumidor Anvisa), SINAPI (Caixa/IBGE), SICRO (DNIT), CONAB (Hortifrúti/Alimentos), SEINFRA e SETOP.',
      urlPortal: 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos',
      suportaPaginacaoCompleta: true,
      maxTamanhoPaginaPermitido: 100,
      rateLimitRequisicoesPorSegundo: 10,
      concorrenciaMaximaRecomendada: 5,
      requerCredencial: false,
      credencialConfigurada: true,
      isDemo: false,
    }
  }

  public normalize(
    rawItem: ReferencialItemResult,
    index: number,
    metadata?: any,
  ): AmostraPreco | null {
    if (!rawItem) return null

    const valorUnitario = Number(rawItem.preco_unitario) || 0
    if (isNaN(valorUnitario) || valorUnitario <= 0) {
      console.info('[ReferenciaisConnectorAdapter] Amostra descartada: sem preço unitário', {
        id: rawItem.id,
        item: rawItem.descricao_original,
        motivo: 'sem preço unitário',
      })
      return null
    }

    const id = rawItem.id || `REF-${index}`
    const descricao = rawItem.descricao_original || 'Item Referencial'
    const unidade = (rawItem.unidade || 'UN').trim().toUpperCase()
    const dataRef = rawItem.data_publicacao || new Date().toISOString()
    const orgaoNome = rawItem.is_regulatorio
      ? 'ANVISA / Câmara de Regulação do Mercado de Medicamentos'
      : rawItem.fonte_nome || 'Governo Federal / Órgão Gestor da Tabela'

    return {
      id: `REF-${id}-${index}-${valorUnitario.toFixed(4).replace('.', '_')}`,
      fonte: rawItem.fonte_nome || 'Referencial',
      fonteNomeExibicao: `${rawItem.fonte_nome || 'Referencial'} (Tabela Oficial)`,
      idExterno: rawItem.codigo_registro || String(id),
      urlOriginal: rawItem.url_oficial || 'https://www.gov.br/anvisa',
      dataPublicacaoOuContrato: dataRef,
      produto: descricao.trim().toUpperCase(),
      descricaoCompleta: descricao.trim().toUpperCase(),
      descricaoNormalizada: descricao.trim().toUpperCase(),
      orgaoComprador: orgaoNome,
      orgaoCnpj: 'NÃO INFORMADO',
      uf: rawItem.uf || 'BR',
      fornecedorNome: rawItem.laboratorio_fabricante || 'Tabela Oficial Referencial',
      fornecedorCnpjOuCpf: rawItem.cnpj_fabricante || 'NÃO INFORMADO',
      fornecedorPorte: 'DEMAIS',
      unidade,
      quantidade: 1,
      valorUnitario,
      valorTotal: valorUnitario,
      modalidadeLicitacao: 'Tabela Referencial Oficial',
      numeroProcessoOuContrato: rawItem.codigo_registro || String(id),
      marca: 'NÃO INFORMADO',
      fabricante: rawItem.laboratorio_fabricante || 'NÃO INFORMADO',
      codigoCatalogo: rawItem.codigo_registro || 'REFERENCIAL',
      hashRastreabilidade: rawItem.hash || `hash_ref_${id}`,
      scoreSimilaridade: 95,
      natureza: 'referencial',
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
        const res = await ReferenciaisService.consultarReferenciais({
          termo: params.termo,
          fonte: 'todas',
          uf: params.uf,
        })

        if (!res.sucesso) {
          return {
            sucesso: false,
            amostras: [],
            pagination: {
              paginaAtual: 1,
              tamanhoPagina: 100,
              totalRegistrosInformadoApi: 0,
              totalPaginasInformadoApi: 0,
              temMaisPaginas: false,
            },
            tempoMs: Math.round(performance.now() - t0),
            statusHttp: 500,
            isIndisponivel: true,
            erro: res.erro || 'Falha ao consultar tabelas referenciais',
          }
        }

        const amostras: AmostraPreco[] = []
        for (let i = 0; i < res.registros.length; i++) {
          const norm = this.normalize(res.registros[i], i)
          if (norm) amostras.push(norm)
        }

        return {
          sucesso: true,
          amostras,
          pagination: {
            paginaAtual: 1,
            tamanhoPagina: amostras.length || 10,
            totalRegistrosInformadoApi: res.totalEncontrados || amostras.length,
            totalPaginasInformadoApi: 1,
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
            paginaAtual: 1,
            tamanhoPagina: 10,
            totalRegistrosInformadoApi: 0,
            totalPaginasInformadoApi: 0,
            temMaisPaginas: false,
          },
          tempoMs: Math.round(performance.now() - t0),
          statusHttp: 500,
          isIndisponivel: true,
          erro: err?.message || 'Falha na consulta às tabelas referenciais',
        }
      }
    })
  }
}
