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
import { obterCodigosCatmatDoTermo, codigoCorrespondeAoTermo } from '../catalogoOficialCanonico'

export class PncpConnectorAdapter extends BasePriceConnectorAdapter {
  public readonly id = 'pncp'
  public readonly nome = 'PNCP (Portal Nacional de Contratações Públicas)'

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
      Number(rawItem.valorUnitarioHomologado) ||
      Number(rawItem.valor_unitario_homologado) ||
      Number(rawItem.valorUnitarioEstimado) ||
      Number(rawItem.valor_unitario_estimado) ||
      Number(rawItem.valorUnitario) ||
      Number(rawItem.valor_unitario) ||
      Number(rawItem.valor_normalizado) ||
      0

    // REGRA MANDATÓRIA DO PNCP:
    // É expressamente proibido usar valor_global, valor_total da contratação como se fosse preço unitário.
    // A divisão de total por quantidade só é permitida se comprovadamente pertencer ao mesmo subitem e
    // nunca a partir de valor_global ou valor total da contratação inteira.
    if (valorUnitario <= 0) {
      // Tenta apenas valores totais específicos do subitem (NUNCA valor_global ou valor total da contratação)
      const vTotalItem =
        Number(rawItem.valorTotalHomologado) ||
        Number(rawItem.valor_total_homologado) ||
        Number(rawItem.valorTotal) ||
        Number(rawItem.valor_total) ||
        0

      // Permite total ÷ quantidade apenas quando ambos os campos comprovadamente pertencem ao mesmo subitem
      const isContratacaoSemItem =
        Boolean(rawItem._is_contratacao_sem_item) || Boolean(rawItem._detalhamento_pendente)
      const temIdentificadorSubitem =
        rawItem.numeroItem !== undefined ||
        rawItem.numero_item !== undefined ||
        Boolean(rawItem.item_externo)
      if (!isContratacaoSemItem && temIdentificadorSubitem && vTotalItem > 0 && quantidade > 0) {
        const calculado = vTotalItem / quantidade
        if (!isNaN(calculado) && calculado > 0) {
          valorUnitario = Number(calculado.toFixed(4))
        }
      }
    }

    // Identifica se a natureza do preço é homologada/contratada ou estimada
    const temHomologado =
      (Number(rawItem.valorUnitarioHomologado) ||
        Number(rawItem.valor_unitario_homologado) ||
        Number(rawItem.valorTotalHomologado) ||
        Number(rawItem.valor_total_homologado) ||
        0) > 0

    const naturezaPreco: 'contratado' | 'estimado' = temHomologado ? 'contratado' : 'estimado'

    // Diretriz: "O preço unitário de todos os itens tem que aparecer. Se não houver preços, não deve constar."
    // Amostras com preço unitário apurado <= 0, NaN ou nulo são descartadas sumariamente.
    // Preserva preços decimais em centavos (> 0 e < 1.00) mantendo precisão de 4 casas decimais sem arredondar para zero.
    if (isNaN(valorUnitario) || valorUnitario <= 0) {
      console.info('[PncpConnectorAdapter] Amostra descartada: sem preço unitário apurado', {
        id_externo:
          rawItem.id_externo || rawItem.numeroControlePNCP || rawItem.numero_controle_pncp,
        item: rawItem.item_externo || rawItem.descricao || rawItem.descricaoItem,
        motivo: 'sem preço unitário válido',
      })
      return null
    }

    // Normalização sem arredondar valores pequenos para zero, garantindo precisão de 4 decimais
    const valorEfetivo = Number(valorUnitario.toFixed(4))
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

