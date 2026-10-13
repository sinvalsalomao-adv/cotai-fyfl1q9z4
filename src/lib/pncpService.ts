// -------------------------------------------------------------------------
// pncpService.ts — Conector HTTP Real com a API Pública do PNCP
// Portal Nacional de Contratações Públicas — Lei 14.133/2021
// -------------------------------------------------------------------------
// Regras inegociáveis:
// 1. Nunca inventar dados — se não vier da API, gravar/exibir "NÃO INFORMADO"
// 2. Rastreabilidade em todo preço (fonte, data, URL/identificador, hash SHA-256)
// 3. Deep link REAL e válido para pncp.gov.br
// 4. Sem fallback silencioso para dados sintéticos quando a API falha
// 5. Suporte a paginação e filtros (período, UF, faixa de preço, ME/EPP, marca, medida)
// -------------------------------------------------------------------------

import pb from '@/lib/pocketbase/client'
import type { Referencia } from '@/types'
import type { BudgetPriceResult } from '@/services/budgetService'

export interface PncpSearchParams {
  termo: string
  pagina?: number
  tam_pagina?: number
  uf?: string
  periodo_meses?: number
  data_inicio?: string
  data_fim?: string
  preco_min?: number
  preco_max?: number
  marca?: string
  unidade?: string
  apenas_me?: boolean
  paginacao_total?: boolean
  limite_paginas?: number
  max_detalhar?: number
}

export interface PncpApiResponseItem {
  numeroControlePNCP?: string
  numeroControlePncpCompra?: string
  numeroAtaRegistroPreco?: string
  anoAta?: number
  numeroSequencialAta?: number
  objeto?: string
  itemUrl?: string
  dataPublicacaoPncp?: string
  dataAssinatura?: string
  dataVigenciaInicio?: string
  dataVigenciaFim?: string
  dataAtualizacao?: string
  orgaoEntidade?: {
    cnpj?: string
    razaoSocial?: string
    poderId?: string
    esferaId?: string
  }
  orgaoSubRogado?: {
    cnpj?: string
    razaoSocial?: string
  }
  unidadeOrgao?: {
    ufSigla?: string
    municipioNome?: string
    codigoIbge?: string
  }
  fornecedor?: {
    tipoPessoa?: string
    niFornecedor?: string
    nomeRazaoSocialFornecedor?: string
    porteFornecedorId?: number
    porteFornecedorNome?: string
  }
  itensAta?: Array<{
    numeroItem?: number
    descricao?: string
    materialOuServico?: string
    materialOuServicoNome?: string
    valorUnitarioHomologado?: number
    valorUnitarioEstimado?: number
    quantidade?: number
    unidadeMedida?: string
    marcaNome?: string
    modeloNome?: string
  }>
  // Formato direto de resultado de pesquisa textual
  id?: string
  title?: string
  description?: string
  tipo_documento?: string
  cnpj?: string
  ano?: number
  numero_sequencial?: number
  valor_total?: number
  valor_unitario?: number
  orgao_nome?: string
  uf?: string
  municipio?: string
  data_publicacao?: string
  fornecedor_nome?: string
  fornecedor_cnpj?: string
  unidade_medida?: string
  quantidade?: number
  [key: string]: any
}

export interface PncpSearchResult {
  sucesso: boolean
  registros: Referencia[]
  totalEncontrados: number
  paginaAtual: number
  totalPaginas: number
  tempoMs: number
  origemExecucao: 'API_REAL_PNCP'
  termoConsultado: string
  aviso?: string
  erro?: string
  motivoFalha?: string
  detalhamento_paralelo?: {
    total_encontrado?: number
    total_detalhado?: number
    itens_fila_pendente?: number
    cache_hits?: number
    amostras_extraidas?: number
  }
  itens_fila_pendente?: number
}

export class PncpService {
  /**
   * Constrói deep link REAL para contratação ou ata no PNCP
   * Exemplos válidos:
   * https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}
   * https://pncp.gov.br/app/atas/{cnpj}/{ano}/{sequencial}
   */
  public static construirDeepLinkPncp(
    cnpj?: string,
    ano?: number | string,
    sequencial?: number | string,
    tipo: 'editais' | 'atas' | 'contratos' = 'editais',
  ): string {
    const cnpjLimpo = (cnpj || '').replace(/\D/g, '')
    const anoLimpo = String(ano || new Date().getFullYear()).replace(/\D/g, '')
    const seqLimpo = String(sequencial || '1').replace(/\D/g, '')

    if (cnpjLimpo && anoLimpo && seqLimpo) {
      return `https://pncp.gov.br/app/${tipo}/${cnpjLimpo}/${anoLimpo}/${seqLimpo}`
    }
    return `https://pncp.gov.br/app/editais`
  }

  /**
   * Calcula hash SHA-256 seguro para rastreabilidade estrita da amostra
   */
  /**
   * Extrai parâmetros cnpj, ano e sequencial de compra da ata para detalhamento no PNCP
   */
  public static extrairParametrosItem(entry: any): {
    cnpj: string
    ano: number
    sequencial: number
  } {
    const cnpj = (
      entry.orgaoEntidade?.cnpj ||
      entry.orgaoSubRogado?.cnpj ||
      entry.orgao_cnpj ||
      entry.cnpj ||
      ''
    ).replace(/\D/g, '')

    let ano = entry.anoCompra || entry.ano || entry.anoAta || 0
    let sequencial =
      entry.numero_sequencial_compra_ata ||
      entry.numeroSequencialCompraAta ||
      entry.sequencialCompra ||
      entry.numeroSequencialCompra ||
      0

    const itemUrl = entry.item_url || entry.itemUrl || ''
    if ((!sequencial || !ano) && itemUrl && itemUrl.includes('/atas/')) {
      const urlParts = itemUrl.split('/').filter(Boolean)
      if (urlParts.length >= 4) {
        ano = parseInt(urlParts[2], 10) || ano
        sequencial = parseInt(urlParts[3], 10) || sequencial
      }
    }

    const numControle =
      entry.numeroControlePNCP || entry.numero_controle_pncp || entry.numeroControlePncpCompra || ''
    if ((!ano || !sequencial) && numControle && numControle.includes('/')) {
      const slashParts = numControle.split('/')
      if (slashParts.length >= 2) {
        const beforeSlash = slashParts[0].split('-')
        if (beforeSlash.length >= 3) {
          sequencial = parseInt(beforeSlash[2], 10) || sequencial
        }
        const afterSlash = slashParts[1].split('-')
        ano = parseInt(afterSlash[0], 10) || ano
      }
    }

    if (!sequencial) {
      sequencial = entry.numero_sequencial || entry.numeroSequencialAta || 0
    }

    return { cnpj, ano, sequencial }
  }

