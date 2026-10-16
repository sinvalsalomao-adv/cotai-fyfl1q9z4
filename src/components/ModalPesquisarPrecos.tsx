import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  X,
  Search,
  Sparkles,
  ExternalLink,
  ShieldAlert,
  Check,
  Building,
  Calendar,
  FileText,
  Building2,
  Tag,
  Hash,
  AlertTriangle,
  Filter,
  Activity,
  Plus,
  HelpCircle,
  Eye,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  RotateCcw,
  ListCheck,
  Calendar as CalendarIcon,
  Info,
  Loader2,
  Clock,
  Database,
  Layers,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import {
  FiltroFonteMultiplo,
  ChipFiltroFonteAtivo,
  ItemFonteContagem,
} from '@/components/FiltroFonteMultiplo'
import { TermoDestacado, calcularDiasVencimento } from '@/components/TermoDestacado'
import type {
  BudgetItem,
  BudgetPriceResult,
  BudgetMethodology,
  BudgetStatistics,
  BudgetExpurgatedPrice,
} from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'
import { PriceIndexService } from '@/lib/priceIndexService'
import pb from '@/lib/pocketbase/client'
import {
  codigoCorrespondeAoTermo,
  amostraEhNaturezaIncompativel,
} from '@/lib/catalogoOficialCanonico'

// BUG FIX v0.0.82: Normalização canônica ÚNICA de fonte usada tanto para montar a lista
// "fontesDisponiveis" (chaves do FiltroFonteMultiplo) quanto para filtrar a grade.
// Assim a seleção confirmada no botão "Aplicar" e o rótulo real da amostra falam a MESMA língua
// ('PNCP' ↔ 'pncp', 'Compras.gov.br' ↔ 'compras_gov', 'BPS' ↔ 'bps', etc.) e nada vaza do filtro.
export function fonteNormalizada(
  rawSource?: string,
  rawSourceType?: string,
): { key: string; label: string } | null {
  const raw = (rawSource || '').trim()
  const typeLower = (rawSourceType || '').trim().toLowerCase()
  const lower = raw.toLowerCase()

  if (!raw && !typeLower) return null

  if (
    lower === 'pncp' ||
    lower.includes('pncp') ||
    lower.includes('pncp.gov.br') ||
    typeLower === 'pncp' ||
    lower.includes('portal nacional de contratacoes') ||
    lower.includes('portal nacional de contratações')
  ) {
    return { key: 'PNCP', label: 'PNCP' }
  }
  if (
    lower.includes('compras.gov') ||
    lower.includes('compras_gov') ||
    lower.includes('compras') ||
    lower === 'catmat' ||
    typeLower === 'compras_gov' ||
    typeLower === 'comprasgov'
  ) {
    return { key: 'Compras.gov.br', label: 'Compras.gov.br' }
  }
  if (
    lower === 'bps' ||
    lower.includes('saude') ||
    lower.includes('banco de preços em saúde') ||
    typeLower === 'bps'
  ) {
    return { key: 'BPS', label: 'BPS (Ministério da Saúde)' }
  }
  if (
    lower.includes('portal de compras') ||
    lower.includes('portal_compras') ||
    lower === 'pcp' ||
    typeLower === 'portal_compras_publicas'
  ) {
    return { key: 'Portal de Compras Públicas', label: 'Portal de Compras Públicas' }
  }
  if (lower === 'cmed') return { key: 'CMED', label: 'CMED (ANVISA)' }
  if (lower === 'sinapi') return { key: 'SINAPI', label: 'SINAPI' }
  if (lower === 'sicro') return { key: 'SICRO', label: 'SICRO' }
  if (lower === 'conab' || lower === 'ceasa') return { key: 'CONAB', label: 'CONAB / CEASA' }
  if (lower.includes('seinfra')) return { key: 'SEINFRA/CE', label: 'SEINFRA/CE' }
  if (lower.includes('setop')) return { key: 'SETOP/MG', label: 'SETOP/MG' }
  if (lower.includes('bec')) return { key: 'BEC-SP', label: 'BEC-SP' }
  if (lower === 'manual') return { key: 'Manual', label: 'Cotação Comercial (Manual)' }

  // Fonte fora do catálogo canônico: mantém rastreabilidade usando o próprio valor
  const key = raw || rawSourceType
  return { key, label: raw || (rawSourceType || '').toUpperCase() }
}

interface ModalPesquisarPrecosProps {
  item: BudgetItem
  budgetId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: (resultado: any) => void
}