    // Extração da unidade de fornecimento real da fonte (campo unidadeMedida/sigla e descrição)
    // Se a descrição indicar embalagem coletiva (caixa com N, frasco, envelope, etc.), preservar
    // a unidade qualificada da fonte (ex.: "CX 250 UN", "CX", "FR") sem fallback cego para "UN"
    // e sem inventar divisão de preço por quantidade inferida.
    const extrairUnidadeQualificada = (uBruta?: string, dBruta?: string): string => {
      const u = (uBruta || '').trim().toUpperCase()
      const d = (dBruta || '').trim().toUpperCase()

      // Padrões de embalagem coletiva na descrição do item ou na própria unidade
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

      // Se a unidade informada já indica coletiva ou formato específico
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

    const unidade = extrairUnidadeQualificada(rawItem.unidade || rawItem.unidadeMedida, descricao)
    const dataContrato =
      rawItem.data_contratacao ||
      rawItem.dataPublicacaoPncp ||
      rawItem.dataAssinatura ||
      rawItem.dataPublicacao ||
      rawItem.data_publicacao ||
      undefined

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

    const detalhamentoPendente = Boolean(rawItem._detalhamento_pendente)

    return {
      id: `PNCP-${idExterno}-${index}-${valorEfetivo.toFixed(4).replace('.', '_')}`,
      fonte: 'PNCP',
      fonteNomeExibicao: 'PNCP (Portal Nacional de Contratações Públicas)',
      idExterno,
      urlOriginal:
        rawItem.url ||
        rawItem.itemUrl ||
        (idExterno ? `https://pncp.gov.br/app/editais/${idExterno}` : ''),
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
      valorTotal: valorEfetivo * quantidade,
      modalidadeLicitacao: rawItem.modalidade_licitacao || 'Pregão Eletrônico',
      numeroProcessoOuContrato: rawItem.processo_origem || idExterno,
      marca: rawItem.marca_modelo || rawItem.marcaNome || 'NÃO INFORMADO',
      codigoCatalogo: rawItem.codigo_catalogo || 'CATMAT',
      hashRastreabilidade: hash,
      scoreSimilaridade: rawItem.similarity_score || 95,
      natureza: naturezaPreco,
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
        nao_informado: false,
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

      // Se há códigos CATMAT canônicos associados (ex.: 462776 para picolé), informa o backend
      const codigosCatmat =
        params.catmatOuCodigo ||
        (obterCodigosCatmatDoTermo(params.termo).length > 0
          ? obterCodigosCatmatDoTermo(params.termo).join(',')
          : undefined)
      if (codigosCatmat) {
        queryParams.set('catmat', codigosCatmat)
      }

      // Enviamos max_detalhar para permitir que o backend detalhe os itens das contratações
      // Em requisições de página rápida, limita para 2 para não bloquear o cliente HTTP
      const maxDetalharParam = params.maxDetalhar ?? params.maxDetalharAoVivo ?? 2
      queryParams.set('max_detalhar', String(maxDetalharParam))
      const endpoint = baseUrl
        ? `${baseUrl}/backend/v1/pncp/search?${queryParams.toString()}`
        : `/backend/v1/pncp/search?${queryParams.toString()}`

      const authToken = pb.authStore?.token || ''
      const controller = new AbortController()
      let timedOut = false
      const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.timeoutPorPaginaMs)

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
          try {
            const errData = await response.json()
            erroMsg = errData.message || errData.error || erroMsg
          } catch {
            /* intentionally ignored */
          } finally {
            clearTimeout(timeoutId)
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
              const subQtd = Number(sub.quantidade) || 1
              // Cascata de extração: (a) homologado subitem; (b) estimado subitem; (c) unitário explícito do subitem
              // PROIBIDO usar valor_global ou valor total da contratação como preço unitário do item
              let subValor =
                Number(sub.valorUnitarioHomologado) ||
                Number(sub.valor_unitario_homologado) ||
                Number(sub.valorUnitarioEstimado) ||
                Number(sub.valor_unitario_estimado) ||
                Number(sub.valorUnitario) ||
                Number(sub.valor_unitario) ||
                Number(sub.valor_normalizado) ||
                0

              if (subValor <= 0) {
                // Divisão APENAS pelo total do próprio subitem — JAMAIS pelo valor_global da contratação
                const subTotal =
                  Number(sub.valorTotalHomologado) ||
                  Number(sub.valor_total_homologado) ||
                  Number(sub.valorTotal) ||
                  Number(sub.valor_total) ||
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
                  sub.valorUnitarioHomologado ??
                  sub.valor_unitario_homologado ??
                  entry.valorUnitarioHomologado ??
                  entry.valor_unitario_homologado,
                valorTotalHomologado:
                  sub.valorTotalHomologado ??
                  sub.valor_total_homologado ??
                  entry.valorTotalHomologado ??
                  entry.valor_total_homologado,
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
              if (norm) {
                // Não descarta automaticamente: todas as amostras com preço unitário são preservadas
                // Diferenças e categorias de risco são sinalizadas para juízo crítico humano
                amostras.push(norm)
              }
            }
          } else {
            // Se não veio itensAta, só aceita a amostra se entry tiver preço unitário real do item
            // (e NUNCA aceita contratação global sem detalhamento com preço sintético)
            if (!entry._detalhamento_pendente) {
              const norm = this.normalize(entry, i)
              if (norm) {
                amostras.push(norm)
              }
            }
          }
        }

        // Ordenação estrita crescente pelo menor preço unitário numérico
        amostras.sort((a, b) => a.valorUnitario - b.valorUnitario)

        // Persistência assíncrona idempotente no índice local de pesquisa (bloqueada se signal foi cancelado)
        if (amostras.length > 0 && !params.signal?.aborted) {
          PriceIndexService.persistirAmostras(amostras).catch((pErr) => {
            console.warn('[PncpConnectorAdapter] Falha ao persistir amostras no índice:', pErr)
          })
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
        if (params.signal?.aborted) {
          throw new DOMException('Busca cancelada pelo usuário.', 'AbortError')
        }
        const isTimeout = timedOut || (err?.name === 'AbortError' && !params.signal?.aborted)
        const errMsg = err?.message || ''
        const isNetworkError =
          isTimeout ||
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
          statusHttp: isTimeout ? 408 : 500,
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