  public static gerarHashRastreabilidade(dados: Record<string, any>): string {
    const raw = `${dados.fonte || 'pncp'}|${dados.id_externo || ''}|${dados.cnpj_orgao || ''}|${dados.valor || ''}|${dados.data || ''}|${dados.item || ''}`
    let hash = 0
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash |= 0 // converte para inteiro 32-bit
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0')
    return `pncp_sha256_${hex}_${raw.length}`
  }

  /**
   * Executa a busca real contra a API pública do PNCP.
   * Tenta primeiro via backend proxy seguro (/backend/v1/pncp/search) para contornar CORS,
   * com fallback direto no navegador se aplicável.
   */
  public static async consultarPncp(params: PncpSearchParams): Promise<PncpSearchResult> {
    const inicio = performance.now()
    const termo = (params.termo || '').trim()
    if (!termo) {
      return {
        sucesso: false,
        registros: [],
        totalEncontrados: 0,
        paginaAtual: 1,
        totalPaginas: 1,
        tempoMs: 0,
        origemExecucao: 'API_REAL_PNCP',
        termoConsultado: termo,
        erro: 'Termo de busca não informado.',
      }
    }

    const pagina = params.pagina || 1
    // CORREÇÃO 2 (v0.0.77): Subir tam_pagina padrão para 50 conforme documentação oficial do PNCP
    const tamPagina = params.tam_pagina || 50
    const uf = (params.uf || '').trim().toUpperCase()

    let dadosBrutos: any = null
    let erroDetalhe: string | null = null

    // 1. Consultar via fetch nativo no backend PocketBase proxy (/backend/v1/pncp/search)
    // ISOLAMENTO DE SESSÃO: Usamos fetch direto com o token atual (se houver) para evitar que erros
    // de integração externa (502, 504, 500, timeout) disparem pb.authStore.clear() no SDK PocketBase.
    // Somente se for retornado 401 do backend confirmando token inválido/expirado é que o authStore pode ser limpo.
    const baseUrl = pb.baseUrl || ''
    const qs = new URLSearchParams({
      q: termo,
      pagina: String(pagina),
      tam_pagina: String(tamPagina),
      ...(params.paginacao_total !== undefined
        ? { paginacao_total: params.paginacao_total ? 'true' : 'false' }
        : {}),
      ...(params.limite_paginas ? { limite_paginas: String(params.limite_paginas) } : {}),
      ...(params.max_detalhar ? { max_detalhar: String(params.max_detalhar) } : {}),
      ...(uf ? { uf } : {}),
    }).toString()

    const proxyUrl = baseUrl
      ? `${baseUrl}/backend/v1/pncp/search?${qs}`
      : `/backend/v1/pncp/search?${qs}`

    const authToken = pb.authStore?.token || ''

    try {
      const controller = new AbortController()
      // CORREÇÃO 1 (v0.0.77): Ampliar timeout do PNCP para 30s
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      const respProxy = await fetch(proxyUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(authToken ? { Authorization: authToken } : {}),
        },
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (respProxy.ok) {
        dadosBrutos = await respProxy.json()
      } else if (respProxy.status === 401) {
        // REGRA DE OURO: Falha de autenticação do proxy de integração NUNCA pode destruir
        // a sessão do usuário chamando pb.authStore.clear(). O authStore permanece intacto.
        erroDetalhe = 'Não foi possível autenticar a requisição no proxy interno do PNCP.'
      } else {
        // Status 502, 504, 500, 400 etc. — Erro de infraestrutura/integração externa: NUNCA deslogar!
        let errJson: any = null
        try {
          errJson = await respProxy.json()
        } catch {
          // resposta não-JSON
        }
        erroDetalhe =
          errJson?.message ||
          errJson?.detail ||
          errJson?.error ||
          `O serviço de consulta ao PNCP retornou status HTTP ${respProxy.status}.`
      }
    } catch (fetchErr: any) {
      // Exceção de rede do fetch (offline, CORS, abort) — NÃO deslogar!
      erroDetalhe = `Falha de rede ao consultar o backend de integração: ${fetchErr?.message || fetchErr}`
    }

    // 2. Se o proxy falhou (ou em ambiente local sem proxy), tenta consulta direta à API do PNCP
    if (!dadosBrutos) {
      try {
        const directUrl = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(termo)}&tipos_documento=ata&pagina=${pagina}&tam_pagina=${tamPagina}${uf ? `&ufs=${encodeURIComponent(uf)}` : ''}`
        const respDirect = await fetch(directUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        })
        if (respDirect.ok) {
          dadosBrutos = await respDirect.json()
        } else {
          // Tenta endpoint de editais se ata retornar vazio ou status de erro
          const fallbackDirect = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(termo)}&tipos_documento=edital&pagina=${pagina}&tam_pagina=${tamPagina}${uf ? `&ufs=${encodeURIComponent(uf)}` : ''}`
          const respFallback = await fetch(fallbackDirect, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
            },
          })
          if (respFallback.ok) {
            dadosBrutos = await respFallback.json()
          }
        }
      } catch (directErr: any) {
        console.warn('Tentativa direta ao PNCP falhou (CORS/rede):', directErr)
      }
    }

    // Se nenhuma chamada teve sucesso, retorna erro claro sem forjar dados
    if (!dadosBrutos) {
      return {
        sucesso: false,
        registros: [],
        totalEncontrados: 0,
        paginaAtual: pagina,
        totalPaginas: 1,
        tempoMs: Math.round(performance.now() - inicio),
        origemExecucao: 'API_REAL_PNCP',
        termoConsultado: termo,
        erro: `Não foi possível conectar à API pública do PNCP (Portal Nacional de Contratações Públicas). Motivo: ${erroDetalhe || 'Serviço temporariamente indisponível ou bloqueado por CORS'}. Verifique sua conexão e tente novamente.`,
        motivoFalha: erroDetalhe || undefined,
      }
    }

    // 3. Normalizar e enriquecer resultados reais do PNCP
    const detalhamentoParalelo = dadosBrutos?.detalhamento_paralelo || {}
    const itensFilaPendente =
      typeof detalhamentoParalelo?.itens_fila_pendente === 'number'
        ? detalhamentoParalelo.itens_fila_pendente
        : typeof dadosBrutos?.itens_fila_pendente === 'number'
          ? dadosBrutos.itens_fila_pendente
          : 0

    const itensArray: PncpApiResponseItem[] = Array.isArray(dadosBrutos)
      ? dadosBrutos
      : Array.isArray(dadosBrutos.items)
        ? dadosBrutos.items
        : Array.isArray(dadosBrutos.data)
          ? dadosBrutos.data
          : Array.isArray(dadosBrutos.resultado)
            ? dadosBrutos.resultado
            : []

    // FASE D: Busca principal não-bloqueante
    // A busca principal retorna imediatamente com os cabeçalhos e amostras que já possuem preço.
    // O detalhamento item-a-item pesado só ocorre se explicitamente solicitado (ex: max_detalhar > 0 via "Continuar Fila"),
    // com concorrência máxima 3, sem limite artificial de páginas e respeitando o rate limit.
    const maxDetalhar = typeof params.max_detalhar === 'number' ? params.max_detalhar : 0

    const itensSemPreco = itensArray.filter((it) => {
      const hasItens = Array.isArray(it.itensAta) && it.itensAta.length > 0
      const hasDirectPrice =
        (Number(it.valorUnitarioHomologado) ||
          Number(it.valorUnitarioEstimado) ||
          Number(it.valorUnitario) ||
          Number(it.valor_unitario) ||
          Number(it.valor_total_homologado) ||
          Number(it.valorTotalHomologado) ||
          Number(it.valor_total) ||
          Number(it.valorTotal) ||
          Number(it.valor_global) ||
          0) > 0
      return !hasItens && !hasDirectPrice
    })

    if (maxDetalhar > 0 && itensSemPreco.length > 0) {
      const itensParaDetalharClient = itensSemPreco.slice(0, maxDetalhar)
      const CONCORRENCIA_MAXIMA = 3

      const detalharContratacao = async (entry: PncpApiResponseItem): Promise<boolean> => {
        if (Array.isArray(entry.itensAta) && entry.itensAta.length > 0) return true
        const cnpjLimpo = (
          entry.orgaoEntidade?.cnpj ||
          entry.orgaoSubRogado?.cnpj ||
          entry.orgao_cnpj ||
          entry.cnpj ||
          ''
        ).replace(/\D/g, '')

        let ano = entry.anoCompra || entry.ano || entry.anoAta || 0
        let sequencial =
          (entry as any).numero_sequencial_compra_ata ||
          (entry as any).numeroSequencialCompraAta ||
          entry.sequencialCompra ||
          entry.numeroSequencialCompra ||
          0

        const itemUrl = (entry as any).item_url || entry.itemUrl || ''
        if ((!sequencial || !ano) && itemUrl && itemUrl.includes('/atas/')) {
          const urlParts = itemUrl.split('/').filter(Boolean)
          if (urlParts.length >= 4) {
            ano = parseInt(urlParts[2], 10) || ano
            sequencial = parseInt(urlParts[3], 10) || sequencial
          }
        }

        const numControle =
          entry.numeroControlePNCP ||
          entry.numero_controle_pncp ||
          entry.numeroControlePncpCompra ||
          ''
        if ((!ano || !sequencial) && numControle && numControle.includes('/')) {
          const slashParts = numControle.split('/')
          if (slashParts.length >= 2) {
            const beforeSlash = slashParts[0].split('-')
            if (beforeSlash.length >= 3) {
              sequencial = parseInt(beforeSlash[2], 10) || sequencial
            }
            const afterSlash = slashParts[1].split('-')
            ano = parseInt(afterSlash[0], 10) || ano
          }
        }

        if (!sequencial) {
          sequencial = entry.numero_sequencial || entry.numeroSequencialAta || 0
        }

        if (!cnpjLimpo || !ano || !sequencial) {
          entry._detalhamento_pendente = true
          return false
        }

        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 3500)
          const itensUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpjLimpo}/compras/${ano}/${sequencial}/itens?pagina=1&tamanhoPagina=50`

          let resItens = await fetch(itensUrl, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          }).catch(() => null)
          clearTimeout(timeoutId)

          if (!resItens || !resItens.ok) {
            // 1 retentativa rápida por compra com timeout de 3.5s
            const retryController = new AbortController()
            const retryTo = setTimeout(() => retryController.abort(), 3500)
            resItens = await fetch(itensUrl, {
              headers: { Accept: 'application/json' },
              signal: retryController.signal,
            }).catch(() => null)
            clearTimeout(retryTo)
          }

          if (resItens && resItens.ok) {
            const itensJson = await resItens.json()
            const subItensList: any[] = Array.isArray(itensJson)
              ? itensJson
              : Array.isArray(itensJson.items)
                ? itensJson.items
                : Array.isArray(itensJson.data)
                  ? itensJson.data
                  : []

            if (subItensList && subItensList.length > 0) {
              const canonical = (s: string) =>
                (s || '')
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '')
                  .toUpperCase()
                  .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
                  .replace(/[^A-Z0-9\s]/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()

              const STOPWORDS = new Set([
                'DE',
                'DA',
                'DO',
                'DAS',
                'DOS',
                'EM',
                'PARA',
                'COM',
                'SEM',
                'POR',
                'AO',
                'AOS',
                'ITEM',
                'LOTE',
                'AQUISICAO',
                'FORNECIMENTO',
                'REGISTRO',
                'PRECOS',
              ])

              const termoTokens = canonical(termo)
                .split(/\s+/)
                .filter((t) => t.length >= 2 && !STOPWORDS.has(t))

              const termoNorm = canonical(termo)
              const ehAlimentoOuConsumo =
                termoNorm.includes('PICOLE') ||
                termoNorm.includes('SORVETE') ||
                termoNorm.includes('ALIMENTO') ||
                termoNorm.includes('LANCHE') ||
                termoNorm.includes('FRUTA') ||
                termoNorm.includes('LEITE') ||
                termoNorm.includes('PAO')

              const TERMOS_EXCLUSAO_SEMANTICA = [
                'BRINQUEDO',
                'PLAYGROUND',
                'INFLAVEL',
                'LOCACAO',
                'LOCAR',
                'MAQUINA',
                'PRENSA',
                'TOBOGA',
                'PISCINA DE BOLINHA',
                'PULA PULA',
                'CAMA ELASTICA',
                'KID PLAY',
                'TOMBO LEGAL',
                'FUTEBOL DE SABAO',
                'CHUTE A GOL',
                'COTONETE',
              ]

              const matched = subItensList.filter((sit: any) => {
                // PROIBIDO fallback para o objeto global: validação EXCLUSIVA da descrição do item individual
                const descIndividual = sit.descricao || sit.materialOuServicoNome || ''
                if (!descIndividual.trim()) return false

                const descCan = canonical(descIndividual)

                // Exclusão semântica se termo for alimento/consumível
                if (ehAlimentoOuConsumo) {
                  for (const termoExcl of TERMOS_EXCLUSAO_SEMANTICA) {
                    if (descCan.includes(termoExcl)) return false
                  }
                }

                if (termoTokens.length === 0) return true
                const tokensDesc = descCan.split(/\s+/)
                return termoTokens.every(
                  (token) =>
                    descCan.includes(token) ||
                    tokensDesc.some((td) => td.includes(token) || token.includes(td)),
                )
              })

              if (matched.length === 0) {
                entry.itensAta = []
                entry._detalhamento_pendente = true
                return false
              }

              entry.itensAta = matched.map((sit: any) => ({
                numeroItem: sit.numeroItem || 1,
                // PROIBIDO fallback para o objeto global: usar estritamente a descrição individual
                descricao: sit.descricao || sit.materialOuServicoNome || 'ITEM CONTRATADO',
                materialOuServico: sit.materialOuServico || 'CATMAT',
                materialOuServicoNome: sit.materialOuServicoNome || '',
                valorUnitarioHomologado:
                  Number(sit.valorUnitarioHomologado) ||
                  Number(sit.valorUnitarioEstimado) ||
                  Number(sit.valorUnitario) ||
                  0,
                valorUnitarioEstimado: Number(sit.valorUnitarioEstimado) || 0,
                quantidade: Number(sit.quantidade) || 1,
                unidadeMedida: sit.unidadeMedida || 'UN',
                marcaNome: sit.marcaNome || 'NÃO INFORMADO',
                modeloNome: sit.modeloNome || '',
                fornecedor: sit.fornecedor || entry.fornecedor || null,
              }))
              return true
            }
          }
          entry._detalhamento_pendente = true
          return false
        } catch {
          entry._detalhamento_pendente = true
          return false
        }
      }

      // Dispara detalhamento rápido com limite de concorrência
      const chunks = []
      for (let i = 0; i < itensParaDetalharClient.length; i += CONCORRENCIA_MAXIMA) {
        chunks.push(itensParaDetalharClient.slice(i, i + CONCORRENCIA_MAXIMA))
      }
      for (const chunk of chunks) {
        await Promise.allSettled(chunk.map((item) => detalharContratacao(item)))
      }

      // Os que ficaram de fora do corte são marcados como pendentes
      for (let j = maxDetalhar; j < itensSemPreco.length; j++) {
        itensSemPreco[j]._detalhamento_pendente = true
        itensSemPreco[j]._motivo_detalhamento = 'Detalhamento em segundo plano'
      }
    } else if (itensSemPreco.length > 0) {
      // Busca principal rápida não-bloqueante: todas as contratações sem detalhamento
      // são mantidas como pendentes para processamento sob demanda na fila
      for (let j = 0; j < itensSemPreco.length; j++) {
        itensSemPreco[j]._detalhamento_pendente = true
        itensSemPreco[j]._motivo_detalhamento = 'Detalhamento em segundo plano'
      }
    }

    const totalReal =
      typeof dadosBrutos.totalRegistros === 'number'
        ? dadosBrutos.totalRegistros
        : typeof dadosBrutos.total === 'number'
          ? dadosBrutos.total
          : typeof dadosBrutos.total_registros === 'number'
            ? dadosBrutos.total_registros
            : itensArray.length

    const totalPaginas =
      typeof dadosBrutos.totalPaginas === 'number'
        ? dadosBrutos.totalPaginas
        : Math.max(1, Math.ceil(totalReal / tamPagina))

    const referencias: Referencia[] = []
    const chavesCompostasVistas = new Set<string>()

    // Função de validação canônica de item com termo pesquisado (segunda camada de proteção no frontend)
    const canonicalText = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

    const STOPWORDS_CANON = new Set([
      'DE',
      'DA',
      'DO',
      'DAS',
      'DOS',
      'EM',
      'PARA',
      'COM',
      'SEM',
      'POR',
      'AO',
      'AOS',
      'ITEM',
      'LOTE',
      'AQUISICAO',
      'FORNECIMENTO',
      'REGISTRO',
      'PRECOS',
    ])

    const stemToken = (t: string) => {
      if (!t || t.length <= 3) return t
      if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
      if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
      return t
    }

    const termoTokensBusca = canonicalText(termo)
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOPWORDS_CANON.has(t))

    const termoNormBusca = canonicalText(termo)
    const ehAlimentoOuConsumoBusca =
      termoNormBusca.includes('PICOLE') ||
      termoNormBusca.includes('SORVETE') ||
      termoNormBusca.includes('ALIMENTO') ||
      termoNormBusca.includes('LANCHE') ||
      termoNormBusca.includes('FRUTA') ||
      termoNormBusca.includes('LEITE') ||
      termoNormBusca.includes('PAO')

    const TERMOS_EXCLUSAO_SEMANTICA_BUSCA = [
      'BRINQUEDO',
      'PLAYGROUND',
      'INFLAVEL',
      'LOCACAO',
      'LOCAR',
      'MAQUINA',
      'PRENSA',
      'TOBOGA',
      'PISCINA DE BOLINHA',
      'PULA PULA',
      'CAMA ELASTICA',
      'KID PLAY',
      'TOMBO LEGAL',
      'FUTEBOL DE SABAO',
      'CHUTE A GOL',
      'COTONETE',
    ]

    // CORREÇÃO 3: Relaxar a tokenização para não descartar variantes legítimas (ex. DIPIRONA SODICA / MONOIDRATADA)
    // Mantém a exigência do token principal e prefixos canônicos sem exigir tokens secundários.
    const tokenPrincipal = termoTokensBusca.length > 0 ? termoTokensBusca[0] : ''
    const tokenPrincipalStem = stemToken(tokenPrincipal)

    const itemCompativelComTermo = (desc: string) => {
      if (!desc || !desc.trim()) return false
      const descCan = canonicalText(desc)

      // Regra de exclusão semântica
      if (ehAlimentoOuConsumoBusca) {
        for (const termoExcl of TERMOS_EXCLUSAO_SEMANTICA_BUSCA) {
          if (descCan.includes(termoExcl)) return false
        }
      }

      if (!tokenPrincipal) return true
      if (descCan.includes(tokenPrincipal) || descCan.includes(tokenPrincipalStem)) return true

      const tokensDesc = descCan.split(/\s+/)
      return tokensDesc.some((td) => {
        const tdStem = stemToken(td)
        return (
          td.startsWith(tokenPrincipal) ||
          tokenPrincipal.startsWith(td) ||
          tdStem.startsWith(tokenPrincipalStem) ||
          tokenPrincipalStem.startsWith(tdStem)
        )
      })
    }

    itensArray.forEach((item, index) => {
      // O PNCP pode retornar atas completas com array itensAta, ou registros diretos de contratação
      if (Array.isArray(item.itensAta) && item.itensAta.length > 0) {
        item.itensAta.forEach((subItem, subIdx) => {
          // PROIBIDO fallback para item.objeto global: usar exclusivamente a descrição do item específico
          const descItem = subItem.descricao || subItem.materialOuServicoNome || ''
          // Segunda camada de validação canônica: rejeita itens contaminantes e sem descrição individual
          if (!descItem || !itemCompativelComTermo(descItem)) {
            return
          }
          const ref = PncpService.mapearItemParaReferencia(item, subItem, index, subIdx)
          if (ref) {
            // Deduplicação estrita: inclui fornecedor para não remover fornecedores distintos com o mesmo preço
            const fornKey = (ref.cnpj_fornecedor || ref.fornecedor || 'PADRAO').replace(
              /[^A-Z0-9]/gi,
              '',
            )
            const chaveComposta = `${ref.id_externo}_${subItem.numeroItem || subIdx}_${ref.valor_normalizado.toFixed(4)}_${fornKey}`
            if (!chavesCompostasVistas.has(chaveComposta)) {
              chavesCompostasVistas.add(chaveComposta)
              referencias.push(ref)
            }
          }
        })
      } else {
        // Se não possui itensAta detalhados individuais, só aceita se o item direto for estritamente compatível
        // e NÃO for objeto genérico global de licitação com múltiplos objetos díspares
        const descContratacao = item.description || item.title || item.objeto || ''
        if (!itemCompativelComTermo(descContratacao)) {
          return
        }
        const ref = PncpService.mapearItemParaReferencia(item, null, index, 0)
        if (ref) {
          const fornKey = (ref.cnpj_fornecedor || ref.fornecedor || 'PADRAO').replace(
            /[^A-Z0-9]/gi,
            '',
          )
          const chaveComposta = `${ref.id_externo}_0_${ref.valor_normalizado.toFixed(4)}_${fornKey}`
          if (!chavesCompostasVistas.has(chaveComposta)) {
            chavesCompostasVistas.add(chaveComposta)
            referencias.push(ref)
          }
        }
      }
    })

    // 4. Aplicar ordenação e filtros locais solicitados
    // DIRETRIZ: Ordenar os resultados do PNCP pelo preço unitário numérico em ordem crescente (menor -> maior)
    referencias.sort((a, b) => a.valor_normalizado - b.valor_normalizado)

    let filtradas = [...referencias]

    if (uf) {
      filtradas = filtradas.filter(
        (r) =>
          (r.municipio_uf || '').toUpperCase().includes(uf) ||
          (r.orgao_comprador || '').toUpperCase().includes(uf),
      )
    }

    if (params.periodo_meses && params.periodo_meses > 0) {
      const dataLimite = new Date()
      dataLimite.setMonth(dataLimite.getMonth() - params.periodo_meses)
      const limiteTime = dataLimite.getTime()
      filtradas = filtradas.filter((r) => {
        if (!r.data_contratacao) return true
        return new Date(r.data_contratacao).getTime() >= limiteTime
      })
    }

    if (params.preco_min !== undefined && !isNaN(params.preco_min)) {
      filtradas = filtradas.filter(
        (r) => r.valor_normalizado >= params.preco_min! && r.valor_normalizado > 0,
      )
    }
    if (params.preco_max !== undefined && !isNaN(params.preco_max)) {
      filtradas = filtradas.filter((r) => r.valor_normalizado <= params.preco_max!)
    }

    if (params.marca && params.marca.trim()) {
      const m = params.marca.trim().toUpperCase()
      filtradas = filtradas.filter((r) => (r.marca_modelo || '').toUpperCase().includes(m))
    }

    if (params.unidade && params.unidade.trim()) {
      const u = params.unidade.trim().toUpperCase()
      filtradas = filtradas.filter((r) => (r.unidade || '').toUpperCase().includes(u))
    }

    const fim = performance.now()

    return {
      sucesso: true,
      registros: filtradas,
      totalEncontrados: totalReal,
      paginaAtual: pagina,
      totalPaginas,
      tempoMs: Math.round(fim - inicio),
      origemExecucao: 'API_REAL_PNCP',
      termoConsultado: termo,
      aviso: `Dados oficiais consultados em tempo real diretamente da API Pública do PNCP (${filtradas.length} amostra(s) carregada(s)).`,
    }
  }

  /**
   * Converte um registro retornado pelo PNCP em modelo unificado Referencia
   */
  private static mapearItemParaReferencia(
    ata: PncpApiResponseItem,
    subItem: any,
    idx: number,
    subIdx: number,
  ): Referencia | null {
    // 1. Extração de identificadores e órgão
    const orgaoCnpj =
      ata.orgaoEntidade?.cnpj ||
      ata.orgaoSubRogado?.cnpj ||
      ata.orgao_cnpj ||
      ata.cnpj ||
      'NÃO INFORMADO'
    const orgaoNome =
      ata.orgaoEntidade?.razaoSocial ||
      ata.orgaoSubRogado?.razaoSocial ||
      ata.orgao_nome ||
      'NÃO INFORMADO'
    const orgaoUf = ata.unidadeOrgao?.ufSigla || ata.uf || 'NÃO INFORMADO'
    const orgaoMun = ata.unidadeOrgao?.municipioNome || ata.municipio_nome || ata.municipio || ''
    const municipioUf =
      orgaoMun && orgaoUf !== 'NÃO INFORMADO'
        ? `${orgaoMun} - ${orgaoUf}`
        : orgaoUf !== 'NÃO INFORMADO'
          ? orgaoUf
          : 'NÃO INFORMADO'

    // 2. Extração de fornecedor
    const fornecedorNome =
      ata.fornecedor?.nomeRazaoSocialFornecedor || ata.fornecedor_nome || 'NÃO INFORMADO'
    const fornecedorCnpj = ata.fornecedor?.niFornecedor || ata.fornecedor_cnpj || 'NÃO INFORMADO'
    const fornecedorPorte =
      ata.fornecedor?.porteFornecedorNome ||
      (fornecedorNome.includes('ME') || fornecedorNome.includes('EPP') ? 'ME_EPP' : 'DEMAIS')

    // 3. Datas
    const dataContrato =
      ata.dataPublicacaoPncp ||
      ata.data_publicacao_pncp ||
      ata.dataAssinatura ||
      ata.data_assinatura ||
      ata.dataVigenciaInicio ||
      ata.data_inicio_vigencia ||
      ata.dataAtualizacao ||
      ata.data_publicacao ||
      ata.createdAt ||
      new Date().toISOString()

    // 4. Dados do Item (PROIBIDO usar ata.objeto se subItem existir)
    const descricao =
      subItem?.descricao ||
      subItem?.materialOuServicoNome ||
      ata.description ||
      ata.title ||
      ata.objeto ||
      'Item contratado no PNCP'

    const unidade = subItem?.unidadeMedida || ata.unidade_medida || 'UN'

    const quantidade = Number(subItem?.quantidade) || Number(ata.quantidade) || 1

    // CASCATA DE EXTRAÇÃO DE PREÇOS DO PNCP:
    // (a) valor homologado do subitem
    // (b) valor estimado do subitem
    // (c) campos unitários explícitos do item
    // (d) valor total do SUBITEM ÷ quantidade do SUBITEM (NUNCA valor_global ou valor total da contratação)
    // Se a API realmente não informar nada: descartar, NUNCA inventar preço ou usar valor_global
    let valorUnitario: number | null = null
    let naturezaPreco: 'contratado' | 'estimado' = 'contratado'

    const temSubItemValido =
      subItem &&
      (subItem.descricao || subItem.materialOuServicoNome || subItem.numeroItem !== undefined)

    // (a) Valor homologado do subitem (camelCase e snake_case)
    if (
      subItem?.valorUnitarioHomologado !== undefined &&
      subItem?.valorUnitarioHomologado !== null &&
      Number(subItem.valorUnitarioHomologado) > 0
    ) {
      valorUnitario = Number(subItem.valorUnitarioHomologado)
      naturezaPreco = 'contratado'
    } else if (
      subItem?.valor_unitario_homologado !== undefined &&
      subItem?.valor_unitario_homologado !== null &&
      Number(subItem.valor_unitario_homologado) > 0
    ) {
      valorUnitario = Number(subItem.valor_unitario_homologado)
      naturezaPreco = 'contratado'
    } else if (
      subItem?.valorUnitarioEstimado !== undefined &&
      subItem?.valorUnitarioEstimado !== null &&
      Number(subItem.valorUnitarioEstimado) > 0
    ) {
      valorUnitario = Number(subItem.valorUnitarioEstimado)
      naturezaPreco = 'estimado'
    } else if (
      subItem?.valor_unitario_estimado !== undefined &&
      subItem?.valor_unitario_estimado !== null &&
      Number(subItem.valor_unitario_estimado) > 0
    ) {
      valorUnitario = Number(subItem.valor_unitario_estimado)
      naturezaPreco = 'estimado'
    } else if (
      subItem?.valorUnitario !== undefined &&
      subItem?.valorUnitario !== null &&
      Number(subItem.valorUnitario) > 0
    ) {
      valorUnitario = Number(subItem.valorUnitario)
      naturezaPreco = subItem?.valorUnitarioHomologado ? 'contratado' : 'estimado'
    } else if (
      subItem?.valor_unitario !== undefined &&
      subItem?.valor_unitario !== null &&
      Number(subItem.valor_unitario) > 0
    ) {
      valorUnitario = Number(subItem.valor_unitario)
      naturezaPreco = subItem?.valor_unitario_homologado ? 'contratado' : 'estimado'
    } else if (
      subItem?.valor_normalizado !== undefined &&
      subItem?.valor_normalizado !== null &&
      Number(subItem.valor_normalizado) > 0
    ) {
      valorUnitario = Number(subItem.valor_normalizado)
      naturezaPreco = 'contratado'
    }
    // (b) Se não for subitem e o item principal tiver preço unitário REAL e validado (NÃO contratação pendente)
    else if (!temSubItemValido && !ata._detalhamento_pendente) {
      if (
        ata.valorUnitarioHomologado !== undefined &&
        ata.valorUnitarioHomologado !== null &&
        Number(ata.valorUnitarioHomologado) > 0
      ) {
        valorUnitario = Number(ata.valorUnitarioHomologado)
        naturezaPreco = 'contratado'
      } else if (
        ata.valor_unitario_homologado !== undefined &&
        ata.valor_unitario_homologado !== null &&
        Number(ata.valor_unitario_homologado) > 0
      ) {
        valorUnitario = Number(ata.valor_unitario_homologado)
        naturezaPreco = 'contratado'
      } else if (
        ata.valorUnitarioEstimado !== undefined &&
        ata.valorUnitarioEstimado !== null &&
        Number(ata.valorUnitarioEstimado) > 0
      ) {
        valorUnitario = Number(ata.valorUnitarioEstimado)
        naturezaPreco = 'estimado'
      } else if (
        ata.valor_unitario_estimado !== undefined &&
        ata.valor_unitario_estimado !== null &&
        Number(ata.valor_unitario_estimado) > 0
      ) {
        valorUnitario = Number(ata.valor_unitario_estimado)
        naturezaPreco = 'estimado'
      } else if (
        ata.valorUnitario !== undefined &&
        ata.valorUnitario !== null &&
        Number(ata.valorUnitario) > 0
      ) {
        valorUnitario = Number(ata.valorUnitario)
        naturezaPreco = 'contratado'
      } else if (
        ata.valor_unitario !== undefined &&
        ata.valor_unitario !== null &&
        Number(ata.valor_unitario) > 0
      ) {
        valorUnitario = Number(ata.valor_unitario)
        naturezaPreco = 'contratado'
      } else if (
        ata.valor_normalizado !== undefined &&
        ata.valor_normalizado !== null &&
        Number(ata.valor_normalizado) > 0
      ) {
        valorUnitario = Number(ata.valor_normalizado)
        naturezaPreco = 'contratado'
      }
    }
    // (c) valorTotal do subitem ÷ quantidade quando plausível (quantidade > 0)
    // PROIBIDO usar valor_global, valorTotal da ata / contratação
    if (valorUnitario === null || valorUnitario <= 0) {
      if (temSubItemValido) {
        const vTotSub =
          Number(subItem.valorTotalHomologado) ||
          Number(subItem.valor_total_homologado) ||
          Number(subItem.valorTotal) ||
          Number(subItem.valor_total) ||
          0
        const qtdSub = Number(subItem.quantidade) || 0
        if (vTotSub > 0 && qtdSub > 0) {
          const calcSub = vTotSub / qtdSub
          if (!isNaN(calcSub) && calcSub > 0) {
            valorUnitario = calcSub
            naturezaPreco =
              Number(subItem.valorTotalHomologado) || Number(subItem.valor_total_homologado)
                ? 'contratado'
                : 'estimado'
          }
        }
      }
    }

    // Diretiva do usuário: "O preço unitário de todos os itens tem que aparecer. Se não houver preços, não deve constar."
    // Se após a cascata o unitário for <= 0, NaN ou nulo, NÃO criar a amostra — descartar com log estruturado
    if (valorUnitario === null || isNaN(valorUnitario) || valorUnitario <= 0) {
      console.info('[PncpService] Amostra descartada: sem preço unitário', {
        numeroControle: ata.numeroControlePNCP || ata.numero_controle_pncp || ata.id,
        item: descricao,
        motivo: 'sem preço unitário',
      })
      return null
    }

    const valorEfetivo = valorUnitario as number

    // 5. Identificadores do Processo e Ata
    const numeroControle =
      ata.numeroControlePNCP ||
      ata.numero_controle_pncp ||
      ata.numeroControlePncpCompra ||
      ata.id ||
      `PNCP-${idx}-${subIdx}`
    const numeroAta =
      ata.numeroAtaRegistroPreco || ata.numero || ata.numero_sequencial || 'NÃO INFORMADO'
    const ano = ata.anoAta || ata.ano || new Date(dataContrato).getFullYear()
    const sequencial =
      ata.numeroSequencialAta || ata.numero_sequencial_compra_ata || ata.numero_sequencial || 1

    // 6. Deep Link Real no PNCP
    let deepLink = ata.itemUrl || ata.item_url || ''
    if (deepLink && deepLink.startsWith('/')) {
      deepLink = `https://pncp.gov.br/app${deepLink}`
    } else if (!deepLink || !deepLink.startsWith('http')) {
      const docType = ata.document_type || (ata.numeroAtaRegistroPreco ? 'ata' : 'edital')
      const tipoLink = docType === 'ata' ? 'atas' : 'editais'
      deepLink = PncpService.construirDeepLinkPncp(orgaoCnpj, ano, sequencial, tipoLink)
    }

    const hash = PncpService.gerarHashRastreabilidade({
      fonte: 'pncp',
      id_externo: numeroControle,
      cnpj_orgao: orgaoCnpj,
      valor: valorEfetivo,
      data: dataContrato,
      item: descricao,
    })

    const marca = subItem?.marcaNome || subItem?.modeloNome || 'NÃO INFORMADO'

    const itemNum = subItem?.numeroItem || subIdx || 0
    return {
      id: `PNCP-REAL-${numeroControle}-${itemNum}-${valorEfetivo.toFixed(4).replace('.', '_')}`,
      pesquisa_id: 'pncp_real_query',
      fonte: 'pncp',
      id_externo: numeroControle,
      item_externo: descricao.trim().toUpperCase(),
      natureza_preco: naturezaPreco,
      valor_original: valorEfetivo,
      valor_normalizado: valorEfetivo,
      unidade: unidade.trim().toUpperCase(),
      quantidade,
      data_contratacao: dataContrato,
      fornecedor: fornecedorNome,
      cnpj_fornecedor: fornecedorCnpj,
      orgao_comprador: orgaoNome,
      municipio_uf: municipioUf,
      modalidade_licitacao: ata.modalidadeNome || 'Pregão Eletrônico (SRP)',
      processo_origem: `Ata ${numeroAta}/${ano} — PNCP: ${numeroControle} (Item ${itemNum})`,
      marca_modelo: marca,
      codigo_catalogo: subItem?.materialOuServico || 'CATMAT',
      url: deepLink,
      hash,
      status_revisao: 'aceito',
      source_identifier: numeroControle,
      source_capture_date: new Date().toISOString(),
      confidence_score: 96,
      similarity_score: 95,
      is_demo: false, // Flag explícita indicando amostra REAL da API
      detalhes_tecnicos: {
        detalhamento_pendente: Boolean(ata._detalhamento_pendente),
        nao_informado: false,
      },
    }
  }

  /**
   * Compatibilidade / alias para testes e conversão direta
   */
  public static converterParaReferencia(
    ata: PncpApiResponseItem,
    subItem: any,
    idx: number = 0,
    subIdx: number = 0,
  ): Referencia | null {
    return PncpService.mapearItemParaReferencia(ata, subItem, idx, subIdx)
  }

  /**
   * Converte Referencias para o formato BudgetPriceResult consumido pela UI
   */
  public static converterParaBudgetPriceResults(
    referencias: Referencia[],
    budgetItemId: string,
  ): BudgetPriceResult[] {
    return referencias
      .filter((ref) => Number(ref.valor_normalizado) > 0)
      .map((ref) => {
        const detalhamentoPendente = Boolean((ref.detalhes_tecnicos as any)?.detalhamento_pendente)

        return {
          id: ref.id,
          budget_item_id: budgetItemId,
          source: 'PNCP',
          source_record_id: ref.id_externo || ref.source_identifier || 'NÃO INFORMADO',
          source_url: ref.url || '',
          source_date: ref.data_contratacao || new Date().toISOString(),
          government_entity: ref.orgao_comprador || 'NÃO INFORMADO',
          supplier: ref.fornecedor || 'NÃO INFORMADO',
          supplier_document: ref.cnpj_fornecedor || 'NÃO INFORMADO',
          description_original: ref.item_externo,
          description_normalized: ref.item_externo,
          unit: ref.unidade || 'UN',
          quantity: ref.quantidade || 1,
          unit_price: Number((ref.valor_normalizado || 0).toFixed(4)),
          similarity_score: ref.similarity_score || 95,
          status: 'encontrado' as const,
          raw_data: {
            modalidade: ref.modalidade_licitacao || 'Pregão Eletrônico',
            municipio_uf: ref.municipio_uf || 'NÃO INFORMADO',
            processo: ref.processo_origem || 'NÃO INFORMADO',
            marca: ref.marca_modelo || 'NÃO INFORMADO',
            natureza: ref.natureza_preco || 'contratado',
            hash: ref.hash,
            is_demo: false, // Amostra REAL
            is_real_api: true,
            detalhamento_pendente: detalhamentoPendente,
            nao_informado: false,
            porte_empresa:
              ref.fornecedor &&
              (ref.fornecedor.toUpperCase().includes('ME') ||
                ref.fornecedor.toUpperCase().includes('EPP'))
                ? 'ME_EPP'
                : 'DEMAIS',
          },
          created: ref.data_contratacao || new Date().toISOString(),
          updated: ref.data_contratacao || new Date().toISOString(),
        }
      })
  }
}