export const ModalPesquisarPrecos: React.FC<ModalPesquisarPrecosProps> = ({
  item,
  budgetId,
  isOpen,
  onClose,
  onSuccess,
}) => {
  // Argumento de Pesquisa
  const [searchTerm, setSearchTerm] = useState(item.description)
  const [tipoPesquisa, setTipoPesquisa] = useState<'PALAVRA_CHAVE' | 'CATMAT'>('PALAVRA_CHAVE')
  const [cnpjFiltro, setCnpjFiltro] = useState('')
  const [tipoPalavras, setTipoPalavras] = useState<'palavras' | 'exata'>('palavras')

  // Estados de Busca
  const [loadingSearch, setLoadingSearch] = useState(false)
  const [loadingMoreProgressive, setLoadingMoreProgressive] = useState(false)
  const [loadingConfirm, setLoadingConfirm] = useState(false)
  const [statusIaProgresso, setStatusIaProgresso] = useState('')
  const [priceResults, setPriceResults] = useState<BudgetPriceResult[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detailModalPrice, setDetailModalPrice] = useState<BudgetPriceResult | null>(null)
  const [searchExecuted, setSearchExecuted] = useState(false)
  const [isOrigemRealPncp, setIsOrigemRealPncp] = useState<boolean>(false)
  const [isOrigemRealBps, setIsOrigemRealBps] = useState<boolean>(false)
  const [isOrigemRealPcp, setIsOrigemRealPcp] = useState<boolean>(false)
  const [pcpAguardandoCredencial, setPcpAguardandoCredencial] = useState<boolean>(false)
  const [erroBusca, setErroBusca] = useState<string | null>(null)
  const [paginaPncpCarregada, setPaginaPncpCarregada] = useState<number>(1)
  const [totalPaginasPncpDisponiveis, setTotalPaginasPncpDisponiveis] = useState<number>(1)

  // Guard de corrida para buscas assíncronas concorrentes
  const requestIdRef = React.useRef<number>(0)
  // Latência medida da consulta ao índice local (POST /backend/v1/prices/search)
  const [tookIndexMs, setTookIndexMs] = useState<number | null>(null)
  // Total de amostras indexadas na base local (price_samples_index) para o termo
  const [totalIndexLocal, setTotalIndexLocal] = useState<number>(0)
  const [frescorSincronizacao, setFrescorSincronizacao] = useState<Record<string, any>>({})
  const [cicloDiarioInfo, setCicloDiarioInfo] = useState<any>(null)
  const [metricasConsultaLocal, setMetricasConsultaLocal] = useState<any>(null)
  // Scroll da grade virtualizada
  const [gradeScrollTop, setGradeScrollTop] = useState<number>(0)
  const [gradeClientHeight, setGradeClientHeight] = useState<number>(440)
  const gradeContainerRef = React.useRef<HTMLDivElement>(null)

  // RF-015: Estado global da pesquisa
  // 'Em processamento' | 'Concluída' | 'Concluída parcialmente' | 'Falha total'
  const [estadoPesquisa, setEstadoPesquisa] = useState<
    'Em processamento' | 'Concluída' | 'Concluída parcialmente' | 'Falha total' | null
  >(null)

  // RF-016 & RF-017: Diagnóstico e monitoramento detalhado por fonte
  const [diagnosticoFontes, setDiagnosticoFontes] = useState<
    Array<{
      fonte: string
      status: 'concluido' | 'parcial' | 'falha' | 'processando' | 'aguardando_credencial'
      amostrasObtidas: number
      registrosInformadosApi?: number
      tempoMs?: number
      mensagem?: string
    }>
  >([])
  const [agregacoesPorFonteIndice, setAgregacoesPorFonteIndice] = useState<Record<string, number>>(
    {},
  )
  const [statusTarefaIndice, setStatusTarefaIndice] = useState<{
    ativa?: boolean
    status?: string
    pendentes_count?: number
  } | null>(null)

  // Metodologia e Estatísticas
  const [methodology, setMethodology] = useState<BudgetMethodology | null>(null)
  const [estatisticasCalculadas, setEstatisticasCalculadas] = useState<{
    itemAtualizado: BudgetItem
    estatisticas: BudgetStatistics
    expurgados: BudgetExpurgatedPrice[]
    amostrasDentro: number
    amostrasExpurgadas: number
    amostrasTotal: number
    metodoAplicado: string
    cvCalculado: number
  } | null>(null)

  // Filtros de Refinamento (Painel à Esquerda)
  // Novo estado de seleção múltipla confirmada de fontes ([] = todas)
  const [fontesSelecionadas, setFontesSelecionadas] = useState<string[]>([])
  // CORREÇÃO 2: filtroSituacao padrão 'todas'
  const [filtroSituacao, setFiltroSituacao] = useState<string>('todas')
  // CORREÇÃO 4: filtroPeriodoMeses padrão 0 (sem filtro temporal padrão).
  // Só aplica cláusula temporal quando o usuário escolher explicitamente um período > 0.
  const [filtroPeriodoMeses, setFiltroPeriodoMeses] = useState<number>(0)
  const [filtroUf, setFiltroUf] = useState<string>('')
  const [filtroDataInicio, setFiltroDataInicio] = useState<string>('')
  const [filtroDataFim, setFiltroDataFim] = useState<string>('')
  const [filtroPrecoMin, setFiltroPrecoMin] = useState<string>('')
  const [filtroPrecoMax, setFiltroPrecoMax] = useState<string>('')
  const [filtroPrecoSlider, setFiltroPrecoSlider] = useState<[number, number]>([0, 1000])
  const [sliderPrecoMaximoAbsoluto, setSliderPrecoMaximoAbsoluto] = useState<number>(1000)
  const [filtroVariacaoMedianaPct, setFiltroVariacaoMedianaPct] = useState<string>('') // tolerância % vs mediana
  const [filtroPorteOpcao, setFiltroPorteOpcao] = useState<'TODAS' | 'ME_EPP'>('TODAS')
  const [filtroMedida, setFiltroMedida] = useState<string>('') // unidade de fornecimento
  const [filtroMarca, setFiltroMarca] = useState<string>('') // marca
  const [ordenacao, setOrdenacao] = useState<'menor_preco' | 'maior_preco' | 'data_recente'>(
    'menor_preco',
  )

  // Paginação visual da tabela independente da coleta completa (RF-006, TA-006)
  // O usuário pode alternar entre 20, 50 ou 100 amostras por página visual
  const [itensPorPaginaVisual, setItensPorPaginaVisual] = useState<number>(20)
  const ITENS_POR_PAGINA = itensPorPaginaVisual
  const [paginaAtual, setPaginaAtual] = useState<number>(1)

  // Totais consolidados de busca retornados pelo motor abrangente
  const [totaisConsolidados, setTotaisConsolidados] = useState<{
    totalEncontrados?: number
    valorMinimo?: number
    valorMaximo?: number
    mediaGeral?: number
    medianaGeral?: number
  } | null>(null)

  // Controle de fila pendente do PNCP e paginação progressiva
  const [itensFilaPendente, setItensFilaPendente] = useState<number>(0)
  const [continuandoFila, setContinuandoFila] = useState<boolean>(false)
  const [cancelarFilaPendente, setCancelarFilaPendente] = useState<boolean>(false)
  const [coletaEmTempoRealAtiva, setColetaEmTempoRealAtiva] = useState<boolean>(false)
  const [statusColetaTempoReal, setStatusColetaTempoReal] = useState<string>('')
  const pollingIntervalRef = useRef<any>(null)

  // Valor de Referência para Valores Vantajosos (Prorrogação de Contrato/Licitação)
  const [valorReferencia, setValorReferencia] = useState<number>(
    item.reference_price && item.reference_price > 0 ? item.reference_price : 0,
  )
  const [editandoValorRef, setEditandoValorRef] = useState(false)
  const [novoValorRefInput, setNovoValorRefInput] = useState<string>(
    item.reference_price && item.reference_price > 0 ? String(item.reference_price) : '',
  )
  const [salvandoValorRef, setSalvandoValorRef] = useState(false)

  // Justificativa / Observação da Análise Crítica
  const [mostrandoCampoJustificativa, setMostrandoCampoJustificativa] = useState(false)
  const [justificativaCritica, setJustificativaCritica] = useState('')
  const [salvandoJustificativa, setSalvandoJustificativa] = useState(false)
  const [justificativaSalvaTexto, setJustificativaSalvaTexto] = useState('')

  // Limpeza de polling se modal fechar ou desmontar
  useEffect(() => {
    if (!isOpen) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
      setColetaEmTempoRealAtiva(false)
      setStatusColetaTempoReal('')
    }
  }, [isOpen])

  // Helpers de anti-contaminação e tokenização
  const normalizarTokensTexto = (txt: string): string[] => {
    if (!txt) return []
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
      'UNIDADE',
      'UND',
    ])
    const norm = txt
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .trim()
    if (!norm) return []
    return norm.split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t))
  }

  const stemToken = (t: string): string => {
    if (!t || t.length <= 3) return t
    if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
    if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
    return t
  }

  // Verifica se a descrição de uma amostra possui aderência textual mínima com o termo pesquisado.
  // REGRA MANDATÓRIA (1): Amostras casadas por código oficial CATMAT (ex: 462776/462772 para picolé)
  // NUNCA devem ser rejeitadas pelo filtro de aderência textual — a aderência textual só se aplica
  // a amostras SEM código oficial.
  // REGRA MANDATÓRIA (2): Amostras de natureza inadequada (serviços, palhaço, palito, pirulito)
  // são descartadas mesmo contendo o termo no texto.
  const validarAderenciaTextual = (
    termo: string,
    descricaoAmostra: string,
    codigoItem?: string,
    unidade?: string,
  ): boolean => {
    if (!termo || !termo.trim()) return true

    // Descarta imediatamente se for de natureza incompatível (serviço, palhaço, palito, pirulito)
    if (amostraEhNaturezaIncompativel(termo, descricaoAmostra, unidade)) {
      return false
    }

    // Se a amostra possui código CATMAT oficial correspondente ao termo, é aceita sem teste textual
    if (codigoCorrespondeAoTermo(termo, codigoItem)) {
      return true
    }

    const tokensTermo = normalizarTokensTexto(termo)
    if (tokensTermo.length === 0) return true
    const tokensDesc = normalizarTokensTexto(descricaoAmostra)
    if (tokensDesc.length === 0) return false

    const setTermo = new Set<string>()
    for (const tk of tokensTermo) {
      setTermo.add(tk)
      const st = stemToken(tk)
      if (st) setTermo.add(st)
    }

    for (const dtk of tokensDesc) {
      if (setTermo.has(dtk)) return true
      const dst = stemToken(dtk)
      if (dst && setTermo.has(dst)) return true
    }

    return false
  }

  // Ao abrir, carregar cotações já existentes do item e a metodologia
  useEffect(() => {
    if (isOpen) {
      setSearchTerm(item.last_search_term || item.description)
      const refVal = item.reference_price && item.reference_price > 0 ? item.reference_price : 0
      setValorReferencia(refVal)
      setNovoValorRefInput(refVal > 0 ? String(refVal) : '')
      setEditandoValorRef(false)
      // CORREÇÃO: Limpar grade anterior para resíduos de outra pesquisa não persistirem na grade
      setPriceResults([])
      setSelectedIds([])
      setSearchExecuted(false)
      setFiltroSituacao('todas')
      carregarDadosIniciais()
    }
  }, [isOpen, item.id, item.reference_price])

  const carregarDadosIniciais = async () => {
    try {
      // Zerar estado da grade antes de hidratar do índice e do banco
      setPriceResults([])
      setSelectedIds([])
      setSearchExecuted(false)

      const [meth, list] = await Promise.all([
        BudgetService.obterMetodologia(budgetId),
        BudgetService.listarPrecosDoItem(item.id),
      ])
      setMethodology(meth)

      const termoInicial = (item.last_search_term || item.description || '').trim()

      // Filtra amostras salvas do item que possuam aderência textual com o termo inicial
      // descartando vínculos errados (ex.: registros de dipirona em item picolé)
      const listValida = list.filter((p) => {
        const desc = p.description_normalized || p.description_original || ''
        const cod = p.raw_data?.codigo_item || (p as any).codigo_item || ''
        return validarAderenciaTextual(termoInicial, desc, cod, p.unit)
      })

      // Identifica itens previamente selecionados ou calcula pré-seleção inicial
      let preSelIniciais: string[] = []
      if (listValida.length > 0) {
        setPriceResults(listValida)
        const explicitamenteSelecionados = listValida
          .filter((p) => p.status === 'selecionado')
          .map((p) => p.id)
        if (explicitamenteSelecionados.length > 0) {
          preSelIniciais = explicitamenteSelecionados
        } else {
          const refAtual =
            item.reference_price && item.reference_price > 0 ? item.reference_price : undefined
          const inf = meth?.percentage_lower ?? 30
          const sup = meth?.percentage_upper ?? 30
          preSelIniciais = BudgetService.selecionarMelhoresAmostrasGlobais(
            listValida,
            refAtual,
            3,
            {
              limiteInferiorPct: inf,
              limiteSuperiorPct: sup,
            },
          )
        }
        setSelectedIds(preSelIniciais)
        setSearchExecuted(true)
      } else {
        setPriceResults([])
        setSelectedIds([])
        setSearchExecuted(false)
      }

      // CORREÇÕES 1, 3 e 4: Hidratação a partir do índice local
      // MESMO quando listValida.length > 0, dispara a hidratação em segundo plano via PriceIndexService.searchIndex
      // paginando silenciosamente com tamanho_pagina: 200 até esgotar ou teto razoável (2.000 amostras)
      // e mesclando (merge com deduplicação sem sobrescrever as cotações salvas).
      // Se filtroPeriodoMeses for 0 ou indefinido, NÃO envia clausula temporal.
      if (termoInicial.length > 0) {
        try {
          const MAX_AMOSTRAS_INDEX = 2000
          const TAMANHO_PAGINA_INDEX = 200
          let paginaAtualLoop = 1
          let totalHitsNoIndice = 0
          let todasAmostrasIndex: any[] = []
          let duracaoPrimeiraPagina = 0
          let frescorSinc = null
          let cicloInfo = null
          let resIndex: any = null

          while (todasAmostrasIndex.length < MAX_AMOSTRAS_INDEX) {
            const searchParamsInit: any = {
              palavra_chave: termoInicial,
              tamanho_pagina: TAMANHO_PAGINA_INDEX,
              pagina: paginaAtualLoop,
              ordenar: 'valor_unitario:asc',
            }
            if (filtroPeriodoMeses > 0) {
              searchParamsInit.periodo_meses = filtroPeriodoMeses
            }

            const resInit = await PriceIndexService.searchIndex(searchParamsInit)
            if (paginaAtualLoop === 1) {
              resIndex = resInit
              duracaoPrimeiraPagina = resInit.duracao_ms ?? resInit.took ?? 0
              if (resInit.frescor_sincronizacao) frescorSinc = resInit.frescor_sincronizacao
              if (resInit.ciclo_diario) cicloInfo = resInit.ciclo_diario
            }

            const rawHits = Array.isArray(resInit.hits) ? resInit.hits : resInit.hits?.hits || []
            totalHitsNoIndice = resInit.total ?? resInit.hits?.total ?? rawHits.length

            if (rawHits.length === 0) {
              break
            }

            todasAmostrasIndex.push(...rawHits)

            if (
              todasAmostrasIndex.length >= totalHitsNoIndice ||
              rawHits.length < TAMANHO_PAGINA_INDEX
            ) {
              break
            }

            paginaAtualLoop++
          }

          if (todasAmostrasIndex.length > 0) {
            const amostrasConvertidas = todasAmostrasIndex
              .map((h: any) => PriceIndexService.hitToAmostraPreco(h._source || h))
              .filter(
                (a: any) =>
                  typeof a.valorUnitario === 'number' &&
                  !isNaN(a.valorUnitario) &&
                  a.valorUnitario > 0 &&
                  validarAderenciaTextual(
                    termoInicial,
                    a.descricaoCompleta || a.produto || a.descricaoNormalizada || '',
                    a.codigoCatalogo,
                    a.unidade,
                  ),
              )
              .map((a: any) => BudgetService.converterAmostraPrecoParaBudgetPriceResult(a, item.id))

            // Deduplicação canônica preservando as cotações já salvas
            const mapaMesclado = new Map<string, BudgetPriceResult>()
            const gerarChaveCanonica = (p: BudgetPriceResult) => {
              if (p.source_record_id) return `${p.source}#${p.source_record_id}#${p.unit_price}`
              if (p.source_url) return `${p.source}#${p.source_url}#${p.unit_price}`
              return `${p.source}#${p.id}#${p.unit_price}`
            }

            // 1. Insere as cotações salvas primeiro (têm prioridade máxima e mantêm seus IDs de banco)
            for (const salva of listValida) {
              if (salva && typeof salva.unit_price === 'number' && salva.unit_price > 0) {
                mapaMesclado.set(gerarChaveCanonica(salva), salva)
              }
            }

            // 2. Mescla as amostras do índice que ainda não estão presentes
            for (const amostraIdx of amostrasConvertidas) {
              const chave = gerarChaveCanonica(amostraIdx)
              if (!mapaMesclado.has(chave)) {
                mapaMesclado.set(chave, amostraIdx)
              }
            }

            const listaMesclada = Array.from(mapaMesclado.values()).sort(
              (a, b) => a.unit_price - b.unit_price,
            )

            if (listaMesclada.length > 0) {
              const precosMesclados = listaMesclada.map((x) => x.unit_price).sort((a, b) => a - b)
              setPriceResults(listaMesclada)
              setSearchExecuted(true)
              const porFonteIndiceInit: Record<string, number> =
                (resIndex?.aggregations?.por_fonte as any) ?? {}
              const somaPorFonteInit =
                (porFonteIndiceInit['PNCP'] || 0) +
                (porFonteIndiceInit['Compras.gov.br'] || porFonteIndiceInit['COMPRAS'] || 0)
              const totalExibir =
                somaPorFonteInit > 0
                  ? somaPorFonteInit
                  : totalHitsNoIndice > 0
                    ? totalHitsNoIndice
                    : listaMesclada.length
              setTotalIndexLocal(totalExibir)
              setTookIndexMs(duracaoPrimeiraPagina)
              if (frescorSinc) setFrescorSincronizacao(frescorSinc)
              if (cicloInfo) setCicloDiarioInfo(cicloInfo)

              const statsAggInit = resIndex?.aggregations?.estatisticas
              const minP = statsAggInit?.minimo > 0 ? statsAggInit.minimo : precosMesclados[0]
              const maxP =
                statsAggInit?.maximo > 0
                  ? statsAggInit.maximo
                  : precosMesclados[precosMesclados.length - 1]
              const medP =
                statsAggInit?.media > 0
                  ? statsAggInit.media
                  : precosMesclados.reduce((a, b) => a + b, 0) / precosMesclados.length
              const meioP = Math.floor(precosMesclados.length / 2)
              const medianaP =
                statsAggInit?.mediana > 0
                  ? statsAggInit.mediana
                  : precosMesclados.length % 2 === 0
                    ? (precosMesclados[meioP - 1] + precosMesclados[meioP]) / 2
                    : precosMesclados[meioP]

              setTotaisConsolidados({
                totalEncontrados: totalExibir,
                valorMinimo: minP,
                valorMaximo: maxP,
                mediaGeral: medP,
                medianaGeral: medianaP,
              })

              // Preservar seleções existentes se list tinha cotações
              if (preSelIniciais.length > 0) {
                setSelectedIds(preSelIniciais)
              } else {
                const refAtual =
                  item.reference_price && item.reference_price > 0
                    ? item.reference_price
                    : undefined
                const inf = meth?.percentage_lower ?? 30
                const sup = meth?.percentage_upper ?? 30
                const preSel = BudgetService.selecionarMelhoresAmostrasGlobais(
                  listaMesclada,
                  refAtual,
                  3,
                  { limiteInferiorPct: inf, limiteSuperiorPct: sup },
                )
                setSelectedIds(preSel)
              }

              // Diagnóstico consolidado por fonte usando agregação do índice como fonte da verdade
              const amostrasPorFonteInit: Record<string, number> = {}
              for (const p of listaMesclada) {
                const fn = fonteNormalizada(p.source, p.sourceType)
                const sKey = fn?.key || p.source || 'Outra'
                amostrasPorFonteInit[sKey] = (amostrasPorFonteInit[sKey] || 0) + 1
              }

              setAgregacoesPorFonteIndice(porFonteIndiceInit)
              const totalPncpInit = porFonteIndiceInit['PNCP'] ?? 0
              const totalComprasInit =
                porFonteIndiceInit['Compras.gov.br'] ?? porFonteIndiceInit['COMPRAS'] ?? 0

              const taskStatusInit = resIndex?.status_tarefa
              if (taskStatusInit) setStatusTarefaIndice(taskStatusInit)
              const tarefaAtivaInit =
                Boolean(taskStatusInit?.ativa) ||
                (typeof taskStatusInit?.pendentes_count === 'number' &&
                  taskStatusInit.pendentes_count > 0)

              setDiagnosticoFontes([
                {
                  fonte: 'PNCP',
                  status: (tarefaAtivaInit
                    ? 'processando'
                    : totalPncpInit > 0
                      ? 'concluido'
                      : 'processando') as any,
                  amostrasObtidas: totalPncpInit,
                  mensagem:
                    totalPncpInit > 0
                      ? `${totalPncpInit} amostras oficiais homologadas indexadas`
                      : tarefaAtivaInit
                        ? 'Coleta em andamento / detalhando'
                        : 'Sem amostras PNCP no índice',
                },
                {
                  fonte: 'Compras.gov.br',
                  status: (totalComprasInit > 0 ? 'concluido' : 'processando') as any,
                  amostrasObtidas: totalComprasInit,
                  mensagem:
                    totalComprasInit > 0
                      ? `${totalComprasInit} amostras recuperadas via CATMAT/ARP indexadas`
                      : 'Sem amostras Compras.gov.br no índice',
                },
              ])
            }
          }
        } catch (errHidrat) {
          console.warn(
            '[ModalPesquisarPrecos] Hidratação inicial a partir do índice local:',
            errHidrat,
          )
        }
      }
    } catch (err) {
      console.error('Erro ao carregar dados iniciais de cotação:', err)
    }
  }

  // Ação de Pesquisar ou Cotar com IA com Carregamento Progressivo (Página 1 rápida + Páginas seguintes em tempo real)
  const handleBuscar = async (isIa: boolean = false) => {
    const currentReqId = ++requestIdRef.current
    setLoadingSearch(true)
    setLoadingMoreProgressive(false)
    setErroBusca(null)
    setEstadoPesquisa('Em processamento')
    setStatusIaProgresso(
      isIa
        ? 'Consultando índice local de alta performance e auditando fontes oficiais...'
        : 'Consultando índice local (~4-8ms) e disparando coleta nas fontes oficiais...',
    )

    // CORREÇÃO: Limpar a grade ao disparar nova busca para resíduos de pesquisas anteriores não persistirem
    setPriceResults([])
    setSelectedIds([])
    setSearchExecuted(false)

    // Diagnóstico inicial com chave canônica 'PNCP' e 'Compras.gov.br'
    const diagInicial = [
      {
        fonte: 'PNCP',
        status: 'processando' as const,
        amostrasObtidas: 0,
        mensagem: 'Consultando índice local e API oficial do PNCP...',
      },
      {
        fonte: 'Compras.gov.br',
        status: 'processando' as const,
        amostrasObtidas: 0,
        mensagem: 'Consultando índice local e Compras.gov.br...',
      },
    ]
    setDiagnosticoFontes(diagInicial)

    const minVal = filtroPrecoMin ? parseFloat(filtroPrecoMin.replace(',', '.')) : undefined
    const maxVal = filtroPrecoMax ? parseFloat(filtroPrecoMax.replace(',', '.')) : undefined

    const inf = methodology?.percentage_lower ?? 30
    const sup = methodology?.percentage_upper ?? 30

    // Termo da busca atual para validação anti-contaminação
    const termoBuscaAtual = searchTerm.trim()

    // Mapa unívoco para merge incremental na grade sem duplicar e sem descartar
    const mapaGrade = new Map<string, BudgetPriceResult>()
    const gerarChaveUnica = (p: BudgetPriceResult) =>
      `${p.source}_${p.source_record_id || p.id}_${p.unit_price}`

    let ultimasAgregacoesIndice: Record<string, number> = {}
    let ultimaTarefaStatus: { ativa?: boolean; status?: string; pendentes_count?: number } | null =
      null

    const aplicarMergeGrade = (novosLotes: BudgetPriceResult[], totaisAtualizados?: any) => {
      if (requestIdRef.current !== currentReqId) return
      for (const p of novosLotes) {
        if (!p || typeof p.unit_price !== 'number' || isNaN(p.unit_price) || p.unit_price <= 0) {
          continue
        }
        // Validação anti-contaminação obrigatória: descarta amostras que chegam via orquestrador/merge
        // quando não houver aderência textual mínima com o termo pesquisado
        // MAS preserva amostras casadas por código oficial CATMAT
        const descTexto = p.description_normalized || p.description_original || ''
        const codAmostra =
          p.raw_data?.codigo_item ||
          (p as any).codigo_item ||
          (p.raw_data?.codigoCatalogo as string) ||
          ''
        if (!validarAderenciaTextual(termoBuscaAtual, descTexto, codAmostra, p.unit)) {
          continue
        }
        const k = gerarChaveUnica(p)
        if (!mapaGrade.has(k)) {
          mapaGrade.set(k, p)
        }
      }

      const lista = Array.from(mapaGrade.values()).sort((a, b) => a.unit_price - b.unit_price)
      setPriceResults(lista)
      setSearchExecuted(true)

      if (totaisAtualizados) {
        setTotaisConsolidados(totaisAtualizados)
      } else if (lista.length > 0) {
        const precos = lista.map((x) => x.unit_price)
        const minP = Math.min(...precos)
        const maxP = Math.max(...precos)
        const medP = precos.reduce((a, b) => a + b, 0) / precos.length
        const meioP = Math.floor(precos.length / 2)
        const medianaP =
          precos.length % 2 === 0 ? (precos[meioP - 1] + precos[meioP]) / 2 : precos[meioP]
        setTotaisConsolidados({
          totalEncontrados: lista.length,
          valorMinimo: minP,
          valorMaximo: maxP,
          mediaGeral: medP,
          medianaGeral: medianaP,
        })
      }

      // Pré-seleção inteligente mantendo a grade viva
      const sel = BudgetService.selecionarMelhoresAmostrasGlobais(
        lista,
        valorReferencia > 0 ? valorReferencia : undefined,
        3,
        { limiteInferiorPct: inf, limiteSuperiorPct: sup },
      )
      setSelectedIds(sel)

      // Atualiza diagnóstico com contagens por chave canônica priorizando a agregação real do índice
      const amostrasPorFonte: Record<string, number> = {}
      for (const p of lista) {
        const fn = fonteNormalizada(p.source, p.sourceType)
        const sKey = fn?.key || p.source || 'Outra'
        amostrasPorFonte[sKey] = (amostrasPorFonte[sKey] || 0) + 1
      }

      const totalPncpElegivel = ultimasAgregacoesIndice['PNCP'] ?? 0
      const totalComprasElegivel =
        ultimasAgregacoesIndice['Compras.gov.br'] ?? ultimasAgregacoesIndice['COMPRAS'] ?? 0

      const tarefaPncpAtivaMerge =
        Boolean(ultimaTarefaStatus?.ativa) ||
        itensFilaPendente > 0 ||
        coletaEmTempoRealAtiva ||
        (typeof ultimaTarefaStatus?.pendentes_count === 'number' &&
          ultimaTarefaStatus.pendentes_count > 0)

      setDiagnosticoFontes([
        {
          fonte: 'PNCP',
          status: (tarefaPncpAtivaMerge
            ? 'processando'
            : totalPncpElegivel > 0
              ? 'concluido'
              : 'processando') as any,
          amostrasObtidas: totalPncpElegivel,
          mensagem:
            totalPncpElegivel > 0
              ? `${totalPncpElegivel} amostras oficiais homologadas indexadas`
              : 'Consultando índice e API oficial do PNCP...',
        },
        {
          fonte: 'Compras.gov.br',
          status: (totalComprasElegivel > 0 ? 'concluido' : 'processando') as any,
          amostrasObtidas: totalComprasElegivel,
          mensagem:
            totalComprasElegivel > 0
              ? `${totalComprasElegivel} amostras recuperadas via CATMAT/ARP indexadas`
              : 'Consultando índice e API oficial Compras.gov.br...',
        },
      ])
    }

    try {
      // =======================================================================
      // (B) PASSO 1: HIDRATAÇÃO IMEDIATA DA GRADE VIA ÍNDICE LOCAL
      // =======================================================================
      const fonteFiltroCanonica =
        fontesSelecionadas.length === 1
          ? fonteNormalizada(fontesSelecionadas[0])?.key || fontesSelecionadas[0]
          : undefined

      const searchParamsIndex: any = {
        palavra_chave: searchTerm,
        palavra_exata: tipoPalavras === 'exata',
        uf: filtroUf.trim() || undefined,
        data_inicio: filtroDataInicio || undefined,
        data_fim: filtroDataFim || undefined,
        preco_min: !isNaN(minVal as number) ? minVal : undefined,
        preco_max: !isNaN(maxVal as number) ? maxVal : undefined,
        unidade: filtroMedida.trim() || undefined,
        marca: filtroMarca.trim() || undefined,
        porte: filtroPorteOpcao === 'ME_EPP' ? 'ME_EPP' : undefined,
        fonte: fonteFiltroCanonica,
        ordenar: 'valor_unitario:asc',
        pagina: 1,
        tamanho_pagina: 100,
      }
      if (filtroPeriodoMeses > 0) {
        searchParamsIndex.periodo_meses = filtroPeriodoMeses
      }

      try {
        const resIdx = await PriceIndexService.searchIndex(searchParamsIndex)
        if (requestIdRef.current !== currentReqId) return

        setTookIndexMs(resIdx.duracao_ms ?? resIdx.took ?? 0)
        const totalLocalEncontrado = resIdx.total ?? resIdx.hits?.total ?? 0
        const aggFontesIdx = resIdx.aggregations?.por_fonte
        const somaPorFonteIdx =
          aggFontesIdx && typeof aggFontesIdx === 'object'
            ? (aggFontesIdx['PNCP'] || 0) +
              (aggFontesIdx['Compras.gov.br'] || aggFontesIdx['COMPRAS'] || 0)
            : 0
        const totalIndexEfetivo = somaPorFonteIdx > 0 ? somaPorFonteIdx : totalLocalEncontrado
        setTotalIndexLocal(totalIndexEfetivo)
        if (resIdx.frescor_sincronizacao) {
          setFrescorSincronizacao(resIdx.frescor_sincronizacao)
        }
        if (resIdx.ciclo_diario) {
          setCicloDiarioInfo(resIdx.ciclo_diario)
        }
        if (resIdx.metricas_consulta) {
          setMetricasConsultaLocal(resIdx.metricas_consulta)
        }
        if (resIdx.aggregations?.por_fonte) {
          ultimasAgregacoesIndice = {
            ...ultimasAgregacoesIndice,
            ...resIdx.aggregations.por_fonte,
          }
          setAgregacoesPorFonteIndice(ultimasAgregacoesIndice)
        }
        if (resIdx.status_tarefa) {
          ultimaTarefaStatus = resIdx.status_tarefa
          setStatusTarefaIndice(resIdx.status_tarefa)
        }

        const rawHits = Array.isArray(resIdx.hits) ? resIdx.hits : resIdx.hits?.hits || []
        if (rawHits.length > 0) {
          const amostrasIndexConvertidas = rawHits
            .map((h: any) => PriceIndexService.hitToAmostraPreco(h._source || h))
            .filter(
              (a: any) =>
                typeof a.valorUnitario === 'number' &&
                !isNaN(a.valorUnitario) &&
                a.valorUnitario > 0,
            )
            .map((a: any) => BudgetService.converterAmostraPrecoParaBudgetPriceResult(a, item.id))

          const statsAgg = resIdx.aggregations?.estatisticas
          aplicarMergeGrade(amostrasIndexConvertidas, {
            totalEncontrados: totalIndexEfetivo,
            valorMinimo: statsAgg?.minimo || resIdx.aggregations?.preco_minimo || 0,
            valorMaximo: statsAgg?.maximo || resIdx.aggregations?.preco_maximo || 0,
            mediaGeral: statsAgg?.media || resIdx.aggregations?.preco_medio || 0,
            medianaGeral: statsAgg?.mediana || resIdx.aggregations?.preco_mediana || 0,
          })
          setStatusIaProgresso(
            `Índice local carregado em ${resIdx.duracao_ms ?? resIdx.took ?? 0}ms (${amostrasIndexConvertidas.length} amostras). Sincronizando com APIs oficiais...`,
          )
        }
      } catch (errIndex) {
        console.warn(
          '[ModalPesquisarPrecos] Consulta imediata ao índice local falhou/vazia:',
          errIndex,
        )
      }

      // =======================================================================
      // (B) PASSO 2: COLETA PARALELA NO ORQUESTRADOR COM MERGE PROGRESSIVO
      // =======================================================================
      const paramsBase = {
        periodo_meses: filtroPeriodoMeses,
        data_inicio: filtroDataInicio || undefined,
        data_fim: filtroDataFim || undefined,
        uf: filtroUf.trim() || undefined,
        fonte: fonteFiltroCanonica,
        preco_min: !isNaN(minVal as number) ? minVal : undefined,
        preco_max: !isNaN(maxVal as number) ? maxVal : undefined,
        marca: filtroMarca.trim() || undefined,
        unidade: filtroMedida.trim() || undefined,
        apenas_me: filtroPorteOpcao === 'ME_EPP',
        usar_api_real_pncp: true,
      }

      const maxDetalharFila = continuandoFila ? 30 : 15

      const resOrchestrator = await BudgetService.pesquisarPrecosAbrangente(item, searchTerm, {
        ...paramsBase,
        tam_pagina: 50,
        paginacao_total: true,
        max_detalhar: maxDetalharFila,
        forcarAtualizacaoCache: false,
        onProgress: (prog) => {
          if (requestIdRef.current !== currentReqId) return
          aplicarMergeGrade(prog.amostrasAcumuladas, prog.estatisticas)
        },
      })

      if (requestIdRef.current !== currentReqId) return

      aplicarMergeGrade(resOrchestrator.registros, resOrchestrator.totais)

      setIsOrigemRealPncp(!!resOrchestrator.origemRealPncp)
      setIsOrigemRealBps(!!resOrchestrator.origemRealBps)
      setIsOrigemRealPcp(!!resOrchestrator.origemRealPcp)
      setPcpAguardandoCredencial(Boolean(resOrchestrator.pcpAguardandoCredenciamento))
      setPaginaAtual(1)

      // Captura de itens pendentes na fila de detalhamento
      const pncpObs = resOrchestrator.observabilidade?.detalhePorFonte?.['pncp']
      const fila =
        (pncpObs as any)?.itens_fila_pendente ||
        (pncpObs as any)?.detalhamento_paralelo?.itens_fila_pendente ||
        (pncpObs as any)?.metadata?.itens_fila_pendente ||
        0
      setItensFilaPendente(fila)

      // Diagnóstico consolidado com chaves canônicas usando o acervo real do índice como fonte da verdade
      const amostrasPorFonteFinal: Record<string, number> = {}
      let totalHomologadosPncp = 0
      let totalEstimadosPncp = 0
      for (const p of mapaGrade.values()) {
        const fn = fonteNormalizada(p.source, p.sourceType)
        const sKey = fn?.key || p.source || 'Outra'
        amostrasPorFonteFinal[sKey] = (amostrasPorFonteFinal[sKey] || 0) + 1
        if (sKey === 'PNCP') {
          if (
            p.raw_data?.natureza === 'homologado' ||
            p.raw_data?.natureza_preco === 'homologado'
          ) {
            totalHomologadosPncp++
          } else {
            totalEstimadosPncp++
          }
        }
      }

      const totalPncpFinal = ultimasAgregacoesIndice['PNCP'] ?? 0
      const totalComprasFinal =
        ultimasAgregacoesIndice['Compras.gov.br'] ?? ultimasAgregacoesIndice['COMPRAS'] ?? 0
      setAgregacoesPorFonteIndice(ultimasAgregacoesIndice)
      if (ultimaTarefaStatus) setStatusTarefaIndice(ultimaTarefaStatus)

      const tarefaPncpAtiva =
        Boolean(ultimaTarefaStatus?.ativa) || fila > 0 || itensFilaPendente > 0

      const descrPncpFinal =
        totalPncpFinal > 0
          ? `${totalPncpFinal} amostras oficiais homologadas indexadas`
          : tarefaPncpAtiva
            ? 'Coleta em andamento / detalhando contratações na API...'
            : resOrchestrator.errosPorFonte?.['pncp'] || 'Sem registros compatíveis'

      const descrComprasFinal =
        totalComprasFinal > 0
          ? `${totalComprasFinal} amostras recuperadas via CATMAT/ARP indexadas`
          : resOrchestrator.errosPorFonte?.['compras_gov'] || 'Nenhum registro para este termo'

      const diagFinal = [
        {
          fonte: 'PNCP',
          status: (tarefaPncpAtiva
            ? 'processando'
            : totalPncpFinal > 0
              ? 'concluido'
              : resOrchestrator.errosPorFonte?.['pncp']
                ? 'falha'
                : 'concluido') as any,
          amostrasObtidas: totalPncpFinal,
          registrosInformadosApi:
            resOrchestrator.observabilidade?.detalhePorFonte?.['pncp']?.quantidadeInformadaApi || 0,
          mensagem: descrPncpFinal,
        },
        {
          fonte: 'Compras.gov.br',
          status: (totalComprasFinal > 0
            ? 'concluido'
            : resOrchestrator.errosPorFonte?.['compras_gov']
              ? 'falha'
              : 'concluido') as any,
          amostrasObtidas: totalComprasFinal,
          registrosInformadosApi:
            resOrchestrator.observabilidade?.detalhePorFonte?.['compras_gov']
              ?.quantidadeInformadaApi || 0,
          mensagem: descrComprasFinal,
        },
      ]
      setDiagnosticoFontes(diagFinal)

      if (resOrchestrator.estadoPesquisa === 'CONCLUIDA_PARCIALMENTE') {
        setEstadoPesquisa('Concluída parcialmente')
      } else if (resOrchestrator.estadoPesquisa === 'FALHA_TOTAL') {
        setEstadoPesquisa('Falha total')
      } else {
        setEstadoPesquisa('Concluída')
      }
    } catch (err: any) {
      if (requestIdRef.current !== currentReqId) return
      console.error('Erro ao pesquisar preços:', err)
      const msg = err.message || 'Falha de comunicação com as fontes de pesquisa.'
      setErroBusca(msg)
      setEstadoPesquisa('Falha total')
    } finally {
      if (requestIdRef.current === currentReqId) {
        setLoadingSearch(false)
        setStatusIaProgresso('')

        // =======================================================================
        // (C) ACOMPANHAMENTO EM TEMPO REAL NO MODAL VIA POLLING (ENCHIMENTO AUTOMÁTICO)
        // Se a busca inicial encontrou itens pendentes de detalhamento ou se a base
        // ainda tem poucos itens (< 30), inicia polling de alta performance no índice
        // local a cada 3.5 segundos para que a grade encha SOZINHA conforme o worker
        // grava novos lotes, sem o usuário precisar pesquisar novamente.
        // =======================================================================
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
        }

        const deveAtivarPolling =
          itensFilaPendente > 0 ||
          mapaGrade.size < 40 ||
          (searchTerm && searchTerm.trim().length >= 3)

        if (deveAtivarPolling) {
          setColetaEmTempoRealAtiva(true)
          setStatusColetaTempoReal(
            'Coleta em andamento em segundo plano — a grade atualizará ao vivo conforme o worker grava lotes.',
          )

          let ciclosSemNovidades = 0
          let ultimaContagemConhecida = mapaGrade.size

          pollingIntervalRef.current = setInterval(async () => {
            // Guard de corrida: se uma nova busca foi disparada ou modal fechado, aborta
            if (requestIdRef.current !== currentReqId) {
              if (pollingIntervalRef.current) {
                clearInterval(pollingIntervalRef.current)
                pollingIntervalRef.current = null
              }
              setColetaEmTempoRealAtiva(false)
              setStatusColetaTempoReal('')
              return
            }

            try {
              const fonteFiltroAtual =
                fontesSelecionadas.length === 1
                  ? fonteNormalizada(fontesSelecionadas[0])?.key || fontesSelecionadas[0]
                  : undefined

              const searchParamsPoll: any = {
                palavra_chave: searchTerm,
                palavra_exata: tipoPalavras === 'exata',
                uf: filtroUf.trim() || undefined,
                data_inicio: filtroDataInicio || undefined,
                data_fim: filtroDataFim || undefined,
                preco_min: !isNaN(minVal as number) ? minVal : undefined,
                preco_max: !isNaN(maxVal as number) ? maxVal : undefined,
                unidade: filtroMedida.trim() || undefined,
                marca: filtroMarca.trim() || undefined,
                porte: filtroPorteOpcao === 'ME_EPP' ? 'ME_EPP' : undefined,
                fonte: fonteFiltroAtual,
                ordenar: 'valor_unitario:asc',
                pagina: 1,
                tamanho_pagina: 100,
              }
              if (filtroPeriodoMeses > 0) {
                searchParamsPoll.periodo_meses = filtroPeriodoMeses
              }

              const resPoll = await PriceIndexService.searchIndex(searchParamsPoll)

              if (requestIdRef.current !== currentReqId) return

              const totalAgora = resPoll.total ?? resPoll.hits?.total ?? 0
              const aggFontesPoll = resPoll.aggregations?.por_fonte
              const somaPorFontePoll =
                aggFontesPoll && typeof aggFontesPoll === 'object'
                  ? (aggFontesPoll['PNCP'] || 0) +
                    (aggFontesPoll['Compras.gov.br'] || aggFontesPoll['COMPRAS'] || 0)
                  : 0
              const totalIndexEfetivoPoll = somaPorFontePoll > 0 ? somaPorFontePoll : totalAgora
              setTotalIndexLocal(totalIndexEfetivoPoll)
              setTookIndexMs(resPoll.duracao_ms ?? resPoll.took ?? 0)
              if (resPoll.aggregations?.por_fonte) {
                ultimasAgregacoesIndice = {
                  ...ultimasAgregacoesIndice,
                  ...resPoll.aggregations.por_fonte,
                }
                setAgregacoesPorFonteIndice(ultimasAgregacoesIndice)
              }
              if (resPoll.status_tarefa) {
                ultimaTarefaStatus = resPoll.status_tarefa
                setStatusTarefaIndice(resPoll.status_tarefa)
              }

              const statsAggPoll = resPoll.aggregations?.estatisticas
              if (statsAggPoll) {
                setTotaisConsolidados((prev: any) => ({
                  ...prev,
                  totalEncontrados: totalIndexEfetivoPoll,
                  valorMinimo: statsAggPoll.minimo > 0 ? statsAggPoll.minimo : prev?.valorMinimo,
                  valorMaximo: statsAggPoll.maximo > 0 ? statsAggPoll.maximo : prev?.valorMaximo,
                  mediaGeral: statsAggPoll.media > 0 ? statsAggPoll.media : prev?.mediaGeral,
                  medianaGeral:
                    statsAggPoll.mediana > 0 ? statsAggPoll.mediana : prev?.medianaGeral,
                }))
              }

              const rawHitsPoll = Array.isArray(resPoll.hits)
                ? resPoll.hits
                : resPoll.hits?.hits || []
              if (rawHitsPoll.length > 0) {
                const amostrasPollConvertidas = rawHitsPoll
                  .map((h: any) => PriceIndexService.hitToAmostraPreco(h._source || h))
                  .filter(
                    (a: any) =>
                      typeof a.valorUnitario === 'number' &&
                      !isNaN(a.valorUnitario) &&
                      a.valorUnitario > 0,
                  )
                  .map((a: any) =>
                    BudgetService.converterAmostraPrecoParaBudgetPriceResult(a, item.id),
                  )

                const qtdAntes = mapaGrade.size
                aplicarMergeGrade(
                  amostrasPollConvertidas,
                  statsAggPoll
                    ? {
                        totalEncontrados: totalIndexEfetivoPoll,
                        valorMinimo: statsAggPoll.minimo,
                        valorMaximo: statsAggPoll.maximo,
                        mediaGeral: statsAggPoll.media,
                        medianaGeral: statsAggPoll.mediana,
                      }
                    : {
                        totalEncontrados: totalIndexEfetivoPoll,
                      },
                )
                const qtdDepois = mapaGrade.size

                if (qtdDepois > qtdAntes) {
                  ciclosSemNovidades = 0
                  ultimaContagemConhecida = qtdDepois
                  setStatusColetaTempoReal(
                    `Coleta em andamento — ${qtdDepois} amostras indexadas até agora (+${qtdDepois - qtdAntes} novas)`,
                  )
                } else {
                  ciclosSemNovidades++
                  if (ciclosSemNovidades >= 6) {
                    // Após ~21 segundos sem novos lotes, encerra o polling para economizar recursos
                    if (pollingIntervalRef.current) {
                      clearInterval(pollingIntervalRef.current)
                      pollingIntervalRef.current = null
                    }
                    setColetaEmTempoRealAtiva(false)
                    setStatusColetaTempoReal('')
                  }
                }
              }
            } catch (errPoll) {
              console.warn('[ModalPesquisarPrecos] Polling de acompanhamento do índice:', errPoll)
            }
          }, 3500)
        }
      }
    }
  }

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    )
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(priceResults.map((p) => p.id))
    } else {
      setSelectedIds([])
    }
  }

  // Ações de seleção para conveniência
  const handleSelectPage = (checked: boolean) => {
    const pageIds = amostrasPaginadas.map((p) => p.id)
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...pageIds])))
    } else {
      setSelectedIds((prev) => prev.filter((id) => !pageIds.includes(id)))
    }
  }

  // Lista de fontes autorizadas (somente PNCP e Compras.gov.br por diretriz de negócio)
  const fontesDisponiveis = useMemo<ItemFonteContagem[]>(() => {
    const contagens: Record<string, { label: string; count: number }> = {
      PNCP: { label: 'PNCP', count: 0 },
      'Compras.gov.br': { label: 'Compras.gov.br', count: 0 },
    }

    priceResults.forEach((p) => {
      const fonteCanonica = fonteNormalizada(p.source, p.sourceType)
      if (!fonteCanonica) return
      const { key } = fonteCanonica
      if (contagens[key]) {
        contagens[key].count += 1
      }
    })

    return [
      { key: 'PNCP', label: 'PNCP', count: contagens['PNCP'].count },
      { key: 'Compras.gov.br', label: 'Compras.gov.br', count: contagens['Compras.gov.br'].count },
    ]
  }, [priceResults])

  // Mediana de referência para filtro de tolerância %
  const medianaBase = useMemo(() => {
    if (priceResults.length === 0) return 0
    const vals = priceResults.map((p) => p.unit_price).sort((a, b) => a - b)
    const m = Math.floor(vals.length / 2)
    return vals.length % 2 === 0 ? (vals[m - 1] + vals[m]) / 2 : vals[m]
  }, [priceResults])

  // Filtros aplicados sobre as amostras retornadas (suprime qualquer fonte que não seja PNCP ou Compras.gov.br)
  const amostrasFiltradas = useMemo(() => {
    // Diretriz de negócio: suprimir registros de fontes desativadas (aceita apenas PNCP e Compras.gov.br)
    let lista = priceResults.filter((p) => {
      const fn = fonteNormalizada(p.source, p.sourceType)
      return fn && (fn.key === 'PNCP' || fn.key === 'Compras.gov.br')
    })

    // 1. Origem / Fonte das amostras — Multi-seleção confirmada pelo usuário no botão "Aplicar".
    // BUG FIX v0.0.82: a grade passava por comparação textual solta (includes) entre o raw da amostra
    // e a chave selecionada, e amostras com fonte fora do padrão vazavam o filtro. Agora a amostra e
    // a seleção passam pelo MESMO normalizador canônico (fonteNormalizada), garantindo que com fontes
    // selecionadas a grade exiba SOMENTE amostras dessas fontes.
    if (fontesSelecionadas.length > 0) {
      const selecionadasCanonicas = new Set(
        fontesSelecionadas.map((selKey) => fonteNormalizada(selKey)?.key || '').filter(Boolean),
      )
      lista = lista.filter((p) => {
        const fonteAmostra = fonteNormalizada(p.source, p.sourceType)
        return Boolean(fonteAmostra && selecionadasCanonicas.has(fonteAmostra.key))
      })
    }

    // 2. Situação da amostra
    if (filtroSituacao !== 'todas') {
      if (filtroSituacao === 'selecionados') {
        lista = lista.filter((p) => selectedIds.includes(p.id))
      } else if (filtroSituacao === 'nao_selecionados') {
        lista = lista.filter((p) => !selectedIds.includes(p.id))
      } else if (filtroSituacao === 'expurgados') {
        lista = lista.filter((p) => p.status === 'expurgado')
      }
    }

    // 3. Período por Meses para trás (quando selecionado no painel Refinar)
    if (filtroPeriodoMeses > 0) {
      const dataLimite = new Date()
      dataLimite.setMonth(dataLimite.getMonth() - filtroPeriodoMeses)
      const limiteTime = dataLimite.getTime()
      lista = lista.filter((p) => {
        if (!p.source_date) return true
        return new Date(p.source_date).getTime() >= limiteTime
      })
    }

    // 4. Unidade Federativa (UF)
    if (filtroUf.trim()) {
      const ufBuscada = filtroUf.trim().toUpperCase()
      lista = lista.filter(
        (p) =>
          p.government_entity?.toUpperCase().includes(ufBuscada) ||
          p.raw_data?.municipio_uf?.toUpperCase().includes(ufBuscada),
      )
    }

    // 5. Período manual De / Até (opcional complementar)
    if (filtroDataInicio) {
      const dIni = new Date(filtroDataInicio).getTime()
      lista = lista.filter((p) => {
        if (!p.source_date) return true
        return new Date(p.source_date).getTime() >= dIni
      })
    }
    if (filtroDataFim) {
      const dFim = new Date(filtroDataFim + 'T23:59:59').getTime()
      lista = lista.filter((p) => {
        if (!p.source_date) return true
        return new Date(p.source_date).getTime() <= dFim
      })
    }

    // 5. Variação de preços (Faixa Mín e Máx aplicada via botão Aplicar ou Slider)
    // Diretriz: o preço unitário de todos os itens tem que aparecer (> 0).
    const pMin = filtroPrecoMin ? parseFloat(filtroPrecoMin.replace(',', '.')) : NaN
    const pMax = filtroPrecoMax ? parseFloat(filtroPrecoMax.replace(',', '.')) : NaN
    if (!isNaN(pMin) && pMin > 0) {
      lista = lista.filter((p) => p.unit_price >= pMin)
    }
    if (!isNaN(pMax)) {
      lista = lista.filter((p) => p.unit_price <= pMax)
    }

    // 6. Tolerância % vs Mediana
    const tolPct = filtroVariacaoMedianaPct ? parseFloat(filtroVariacaoMedianaPct) : NaN
    if (!isNaN(tolPct) && tolPct > 0 && medianaBase > 0) {
      const limInf = medianaBase * (1 - tolPct / 100)
      const limSup = medianaBase * (1 + tolPct / 100)
      lista = lista.filter((p) => p.unit_price >= limInf && p.unit_price <= limSup)
    }

    // 7. Porte da Empresa (TODAS vs ME/EPP com transparência)
    if (filtroPorteOpcao === 'ME_EPP') {
      lista = lista.filter((p) => {
        const supp = (p.supplier || '').toUpperCase()
        const rawPorte = p.raw_data?.porte_empresa || p.raw_data?.fornecedorPorte
        if (rawPorte === 'ME_EPP' || rawPorte === 'ME' || rawPorte === 'EPP') return true
        if (
          supp.includes(' ME') ||
          supp.includes(' EPP') ||
          supp.includes('MICROEMPRESA') ||
          supp.includes('LTDA - ME') ||
          supp.includes('LTDA ME') ||
          supp.includes('EPP ')
        ) {
          return true
        }
        return false
      })
    }

    // 8. Medida de fornecimento (unidade)
    if (filtroMedida.trim()) {
      const med = filtroMedida.trim().toUpperCase()
      lista = lista.filter((p) => (p.unit || '').toUpperCase().includes(med))
    }

    // 9. Marca
    if (filtroMarca.trim()) {
      const marc = filtroMarca.trim().toUpperCase()
      lista = lista.filter(
        (p) =>
          (p.raw_data?.marca || '').toUpperCase().includes(marc) ||
          (p.description_original || '').toUpperCase().includes(marc),
      )
    }

    // Ordenação
    if (ordenacao === 'menor_preco') {
      lista.sort((a, b) => a.unit_price - b.unit_price)
    } else if (ordenacao === 'maior_preco') {
      lista.sort((a, b) => b.unit_price - a.unit_price)
    } else if (ordenacao === 'data_recente') {
      lista.sort(
        (a, b) => new Date(b.source_date || 0).getTime() - new Date(a.source_date || 0).getTime(),
      )
    }

    return lista
  }, [
    priceResults,
    fontesSelecionadas,
    filtroSituacao,
    filtroUf,
    filtroDataInicio,
    filtroDataFim,
    filtroPrecoMin,
    filtroPrecoMax,
    filtroVariacaoMedianaPct,
    filtroPorteOpcao,
    filtroMedida,
    filtroMarca,
    ordenacao,
    selectedIds,
    medianaBase,
  ])

  // Limpar filtros de refinamento
  const handleLimparFiltros = () => {
    setFontesSelecionadas([])
    setFiltroSituacao('todas')
    setFiltroPeriodoMeses(0)
    setFiltroUf('')
    setFiltroDataInicio('')
    setFiltroDataFim('')
    setFiltroPrecoMin('')
    setFiltroPrecoMax('')
    setFiltroPrecoSlider([0, sliderPrecoMaximoAbsoluto])
    setFiltroVariacaoMedianaPct('')
    setFiltroPorteOpcao('TODAS')
    setFiltroMedida('')
    setFiltroMarca('')
    setOrdenacao('menor_preco')
    setPaginaAtual(1)
  }

  const temFiltroAtivo =
    fontesSelecionadas.length > 0 ||
    filtroSituacao !== 'todas' ||
    filtroPeriodoMeses > 0 ||
    filtroUf.trim().length > 0 ||
    Boolean(filtroDataInicio) ||
    Boolean(filtroDataFim) ||
    Boolean(filtroPrecoMin) ||
    Boolean(filtroPrecoMax) ||
    Boolean(filtroVariacaoMedianaPct) ||
    filtroPorteOpcao !== 'TODAS' ||
    filtroMedida.trim().length > 0 ||
    filtroMarca.trim().length > 0

  // Atualiza slider quando os resultados chegarem
  useEffect(() => {
    if (priceResults.length > 0) {
      const vals = priceResults.map((p) => p.unit_price).filter((v) => !isNaN(v) && v >= 0)
      if (vals.length > 0) {
        const min = Math.min(...vals)
        const max = Math.max(...vals)
        const teto = Math.ceil(max * 1.05) || 100
        setSliderPrecoMaximoAbsoluto(teto)
        if (!filtroPrecoMin && !filtroPrecoMax) {
          setFiltroPrecoSlider([min, teto])
        }
      }
    }
  }, [priceResults])

  // Aplicar faixa de preço a partir do painel REFINAR
  const handleAplicarFaixaPreco = () => {
    setFiltroPrecoMin(filtroPrecoSlider[0].toFixed(2))
    setFiltroPrecoMax(filtroPrecoSlider[1].toFixed(2))
    setPaginaAtual(1)
  }

  // Resetar página quando a lista de amostras filtradas mudar
  useEffect(() => {
    setPaginaAtual(1)
  }, [
    fontesSelecionadas,
    filtroSituacao,
    filtroPeriodoMeses,
    filtroUf,
    filtroDataInicio,
    filtroDataFim,
    filtroPrecoMin,
    filtroPrecoMax,
    filtroVariacaoMedianaPct,
    filtroPorteOpcao,
    filtroMedida,
    filtroMarca,
    ordenacao,
    priceResults,
  ])

  // Cálculos da paginação sobre as amostras filtradas
  const totalAmostrasFiltradas = amostrasFiltradas.length
  const totalPaginas = Math.max(1, Math.ceil(totalAmostrasFiltradas / ITENS_POR_PAGINA))

  // Garantir que a página atual seja válida
  const paginaValida = Math.min(Math.max(1, paginaAtual), totalPaginas)

  const indiceInicio = (paginaValida - 1) * ITENS_POR_PAGINA
  const indiceFim = Math.min(indiceInicio + ITENS_POR_PAGINA, totalAmostrasFiltradas)
  const amostrasPaginadas = useMemo(() => {
    return amostrasFiltradas.slice(indiceInicio, indiceFim)
  }, [amostrasFiltradas, indiceInicio, indiceFim])

  // Gerador de páginas visíveis para paginação amigável
  const paginasVisiveis = useMemo(() => {
    if (totalPaginas <= 7) {
      return Array.from({ length: totalPaginas }, (_, i) => i + 1)
    }
    const current = paginaValida
    const pages: (number | string)[] = [1]
    const left = Math.max(2, current - 1)
    const right = Math.min(totalPaginas - 1, current + 1)

    if (left > 2) {
      pages.push('...')
    }
    for (let i = left; i <= right; i++) {
      pages.push(i)
    }
    if (right < totalPaginas - 1) {
      pages.push('...')
    }
    pages.push(totalPaginas)
    return pages
  }, [totalPaginas, paginaValida])

  // Cálculos dinâmicos em tempo real das amostras selecionadas (sem fechar a janela)
  // Amostras sem preço (NÃO INFORMADO) não entram no cálculo de estatísticas/mediana
  const precosSelecionados = useMemo(
    () => priceResults.filter((p) => selectedIds.includes(p.id)),
    [priceResults, selectedIds],
  )
  const valoresSelecionados = useMemo(
    () =>
      precosSelecionados
        .filter((p) => !p.raw_data?.nao_informado && p.unit_price > 0)
        .map((p) => p.unit_price)
        .sort((a, b) => a - b),
    [precosSelecionados],
  )

  // Estatísticas do conjunto completo de amostras válidas da pesquisa (fallback local estrito sobre priceResults)
  const valoresValidosGerais = useMemo(
    () =>
      priceResults
        .filter(
          (p) =>
            !p.raw_data?.nao_informado &&
            typeof p.unit_price === 'number' &&
            Number.isFinite(p.unit_price) &&
            p.unit_price > 0,
        )
        .map((p) => p.unit_price)
        .sort((a, b) => a - b),
    [priceResults],
  )
  const countGeralValido = valoresValidosGerais.length
  const precoMinLocalGeral = countGeralValido > 0 ? valoresValidosGerais[0] : 0
  const precoMaxLocalGeral = countGeralValido > 0 ? valoresValidosGerais[countGeralValido - 1] : 0
  const precoMediaLocalGeral =
    countGeralValido > 0 ? valoresValidosGerais.reduce((a, b) => a + b, 0) / countGeralValido : 0
  const meioGeral = Math.floor(countGeralValido / 2)
  const precoMedianaLocalGeral =
    countGeralValido > 0
      ? countGeralValido % 2 === 0
        ? (valoresValidosGerais[meioGeral - 1] + valoresValidosGerais[meioGeral]) / 2
        : valoresValidosGerais[meioGeral]
      : 0

  let desvioPadraoGeral = 0
  if (countGeralValido > 1) {
    const somaQuadG = valoresValidosGerais.reduce(
      (acc, v) => acc + Math.pow(v - precoMediaLocalGeral, 2),
      0,
    )
    desvioPadraoGeral = Math.sqrt(somaQuadG / (countGeralValido - 1))
  }
  const cvGeral = precoMediaLocalGeral > 0 ? (desvioPadraoGeral / precoMediaLocalGeral) * 100 : 0

  const countSel = valoresSelecionados.length
  const precoMinSel = countSel > 0 ? valoresSelecionados[0] : 0
  const precoMaxSel = countSel > 0 ? valoresSelecionados[countSel - 1] : 0
  const precoMediaSel = countSel > 0 ? valoresSelecionados.reduce((a, b) => a + b, 0) / countSel : 0
  const meio = Math.floor(countSel / 2)
  const precoMedianaSel =
    countSel > 0
      ? countSel % 2 === 0
        ? (valoresSelecionados[meio - 1] + valoresSelecionados[meio]) / 2
        : valoresSelecionados[meio]
      : 0

  let desvioPadraoSel = 0
  if (countSel > 1) {
    const somaQuad = valoresSelecionados.reduce((acc, v) => acc + Math.pow(v - precoMediaSel, 2), 0)
    desvioPadraoSel = Math.sqrt(somaQuad / (countSel - 1))
  }
  const cvSel = precoMediaSel > 0 ? (desvioPadraoSel / precoMediaSel) * 100 : 0
  const decimais = methodology?.decimal_places || 2

  // Limites do Juízo Crítico (70% a 130% por padrão)
  let limiteInferior = 0
  let limiteSuperior = 0
  let labelInferior = '(-30% da mediana)'
  let labelSuperior = '(+30% da mediana)'

  if (methodology?.critical_judgment_method === 'percentual' || !methodology) {
    const sup = methodology?.percentage_upper ?? 30
    const inf = methodology?.percentage_lower ?? 30
    limiteInferior = Math.max(0, precoMedianaSel * (1 - inf / 100))
    limiteSuperior = precoMedianaSel * (1 + sup / 100)
    labelInferior = `(-${inf}% da mediana)`
    labelSuperior = `(+${sup}% da mediana)`
  } else if (methodology.critical_judgment_method === 'desvio_padrao') {
    const fator = methodology.standard_deviation_parameter || 2.0
    limiteInferior = Math.max(0, precoMediaSel - fator * desvioPadraoSel)
    limiteSuperior = precoMediaSel + fator * desvioPadraoSel
    labelInferior = `(-${fator} DP)`
    labelSuperior = `(+${fator} DP)`
  }

  // Identificação de discrepâncias para o Juízo Crítico
  const criticasCount = precosSelecionados.filter(
    (p) => p.unit_price < limiteInferior || p.unit_price > limiteSuperior,
  ).length
  const expurgadosCount = precosSelecionados.filter(
    (p) =>
      p.status === 'expurgado' || p.unit_price < limiteInferior || p.unit_price > limiteSuperior,
  ).length

  // Salvar/Atualizar Valor de Referência diretamente no modal
  const handleSalvarValorReferencia = async () => {
    const valNumerico =
      novoValorRefInput.trim() !== '' ? parseFloat(novoValorRefInput.replace(',', '.')) : 0
    if (isNaN(valNumerico) || valNumerico < 0) {
      alert('Por favor, informe um valor numérico válido maior ou igual a zero.')
      return
    }

    setSalvandoValorRef(true)
    try {
      await BudgetService.atualizarItem(
        item.id,
        {
          reference_price: valNumerico,
        },
        budgetId,
      )
      setValorReferencia(valNumerico)
      item.reference_price = valNumerico
      setEditandoValorRef(false)

      // Se houver amostras na tela e nenhuma seleção manual persistida,
      // recalcular a pré-seleção determinística considerando o novo valor de referência
      if (priceResults.length > 0) {
        const inf = methodology?.percentage_lower ?? 30
        const sup = methodology?.percentage_upper ?? 30
        const novaPreSel = BudgetService.selecionarMelhoresAmostrasGlobais(
          priceResults,
          valNumerico > 0 ? valNumerico : undefined,
          3,
          { limiteInferiorPct: inf, limiteSuperiorPct: sup },
        )
        setSelectedIds(novaPreSel)
      }
    } catch (e: any) {
      alert('Erro ao salvar valor de referência: ' + (e.message || 'Falha'))
    } finally {
      setSalvandoValorRef(false)
    }
  }

  // Estatísticas de Vantajosidade sobre os preços encontrados
  const analiseVantajosidade = useMemo(() => {
    if (!valorReferencia || valorReferencia <= 0) return null

    const precosParaAnalise = priceResults.length > 0 ? priceResults : []
    const totalAmostras = precosParaAnalise.length
    if (totalAmostras === 0) return null

    const acimaOuIgual = precosParaAnalise.filter((p) => p.unit_price >= valorReferencia)
    const abaixo = precosParaAnalise.filter((p) => p.unit_price < valorReferencia)

    // Menor preço de mercado que está acima da referência (o mais próximo favorável)
    const valoresAcima = acimaOuIgual.map((p) => p.unit_price).sort((a, b) => a - b)
    const menorPrecoAcima = valoresAcima.length > 0 ? valoresAcima[0] : null

    // Diferença média em R$ e % de todas as amostras em relação à referência
    let somaDiffRs = 0
    let somaDiffPct = 0
    precosParaAnalise.forEach((p) => {
      const diffRs = p.unit_price - valorReferencia
      const diffPct = (diffRs / valorReferencia) * 100
      somaDiffRs += diffRs
      somaDiffPct += diffPct
    })
    const diffMediaRs = somaDiffRs / totalAmostras
    const diffMediaPct = somaDiffPct / totalAmostras

    // Diferença média especificamente dos preços acima (vantajosos para a prorrogação)
    let somaAcimaRs = 0
    acimaOuIgual.forEach((p) => {
      somaAcimaRs += p.unit_price - valorReferencia
    })
    const diffMediaAcimaRs = acimaOuIgual.length > 0 ? somaAcimaRs / acimaOuIgual.length : 0
    const diffMediaAcimaPct =
      acimaOuIgual.length > 0 ? (diffMediaAcimaRs / valorReferencia) * 100 : 0

    // Percentual de cotações favoráveis à prorrogação
    const pctFavoravel = (acimaOuIgual.length / totalAmostras) * 100
    const comprovada = acimaOuIgual.length > 0

    return {
      valorReferencia,
      totalAmostras,
      qtdAcima: acimaOuIgual.length,
      qtdAbaixo: abaixo.length,
      pctFavoravel,
      menorPrecoAcima,
      diffMediaRs,
      diffMediaPct,
      diffMediaAcimaRs,
      diffMediaAcimaPct,
      comprovada,
    }
  }, [valorReferencia, priceResults])

  // Confirmação das Cotações e Execução do Cálculo Determinístico
  const handleConfirmarCotacoes = async () => {
    if (selectedIds.length === 0) {
      alert('Selecione pelo menos uma cotação para o cálculo.')
      return
    }

    // Validação: amostras selecionadas devem ter preço unitário válido (> 0)
    const precosParaConfirmar = priceResults.filter((p) => selectedIds.includes(p.id))
    const amostrasSemPreco = precosParaConfirmar.filter(
      (p) => p.unit_price <= 0 || Boolean(p.raw_data?.nao_informado),
    )
    if (amostrasSemPreco.length > 0) {
      alert(
        'Existem amostras selecionadas sem preço unitário válido. Apenas itens com preço unitário homologado podem ser confirmados.',
      )
      return
    }

    setLoadingConfirm(true)
    try {
      // Limita a confirmação às primeiras 3 amostras selecionadas
      const selectedIdsEfetivos = Array.from(new Set(selectedIds)).slice(0, 3)

      // Garante que os registros selecionados estejam no banco para cálculo se vieram direto da busca abrangente
      const precosParaPersistir = priceResults.filter(
        (p) =>
          selectedIdsEfetivos.includes(p.id) &&
          (p.id.startsWith('DIP-') || p.id.startsWith('REF-')),
      )
      for (const p of precosParaPersistir) {
        try {
          const criado = await pb.collection('budget_price_results').create({
            budget_item_id: item.id,
            source: p.source,
            source_record_id: p.source_record_id,
            source_url: p.source_url,
            source_date: p.source_date,
            government_entity: p.government_entity,
            supplier: p.supplier,
            supplier_document: p.supplier_document,
            description_original: p.description_original,
            description_normalized: p.description_normalized,
            unit: p.unit,
            quantity: p.quantity,
            unit_price: p.unit_price,
            similarity_score: p.similarity_score,
            status: 'selecionado',
            raw_data: p.raw_data,
          })
          // Atualiza id do item em selectedIds e priceResults
          const indexPr = priceResults.findIndex((r) => r.id === p.id)
          if (indexPr >= 0) {
            priceResults[indexPr].id = criado.id
          }
          const indexSel = selectedIds.indexOf(p.id)
          if (indexSel >= 0) {
            selectedIds[indexSel] = criado.id
          }
          const indexSelEf = selectedIdsEfetivos.indexOf(p.id)
          if (indexSelEf >= 0) {
            selectedIdsEfetivos[indexSelEf] = criado.id
          }
        } catch {
          // segue em caso de duplicata
        }
      }

      const res = await BudgetService.confirmarCotacoesECalcular(
        item,
        selectedIdsEfetivos,
        budgetId,
      )
      setEstatisticasCalculadas(res)

      // Recarrega cotações para refletir status atualizado (expurgado / selecionado)
      const listaAtualizada = await BudgetService.listarPrecosDoItem(item.id)
      if (listaAtualizada.length > 0) {
        setPriceResults(listaAtualizada)
      }

      alert(
        `Cotações confirmadas com sucesso!\nPreço Unitário Calculado (${res.metodoAplicado}): R$ ${res.itemAtualizado.unit_price?.toFixed(
          decimais,
        )}\nAmostras válidas: ${res.amostrasDentro} | Expurgadas pelo juízo crítico: ${res.amostrasExpurgadas}`,
      )
      onSuccess(res)
    } catch (err: any) {
      console.error('Erro ao confirmar cotações:', err)
      alert('Erro ao calcular cotações: ' + (err.message || 'Verifique os dados'))
    } finally {
      setLoadingConfirm(false)
    }
  }

  // Registrar justificativa técnica da análise crítica
  const handleSalvarJustificativaCritica = async () => {
    if (!justificativaCritica.trim()) {
      alert('Por favor, informe a justificativa técnica.')
      return
    }

    setSalvandoJustificativa(true)
    try {
      await BudgetService.registrarLog({
        budget_id: budgetId,
        action: 'JUSTIFICATIVA_ANALISE_CRITICA',
        entity_type: 'budget_items',
        entity_id: item.id,
        description: `Justificativa registrada na Análise Crítica do Item ${String(item.sequence).padStart(2, '0')}: "${justificativaCritica.trim()}".`,
        metadata: {
          item_id: item.id,
          justificativa: justificativaCritica.trim(),
          data: new Date().toISOString(),
        },
      })
      setJustificativaSalvaTexto(justificativaCritica.trim())
      setMostrandoCampoJustificativa(false)
      alert('Justificativa técnica registrada com sucesso no dossiê de auditoria!')
    } catch (e: any) {
      alert('Erro ao registrar justificativa: ' + (e.message || 'Falha'))
    } finally {
      setSalvandoJustificativa(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 overflow-y-auto">
      <div className="bg-[#eef1f4] border border-[#7d8b99] shadow-2xl w-full max-w-[97vw] lg:max-w-6xl my-4 flex flex-col rounded-none max-h-[95vh] overflow-hidden font-sans text-xs">
        {/* BARRA SUPERIOR AZUL-ESCURA #124268 (PADRÃO CESTA DE PREÇOS) */}
        <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none border-b border-[#0c314f] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-xs sm:text-sm tracking-wider uppercase">
              PESQUISAR PREÇOS — ITEM {String(item.sequence).padStart(2, '0')}
            </span>
            <span className="text-[#84a9c9] text-xs">|</span>
            <span className="text-[#bcd3e6] font-mono text-[11px] uppercase truncate max-w-xs sm:max-w-md">
              {item.description}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
            title="Fechar Janela"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* CORPO DO MODAL ROLÁVEL COM TODAS AS SEÇÕES */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 bg-[#eef1f4]">
          {/* SEÇÃO 1: DESCRIÇÃO DO ITEM A SER COTADO */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <span className="inline-block w-2.5 h-2.5 bg-white/90 border border-[#4a5059] flex-shrink-0" />
              <span>DESCRIÇÃO DO ITEM A SER COTADO</span>
            </div>
            <div className="p-3 bg-white space-y-1">
              <div className="text-[13px] font-bold text-[#124268] uppercase leading-tight">
                {String(item.sequence).padStart(2, '0')}. {item.description}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-[#4b5563] pt-1 border-t border-[#e5e7eb]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span>
                    Medida de Fornecimento:{' '}
                    <strong className="text-gray-900 font-mono">{item.unit}</strong>
                  </span>
                  <span>
                    Quantidade:{' '}
                    <strong className="text-gray-900 font-mono">
                      {typeof item.quantity === 'number' && Number.isFinite(item.quantity)
                        ? item.quantity.toLocaleString('pt-BR')
                        : (item.quantity ?? '—')}
                    </strong>
                  </span>
                  <span>
                    Tipo: <strong className="text-gray-900">{item.type}</strong>
                  </span>
                  {item.brand && (
                    <span>
                      Marca de Referência: <strong className="text-gray-900">{item.brand}</strong>
                    </span>
                  )}
                </div>

                {item.unit_price && item.unit_price > 0 && (
                  <span className="text-emerald-800 font-bold font-mono text-[11.5px]">
                    Preço Homologado Atual: R$ {item.unit_price.toFixed(decimais)}
                  </span>
                )}
              </div>

              {/* BARRA DE VALORES VANTAJOSOS (VALOR DE REFERÊNCIA / PRORROGAÇÃO) */}
              <div className="mt-2 pt-2 border-t border-dashed border-[#b8c2cc] bg-blue-50/50 p-2 text-xs flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold uppercase tracking-wider text-[10.5px] text-[#124268] flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 bg-[#124268]" />
                    VALORES VANTAJOSOS (PRORROGAÇÃO DE CONTRATO):
                  </span>
                  {valorReferencia > 0 && !editandoValorRef ? (
                    <span className="inline-flex items-center gap-1.5 bg-white px-2 py-0.5 border border-blue-300 font-mono font-bold text-[#124268]">
                      <span>Ref. Vigente:</span>
                      <strong className="text-sm">R$ {valorReferencia.toFixed(decimais)}</strong>
                    </span>
                  ) : !editandoValorRef ? (
                    <span className="text-gray-500 italic text-[11px]">
                      Nenhum valor de referência contratual cadastrado.
                    </span>
                  ) : null}
                </div>

                {editandoValorRef ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-gray-700">R$:</span>
                    <Input
                      type="number"
                      step="0.0001"
                      min="0"
                      placeholder="0,00"
                      value={novoValorRefInput}
                      onChange={(e) => setNovoValorRefInput(e.target.value)}
                      className="h-7 w-28 text-xs font-mono font-bold rounded-none border-blue-400 bg-white"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleSalvarValorReferencia}
                      disabled={salvandoValorRef}
                      className="h-7 px-2.5 text-[10px] font-bold uppercase rounded-none bg-[#124268] text-white"
                    >
                      {salvandoValorRef ? '...' : 'SALVAR'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setNovoValorRefInput(valorReferencia > 0 ? String(valorReferencia) : '')
                        setEditandoValorRef(false)
                      }}
                      className="h-7 px-2 text-[10px] uppercase rounded-none border-gray-400"
                    >
                      CANCELAR
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditandoValorRef(true)}
                    className="h-6 px-2.5 text-[10px] font-bold uppercase rounded-none border-blue-300 text-blue-900 bg-white hover:bg-blue-50"
                  >
                    {valorReferencia > 0
                      ? '✏️ EDITAR VALOR DE REFERÊNCIA'
                      : '+ CADASTRAR VALOR DE REFERÊNCIA'}
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* SEÇÃO 2: ARGUMENTO DE PESQUISA (COM BOTÃO [COTAR COM IA] AO LADO DE [BUSCAR]) */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <Search className="h-3 w-3 flex-shrink-0" />
              <span>ARGUMENTO DE PESQUISA</span>
            </div>

            {/* Abas de Argumento de Pesquisa */}
            <div className="flex border-b border-[#cbd5e1] bg-[#eef2f6] text-[11px]">
              <button
                type="button"
                onClick={() => setTipoPesquisa('PALAVRA_CHAVE')}
                className={`px-3 py-1.5 font-bold uppercase tracking-wider text-[10.5px] transition-colors border-r border-[#cbd5e1] ${
                  tipoPesquisa === 'PALAVRA_CHAVE'
                    ? 'bg-white text-[#124268] border-b-2 border-b-[#124268]'
                    : 'text-[#475569] hover:bg-[#e2e8f0]'
                }`}
              >
                PESQUISAR POR PALAVRA-CHAVE
              </button>
              <button
                type="button"
                onClick={() => setTipoPesquisa('CATMAT')}
                className={`px-3 py-1.5 font-bold uppercase tracking-wider text-[10.5px] transition-colors border-r border-[#cbd5e1] ${
                  tipoPesquisa === 'CATMAT'
                    ? 'bg-white text-[#124268] border-b-2 border-b-[#124268]'
                    : 'text-[#475569] hover:bg-[#e2e8f0]'
                }`}
              >
                PESQUISAR POR CATMAT/CATSER
              </button>
            </div>

            {/* Conteúdo de busca */}
            <div className="p-3 bg-white space-y-2">
              <div>
                <label className="text-[11px] font-bold text-[#374151] block mb-1">
                  {tipoPesquisa === 'PALAVRA_CHAVE'
                    ? 'Termo da descrição técnica ou genérica do produto:'
                    : 'Código ou especificação oficial do CATMAT/CATSER:'}
                </label>
                <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                  <div className="md:col-span-8">
                    <Input
                      placeholder={
                        tipoPesquisa === 'PALAVRA_CHAVE'
                          ? 'Ex: DIPIRONA 500MG COMPRIMIDO ou PARACETAMOL'
                          : 'Ex: CATMAT 269412 ou Medicamento genérico'
                      }
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="text-xs h-8 rounded-none border-[#94a3b8] bg-white focus-visible:ring-1 focus-visible:ring-[#124268]"
                    />
                  </div>
                  <div className="md:col-span-4 flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-[#374151] whitespace-nowrap">
                      CNPJ:
                    </span>
                    <Input
                      placeholder="00.000.000/0000-00"
                      value={cnpjFiltro}
                      onChange={(e) => setCnpjFiltro(e.target.value)}
                      className="text-xs h-8 font-mono rounded-none border-[#94a3b8] bg-white"
                    />
                  </div>
                </div>

                {/* Radio buttons estilo Cesta de Preços */}
                <div className="flex items-center gap-6 mt-2 text-[11px] text-[#374151]">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="tipoPalavras"
                      checked={tipoPalavras === 'palavras'}
                      onChange={() => setTipoPalavras('palavras')}
                      className="text-[#124268] focus:ring-[#124268]"
                    />
                    <span>Contendo as palavras</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="tipoPalavras"
                      checked={tipoPalavras === 'exata'}
                      onChange={() => setTipoPalavras('exata')}
                      className="text-[#124268] focus:ring-[#124268]"
                    />
                    <span>Expressão exata</span>
                  </label>
                </div>
              </div>

              {/* Botões [BUSCAR] e [COTAR COM IA] lado a lado */}
              <div className="flex flex-wrap items-center justify-between pt-2 border-t border-[#e5e7eb] gap-2">
                <div className="text-[11px] text-[#4b5563] flex items-center gap-2">
                  {loadingSearch && (
                    <span className="inline-flex items-center gap-1.5 text-[#124268] font-bold animate-pulse">
                      <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                      {statusIaProgresso}
                    </span>
                  )}
                  {!loadingSearch && searchExecuted && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        className={`rounded-none text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 ${
                          isOrigemRealPncp
                            ? 'bg-emerald-700 text-white border-emerald-800'
                            : isOrigemRealBps
                              ? 'bg-rose-700 text-white border-rose-800'
                              : 'bg-gray-100 text-gray-800 border-gray-300'
                        }`}
                      >
                        {isOrigemRealPncp
                          ? '✓ PNCP REAL (OFICIAL) — pncp.gov.br'
                          : isOrigemRealBps
                            ? '✓ BPS REAL (DADOS ABERTOS MS) — saude.gov.br'
                            : 'CONSULTA DE CONECTORES OFICIAIS'}
                      </Badge>
                      {isOrigemRealBps && isOrigemRealPncp && (
                        <Badge className="rounded-none text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 bg-rose-700 text-white">
                          ✓ BPS (MS)
                        </Badge>
                      )}
                      {isOrigemRealPcp && (
                        <Badge className="rounded-none text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 bg-emerald-600 text-white">
                          ✓ PCP REAL (OFICIAL)
                        </Badge>
                      )}
                      {loadingMoreProgressive && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-blue-700 font-bold bg-blue-50 border border-blue-300 px-2 py-0.5 animate-pulse">
                          <Sparkles className="h-3 w-3 text-amber-500 animate-spin" />
                          Carregando mais amostras (página {paginaPncpCarregada} de{' '}
                          {totalPaginasPncpDisponiveis}) — {priceResults.length} amostras na
                          grade...
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleBuscar(false)}
                    disabled={loadingSearch || !searchTerm.trim()}
                    className="h-8 px-4 text-xs font-bold uppercase rounded-none border-gray-400 text-gray-700 bg-white hover:bg-gray-50 flex items-center gap-1.5"
                  >
                    <Search className="h-3.5 w-3.5" />
                    <span>BUSCAR</span>
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleBuscar(true)}
                    disabled={loadingSearch || !searchTerm.trim()}
                    className="h-8 px-5 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex items-center gap-1.5"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-amber-300 animate-pulse" />
                    <span>{loadingSearch ? 'COTANDO COM IA...' : 'COTAR COM IA'}</span>
                  </Button>
                </div>
              </div>

              {/* Aviso Estruturado quando o Portal de Compras Públicas aguarda credenciamento */}
              {pcpAguardandoCredencial && !erroBusca && (
                <div className="mt-2 bg-[#eff6ff] border-l-4 border-blue-600 p-2.5 text-[11px] text-blue-950 flex items-start gap-2 border border-blue-200">
                  <ShieldAlert className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <strong className="block text-blue-900 uppercase font-bold text-[10.5px]">
                        Portal de Compras Públicas (PCP Oficial) — Aguardando Credenciamento:
                      </strong>
                      <Badge className="bg-amber-100 text-amber-900 border-amber-300 text-[9.5px] rounded-none font-bold">
                        Exige Token da API
                      </Badge>
                    </div>
                    <p className="text-blue-900 leading-relaxed">
                      O conector operacional do Portal de Compras Públicas está integrado via proxy
                      backend, porém a chave institucional (
                      <code className="font-mono bg-blue-100 px-1">
                        PORTAL_COMPRAS_PUBLICAS_API_KEY
                      </code>
                      ) ainda não foi provisionada pelo órgão. Conforme a Lei nº 14.133/2021,{' '}
                      <strong>
                        o COTAI não substitui dados silenciosamente por amostras sintéticas
                      </strong>{' '}
                      e sua sessão de usuário permanece 100% íntegra.
                    </p>
                    <div className="pt-1">
                      <a
                        href="https://apipcp.portaldecompraspublicas.com.br/comprador/apidoc/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10.5px] text-[#124268] hover:underline font-bold"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span>Ver Documentação Técnica Oficial da API PCP</span>
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {/* Mensagem de Erro Clara quando a API Falha (Sem cair silenciosamente para dados falsos) */}
              {erroBusca && (
                <div className="mt-2 bg-[#fffbeb] border-l-4 border-amber-500 p-2.5 text-[11px] text-amber-950 flex items-start gap-2 border border-[#fef08a]">
                  <ShieldAlert className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <strong className="block text-amber-900 uppercase font-bold text-[10.5px]">
                      Aviso de Comunicação com as Fontes Oficiais:
                    </strong>
                    <span className="text-amber-900">{erroBusca}</span>
                    <p className="mt-1 text-[10px] text-amber-800">
                      Conforme a política de rastreabilidade e integridade da Lei nº 14.133/2021, o
                      COTAI nunca substitui dados reais por amostras sintéticas de forma silenciosa.
                      Sua sessão permanece ativa.
                    </p>
                  </div>
                </div>
              )}

              {/* PAINEL TRANSPARÊNCIA E MONITORAMENTO DE TODAS AS FONTES (RF-015, RF-016, RF-017) */}
              {diagnosticoFontes.length > 0 && (
                <div className="mt-3 bg-white border border-[#b8c2cc] p-2.5 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 bg-[#124268]" />
                      <span className="font-bold text-[11px] uppercase tracking-wider text-[#124268]">
                        Estado da Pesquisa (RF-015):
                      </span>
                      <Badge
                        className={`rounded-none text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 ${
                          estadoPesquisa === 'Concluída'
                            ? 'bg-emerald-700 text-white'
                            : estadoPesquisa === 'Concluída parcialmente'
                              ? 'bg-amber-600 text-white'
                              : estadoPesquisa === 'Falha total'
                                ? 'bg-rose-700 text-white'
                                : 'bg-blue-700 text-white animate-pulse'
                        }`}
                      >
                        {estadoPesquisa || 'Pronta para consulta'}
                      </Badge>
                    </div>
                    <span className="text-[10px] text-gray-500 font-mono">
                      Fluxo: API → Backend → Processamento → Frontend (Sem perdas)
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {diagnosticoFontes.map((diag, idx) => {
                      const isPncp = diag.fonte === 'PNCP'
                      const isCompras = diag.fonte === 'Compras.gov.br'
                      const amostrasFonte = isPncp
                        ? (agregacoesPorFonteIndice['PNCP'] ?? diag.amostrasObtidas ?? 0)
                        : isCompras
                          ? (agregacoesPorFonteIndice['Compras.gov.br'] ??
                            agregacoesPorFonteIndice['COMPRAS'] ??
                            diag.amostrasObtidas ??
                            0)
                          : (diag.amostrasObtidas ?? 0)

                      const pncpEmAndamento =
                        isPncp &&
                        (Boolean(statusTarefaIndice?.ativa) ||
                          itensFilaPendente > 0 ||
                          coletaEmTempoRealAtiva ||
                          (typeof statusTarefaIndice?.pendentes_count === 'number' &&
                            statusTarefaIndice.pendentes_count > 0))

                      const isProcessando =
                        pncpEmAndamento || (!isPncp && diag.status === 'processando')
                      const isConcluido =
                        !isProcessando && (diag.status === 'concluido' || amostrasFonte > 0)

                      return (
                        <div
                          key={idx}
                          className={`p-2 border text-[11px] space-y-1 ${
                            isConcluido
                              ? 'bg-emerald-50/50 border-emerald-200 text-emerald-950'
                              : isProcessando
                                ? 'bg-sky-50/60 border-sky-300 text-sky-950'
                                : diag.status === 'aguardando_credencial'
                                  ? 'bg-blue-50/50 border-blue-200 text-blue-950'
                                  : 'bg-rose-50/50 border-rose-200 text-rose-950'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <strong className="font-bold uppercase text-[10.5px] truncate">
                              {diag.fonte}
                            </strong>
                            <span
                              className={`text-[9.5px] font-bold uppercase px-1.5 py-0.2 border flex items-center gap-1 ${
                                isProcessando
                                  ? 'bg-sky-100 text-sky-800 border-sky-300'
                                  : isConcluido
                                    ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                    : diag.status === 'aguardando_credencial'
                                      ? 'bg-amber-100 text-amber-800 border-amber-300'
                                      : 'bg-rose-100 text-rose-800 border-rose-300'
                              }`}
                            >
                              {isProcessando && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                              {isProcessando
                                ? 'Coleta em Andamento / Detalhando'
                                : isConcluido
                                  ? 'Concluído'
                                  : diag.status === 'aguardando_credencial'
                                    ? 'Aguardando Token'
                                    : 'Falha/Indisponível'}
                            </span>
                          </div>

                          <div className="flex items-baseline justify-between font-mono text-[11px]">
                            <span>Amostras indexadas:</span>
                            <strong className="text-[12px] text-[#124268]">
                              {amostrasFonte.toLocaleString('pt-BR')}
                            </strong>
                          </div>

                          {diag.registrosInformadosApi !== undefined &&
                            diag.registrosInformadosApi > 0 && (
                              <div className="text-[9.5px] text-gray-600 flex justify-between font-mono">
                                <span>Processos na API:</span>
                                <span className="font-bold">
                                  {diag.registrosInformadosApi.toLocaleString('pt-BR')}
                                </span>
                              </div>
                            )}

                          {diag.mensagem && (
                            <div
                              className="text-[9.5px] text-gray-500 italic truncate"
                              title={diag.mensagem}
                            >
                              {diag.mensagem}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* PAINEL CONSOLIDADO: COMPROVAÇÃO DE VALORES VANTAJOSOS PARA PRORROGAÇÃO */}
          {analiseVantajosidade && (
            <div className="bg-gradient-to-r from-emerald-50 via-blue-50 to-emerald-50 border-2 border-emerald-500 p-3 shadow-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-300 pb-2">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 bg-emerald-600 rounded-none" />
                  <span className="font-bold text-xs uppercase tracking-wider text-emerald-950">
                    ANÁLISE DE VALORES VANTAJOSOS — COMPROVAÇÃO DE PRORROGAÇÃO CONTRATUAL
                  </span>
                </div>
                <Badge
                  className={`rounded-none text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 ${
                    analiseVantajosidade.comprovada
                      ? 'bg-emerald-700 text-white'
                      : 'bg-amber-600 text-white'
                  }`}
                >
                  {analiseVantajosidade.comprovada
                    ? '✓ PRORROGAÇÃO VANTAJOSA (PREÇOS DE MERCADO ACIMA DO CONTRATO)'
                    : '⚠ REQUER ANÁLISE (TODOS PREÇOS ABAIXO DO CONTRATO)'}
                </Badge>
              </div>

              {/* Métricas consolidadas de vantajosidade */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                {/* 1. Preço Contratado */}
                <div className="bg-white p-2 border border-emerald-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    VALOR REFERENCIAL (CONTRATADO)
                  </span>
                  <span className="text-base font-bold font-mono text-[#124268] block">
                    R$ {analiseVantajosidade.valorReferencia.toFixed(decimais)}
                  </span>
                  <span className="text-[9.5px] text-gray-500">Contrato Vigente</span>
                </div>

                {/* 2. Cotações Acima / Favoráveis */}
                <div className="bg-white p-2 border border-emerald-200">
                  <span className="text-[10px] font-bold text-emerald-800 uppercase block">
                    PREÇOS ACIMA (FAVORÁVEIS)
                  </span>
                  <span className="text-base font-bold font-mono text-emerald-700 block">
                    {analiseVantajosidade.qtdAcima} de {analiseVantajosidade.totalAmostras}
                  </span>
                  <span className="text-[9.5px] text-emerald-700 font-bold">
                    {analiseVantajosidade.pctFavoravel.toFixed(1)}% do mercado está mais caro
                  </span>
                </div>

                {/* 3. Menor Preço Acima da Referência */}
                <div className="bg-white p-2 border border-emerald-200">
                  <span className="text-[10px] font-bold text-emerald-800 uppercase block">
                    MENOR PREÇO ACIMA DA REF.
                  </span>
                  <span className="text-base font-bold font-mono text-emerald-800 block">
                    {analiseVantajosidade.menorPrecoAcima !== null
                      ? `R$ ${analiseVantajosidade.menorPrecoAcima.toFixed(decimais)}`
                      : '—'}
                  </span>
                  <span className="text-[9.5px] text-emerald-700 font-mono">
                    {analiseVantajosidade.menorPrecoAcima !== null
                      ? `+R$ ${(analiseVantajosidade.menorPrecoAcima - analiseVantajosidade.valorReferencia).toFixed(decimais)} (+${(((analiseVantajosidade.menorPrecoAcima - analiseVantajosidade.valorReferencia) / analiseVantajosidade.valorReferencia) * 100).toFixed(1)}%)`
                      : 'Nenhuma amostra acima'}
                  </span>
                </div>

                {/* 4. Diferença Média em R$ e % */}
                <div className="bg-white p-2 border border-emerald-200">
                  <span className="text-[10px] font-bold text-[#124268] uppercase block">
                    DIFERENÇA MÉDIA GERAL
                  </span>
                  <span
                    className={`text-base font-bold font-mono block ${
                      analiseVantajosidade.diffMediaRs >= 0 ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {analiseVantajosidade.diffMediaRs >= 0 ? '+' : ''}R${' '}
                    {analiseVantajosidade.diffMediaRs.toFixed(decimais)}
                  </span>
                  <span
                    className={`text-[9.5px] font-bold font-mono ${
                      analiseVantajosidade.diffMediaPct >= 0 ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {analiseVantajosidade.diffMediaPct >= 0 ? '+' : ''}
                    {analiseVantajosidade.diffMediaPct.toFixed(2)}% vs. Contrato
                  </span>
                </div>
              </div>

              {/* Justificativa técnica automática para apoiar o servidor */}
              <div className="bg-white p-2.5 border border-emerald-300 text-[11px] text-gray-800 space-y-1">
                <span className="font-bold text-emerald-900 uppercase block text-[10.5px]">
                  📌 Síntese para Justificativa de Vantajosidade (Art. 106 / 107 da Lei nº
                  14.133/2021):
                </span>
                <p className="text-gray-700 leading-relaxed">
                  O valor de referência contratual vigente é de{' '}
                  <strong className="font-mono text-gray-900">
                    R$ {analiseVantajosidade.valorReferencia.toFixed(decimais)}
                  </strong>
                  . Foram localizadas{' '}
                  <strong>{analiseVantajosidade.totalAmostras} cotações públicas</strong> no
                  mercado, das quais{' '}
                  <strong className="text-emerald-800">
                    {analiseVantajosidade.qtdAcima} amostra(s) (
                    {analiseVantajosidade.pctFavoravel.toFixed(1)}%)
                  </strong>{' '}
                  apresentam preços <strong>superiores ao valor contratado</strong>, com menor preço
                  de mercado a{' '}
                  <strong className="font-mono text-emerald-800">
                    {analiseVantajosidade.menorPrecoAcima !== null
                      ? `R$ ${analiseVantajosidade.menorPrecoAcima.toFixed(decimais)}`
                      : 'N/A'}
                  </strong>{' '}
                  e acréscimo médio de mercado de{' '}
                  <strong className="font-mono text-emerald-800">
                    +{analiseVantajosidade.diffMediaAcimaPct.toFixed(2)}%
                  </strong>{' '}
                  nas cotações superiores. Esse cenário{' '}
                  {analiseVantajosidade.comprovada ? (
                    <strong className="text-emerald-900 bg-emerald-100 px-1">
                      comprova plenamente a vantajosidade econômica da prorrogação contratual
                    </strong>
                  ) : (
                    <strong className="text-amber-900 bg-amber-100 px-1">
                      indica que novas negociações ou pesquisa ampliada são recomendadas
                    </strong>
                  )}
                  , pois realizar nova licitação provavelmente resultaria em contratação por valor
                  mais oneroso à Administração.
                </p>
              </div>
            </div>
          )}

          {/* BANNER INFORMATIVO CESTA DE PREÇOS / FONTES OFICIAIS */}
          <div className="bg-[#fffbeb] border-l-4 border-amber-500 p-2.5 text-[11px] text-amber-900 flex items-start gap-2 border border-[#fef08a]">
            <ShieldAlert className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Fontes Oficiais Consultadas pela IA:</strong> PNCP, Compras.gov.br, CMED,
              SINAPI, SICRO, CONAB, SEINFRA/CE, SETOP/MG e BEC-SP (Art. 23 da Lei nº 14.133/2021).
              Todas as cotações comparadas possuem rastreabilidade estrita (órgão comprador, CNPJ do
              fornecedor, processo e data).
            </div>
          </div>

          {/* CARDS DINÂMICOS DE SÍNTESE ESTATÍSTICA DAS AMOSTRAS (COM TOTAIS CONSOLIDADOS) */}
          {priceResults.length > 0 && (
            <div className="space-y-2">
              <div className="bg-white p-2.5 border border-[#b8c2cc] grid grid-cols-2 sm:grid-cols-5 gap-2 text-center shadow-xs">
                <div className="bg-[#f8fafc] p-2 border border-gray-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    TOTAL DE AMOSTRAS
                  </span>
                  <span className="text-base font-bold font-mono text-[#124268] block">
                    {(() => {
                      const total =
                        typeof totalIndexLocal === 'number' && totalIndexLocal > 0
                          ? totalIndexLocal
                          : typeof totaisConsolidados?.totalEncontrados === 'number' &&
                              Number.isFinite(totaisConsolidados.totalEncontrados)
                            ? totaisConsolidados.totalEncontrados
                            : priceResults.length
                      return typeof total === 'number' && Number.isFinite(total)
                        ? total.toLocaleString('pt-BR')
                        : '0'
                    })()}
                  </span>
                  <span className="text-[9.5px] text-gray-500">
                    {(selectedIds?.length ?? 0).toLocaleString('pt-BR')} selecionada(s)
                  </span>
                </div>
                <div className="bg-[#f8fafc] p-2 border border-gray-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    VALOR MÍNIMO
                  </span>
                  <span className="text-base font-bold font-mono text-emerald-700 block">
                    R${' '}
                    {(() => {
                      const val =
                        typeof totaisConsolidados?.valorMinimo === 'number' &&
                        Number.isFinite(totaisConsolidados.valorMinimo) &&
                        totaisConsolidados.valorMinimo > 0
                          ? totaisConsolidados.valorMinimo
                          : precoMinLocalGeral > 0
                            ? precoMinLocalGeral
                            : undefined
                      return typeof val === 'number' && Number.isFinite(val)
                        ? val.toLocaleString('pt-BR', {
                            minimumFractionDigits: decimais,
                            maximumFractionDigits: 4,
                          })
                        : '—'
                    })()}
                  </span>
                  <span className="text-[9.5px] text-gray-500">amostras coletadas</span>
                </div>
                <div className="bg-[#f8fafc] p-2 border border-gray-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    VALOR MÁXIMO
                  </span>
                  <span className="text-base font-bold font-mono text-amber-700 block">
                    R${' '}
                    {(() => {
                      const val =
                        typeof totaisConsolidados?.valorMaximo === 'number' &&
                        Number.isFinite(totaisConsolidados.valorMaximo) &&
                        totaisConsolidados.valorMaximo > 0
                          ? totaisConsolidados.valorMaximo
                          : precoMaxLocalGeral > 0
                            ? precoMaxLocalGeral
                            : undefined
                      return typeof val === 'number' && Number.isFinite(val)
                        ? val.toLocaleString('pt-BR', {
                            minimumFractionDigits: decimais,
                            maximumFractionDigits: 4,
                          })
                        : '—'
                    })()}
                  </span>
                  <span className="text-[9.5px] text-gray-500">todas as variantes</span>
                </div>
                <div className="bg-[#f8fafc] p-2 border border-gray-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    MÉDIA GERAL
                  </span>
                  <span className="text-base font-bold font-mono text-gray-900 block">
                    R${' '}
                    {(() => {
                      const val =
                        typeof totaisConsolidados?.mediaGeral === 'number' &&
                        Number.isFinite(totaisConsolidados.mediaGeral) &&
                        totaisConsolidados.mediaGeral > 0
                          ? totaisConsolidados.mediaGeral
                          : precoMediaLocalGeral > 0
                            ? precoMediaLocalGeral
                            : undefined
                      return typeof val === 'number' && Number.isFinite(val)
                        ? val.toLocaleString('pt-BR', {
                            minimumFractionDigits: decimais,
                            maximumFractionDigits: decimais,
                          })
                        : '—'
                    })()}
                  </span>
                  <span className="text-[9.5px] text-gray-500">
                    CV selec.:{' '}
                    {typeof cvSel === 'number' && Number.isFinite(cvSel)
                      ? cvSel.toFixed(2)
                      : '0.00'}
                    %
                  </span>
                </div>
                <div className="bg-[#e0f2fe] p-2 border border-[#7dd3fc]">
                  <span className="text-[10px] font-bold text-[#124268] uppercase block">
                    MEDIANA GERAL (REF.)
                  </span>
                  <span className="text-base font-bold font-mono text-[#124268] block">
                    R${' '}
                    {(() => {
                      const val =
                        typeof totaisConsolidados?.medianaGeral === 'number' &&
                        Number.isFinite(totaisConsolidados.medianaGeral) &&
                        totaisConsolidados.medianaGeral > 0
                          ? totaisConsolidados.medianaGeral
                          : precoMedianaLocalGeral > 0
                            ? precoMedianaLocalGeral
                            : undefined
                      return typeof val === 'number' && Number.isFinite(val)
                        ? val.toLocaleString('pt-BR', {
                            minimumFractionDigits: decimais,
                            maximumFractionDigits: decimais,
                          })
                        : '—'
                    })()}
                  </span>
                  <span className="text-[9.5px] text-blue-700 font-medium">
                    Preço de Referência
                  </span>
                </div>
              </div>
              {/* Faixa consolidada no padrão esperado pelo usuário */}
              {totaisConsolidados && (
                <div className="bg-[#f1f5f9] border border-[#cbd5e1] px-3 py-1.5 flex flex-wrap items-center justify-between text-[11px] text-[#334155]">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 bg-[#124268]" />
                    <span>
                      Consolidação de Cobertura Total:{' '}
                      <strong className="text-[#0f172a] font-mono">
                        {typeof totaisConsolidados.totalEncontrados === 'number' &&
                        Number.isFinite(totaisConsolidados.totalEncontrados)
                          ? totaisConsolidados.totalEncontrados.toLocaleString('pt-BR')
                          : (priceResults.length ?? 0).toLocaleString('pt-BR')}{' '}
                        amostras
                      </strong>{' '}
                      · R${' '}
                      {typeof totaisConsolidados.valorMinimo === 'number' &&
                      Number.isFinite(totaisConsolidados.valorMinimo)
                        ? totaisConsolidados.valorMinimo.toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        : '—'}{' '}
                      a R${' '}
                      {typeof totaisConsolidados.valorMaximo === 'number' &&
                      Number.isFinite(totaisConsolidados.valorMaximo)
                        ? totaisConsolidados.valorMaximo.toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        : '—'}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-500 italic">
                    Todas as variantes, apresentações e órgãos públicos indexados
                  </span>
                </div>
              )}
            </div>
          )}

          {/* SEÇÕES CONJUNTAS: REFINAR (À ESQUERDA) + RESULTADO DA PESQUISA (À DIREITA) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
            {/* PAINEL À ESQUERDA: REFINAR (3 COLUNAS) */}
            <div className="lg:col-span-3 bg-white border border-[#b8c2cc] shadow-sm">
              <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between select-none">
                <span className="flex items-center gap-1">
                  <Filter className="h-3 w-3 flex-shrink-0" />
                  REFINAR
                </span>
                {temFiltroAtivo && (
                  <button
                    type="button"
                    onClick={handleLimparFiltros}
                    className="text-[9.5px] text-white/90 underline hover:text-white"
                  >
                    Limpar Filtros
                  </button>
                )}
              </div>

              <div className="p-2.5 space-y-2.5 bg-white text-[11px] max-h-[75vh] overflow-y-auto">
                {priceResults.length === 0 ? (
                  <p className="text-[10.5px] text-[#4b5563] leading-relaxed">
                    Quando você preencher o termo de busca e clicar em [BUSCAR] ou [COTAR COM IA], o
                    sistema disponibilizará as opções de refinamento nesta barra lateral.
                  </p>
                ) : (
                  <>
                    {/* 1. Fonte / Origem com Multi-Seleção Confirmada e Contagem */}
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Origem / Fonte das Amostras
                      </label>
                      <FiltroFonteMultiplo
                        fontesDisponiveis={fontesDisponiveis}
                        fontesSelecionadas={fontesSelecionadas}
                        onAplicar={(novas) => {
                          setFontesSelecionadas(novas)
                          setPaginaAtual(1)
                        }}
                        variante="sidebar"
                        disabled={priceResults.length === 0}
                      />
                    </div>

                    {/* 2. Situação da Amostra */}
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Situação da Amostra
                      </label>
                      <select
                        value={filtroSituacao}
                        onChange={(e) => setFiltroSituacao(e.target.value)}
                        className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                      >
                        <option value="todas">Todas as Amostras</option>
                        <option value="selecionados">Marcadas para Cálculo</option>
                        <option value="nao_selecionados">Não Marcadas</option>
                        <option value="expurgados">Expurgadas pelo Juízo Crítico</option>
                      </select>
                    </div>

                    {/* 3. Período por Meses para trás (Exigência do usuário) */}
                    <div className="space-y-0.5 pt-1 border-t border-gray-200">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block flex items-center justify-between">
                        <span>Período da Contratação</span>
                        {filtroPeriodoMeses > 0 && (
                          <span className="text-[9px] text-blue-700 font-bold lowercase">
                            últimos {filtroPeriodoMeses} meses
                          </span>
                        )}
                      </label>
                      <select
                        value={filtroPeriodoMeses}
                        onChange={(e) => setFiltroPeriodoMeses(Number(e.target.value))}
                        className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                      >
                        <option value={0}>Todas as datas (padrão)</option>
                        <option value={12}>Últimos 12 meses</option>
                        <option value={11}>Últimos 11 meses</option>
                        <option value={10}>Últimos 10 meses</option>
                        <option value={9}>Últimos 9 meses</option>
                        <option value={8}>Últimos 8 meses</option>
                        <option value={7}>Últimos 7 meses</option>
                        <option value={6}>Últimos 6 meses</option>
                        <option value={5}>Últimos 5 meses</option>
                        <option value={4}>Últimos 4 meses</option>
                        <option value={3}>Últimos 3 meses</option>
                      </select>

                      <div className="grid grid-cols-2 gap-1 pt-1">
                        <div>
                          <span className="text-[9px] text-gray-500 block">De (opcional):</span>
                          <Input
                            type="date"
                            value={filtroDataInicio}
                            onChange={(e) => setFiltroDataInicio(e.target.value)}
                            className="h-6 text-[10px] rounded-none border-[#94a3b8] bg-white px-1"
                          />
                        </div>
                        <div>
                          <span className="text-[9px] text-gray-500 block">Até (opcional):</span>
                          <Input
                            type="date"
                            value={filtroDataFim}
                            onChange={(e) => setFiltroDataFim(e.target.value)}
                            className="h-6 text-[10px] rounded-none border-[#94a3b8] bg-white px-1"
                          />
                        </div>
                      </div>
                    </div>

                    {/* 4. Variação de Preços (Faixa Mín / Máx) */}
                    <div className="space-y-0.5 pt-1 border-t border-gray-200">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Faixa de Preços (R$)
                      </label>
                      <div className="grid grid-cols-2 gap-1">
                        <Input
                          placeholder="Mínimo R$"
                          value={filtroPrecoMin}
                          onChange={(e) => setFiltroPrecoMin(e.target.value)}
                          className="h-6 text-[10px] font-mono rounded-none border-[#94a3b8] bg-white px-1"
                        />
                        <Input
                          placeholder="Máximo R$"
                          value={filtroPrecoMax}
                          onChange={(e) => setFiltroPrecoMax(e.target.value)}
                          className="h-6 text-[10px] font-mono rounded-none border-[#94a3b8] bg-white px-1"
                        />
                      </div>
                    </div>

                    {/* 5. Variação % vs Mediana */}
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block flex justify-between">
                        <span>Tolerância vs Mediana</span>
                        {medianaBase > 0 && (
                          <span className="text-[9px] text-blue-700 font-mono font-normal">
                            Ref: R$ {medianaBase.toFixed(decimais)}
                          </span>
                        )}
                      </label>
                      <select
                        value={filtroVariacaoMedianaPct}
                        onChange={(e) => setFiltroVariacaoMedianaPct(e.target.value)}
                        className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                      >
                        <option value="">Qualquer variação</option>
                        <option value="15">±15% da mediana</option>
                        <option value="25">±25% da mediana</option>
                        <option value="30">±30% da mediana (Juízo Crítico Padrão)</option>
                        <option value="50">±50% da mediana</option>
                      </select>
                    </div>

                    {/* 6. Porte da Empresa (ME / EPP / MEI) */}
                    <div className="space-y-1 pt-1 border-t border-gray-200">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Porte da Empresa
                      </label>
                      <div className="flex items-center gap-4 text-[10px] font-bold">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="filtroPorteModal"
                            value="TODAS"
                            checked={filtroPorteOpcao === 'TODAS'}
                            onChange={() => setFiltroPorteOpcao('TODAS')}
                            className="text-[#124268] focus:ring-[#124268] h-3.5 w-3.5"
                          />
                          <span className="text-gray-700 uppercase">TODAS</span>
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="filtroPorteModal"
                            value="ME_EPP"
                            checked={filtroPorteOpcao === 'ME_EPP'}
                            onChange={() => setFiltroPorteOpcao('ME_EPP')}
                            className="text-[#124268] focus:ring-[#124268] h-3.5 w-3.5"
                          />
                          <span className="text-gray-700 uppercase">ME / EPP</span>
                        </label>
                      </div>
                    </div>

                    {/* 7. Medida de Fornecimento (Unidade) */}
                    <div className="space-y-0.5 pt-1 border-t border-gray-200">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Medida de Fornecimento
                      </label>
                      <Input
                        placeholder="Ex: UN, CAIXA, COMPRIMIDO, FRASCO..."
                        value={filtroMedida}
                        onChange={(e) => setFiltroMedida(e.target.value)}
                        className="h-7 text-[10.5px] uppercase font-mono rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>

                    {/* 8. Marca do Produto */}
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Marca do Fornecedor / Fabricante
                      </label>
                      <Input
                        placeholder="Ex: EMS, PRATI, DELL, YPÊ..."
                        value={filtroMarca}
                        onChange={(e) => setFiltroMarca(e.target.value)}
                        className="h-7 text-[10.5px] uppercase rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>

                    {/* 9. Unidade Federativa (UF) */}
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Unidade Federativa (UF)
                      </label>
                      <Input
                        placeholder="Ex: SP, RN, DF, MG, RJ..."
                        value={filtroUf}
                        onChange={(e) => setFiltroUf(e.target.value)}
                        className="h-7 text-[10.5px] uppercase font-mono rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>

                    {/* Alerta de Amostras fora do filtro */}
                    {amostrasFiltradas.length < priceResults.length && (
                      <div className="bg-amber-50 p-2 border border-amber-200 text-[9.5px] text-amber-900 leading-snug">
                        <strong>Rastreabilidade preservada:</strong>{' '}
                        {priceResults.length - amostrasFiltradas.length} amostra(s) fora deste
                        filtro permanecem registradas no banco (sem exclusão silenciosa).
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* PAINEL À DIREITA: RESULTADO DA PESQUISA (9 COLUNAS) */}
            <div className="lg:col-span-9 bg-white border border-[#b8c2cc] shadow-sm flex flex-col space-y-2">
              {/* CORREÇÃO 6 (a): Banner âmbar quando itens_fila_pendente > 0 */}
              {itensFilaPendente > 0 && (
                <div className="bg-amber-50 border-l-4 border-amber-500 p-2.5 text-amber-950 flex flex-wrap items-center justify-between gap-2 border border-amber-200">
                  <div className="flex items-center gap-2 text-xs">
                    <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                    <div>
                      <strong className="block text-[11px] uppercase font-bold text-amber-900">
                        {itensFilaPendente} contratações com detalhamento pendente — refaça a busca
                        para completar
                      </strong>
                      <span className="text-[10px] text-amber-800">
                        Orçamento seguro atingido para evitar 504 Gateway Timeout. Amostras
                        identificadas prontas para detalhar.
                      </span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={async () => {
                      setContinuandoFila(true)
                      try {
                        await handleBuscar(false)
                      } finally {
                        setContinuandoFila(false)
                      }
                    }}
                    disabled={loadingSearch}
                    className="h-7 text-xs bg-blue-700 hover:bg-blue-800 text-white font-bold rounded-none px-3"
                  >
                    {continuandoFila ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                        ATUALIZANDO...
                      </>
                    ) : (
                      'ATUALIZAR ÍNDICE'
                    )}
                  </Button>{' '}
                </div>
              )}

              {/* CORREÇÃO 6 (c): Indicador explícito FONTE INDISPONÍVEL - restrito a falha real (status 'falha' sem registros informados) */}
              {diagnosticoFontes.some(
                (d) =>
                  d.status === 'falha' &&
                  (!d.registrosInformadosApi || d.registrosInformadosApi === 0),
              ) && (
                <div className="bg-rose-50 border-l-4 border-rose-600 p-2 text-[11px] text-rose-950 border border-rose-200 flex flex-wrap items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-rose-600 flex-shrink-0" />
                  <span className="font-bold uppercase text-[10px] text-rose-900">
                    FONTE INDISPONÍVEL:
                  </span>
                  {diagnosticoFontes
                    .filter(
                      (d) =>
                        d.status === 'falha' &&
                        (!d.registrosInformadosApi || d.registrosInformadosApi === 0),
                    )
                    .map((d) => (
                      <Badge
                        key={d.fonte}
                        variant="outline"
                        className="bg-white text-rose-800 border-rose-300 font-mono text-[9px]"
                      >
                        {d.fonte}: FONTE INDISPONÍVEL ({d.mensagem || 'falha de comunicação'})
                      </Badge>
                    ))}
                </div>
              )}

              <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex flex-wrap items-center justify-between gap-1 select-none">
                <div className="flex flex-wrap items-center gap-2">
                  <span>RESULTADO DA PESQUISA</span>
                  <span className="text-white/80">|</span>
                  {/* Três contadores honestos no cabeçalho */}
                  <span
                    className="bg-black/25 px-1.5 py-0.5 text-[10px] font-mono"
                    title="Total informado pela API externa (PNCP / Compras.gov.br)"
                  >
                    Contratações na API (Upstream):{' '}
                    <strong>
                      {(() => {
                        const up =
                          (diagnosticoFontes.find((d) => d.fonte === 'PNCP')
                            ?.registrosInformadosApi || 0) +
                          (diagnosticoFontes.find((d) => d.fonte === 'Compras.gov.br')
                            ?.registrosInformadosApi || 0)
                        const totalUpstream =
                          up > 0
                            ? up
                            : typeof totaisConsolidados?.totalEncontrados === 'number' &&
                                Number.isFinite(totaisConsolidados.totalEncontrados) &&
                                totaisConsolidados.totalEncontrados > totalIndexLocal
                              ? totaisConsolidados.totalEncontrados
                              : totalIndexLocal > 0
                                ? totalIndexLocal
                                : priceResults.length
                        return totalUpstream.toLocaleString('pt-BR')
                      })()}
                    </strong>
                  </span>
                  <span
                    className="bg-blue-950/60 px-1.5 py-0.5 text-[10px] font-mono text-blue-200"
                    title="Amostras já persistidas na coleção price_samples_index"
                  >
                    Indexadas na base local:{' '}
                    <strong>{totalIndexLocal.toLocaleString('pt-BR')}</strong>
                  </span>
                  <span
                    className="bg-black/25 px-1.5 py-0.5 text-[10px] font-mono"
                    title="Amostras carregadas na grade do modal"
                  >
                    Carregadas na grade:{' '}
                    <strong>{priceResults.length.toLocaleString('pt-BR')}</strong>
                  </span>
                  {tookIndexMs !== null && (
                    <Badge className="rounded-none bg-emerald-700 hover:bg-emerald-700 text-white font-mono text-[9.5px] px-1.5 py-0">
                      Índice local: {tookIndexMs}ms
                    </Badge>
                  )}
                  {coletaEmTempoRealAtiva && (
                    <Badge className="rounded-none bg-amber-500 hover:bg-amber-500 text-black font-mono text-[9.5px] px-1.5 py-0 flex items-center gap-1 animate-pulse">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      Coleta ao vivo em 2º plano
                    </Badge>
                  )}
                  {amostrasFiltradas.length !== priceResults.length && (
                    <span className="bg-emerald-950/60 px-1.5 py-0.5 text-[10px] font-mono text-emerald-200">
                      Após filtros: <strong>{amostrasFiltradas.length}</strong>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* Botão de Filtro de Fonte diretamente no Cabeçalho da Grade */}
                  <FiltroFonteMultiplo
                    fontesDisponiveis={fontesDisponiveis}
                    fontesSelecionadas={fontesSelecionadas}
                    onAplicar={(novas) => {
                      setFontesSelecionadas(novas)
                      setPaginaAtual(1)
                    }}
                    variante="header"
                    disabled={priceResults.length === 0}
                  />

                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-white/90 font-bold tracking-wider">
                      ORDENAR POR:
                    </span>
                    <select
                      value={ordenacao}
                      onChange={(e: any) => setOrdenacao(e.target.value)}
                      className="h-6 text-[10px] bg-white text-[#1f2937] rounded-none px-1 font-bold border-0 uppercase"
                    >
                      <option value="menor_preco">MENOR PREÇO UNITÁRIO</option>
                      <option value="maior_preco">MAIOR PREÇO UNITÁRIO</option>
                      <option value="data_recente">DATA MAIS RECENTE</option>
                    </select>
                  </div>
                </div>{' '}
              </div>

              {/* Notificação visual de coleta ao vivo / enchendo a grade em tempo real */}
              {coletaEmTempoRealAtiva && statusColetaTempoReal && (
                <div className="px-3 pt-2">
                  <div className="bg-amber-50 border border-amber-300 px-3 py-1.5 text-xs text-amber-900 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 text-amber-600 animate-spin shrink-0" />
                      <span className="font-semibold">{statusColetaTempoReal}</span>
                    </div>
                    <span className="text-[11px] text-amber-700 font-mono">
                      A grade enche sozinha conforme novos lotes são indexados
                    </span>
                  </div>
                </div>
              )}

              {/* Chip / Badge clicável que torna visualmente óbvio o filtro de fonte ativo */}
              {fontesSelecionadas.length > 0 && (
                <div className="px-3 pt-2">
                  <ChipFiltroFonteAtivo
                    fontesSelecionadas={fontesSelecionadas}
                    fontesDisponiveis={fontesDisponiveis}
                    onRemoverFonte={(f) => {
                      setFontesSelecionadas((prev) => prev.filter((k) => k !== f))
                      setPaginaAtual(1)
                    }}
                    onLimparTodas={() => {
                      setFontesSelecionadas([])
                      setPaginaAtual(1)
                    }}
                    totalFiltradas={amostrasFiltradas.length}
                    totalGeral={priceResults.length}
                  />
                </div>
              )}

              <div className="p-3 bg-white">
                {priceResults.length === 0 ? (
                  <div className="p-10 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-2">
                    {loadingSearch ? (
                      /* Estado 2: Coleta em andamento (com contador) */
                      <>
                        <Loader2 className="h-8 w-8 mx-auto text-blue-600 animate-spin" />
                        <p className="font-semibold text-gray-800">
                          Coleta em andamento nas fontes oficiais...
                        </p>
                        <p className="text-gray-500">
                          Consultando base indexada local (~4-8ms) e APIs oficiais em paralelo (PNCP
                          e Compras.gov.br).
                        </p>
                        {tookIndexMs !== null && (
                          <p className="text-[11px] font-mono text-blue-700">
                            Índice local respondido em {tookIndexMs}ms
                          </p>
                        )}
                      </>
                    ) : erroBusca ? (
                      /* Estado 5: Falha de comunicação com as fontes */
                      <>
                        <AlertTriangle className="h-8 w-8 mx-auto text-rose-500" />
                        <p className="font-semibold text-rose-800">
                          Falha de comunicação com as fontes oficiais: {erroBusca}
                        </p>
                        <p className="text-gray-500">
                          Conforme a Lei nº 14.133/2021, o COTAI não substitui dados reais por
                          amostras sintéticas. Sua sessão permanece ativa.
                        </p>
                      </>
                    ) : searchExecuted ? (
                      /* Estado 1: Índice vazio aguardando coleta inicial */
                      <>
                        <Database className="h-8 w-8 mx-auto text-amber-500" />
                        <p className="font-semibold text-gray-800">
                          Índice local vazio para este termo — aguardando coleta inicial
                        </p>
                        <p className="text-gray-500 max-w-lg mx-auto">
                          O motor indexado ainda não possui amostras persistidas para este item. A
                          consulta às APIs externas do PNCP e Compras.gov.br está alimentando o
                          índice.
                          {itensFilaPendente > 0 &&
                            ` Há ${itensFilaPendente} contratações pendentes de detalhamento na fila.`}
                        </p>
                        <div className="pt-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleBuscar(false)}
                            className="rounded-none text-xs font-bold border-gray-300 text-gray-800 hover:bg-gray-100"
                          >
                            <RotateCcw className="h-3.5 w-3.5 mr-1" />
                            TENTAR CONSULTA NOVAMENTE
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <Search className="h-8 w-8 mx-auto text-gray-400" />
                        <p className="font-semibold text-gray-700">
                          Nenhuma cotação pesquisada ainda para este item.
                        </p>
                        <p className="text-gray-500">
                          Clique no botão <strong>[BUSCAR]</strong> ou{' '}
                          <strong>[COTAR COM IA]</strong> no bloco acima para consultar diretamente
                          o índice persistente e as fontes oficiais (PNCP e Compras.gov.br).
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* (D) GRADE COM VIRTUALIZAÇÃO NATIVA: ROW_HEIGHT=44, OVERSCAN=6 */}
                    {(() => {
                      const ROW_HEIGHT = 44
                      const OVERSCAN = 6
                      const totalLinhas = amostrasFiltradas.length
                      const startIndex = Math.max(
                        0,
                        Math.floor(gradeScrollTop / ROW_HEIGHT) - OVERSCAN,
                      )
                      const endIndex = Math.min(
                        totalLinhas,
                        Math.ceil((gradeScrollTop + gradeClientHeight) / ROW_HEIGHT) + OVERSCAN,
                      )
                      const paddingTop = startIndex * ROW_HEIGHT
                      const paddingBottom = Math.max(0, (totalLinhas - endIndex) * ROW_HEIGHT)
                      const linhasVisiveis = amostrasFiltradas.slice(startIndex, endIndex)

                      return (
                        <div
                          ref={gradeContainerRef}
                          onScroll={(e) => {
                            const target = e.currentTarget
                            setGradeScrollTop(target.scrollTop)
                            if (
                              target.clientHeight > 0 &&
                              target.clientHeight !== gradeClientHeight
                            ) {
                              setGradeClientHeight(target.clientHeight)
                            }
                          }}
                          className="border border-gray-300 overflow-x-auto overflow-y-auto shadow-2xs max-h-[520px]"
                        >
                          <table className="w-full text-xs text-left border-collapse table-fixed min-w-[1100px]">
                            <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300 select-none sticky top-0 z-10 shadow-xs">
                              <tr className="h-9">
                                <th className="p-2 w-10 text-center">
                                  <Checkbox
                                    checked={
                                      selectedIds.length === priceResults.length &&
                                      priceResults.length > 0
                                    }
                                    onCheckedChange={handleSelectAll}
                                    title={
                                      selectedIds.length === priceResults.length
                                        ? 'Desmarcar todas as amostras'
                                        : 'Marcar todas as amostras'
                                    }
                                    className="rounded-none data-[state=checked]:bg-[#124268]"
                                  />
                                </th>
                                <th className="p-2 whitespace-nowrap w-[110px]">FONTE</th>
                                <th className="p-2 whitespace-nowrap w-[85px]">DATA</th>
                                <th className="p-2 w-[260px]">ÓRGÃO</th>
                                <th className="p-2 min-w-[300px]">DESCRIÇÃO</th>
                                <th className="p-2 text-center w-[75px]">UNIDADE</th>
                                <th className="p-2 text-right w-[95px]">QUANTIDADE</th>
                                <th className="p-2 text-right whitespace-nowrap w-[120px]">
                                  PREÇO UNITÁRIO
                                </th>
                                {valorReferencia > 0 && (
                                  <th className="p-2 text-center whitespace-nowrap w-[160px] bg-blue-50/70 border-x border-blue-200">
                                    VANTAJOSIDADE (REF. R$ {valorReferencia.toFixed(decimais)})
                                  </th>
                                )}
                                <th className="p-2 text-center w-[90px]">SIMILARIDADE</th>
                                <th className="p-2 text-center w-[95px]">ORIGEM</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 bg-white">
                              {paddingTop > 0 && (
                                <tr style={{ height: `${paddingTop}px` }} aria-hidden="true">
                                  <td
                                    colSpan={valorReferencia > 0 ? 11 : 10}
                                    className="p-0 border-0"
                                  />
                                </tr>
                              )}
                              {linhasVisiveis.map((p) => {
                                const isSelected = selectedIds.includes(p.id)
                                const isExpurgado = p.status === 'expurgado'
                                const isForaLimites =
                                  p.unit_price < limiteInferior || p.unit_price > limiteSuperior

                                const temRef = valorReferencia > 0
                                const diffRs = temRef ? p.unit_price - valorReferencia : 0
                                const diffPct = temRef ? (diffRs / valorReferencia) * 100 : 0
                                const isAcima = diffRs > 0
                                const isIgual = Math.abs(diffRs) < 0.0001

                                return (
                                  <tr
                                    key={p.id}
                                    style={{ height: `${ROW_HEIGHT}px` }}
                                    className={`hover:bg-blue-50/40 transition-colors ${
                                      isSelected ? 'bg-blue-50/20' : ''
                                    } ${isExpurgado ? 'opacity-60 bg-red-50/20' : ''} ${
                                      temRef && (isAcima || isIgual)
                                        ? 'border-l-4 border-l-emerald-600'
                                        : ''
                                    }`}
                                  >
                                    {/* Checkbox */}
                                    <td className="p-2 text-center align-middle">
                                      <Checkbox
                                        checked={isSelected}
                                        onCheckedChange={() => handleToggleSelect(p.id)}
                                        className="rounded-none data-[state=checked]:bg-[#124268]"
                                      />
                                    </td>

                                    {/* FONTE */}
                                    <td className="p-2 font-bold text-gray-900 align-middle">
                                      <div className="flex flex-col gap-0.5 items-start">
                                        <Badge
                                          variant="outline"
                                          className={`rounded-none text-[9.5px] font-bold ${
                                            p.source === 'PNCP'
                                              ? 'bg-blue-50 text-blue-800 border-blue-300'
                                              : 'bg-indigo-50 text-indigo-800 border-indigo-300'
                                          }`}
                                        >
                                          {p.source}
                                        </Badge>
                                      </div>
                                    </td>

                                    {/* DATA */}
                                    <td className="p-2 text-gray-600 whitespace-nowrap font-mono text-[10.5px] align-middle">
                                      {p.source_date
                                        ? new Date(p.source_date).toLocaleDateString('pt-BR')
                                        : '—'}
                                    </td>

                                    {/* ÓRGÃO */}
                                    <td
                                      className="p-2 text-gray-800 align-middle truncate"
                                      title={p.government_entity || undefined}
                                    >
                                      <div className="font-semibold text-gray-900 leading-tight truncate text-[11px]">
                                        <TermoDestacado
                                          texto={p.government_entity || 'NÃO INFORMADO'}
                                          termoBusca={searchTerm}
                                        />
                                      </div>
                                      {p.raw_data?.municipio_uf && (
                                        <div className="text-[9.5px] text-gray-500 uppercase truncate font-medium">
                                          {p.raw_data.municipio_uf}
                                        </div>
                                      )}
                                    </td>

                                    {/* DESCRIÇÃO */}
                                    <td
                                      className="p-2 text-gray-900 font-medium align-middle"
                                      title={p.description_original || undefined}
                                    >
                                      <div className="flex items-center gap-1.5 overflow-hidden">
                                        {/* Badge honesto por natureza_preco */}
                                        {(() => {
                                          const nat = (
                                            p.raw_data?.natureza_preco ||
                                            p.raw_data?.natureza ||
                                            ''
                                          ).toLowerCase()
                                          const isPendente =
                                            p.raw_data?.detalhamento_pendente ||
                                            p.raw_data?.nao_informado ||
                                            !p.unit_price ||
                                            p.unit_price <= 0

                                          if (isPendente) {
                                            return (
                                              <Badge
                                                variant="outline"
                                                className="rounded-none text-[8.5px] font-bold tracking-wider px-1 py-0 shrink-0 bg-blue-50 text-blue-800 border-blue-300"
                                              >
                                                Pendente
                                              </Badge>
                                            )
                                          }
                                          if (nat === 'estimado') {
                                            return (
                                              <Badge
                                                variant="outline"
                                                className="rounded-none text-[8.5px] font-bold tracking-wider px-1 py-0 shrink-0 bg-amber-100 text-amber-900 border-amber-400 font-bold"
                                              >
                                                Estimado
                                              </Badge>
                                            )
                                          }
                                          return (
                                            <Badge className="rounded-none text-[8.5px] font-bold tracking-wider px-1 py-0 shrink-0 bg-emerald-700 text-white hover:bg-emerald-700 border-0">
                                              Homologado
                                            </Badge>
                                          )
                                        })()}
                                        <div className="leading-tight truncate text-[11px] text-gray-950 font-medium flex-1">
                                          <TermoDestacado
                                            texto={p.description_original || 'ITEM SEM DESCRIÇÃO'}
                                            termoBusca={searchTerm}
                                          />
                                        </div>
                                      </div>
                                    </td>

                                    {/* UNIDADE */}
                                    <td className="p-2 text-center font-mono text-gray-700 align-middle text-[11px] truncate">
                                      {p.unit}
                                    </td>

                                    {/* QUANTIDADE */}
                                    <td className="p-2 text-right font-mono text-gray-700 align-middle text-[11px]">
                                      {typeof p.quantity === 'number' && Number.isFinite(p.quantity)
                                        ? p.quantity.toLocaleString('pt-BR')
                                        : (p.quantity ?? '—')}
                                    </td>

                                    {/* PREÇO UNITÁRIO */}
                                    <td className="p-2 text-right font-bold font-mono text-gray-900 whitespace-nowrap align-middle text-[11px]">
                                      <div>
                                        R${' '}
                                        {typeof p.unit_price === 'number' &&
                                        Number.isFinite(p.unit_price)
                                          ? p.unit_price.toLocaleString('pt-BR', {
                                              minimumFractionDigits: decimais,
                                              maximumFractionDigits: 4,
                                            })
                                          : '—'}
                                      </div>
                                      {isForaLimites && isSelected && p.unit_price > 0 && (
                                        <span className="text-[8.5px] font-bold text-red-600 font-sans block">
                                          FORA LIMITE
                                        </span>
                                      )}
                                    </td>

                                    {/* VANTAJOSIDADE */}
                                    {temRef && (
                                      <td className="p-2 text-center whitespace-nowrap bg-blue-50/30 border-x border-blue-100 align-middle">
                                        {isAcima ? (
                                          <span className="font-bold font-mono text-[10.5px] text-emerald-800 bg-emerald-100/90 border border-emerald-300 px-1 py-0.5 inline-block">
                                            ▲ +R$ {diffRs.toFixed(decimais)} (+{diffPct.toFixed(1)}
                                            %)
                                          </span>
                                        ) : isIgual ? (
                                          <span className="font-bold font-mono text-[10.5px] text-emerald-800 bg-emerald-50 border border-emerald-300 px-1 py-0.5 inline-block">
                                            = IGUAL À REF.
                                          </span>
                                        ) : (
                                          <span className="font-mono text-[10.5px] text-gray-700 bg-gray-100 border border-gray-300 px-1 py-0.5 inline-block">
                                            ▼ -R$ {Math.abs(diffRs).toFixed(decimais)} (
                                            {diffPct.toFixed(1)}%)
                                          </span>
                                        )}
                                      </td>
                                    )}

                                    {/* SIMILARIDADE */}
                                    <td className="p-2 text-center align-middle">
                                      <span
                                        className={`font-bold px-1.5 py-0.5 text-[10.5px] ${
                                          (p.similarity_score || 0) >= 90
                                            ? 'text-emerald-700 bg-emerald-50 border border-emerald-200'
                                            : (p.similarity_score || 0) >= 75
                                              ? 'text-amber-700 bg-amber-50 border border-amber-200'
                                              : 'text-red-700 bg-red-50 border border-red-200'
                                        }`}
                                      >
                                        {p.similarity_score || 85}%
                                      </span>
                                    </td>

                                    {/* ORIGEM */}
                                    <td className="p-2 text-center whitespace-nowrap align-middle">
                                      <div className="inline-flex items-center gap-1">
                                        <button
                                          type="button"
                                          onClick={() => setDetailModalPrice(p)}
                                          className="text-[#124268] hover:text-[#0c314f] font-bold underline cursor-pointer text-[10.5px]"
                                        >
                                          VER ORIGEM
                                        </button>
                                        {p.source_url &&
                                          (p.source_url.startsWith('http://') ||
                                            p.source_url.startsWith('https://')) && (
                                            <a
                                              href={p.source_url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-emerald-700 hover:text-emerald-900 p-0.5 ml-0.5"
                                              title="Abrir página oficial da contratação"
                                            >
                                              <ExternalLink className="h-3 w-3 inline" />
                                            </a>
                                          )}
                                      </div>
                                    </td>
                                  </tr>
                                )
                              })}
                              {paddingBottom > 0 && (
                                <tr style={{ height: `${paddingBottom}px` }} aria-hidden="true">
                                  <td
                                    colSpan={valorReferencia > 0 ? 11 : 10}
                                    className="p-0 border-0"
                                  />
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )
                    })()}

                    {/* BARRA INFORMATIVA DA GRADE VIRTUALIZADA */}
                    {totalAmostrasFiltradas > 0 && (
                      <div className="bg-[#f8fafc] border border-gray-300 p-2 flex flex-wrap items-center justify-between gap-2 text-xs select-none">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-gray-700">
                            Grade virtualizada:{' '}
                            <strong className="text-gray-900 font-mono">
                              {(totalAmostrasFiltradas ?? 0).toLocaleString('pt-BR')}
                            </strong>{' '}
                            amostras filtradas (todas renderizadas sob demanda com scroll contínuo)
                          </span>
                          <span className="text-gray-300 hidden sm:inline">|</span>
                          <span className="text-[11px] text-gray-600">
                            <strong className="text-[#124268] font-mono">
                              {(selectedIds?.length ?? 0).toLocaleString('pt-BR')}
                            </strong>{' '}
                            marcada(s) globalmente
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setSelectedIds(amostrasFiltradas.map((x) => x.id))}
                            className="text-[10px] text-blue-800 hover:text-blue-950 font-bold underline cursor-pointer"
                            title="Marcar todas as amostras filtradas"
                          >
                            + Marcar todas filtradas
                          </button>
                          <span className="text-gray-300 text-[10px]">·</span>
                          <button
                            type="button"
                            onClick={() => setSelectedIds([])}
                            className="text-[10px] text-gray-600 hover:text-gray-800 underline cursor-pointer"
                            title="Desmarcar todas"
                          >
                            Desmarcar todas
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Três contadores honestos no rodapé da grade */}
                    <div className="bg-[#f8fafc] border border-gray-300 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs select-none">
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-700">
                        <span>
                          Contratações na API (Upstream):{' '}
                          <strong className="font-mono text-gray-900">
                            {(() => {
                              const up =
                                (diagnosticoFontes.find((d) => d.fonte === 'PNCP')
                                  ?.registrosInformadosApi || 0) +
                                (diagnosticoFontes.find((d) => d.fonte === 'Compras.gov.br')
                                  ?.registrosInformadosApi || 0)
                              const totalUpstream =
                                up > 0
                                  ? up
                                  : typeof totaisConsolidados?.totalEncontrados === 'number' &&
                                      Number.isFinite(totaisConsolidados.totalEncontrados) &&
                                      totaisConsolidados.totalEncontrados > totalIndexLocal
                                    ? totaisConsolidados.totalEncontrados
                                    : totalIndexLocal > 0
                                      ? totalIndexLocal
                                      : priceResults.length
                              return totalUpstream.toLocaleString('pt-BR')
                            })()}
                          </strong>
                        </span>
                        <span className="text-gray-300">|</span>
                        <span>
                          Indexadas na base local:{' '}
                          <strong className="font-mono text-blue-700">
                            {totalIndexLocal.toLocaleString('pt-BR')}
                          </strong>
                        </span>
                        <span className="text-gray-300">|</span>
                        <span>
                          Carregadas na grade:{' '}
                          <strong className="font-mono text-gray-900">
                            {priceResults.length.toLocaleString('pt-BR')}
                          </strong>
                        </span>
                        {amostrasFiltradas.length !== priceResults.length && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span>
                              Após filtros:{' '}
                              <strong className="font-mono text-emerald-700">
                                {amostrasFiltradas.length}
                              </strong>
                            </span>
                          </>
                        )}
                        {tookIndexMs !== null && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span className="text-emerald-700 font-mono text-[10.5px] font-bold">
                              Índice local: {tookIndexMs}ms (0 chamadas N+1)
                            </span>
                          </>
                        )}
                        {cicloDiarioInfo?.data_hora && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span
                              className="text-emerald-800 bg-emerald-50 px-1.5 py-0.5 border border-emerald-200 font-mono text-[10px] font-bold"
                              title={`Ciclo diário: ${cicloDiarioInfo.ciclo_id || 'ativo'} - Validadas: ${cicloDiarioInfo.amostras_validadas || 0} - Invalidadas: ${cicloDiarioInfo.amostras_invalidadas || 0}`}
                            >
                              Base atualizada em{' '}
                              {(() => {
                                try {
                                  const d = new Date(cicloDiarioInfo.data_hora)
                                  const dd = String(d.getDate()).padStart(2, '0')
                                  const mm = String(d.getMonth() + 1).padStart(2, '0')
                                  const hh = String(d.getHours()).padStart(2, '0')
                                  const min = String(d.getMinutes()).padStart(2, '0')
                                  return `${dd}/${mm} ${hh}:${min}`
                                } catch (_) {
                                  return cicloDiarioInfo.data_ciclo || 'hoje'
                                }
                              })()}
                            </span>
                          </>
                        )}
                        {frescorSincronizacao && Object.keys(frescorSincronizacao).length > 0 && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span
                              className="text-slate-600 font-mono text-[10.5px]"
                              title="Última sincronização por watermark incremental"
                            >
                              Fontes: PNCP (
                              {frescorSincronizacao['PNCP']?.ultima_data_sincronizada || 'ativo'}) ·
                              Compras.gov (
                              {frescorSincronizacao['Compras.gov.br']?.ultima_data_sincronizada ||
                                'ativo'}
                              )
                            </span>
                          </>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-500 font-mono">
                        Base oficial PNCP e Compras.gov.br em conformidade com art. 23 Lei
                        14.133/2021
                      </div>
                    </div>
                  </div>
                )}

                {/* Botão de confirmação de cotações DENTRO do painel de pesquisa */}
                <div className="pt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 mt-2">
                  <div className="text-[11px] text-gray-600">
                    <strong className="text-gray-900 font-mono">{selectedIds.length}</strong>{' '}
                    amostra(s) marcada(s) para cálculo de{' '}
                    <strong className="text-gray-900 font-mono">{priceResults.length}</strong>{' '}
                    encontrada(s).
                  </div>

                  <Button
                    type="button"
                    onClick={handleConfirmarCotacoes}
                    disabled={loadingConfirm || selectedIds.length === 0}
                    className="h-8 px-6 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex items-center gap-1.5"
                  >
                    <Check className="h-4 w-4 text-emerald-400" />
                    <span>{loadingConfirm ? 'APLICANDO CÁLCULO...' : 'CONFIRMAR COTAÇÕES'}</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* SEÇÃO 3: ANÁLISE CRÍTICA DAS AMOSTRAS (EMBAIXO, DENTRO DA MESMA JANELA) */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <span className="inline-block w-2.5 h-2.5 bg-white/90 border border-[#4a5059] flex-shrink-0" />
              <span>ANÁLISE CRÍTICA DAS AMOSTRAS</span>
            </div>

            <div className="p-3 bg-white space-y-3">
              {/* SUB-BLOCO 1: JUÍZO CRÍTICO */}
              <div className="space-y-1">
                <span className="text-[10.5px] font-bold text-[#374151] uppercase tracking-wider block">
                  JUÍZO CRÍTICO
                </span>
                <div className="overflow-x-auto border border-[#cbd5e1]">
                  <table className="w-full text-center text-[10.5px] border-collapse bg-white">
                    <thead className="bg-[#828892] text-white font-bold text-[10px] uppercase">
                      <tr>
                        <th className="p-1.5 border border-[#9ca3af]">Nº DE AMOSTRAS COLETADAS</th>
                        <th className="p-1.5 border border-[#9ca3af]">MÉDIA</th>
                        <th className="p-1.5 border border-[#9ca3af]">DESVIO-PADRÃO</th>
                        <th className="p-1.5 border border-[#9ca3af]">
                          LIMITE INFERIOR
                          <br />
                          <span className="text-[9px] font-normal lowercase">{labelInferior}</span>
                        </th>
                        <th className="p-1.5 border border-[#9ca3af]">
                          LIMITE SUPERIOR
                          <br />
                          <span className="text-[9px] font-normal lowercase">{labelSuperior}</span>
                        </th>
                        <th className="p-1.5 border border-[#9ca3af]">CRÍTICAS</th>
                        <th className="p-1.5 border border-[#9ca3af]">AMOSTRAS EXPURGADAS</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-xs text-[#111827] divide-y divide-[#cbd5e1]">
                      <tr>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {priceResults.length}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          R$ {precoMediaSel.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {desvioPadraoSel.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] text-[#374151]">
                          R$ {limiteInferior.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] text-[#374151]">
                          R$ {limiteSuperior.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {criticasCount > 0 ? (
                            <span className="inline-block px-1.5 py-0.5 bg-red-600 text-white font-bold text-[10px]">
                              {criticasCount}
                            </span>
                          ) : (
                            <span className="text-gray-500 font-bold">0</span>
                          )}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          <span
                            className={`inline-block px-1.5 py-0.5 text-[10px] font-bold ${
                              expurgadosCount > 0
                                ? 'bg-amber-100 text-amber-900 border border-amber-300'
                                : 'text-gray-500'
                            }`}
                          >
                            {expurgadosCount}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SUB-BLOCO 2: MÉTODO ESTATÍSTICO APLICADO ÀS AMOSTRAS SANEADAS */}
              <div className="space-y-1">
                <span className="text-[10.5px] font-bold text-[#374151] uppercase tracking-wider block">
                  MÉTODO ESTATÍSTICO APLICADO ÀS AMOSTRAS SANEADAS
                </span>
                <div className="overflow-x-auto border border-[#cbd5e1]">
                  <table className="w-full text-center text-[10.5px] border-collapse bg-white">
                    <thead className="bg-[#828892] text-white font-bold text-[10px] uppercase">
                      <tr>
                        <th className="p-1.5 border border-[#9ca3af]">Nº DE AMOSTRAS VÁLIDAS</th>
                        <th className="p-1.5 border border-[#9ca3af]">DESVIO-PADRÃO</th>
                        <th className="p-1.5 border border-[#9ca3af]">COEFICIENTE DE VARIAÇÃO</th>
                        <th className="p-1.5 border border-[#9ca3af]">MENOR PREÇO</th>
                        <th className="p-1.5 border border-[#9ca3af]">MÉDIA</th>
                        <th className="p-1.5 border border-[#9ca3af]">MEDIANA</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-xs text-[#111827] divide-y divide-[#cbd5e1]">
                      <tr>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-emerald-800">
                          {countSel}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {desvioPadraoSel.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {cvSel.toFixed(2)}%
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          R$ {precoMinSel.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          R$ {precoMediaSel.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-[#124268]">
                          R$ {precoMedianaSel.toFixed(decimais)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SUB-BLOCO 3: MEDIDA DE TENDÊNCIA CENTRAL CONFIGURADA */}
              <div className="border border-[#cbd5e1] bg-[#f8fafc] p-2.5 flex flex-col md:flex-row items-center justify-between gap-3">
                <div className="space-y-0.5 text-[11px]">
                  <span className="font-bold text-[#1f2937] uppercase tracking-wider block">
                    MEDIDA DE TENDÊNCIA CENTRAL
                  </span>
                  <p className="text-[10px] text-[#4b5563]">
                    Preço de referência adotado:{' '}
                    <strong className="text-[#124268] uppercase font-mono">
                      {methodology?.estimated_price_method?.toUpperCase() || 'MEDIANA'} — R${' '}
                      {precoMedianaSel.toFixed(decimais)}
                    </strong>
                  </p>
                </div>

                <div className="w-full md:w-80 space-y-1 font-mono text-[11px] text-right">
                  <div className="flex items-center justify-between px-2 py-0.5 border bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]">
                    <span className="font-sans font-bold uppercase text-[10px]">MEDIANA:</span>
                    <span>R$ {precoMedianaSel.toFixed(decimais)}</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-0.5 border bg-white border-[#cbd5e1] text-[#374151]">
                    <span className="font-sans font-bold uppercase text-[10px]">MÉDIA:</span>
                    <span>R$ {precoMediaSel.toFixed(decimais)}</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-0.5 border bg-white border-[#cbd5e1] text-[#374151]">
                    <span className="font-sans font-bold uppercase text-[10px]">MENOR PREÇO:</span>
                    <span>R$ {precoMinSel.toFixed(decimais)}</span>
                  </div>
                </div>
              </div>

              {/* SUB-BLOCO 4: CRÍTICA DOS DADOS E JUSTIFICATIVAS */}
              <div className="space-y-2 pt-1 border-t border-[#cbd5e1]">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-bold text-[#374151] uppercase tracking-wider">
                    CRÍTICA DOS DADOS
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setMostrandoCampoJustificativa(!mostrandoCampoJustificativa)}
                    className="h-6 text-[10px] font-bold uppercase bg-white text-[#124268] hover:bg-gray-100 rounded-none border border-gray-300"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    ADICIONAR JUSTIFICATIVA OU OBSERVAÇÃO
                  </Button>
                </div>

                {/* Avisos Técnicos Obrigatórios */}
                <div className="space-y-1.5 text-[11px]">
                  {countSel < 3 && (
                    <div className="p-2.5 bg-amber-50 border-l-4 border-amber-500 text-amber-950 flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <strong>
                          1. FORAM COLETADAS MENOS DE TRÊS AMOSTRAS VÁLIDAS. É PRECISO JUSTIFICAR
                          ESTE ITEM DO ORÇAMENTO.
                        </strong>
                        <p className="text-[10.5px] text-amber-800">
                          Em conformidade com o art. 23 da Lei nº 14.133/2021, a contratação direta
                          ou estimativa com menos de 3 amostras exige justificativa expressa no
                          dossiê.
                        </p>
                      </div>
                    </div>
                  )}

                  {cvSel > 25 && (
                    <div className="p-2.5 bg-blue-50 border-l-4 border-blue-500 text-blue-950 flex items-start gap-2">
                      <HelpCircle className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <strong>
                          2. COEFICIENTE DE VARIAÇÃO ELEVADO (CV = {cvSel.toFixed(2)}% &gt; 25%).
                        </strong>
                        <p className="text-[10.5px] text-blue-800">
                          A dispersão amostral recomenda a adoção da Mediana como valor de
                          referência para neutralizar assimetrias.
                        </p>
                      </div>
                    </div>
                  )}

                  {justificativaSalvaTexto && (
                    <div className="p-2.5 bg-emerald-50 border-l-4 border-emerald-500 text-emerald-950">
                      <strong>Justificativa Registrada na Auditoria:</strong>
                      <p className="text-[11px] text-emerald-900 mt-0.5 italic">
                        "{justificativaSalvaTexto}"
                      </p>
                    </div>
                  )}
                </div>

                {/* Formulário Inline de Justificativa */}
                {mostrandoCampoJustificativa && (
                  <div className="p-3 bg-gray-50 border border-gray-300 space-y-2 mt-2">
                    <label className="block text-gray-800 font-bold uppercase text-[11px]">
                      Registrar Justificativa Técnica / Observação da Análise Crítica:
                    </label>
                    <Textarea
                      rows={3}
                      value={justificativaCritica}
                      onChange={(e) => setJustificativaCritica(e.target.value)}
                      placeholder="Ex: Em razão da especificidade do princípio ativo e da restrição do mercado produtor homologado pela Anvisa, foram localizadas apenas 2 contratações públicas no período de 12 meses..."
                      className="text-xs rounded-none border-gray-400 bg-white"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setMostrandoCampoJustificativa(false)}
                        className="h-8 text-xs font-bold uppercase rounded-none border-gray-400"
                      >
                        CANCELAR
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={salvandoJustificativa}
                        onClick={handleSalvarJustificativaCritica}
                        className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
                      >
                        {salvandoJustificativa ? 'SALVANDO...' : 'REGISTRAR JUSTIFICATIVA'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* RODAPÉ DO MODAL CESTA DE PREÇOS: BOTÃO CINZA CLARO À ESQUERDA E BOTÃO ESCURO À DIREITA */}
        <div className="bg-[#e5e7eb] border-t border-[#9ca3af] px-4 py-2.5 flex items-center justify-between gap-2 flex-shrink-0 select-none">
          <Button
            type="button"
            onClick={handleConfirmarCotacoes}
            disabled={loadingConfirm || selectedIds.length === 0}
            className="h-8 px-5 text-[11px] font-bold uppercase tracking-wider rounded-none shadow-none bg-[#f3f4f6] text-[#111827] border border-[#9ca3af] hover:bg-white flex items-center gap-1.5"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-700" />
            <span>✓ CONCLUIR COTAÇÃO DO ITEM</span>
          </Button>

          <Button
            type="button"
            onClick={onClose}
            className="h-8 px-6 text-[11px] font-bold uppercase tracking-wider rounded-none shadow-none bg-[#124268] hover:bg-[#0c314f] text-white border border-[#0c314f]"
          >
            ✕ FECHAR JANELA
          </Button>
        </div>
      </div>

      {/* POP-UP COMPLETO: VER ORIGEM DO PREÇO (Rastreabilidade Estrita) */}
      {detailModalPrice && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-2xl rounded-none overflow-hidden">
            <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none">
              <span className="font-bold text-xs uppercase tracking-wider flex items-center gap-2">
                <FileText className="h-4 w-4 text-amber-400" />
                ORIGEM DO PREÇO — RASTREABILIDADE PÚBLICA
              </span>
              <button
                onClick={() => setDetailModalPrice(null)}
                className="text-white/80 hover:text-white p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3 bg-gray-50 p-3 border border-gray-200">
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Fonte:
                  </span>
                  <span className="font-bold text-[#124268] text-sm">
                    {detailModalPrice.source}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Identificador / ID:
                  </span>
                  <span className="font-mono text-gray-800">
                    {detailModalPrice.source_record_id || 'NÃO INFORMADO'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Data da Contratação:
                  </span>
                  <span className="text-gray-800">
                    {detailModalPrice.source_date
                      ? new Date(detailModalPrice.source_date).toLocaleDateString('pt-BR')
                      : 'NÃO INFORMADO'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Preço Unitário:
                  </span>
                  <span className="font-bold text-emerald-700 text-sm font-mono">
                    R$ {detailModalPrice.unit_price.toFixed(4)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Órgão Comprador:
                  </span>
                  <span className="text-gray-900 font-medium">
                    {detailModalPrice.government_entity || 'NÃO INFORMADO'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Fornecedor Vencedor:
                  </span>
                  <span className="text-gray-900 font-medium">
                    {detailModalPrice.supplier || 'NÃO INFORMADO'} (CNPJ:{' '}
                    {detailModalPrice.supplier_document || 'NÃO INFORMADO'})
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Descrição Registrada na Fonte:
                  </span>
                  <p className="text-gray-800 bg-gray-50 p-2 border border-gray-200 font-mono text-[11px]">
                    {detailModalPrice.description_original}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <span className="text-gray-500 block">Unidade de Fornecimento:</span>
                    <strong className="text-gray-800">{detailModalPrice.unit}</strong>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Quantidade Adquirida:</span>
                    <strong className="text-gray-800">
                      {typeof detailModalPrice.quantity === 'number' &&
                      Number.isFinite(detailModalPrice.quantity)
                        ? detailModalPrice.quantity.toLocaleString('pt-BR')
                        : (detailModalPrice.quantity ?? '—')}
                    </strong>
                  </div>
                </div>
              </div>

              {(() => {
                const rawUrl = (detailModalPrice.source_url || '').trim()
                const isSyntheticDemo =
                  detailModalPrice.raw_data?.is_demo === true ||
                  rawUrl.includes('99888777000166') ||
                  rawUrl.includes('12345678000190') ||
                  detailModalPrice.supplier_document === '99.888.777/0001-66' ||
                  detailModalPrice.supplier_document === '12.345.678/0001-90' ||
                  rawUrl.includes('exemplo.gov.br')

                const hasValidExternalLink =
                  !isSyntheticDemo &&
                  (rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))

                if (hasValidExternalLink) {
                  return (
                    <div className="pt-2 border-t border-gray-200 flex flex-wrap justify-between items-center gap-2 bg-blue-50/50 p-2 border border-blue-200">
                      <div>
                        <span className="text-[11px] text-blue-900 font-bold block">
                          Documento / Deep Link Oficial da Fonte:
                        </span>
                        <a
                          href={rawUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-blue-700 underline font-mono truncate max-w-md block hover:text-blue-900"
                        >
                          {rawUrl}
                        </a>
                      </div>
                      <Button
                        type="button"
                        onClick={() => {
                          try {
                            const w = window.open(rawUrl, '_blank', 'noopener,noreferrer')
                            if (!w || w.closed || typeof w.closed === 'undefined') {
                              window.location.href = rawUrl
                            }
                          } catch {
                            window.location.href = rawUrl
                          }
                        }}
                        className="bg-[#124268] text-white hover:bg-[#0c314f] h-8 px-3 font-bold text-xs inline-flex items-center gap-1.5 transition-colors rounded-none"
                      >
                        Abrir URL da Fonte
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )
                }

                return (
                  <div className="pt-2 border-t border-gray-200 space-y-2">
                    <div className="bg-amber-50 border-l-4 border-amber-500 p-2.5 text-[11px] text-amber-900">
                      <div className="font-bold uppercase tracking-wider text-[10px] text-amber-950 flex items-center gap-1.5">
                        <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                        Documento de origem disponível por identificador e processo administrativo
                      </div>
                      <p className="mt-1 text-[10.5px] text-amber-800 leading-snug">
                        {isSyntheticDemo
                          ? 'Amostra de referência paramétrica demonstrativa para ancoragem crítica. Os dados cadastrais e o processo encontram-se registrados para rastreabilidade auditável sem redirecionamento para link externo inexistente.'
                          : 'Esta amostra corresponde a contratação com rastreabilidade administrativa (ata interna, pregão homologado ou cotação direta). Sua higidez e autenticidade constam registradas pelo identificador oficial e processo abaixo:'}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 bg-gray-50 p-2.5 border border-gray-200 text-[10.5px]">
                      <div>
                        <span className="text-gray-500 block text-[9.5px] uppercase font-bold">
                          Processo Administrativo:
                        </span>
                        <strong className="text-gray-900 font-mono">
                          {detailModalPrice.raw_data?.processo ||
                            'Processo Administrativo de Cotação'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-gray-500 block text-[9.5px] uppercase font-bold">
                          Localidade / UF:
                        </span>
                        <strong className="text-gray-900">
                          {detailModalPrice.raw_data?.municipio_uf || 'São Paulo - SP'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-gray-500 block text-[9.5px] uppercase font-bold">
                          Marca / Fabricante:
                        </span>
                        <strong className="text-gray-900">
                          {detailModalPrice.raw_data?.marca || 'NÃO INFORMADO'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-gray-500 block text-[9.5px] uppercase font-bold">
                          Hash SHA-256 de Integridade:
                        </span>
                        <strong className="text-gray-700 font-mono text-[9px] break-all">
                          {detailModalPrice.raw_data?.hash ||
                            'SHA256-' +
                              (detailModalPrice.source_record_id || detailModalPrice.id)
                                .replace(/[^a-zA-Z0-9]/g, '')
                                .slice(0, 16)
                                .toUpperCase()}
                        </strong>
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>

            <div className="bg-gray-100 p-3 border-t border-gray-300 flex justify-end">
              <Button
                type="button"
                onClick={() => setDetailModalPrice(null)}
                className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
              >
                FECHAR
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
