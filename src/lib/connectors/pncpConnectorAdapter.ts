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

export class PncpConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'pncp'
  public readonly nome = 'PNCP (Portal Nacional de Contratações Públicas)'

  constructor() {
    super()
    this.versaoConector = '2.2.0'
    this.maxRetries = 2
    this.retryDelayBaseMs = 400
    // CORREÇÃO 1 (v0.0.77): Ampliar timeout do proxy do PNCP de 12s para ~30s SOMENTE para esta fonte
    this.timeoutPorPaginaMs = 30000
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

    // CASCATA DE EXTRAÇÃO DE PREÇOS DO PNCP (FASE C):
    // 1. valorUnitarioHomologado do subitem
    // 2. valorUnitarioEstimado do subitem
    // 3. Campos camelCase e snake_case do CABEÇALHO (valorUnitarioHomologado, valorTotalHomologado, valorUnitario, valorTotal)
    // 4. valor total ÷ quantidade APENAS quando plausível
    const quantidade = Number(rawItem.quantidade) || 1

    let valorUnitario =
      Number(rawItem.valor_normalizado) ||
      Number(rawItem.valorUnitarioHomologado) ||
      Number(rawItem.valorUnitarioEstimado) ||
      Number(rawItem.valorUnitario) ||
      Number(rawItem.valor_unitario) ||
      0

    // Cascata 4: se ainda zero, tenta valor total ÷ quantidade quando quantidade > 0
    if (valorUnitario <= 0) {
      const vTotal =
        Number(rawItem.valorTotalHomologado) ||
        Number(rawItem.valorTotal) ||
        Number(rawItem.valor_total_homologado) ||
        Number(rawItem.valor_total_estimado) ||
        Number(rawItem.valor_total) ||
        Number(rawItem.valor_global) ||
        0

      if (vTotal > 0 && quantidade > 0) {
        const calculado = vTotal / quantidade
        if (!isNaN(calculado) && calculado > 0) {
          valorUnitario = calculado
        }
      }
    }

    const isNaoInformado = isNaN(valorUnitario) || valorUnitario <= 0
    const valorEfetivo = isNaoInformado ? 0 : valorUnitario

    const orgaoNome =
      rawItem.orgao_comprador ||
      rawItem.orgaoEntidade?.razaoSocial ||
      rawItem.orgao_nome ||
      'Órgão Público PNCP'

    const orgaoCnpj =
      rawItem.orgao_cnpj || rawItem.orgaoEntidade?.cnpj || rawItem.cnpj || 'NÃO INFORMADO'

    const idExterno =
      rawItem.id_externo ||
      rawItem.numeroControlePNCP ||
      rawItem.numero_controle_pncp ||
      `PNCP-${index}`

    const descricao =
      rawItem.item_externo ||
      rawItem.descricao ||
      rawItem.descricaoItem ||
      rawItem.objeto ||
      'Item PNCP'

    const unidade = (rawItem.unidade || rawItem.unidadeMedida || 'UN').trim().toUpperCase()
    const dataContrato =
      rawItem.data_contratacao ||
      rawItem.dataPublicacaoPncp ||
      rawItem.dataAssinatura ||
      new Date().toISOString()

    const fornecedorNome =
      rawItem.fornecedor ||
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

    const detalhamentoPendente = Boolean(rawItem._detalhamento_pendente || isNaoInformado)

    return {
      id: `PNCP-${idExterno}-${index}-${valorEfetivo.toFixed(4).replace('.', '_')}`,
      fonte: 'PNCP',
      fonteNomeExibicao: 'PNCP (Portal Nacional de Contratações Públicas)',
      idExterno,
      urlOriginal: rawItem.url || rawItem.itemUrl || `https://pncp.gov.br/app/editais/${idExterno}`,
      dataPublicacaoOuContrato: dataContrato,
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
      valorTotal: valorEfetivo * quantidade,
      modalidadeLicitacao: rawItem.modalidade_licitacao || 'Pregão Eletrônico',
      numeroProcessoOuContrato: rawItem.processo_origem || idExterno,
      marca: rawItem.marca_modelo || rawItem.marcaNome || 'NÃO INFORMADO',
      codigoCatalogo: rawItem.codigo_catalogo || 'CATMAT',
      hashRastreabilidade: hash,
      scoreSimilaridade: rawItem.similarity_score || 95,
      natureza: 'contratado',
      isDemo: false,
      detalhesAdicionais: {
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
        nao_informado: isNaoInformado,
      },
    }
  }

  public async fetchPage(
    params: ConnectorSearchParams,
    pagina: number,
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
      if (params.uf) queryParams.set('uf', params.uf)

      const endpoint = baseUrl
        ? `${baseUrl}/backend/v1/pncp/search?${queryParams.toString()}`
        : `/backend/v1/pncp/search?${queryParams.toString()}`

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
          let erroMsg = `Erro HTTP ${status} retornado pelo proxy PNCP`
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
              const subQtd = Number(sub.quantidade) || 1
              // Cascata de extração: (a) homologado subitem; (b) cabeçalho camelCase/variantes; (c) total ÷ qtd (> 0)
              let subValor =
                Number(sub.valorUnitarioHomologado) ||
                Number(sub.valorUnitarioEstimado) ||
                Number(sub.valorUnitario) ||
                Number(entry.valorUnitarioHomologado) ||
                Number(entry.valorUnitarioEstimado) ||
                Number(entry.valorUnitario) ||
                Number(entry.valor_unitario) ||
                Number(entry.valor_normalizado) ||
                0

              if (subValor <= 0) {
                const subTotal =
                  Number(sub.valorTotalHomologado) ||
                  Number(sub.valorTotal) ||
                  Number(entry.valorTotalHomologado) ||
                  Number(entry.valorTotal) ||
                  Number(entry.valor_total_homologado) ||
                  Number(entry.valor_total_estimado) ||
                  Number(entry.valor_total) ||
                  Number(entry.valor_global) ||
                  0
                if (subTotal > 0 && subQtd > 0) {
                  const calcSub = subTotal / subQtd
                  if (!isNaN(calcSub) && calcSub > 0) subValor = calcSub
                }
              }

              const subMapeado = {
                ...entry,
                ...sub,
                valorUnitarioHomologado:
                  sub.valorUnitarioHomologado ?? entry.valorUnitarioHomologado,
                valorTotalHomologado: sub.valorTotalHomologado ?? entry.valorTotalHomologado,
                id_externo: entry.numeroControlePNCP || entry.numero_controle_pncp || entry.id,
                item_externo: sub.descricao || sub.materialOuServicoNome,
                valor_normalizado: subValor,
                unidade: sub.unidadeMedida || 'UN',
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
              const norm = this.normalize(subMapeado, i * 100 + j)
              if (norm) amostras.push(norm)
            }
          } else {
            const norm = this.normalize(entry, i)
            if (norm) amostras.push(norm)
          }
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
            itens_fila_pendente: filaPendente,
            detalhamento_paralelo: detalhamento,
            diagnostico_fluxo: data.diagnostico_fluxo,
          },
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
            ? `Timeout de ${this.timeoutPorPaginaMs}ms excedido na consulta ao PNCP`
            : err?.message || 'Falha de conexão com PNCP',
        }
      }
    })
  }
}
