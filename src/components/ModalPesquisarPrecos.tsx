import React, { useState, useEffect, useMemo } from 'react'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import { TermoDestacado, calcularDiasVencimento } from '@/components/TermoDestacado'
import type {
  BudgetItem,
  BudgetPriceResult,
  BudgetMethodology,
  BudgetStatistics,
  BudgetExpurgatedPrice,
} from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'
import pb from '@/lib/pocketbase/client'

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
  const [filtroFonte, setFiltroFonte] = useState<string>('todas')
  const [filtroSituacao, setFiltroSituacao] = useState<string>('todas')
  const [filtroPeriodoMeses, setFiltroPeriodoMeses] = useState<number>(12) // Padrão: Últimos 12 meses (conforme Cesta de Preços)
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
    totalEncontrados: number
    valorMinimo: number
    valorMaximo: number
    mediaGeral: number
    medianaGeral: number
  } | null>(null)

  // Controle de fila pendente do PNCP e paginação progressiva
  const [itensFilaPendente, setItensFilaPendente] = useState<number>(0)
  const [continuandoFila, setContinuandoFila] = useState<boolean>(false)
  const [cancelarFilaPendente, setCancelarFilaPendente] = useState<boolean>(false)

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

  // Ao abrir, carregar cotações já existentes do item e a metodologia
  useEffect(() => {
    if (isOpen) {
      setSearchTerm(item.last_search_term || item.description)
      const refVal = item.reference_price && item.reference_price > 0 ? item.reference_price : 0
      setValorReferencia(refVal)
      setNovoValorRefInput(refVal > 0 ? String(refVal) : '')
      setEditandoValorRef(false)
      carregarDadosIniciais()
    }
  }, [isOpen, item.id, item.reference_price])

  const carregarDadosIniciais = async () => {
    try {
      const [meth, list] = await Promise.all([
        BudgetService.obterMetodologia(budgetId),
        BudgetService.listarPrecosDoItem(item.id),
      ])
      setMethodology(meth)

      if (list.length > 0) {
        setPriceResults(list)
        // Manter as seleções persistidas do usuário se existirem (p.status === 'selecionado'),
        // senão aplicar a pré-seleção determinística global de no máximo 3 amostras
        const explicitamenteSelecionados = list
          .filter((p) => p.status === 'selecionado')
          .map((p) => p.id)
        if (explicitamenteSelecionados.length > 0) {
          setSelectedIds(explicitamenteSelecionados)
        } else {
          const refAtual =
            item.reference_price && item.reference_price > 0 ? item.reference_price : undefined
          const inf = meth?.percentage_lower ?? 30
          const sup = meth?.percentage_upper ?? 30
          const preSel = BudgetService.selecionarMelhoresAmostrasGlobais(list, refAtual, 3, {
            limiteInferiorPct: inf,
            limiteSuperiorPct: sup,
          })
          setSelectedIds(preSel)
        }
        setSearchExecuted(true)
      } else {
        setPriceResults([])
        setSelectedIds([])
        setSearchExecuted(false)
      }
    } catch (err) {
      console.error('Erro ao carregar dados iniciais de cotação:', err)
    }
  }

  // Ação de Pesquisar ou Cotar com IA com Carregamento Progressivo (Página 1 rápida + Páginas seguintes em tempo real)
  const handleBuscar = async (isIa: boolean = false) => {
    setLoadingSearch(true)
    setLoadingMoreProgressive(false)
    setErroBusca(null)
    setEstadoPesquisa('Em processamento')
    setStatusIaProgresso(
      isIa
        ? 'IA auditando contratações públicas na API Real do PNCP e demais fontes...'
        : 'Consultando fontes oficiais em paralelo (PNCP, Compras.gov, BPS, Referenciais)...',
    )

    const diagInicial = [
      { fonte: 'PNCP (pncp.gov.br)', status: 'processando' as const, amostrasObtidas: 0 },
      { fonte: 'Compras.gov.br', status: 'processando' as const, amostrasObtidas: 0 },
      { fonte: 'BPS (Ministério da Saúde)', status: 'processando' as const, amostrasObtidas: 0 },
      {
        fonte: 'Tabelas Referenciais (CMED/SINAPI/SICRO/CONAB)',
        status: 'processando' as const,
        amostrasObtidas: 0,
      },
      { fonte: 'Portal de Compras Públicas', status: 'processando' as const, amostrasObtidas: 0 },
    ]
    setDiagnosticoFontes(diagInicial)

    try {
      const minVal = filtroPrecoMin ? parseFloat(filtroPrecoMin.replace(',', '.')) : undefined
      const maxVal = filtroPrecoMax ? parseFloat(filtroPrecoMax.replace(',', '.')) : undefined

      const paramsBase = {
        periodo_meses: filtroPeriodoMeses,
        data_inicio: filtroDataInicio || undefined,
        data_fim: filtroDataFim || undefined,
        uf: filtroUf.trim() || undefined,
        fonte: filtroFonte !== 'todas' ? filtroFonte : undefined,
        preco_min: !isNaN(minVal as number) ? minVal : undefined,
        preco_max: !isNaN(maxVal as number) ? maxVal : undefined,
        marca: filtroMarca.trim() || undefined,
        unidade: filtroMedida.trim() || undefined,
        apenas_me: filtroPorteOpcao === 'ME_EPP',
        usar_api_real_pncp: true,
      }

      // 1. MOTOR CENTRALIZADO (SearchOrchestrator): Coleta paralela e progressiva de todas as fontes
      setSearchExecuted(true)
      const inf = methodology?.percentage_lower ?? 30
      const sup = methodology?.percentage_upper ?? 30

      const resOrchestrator = await BudgetService.pesquisarPrecosAbrangente(item, searchTerm, {
        ...paramsBase,
        forcarAtualizacaoCache: false,
        onProgress: (prog) => {
          // Atualização progressiva em tempo real conforme cada página de cada API chega (RF-019..021)
          setPriceResults([...prog.amostrasAcumuladas])
          setTotaisConsolidados(prog.estatisticas)

          // Pré-seleção inteligente mantendo a grade viva
          const sel = BudgetService.selecionarMelhoresAmostrasGlobais(
            prog.amostrasAcumuladas,
            valorReferencia > 0 ? valorReferencia : undefined,
            3,
            { limiteInferiorPct: inf, limiteSuperiorPct: sup },
          )
          setSelectedIds(sel)

          // Atualiza diagnóstico de fontes em tempo real
          const amostrasPorFonte: Record<string, number> = {}
          for (const p of prog.amostrasAcumuladas) {
            const s = p.source || 'Outra'
            amostrasPorFonte[s] = (amostrasPorFonte[s] || 0) + 1
          }
          setDiagnosticoFontes([
            {
              fonte: 'PNCP (pncp.gov.br)',
              status: (amostrasPorFonte['PNCP'] ? 'concluido' : 'processando') as any,
              amostrasObtidas: amostrasPorFonte['PNCP'] || 0,
              registrosInformadosApi: prog.totalAmostras,
              mensagem: `${amostrasPorFonte['PNCP'] || 0} amostras recuperadas em streaming`,
            },
            {
              fonte: 'Compras.gov.br',
              status: (amostrasPorFonte['Compras.gov.br'] ? 'concluido' : 'processando') as any,
              amostrasObtidas: amostrasPorFonte['Compras.gov.br'] || 0,
              mensagem: `${amostrasPorFonte['Compras.gov.br'] || 0} amostras recuperadas`,
            },
            {
              fonte: 'BPS (Ministério da Saúde)',
              status: (amostrasPorFonte['BPS'] ? 'concluido' : 'processando') as any,
              amostrasObtidas: amostrasPorFonte['BPS'] || 0,
              mensagem: `${amostrasPorFonte['BPS'] || 0} amostras recuperadas`,
            },
            {
              fonte: 'Tabelas Referenciais (CMED/SINAPI/SICRO/CONAB)',
              status: 'concluido' as const,
              amostrasObtidas:
                (amostrasPorFonte['CMED'] || 0) +
                (amostrasPorFonte['SINAPI'] || 0) +
                (amostrasPorFonte['SICRO'] || 0) +
                (amostrasPorFonte['CONAB'] || 0),
              mensagem: 'Tabelas referenciais oficiais homologadas',
            },
            {
              fonte: 'Portal de Compras Públicas',
              status: 'concluido' as const,
              amostrasObtidas: amostrasPorFonte['Portal de Compras Públicas'] || 0,
              mensagem: 'Portal consultado',
            },
          ])
        },
      })

      setIsOrigemRealPncp(!!resOrchestrator.origemRealPncp)
      setIsOrigemRealBps(!!resOrchestrator.origemRealBps)
      setIsOrigemRealPcp(!!resOrchestrator.origemRealPcp)
      setPcpAguardandoCredencial(Boolean(resOrchestrator.pcpAguardandoCredenciamento))
      setTotaisConsolidados(resOrchestrator.totais)
      setPriceResults(resOrchestrator.registros)
      setPaginaAtual(1)

      // Captura de itens pendentes na fila de detalhamento
      const pncpObs = resOrchestrator.observabilidade?.detalhePorFonte?.['pncp']
      const fila =
        (pncpObs as any)?.itens_fila_pendente ||
        (pncpObs as any)?.detalhamento_paralelo?.itens_fila_pendente ||
        (pncpObs as any)?.metadata?.itens_fila_pendente ||
        0
      setItensFilaPendente(fila)

      // Atualiza diagnóstico de fontes a partir do relatório consolidado
      const amostrasPorFonteFinal: Record<string, number> = {}
      for (const p of resOrchestrator.registros) {
        const s = p.source || 'Outra'
        amostrasPorFonteFinal[s] = (amostrasPorFonteFinal[s] || 0) + 1
      }

      const diagFinal = [
        {
          fonte: 'PNCP (pncp.gov.br)',
          status: (amostrasPorFonteFinal['PNCP'] > 0
            ? 'concluido'
            : resOrchestrator.errosPorFonte?.['pncp']
              ? 'falha'
              : 'concluido') as any,
          amostrasObtidas: amostrasPorFonteFinal['PNCP'] || 0,
          registrosInformadosApi:
            resOrchestrator.observabilidade?.detalhePorFonte?.['pncp']?.quantidadeInformadaApi ||
            amostrasPorFonteFinal['PNCP'] ||
            0,
          mensagem:
            (amostrasPorFonteFinal['PNCP'] || 0) > 0
              ? `${amostrasPorFonteFinal['PNCP']} amostras recuperadas da ata/edital`
              : resOrchestrator.errosPorFonte?.['pncp'] || 'Sem registros compatíveis',
        },
        {
          fonte: 'Compras.gov.br',
          status: (resOrchestrator.errosPorFonte?.['compras_gov'] ? 'falha' : 'concluido') as any,
          amostrasObtidas: amostrasPorFonteFinal['Compras.gov.br'] || 0,
          mensagem:
            (amostrasPorFonteFinal['Compras.gov.br'] || 0) > 0
              ? `${amostrasPorFonteFinal['Compras.gov.br']} amostras recuperadas via CATMAT/ARP`
              : resOrchestrator.errosPorFonte?.['compras_gov'] || 'Nenhum registro para este termo',
        },
        {
          fonte: 'BPS (Ministério da Saúde)',
          status: (resOrchestrator.errosPorFonte?.['bps'] ? 'falha' : 'concluido') as any,
          amostrasObtidas: amostrasPorFonteFinal['BPS'] || 0,
          mensagem:
            (amostrasPorFonteFinal['BPS'] || 0) > 0
              ? `${amostrasPorFonteFinal['BPS']} amostras recuperadas de compras do SUS`
              : resOrchestrator.errosPorFonte?.['bps'] || 'Nenhum registro para este medicamento',
        },
        {
          fonte: 'Tabelas Referenciais (CMED/SINAPI/SICRO/CONAB)',
          status: 'concluido' as const,
          amostrasObtidas:
            (amostrasPorFonteFinal['CMED'] || 0) +
            (amostrasPorFonteFinal['SINAPI'] || 0) +
            (amostrasPorFonteFinal['SICRO'] || 0) +
            (amostrasPorFonteFinal['CONAB'] || 0),
          mensagem: 'Tabelas referenciais oficiais homologadas',
        },
        {
          fonte: 'Portal de Compras Públicas',
          status: (resOrchestrator.pcpAguardandoCredenciamento
            ? 'aguardando_credencial'
            : 'concluido') as any,
          amostrasObtidas: amostrasPorFonteFinal['Portal de Compras Públicas'] || 0,
          mensagem: resOrchestrator.pcpAguardandoCredenciamento
            ? 'Aguardando credencial do órgão conveniado'
            : 'Conector consultado',
        },
      ]
      setDiagnosticoFontes(diagFinal)

      // RF-015: Definição do estado global da pesquisa
      if (resOrchestrator.estadoPesquisa === 'CONCLUIDA_PARCIALMENTE') {
        setEstadoPesquisa('Concluída parcialmente')
      } else if (resOrchestrator.estadoPesquisa === 'FALHA_TOTAL') {
        setEstadoPesquisa('Falha total')
      } else {
        setEstadoPesquisa('Concluída')
      }

      const selecaoFinal = BudgetService.selecionarMelhoresAmostrasGlobais(
        resOrchestrator.registros,
        valorReferencia > 0 ? valorReferencia : undefined,
        3,
        { limiteInferiorPct: inf, limiteSuperiorPct: sup },
      )
      setSelectedIds(selecaoFinal)
    } catch (err: any) {
      console.error('Erro ao pesquisar preços na API do PNCP:', err)
      const msg = err.message || 'Falha de comunicação com as fontes de pesquisa.'
      setErroBusca(msg)
      setEstadoPesquisa('Falha total')
    } finally {
      setLoadingSearch(false)
      setStatusIaProgresso('')
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

  // Mediana de referência para filtro de tolerância %
  const medianaBase = useMemo(() => {
    if (priceResults.length === 0) return 0
    const vals = priceResults.map((p) => p.unit_price).sort((a, b) => a - b)
    const m = Math.floor(vals.length / 2)
    return vals.length % 2 === 0 ? (vals[m - 1] + vals[m]) / 2 : vals[m]
  }, [priceResults])

  // Filtros aplicados sobre as amostras retornadas
  const amostrasFiltradas = useMemo(() => {
    let lista = [...priceResults]

    // 1. Origem / Fonte das amostras
    if (filtroFonte !== 'todas') {
      lista = lista.filter((p) => {
        if (filtroFonte === 'portal_compras_publicas') {
          return (
            p.source === 'portal_compras_publicas' ||
            p.source === 'Portal de Compras Públicas' ||
            p.sourceType === 'portal_compras_publicas' ||
            (p.source && p.source.toLowerCase().includes('compras públicas'))
          )
        }
        return (
          p.source.toLowerCase() === filtroFonte.toLowerCase() ||
          p.source === filtroFonte ||
          (p.sourceType && p.sourceType.toLowerCase() === filtroFonte.toLowerCase())
        )
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
    const pMin = filtroPrecoMin ? parseFloat(filtroPrecoMin.replace(',', '.')) : NaN
    const pMax = filtroPrecoMax ? parseFloat(filtroPrecoMax.replace(',', '.')) : NaN
    if (!isNaN(pMin)) {
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
    filtroFonte,
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
    setFiltroFonte('todas')
    setFiltroSituacao('todas')
    setFiltroPeriodoMeses(12)
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
    filtroFonte !== 'todas' ||
    filtroSituacao !== 'todas' ||
    filtroPeriodoMeses !== 12 ||
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
    filtroFonte,
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
  const precosSelecionados = useMemo(
    () => priceResults.filter((p) => selectedIds.includes(p.id)),
    [priceResults, selectedIds],
  )
  const valoresSelecionados = useMemo(
    () => precosSelecionados.map((p) => p.unit_price).sort((a, b) => a - b),
    [precosSelecionados],
  )

  const countSel = valoresSelecionados.length
  const precoMin = countSel > 0 ? valoresSelecionados[0] : 0
  const precoMax = countSel > 0 ? valoresSelecionados[countSel - 1] : 0
  const precoMedia = countSel > 0 ? valoresSelecionados.reduce((a, b) => a + b, 0) / countSel : 0
  const meio = Math.floor(countSel / 2)
  const precoMediana =
    countSel > 0
      ? countSel % 2 === 0
        ? (valoresSelecionados[meio - 1] + valoresSelecionados[meio]) / 2
        : valoresSelecionados[meio]
      : 0

  let desvioPadrao = 0
  if (countSel > 1) {
    const somaQuad = valoresSelecionados.reduce((acc, v) => acc + Math.pow(v - precoMedia, 2), 0)
    desvioPadrao = Math.sqrt(somaQuad / (countSel - 1))
  }
  const cv = precoMedia > 0 ? (desvioPadrao / precoMedia) * 100 : 0
  const decimais = methodology?.decimal_places || 2

  // Limites do Juízo Crítico (70% a 130% por padrão)
  let limiteInferior = 0
  let limiteSuperior = 0
  let labelInferior = '(-30% da mediana)'
  let labelSuperior = '(+30% da mediana)'

  if (methodology?.critical_judgment_method === 'percentual' || !methodology) {
    const sup = methodology?.percentage_upper ?? 30
    const inf = methodology?.percentage_lower ?? 30
    limiteInferior = Math.max(0, precoMediana * (1 - inf / 100))
    limiteSuperior = precoMediana * (1 + sup / 100)
    labelInferior = `(-${inf}% da mediana)`
    labelSuperior = `(+${sup}% da mediana)`
  } else if (methodology.critical_judgment_method === 'desvio_padrao') {
    const fator = methodology.standard_deviation_parameter || 2.0
    limiteInferior = Math.max(0, precoMedia - fator * desvioPadrao)
    limiteSuperior = precoMedia + fator * desvioPadrao
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
                      {item.quantity.toLocaleString('pt-BR')}
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
                              : filtroFonte.toLowerCase().includes('demonstrativa') ||
                                  filtroFonte.toLowerCase().includes('sintetica')
                                ? 'bg-amber-100 text-amber-900 border-amber-300'
                                : 'bg-gray-100 text-gray-800 border-gray-300'
                        }`}
                      >
                        {isOrigemRealPncp
                          ? '✓ PNCP REAL (OFICIAL) — pncp.gov.br'
                          : isOrigemRealBps
                            ? '✓ BPS REAL (DADOS ABERTOS MS) — saude.gov.br'
                            : filtroFonte.toLowerCase().includes('demonstrativa') ||
                                filtroFonte.toLowerCase().includes('sintetica')
                              ? 'BASE DEMONSTRATIVA SINTÉTICA (ISOLADA) — NÃO USAR PARA CONTRATAÇÃO REAL'
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
                    {diagnosticoFontes.map((diag, idx) => (
                      <div
                        key={idx}
                        className={`p-2 border text-[11px] space-y-1 ${
                          diag.status === 'concluido'
                            ? 'bg-emerald-50/50 border-emerald-200 text-emerald-950'
                            : diag.status === 'parcial'
                              ? 'bg-amber-50/50 border-amber-200 text-amber-950'
                              : diag.status === 'aguardando_credencial'
                                ? 'bg-blue-50/50 border-blue-200 text-blue-950'
                                : diag.status === 'processando'
                                  ? 'bg-sky-50/60 border-sky-300 text-sky-950'
                                  : 'bg-rose-50/50 border-rose-200 text-rose-950'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <strong className="font-bold uppercase text-[10.5px] truncate">
                            {diag.fonte}
                          </strong>
                          <span
                            className={`text-[9.5px] font-bold uppercase px-1.5 py-0.2 border ${
                              diag.status === 'concluido'
                                ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                : diag.status === 'aguardando_credencial'
                                  ? 'bg-amber-100 text-amber-800 border-amber-300'
                                  : diag.status === 'processando'
                                    ? 'bg-sky-100 text-sky-800 border-sky-300'
                                    : 'bg-rose-100 text-rose-800 border-rose-300'
                            }`}
                          >
                            {diag.status === 'concluido'
                              ? 'Concluído'
                              : diag.status === 'aguardando_credencial'
                                ? 'Aguardando Token'
                                : diag.status === 'processando'
                                  ? diag.registrosInformadosApi
                                    ? 'Parcial / Detalhando'
                                    : 'Consultando...'
                                  : 'Falha/Indisponível'}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between font-mono text-[11px]">
                          <span>Amostras recuperadas:</span>
                          <strong className="text-[12px]">{diag.amostrasObtidas}</strong>
                        </div>
                        {diag.registrosInformadosApi !== undefined &&
                          diag.registrosInformadosApi > 0 && (
                            <div className="text-[9.5px] text-gray-600 flex justify-between font-mono">
                              <span>Informados pela API:</span>
                              <span>{diag.registrosInformadosApi}</span>
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
                    ))}
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
                    {totaisConsolidados
                      ? totaisConsolidados.totalEncontrados.toLocaleString('pt-BR')
                      : priceResults.length.toLocaleString('pt-BR')}
                  </span>
                  <span className="text-[9.5px] text-gray-500">
                    {selectedIds.length.toLocaleString('pt-BR')} selecionada(s)
                  </span>
                </div>
                <div className="bg-[#f8fafc] p-2 border border-gray-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    VALOR MÍNIMO
                  </span>
                  <span className="text-base font-bold font-mono text-emerald-700 block">
                    R${' '}
                    {(totaisConsolidados
                      ? totaisConsolidados.valorMinimo
                      : precoMin
                    ).toLocaleString('pt-BR', {
                      minimumFractionDigits: decimais,
                      maximumFractionDigits: 4,
                    })}
                  </span>
                  <span className="text-[9.5px] text-gray-500">amostras coletadas</span>
                </div>
                <div className="bg-[#f8fafc] p-2 border border-gray-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    VALOR MÁXIMO
                  </span>
                  <span className="text-base font-bold font-mono text-amber-700 block">
                    R${' '}
                    {(totaisConsolidados
                      ? totaisConsolidados.valorMaximo
                      : precoMax
                    ).toLocaleString('pt-BR', {
                      minimumFractionDigits: decimais,
                      maximumFractionDigits: 4,
                    })}
                  </span>
                  <span className="text-[9.5px] text-gray-500">todas as variantes</span>
                </div>
                <div className="bg-[#f8fafc] p-2 border border-gray-200">
                  <span className="text-[10px] font-bold text-gray-500 uppercase block">
                    MÉDIA GERAL
                  </span>
                  <span className="text-base font-bold font-mono text-gray-900 block">
                    R${' '}
                    {(totaisConsolidados
                      ? totaisConsolidados.mediaGeral
                      : precoMedia
                    ).toLocaleString('pt-BR', {
                      minimumFractionDigits: decimais,
                      maximumFractionDigits: decimais,
                    })}
                  </span>
                  <span className="text-[9.5px] text-gray-500">CV selec.: {cv.toFixed(2)}%</span>
                </div>
                <div className="bg-[#e0f2fe] p-2 border border-[#7dd3fc]">
                  <span className="text-[10px] font-bold text-[#124268] uppercase block">
                    MEDIANA GERAL (REF.)
                  </span>
                  <span className="text-base font-bold font-mono text-[#124268] block">
                    R${' '}
                    {(totaisConsolidados
                      ? totaisConsolidados.medianaGeral
                      : precoMediana
                    ).toLocaleString('pt-BR', {
                      minimumFractionDigits: decimais,
                      maximumFractionDigits: decimais,
                    })}
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
                        {totaisConsolidados.totalEncontrados.toLocaleString('pt-BR')} amostras
                      </strong>{' '}
                      · R${' '}
                      {totaisConsolidados.valorMinimo.toLocaleString('pt-BR', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      a R${' '}
                      {totaisConsolidados.valorMaximo.toLocaleString('pt-BR', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
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
                    {/* 1. Fonte / Origem */}
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Origem / Fonte das Amostras
                      </label>
                      <select
                        value={filtroFonte}
                        onChange={(e) => setFiltroFonte(e.target.value)}
                        className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                      >
                        <option value="todas">Todas as Fontes</option>
                        <option value="PNCP">PNCP (Federal/Estadual/Mun.)</option>
                        <option value="Compras.gov.br">Compras.gov.br</option>
                        <option value="portal_compras_publicas">
                          Portal de Compras Públicas (PCP Oficial)
                        </option>
                        <option value="CMED">CMED (Teto Regulatório ANVISA)</option>
                        <option value="SINAPI">SINAPI (Custo Construção Civil)</option>
                        <option value="SICRO">SICRO (Custo Rodoviário DNIT)</option>
                        <option value="CONAB">CONAB / CEASA (Abastecimento)</option>
                        <option value="SEINFRA/CE">SEINFRA/CE (Custo Estadual Ceará)</option>
                        <option value="SETOP/MG">SETOP/MG (Custo Estadual Minas Gerais)</option>
                        <option value="BPS">BPS (Saúde / SUS)</option>
                        <option value="BEC-SP">BEC-SP</option>
                        <option value="comercio_eletronico">Comércio Eletrônico</option>
                        <option value="manual">Cotação Direta Fornecedores</option>
                      </select>
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
                    onClick={() => handleBuscar(false)}
                    disabled={loadingSearch}
                    className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] uppercase rounded-none h-6 px-2.5"
                  >
                    {loadingSearch ? 'Continuando...' : 'Continuar Fila'}
                  </Button>
                </div>
              )}

              {/* CORREÇÃO 6 (c): Indicador explícito FONTE INDISPONÍVEL */}
              {diagnosticoFontes.some((d) => d.status === 'falha') && (
                <div className="bg-rose-50 border-l-4 border-rose-600 p-2 text-[11px] text-rose-950 border border-rose-200 flex flex-wrap items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-rose-600 flex-shrink-0" />
                  <span className="font-bold uppercase text-[10px] text-rose-900">
                    FONTE INDISPONÍVEL:
                  </span>
                  {diagnosticoFontes
                    .filter((d) => d.status === 'falha')
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
                  {/* CORREÇÃO 6 (b): Rótulos explícitos das três contagens no cabeçalho */}
                  <span className="bg-black/25 px-1.5 py-0.5 text-[10px] font-mono">
                    Total estimado nas fontes:{' '}
                    <strong>{totaisConsolidados?.totalEncontrados || priceResults.length}</strong>
                  </span>
                  <span className="bg-black/25 px-1.5 py-0.5 text-[10px] font-mono">
                    Carregadas: <strong>{priceResults.length}</strong>
                  </span>
                  <span className="bg-emerald-950/60 px-1.5 py-0.5 text-[10px] font-mono text-emerald-200">
                    Após filtros: <strong>{amostrasFiltradas.length}</strong>
                  </span>
                  {totalAmostrasFiltradas > 0 && (
                    <span className="text-white/80 font-normal text-[10px]">
                      (Mostrando {indiceInicio + 1}–{indiceFim})
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-white/90 font-bold tracking-wider">
                      ORDENAR POR:
                    </span>
                    <select
                      value={ordenacao}
                      onChange={(e: any) => setOrdenacao(e.target.value)}
                      className="h-5 text-[10px] bg-white text-[#1f2937] rounded-none px-1 font-bold border-0 uppercase"
                    >
                      <option value="menor_preco">MENOR PREÇO UNITÁRIO</option>
                      <option value="maior_preco">MAIOR PREÇO UNITÁRIO</option>
                      <option value="data_recente">DATA MAIS RECENTE</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-white">
                {priceResults.length === 0 ? (
                  <div className="p-10 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-2">
                    <Search className="h-8 w-8 mx-auto text-gray-400" />
                    <p className="font-semibold text-gray-700">
                      {searchExecuted
                        ? isOrigemRealPncp
                          ? 'Nenhuma contratação encontrada no PNCP para o termo informado.'
                          : 'Não foram encontradas cotações com o termo informado.'
                        : 'Nenhuma cotação pesquisada ainda para este item.'}
                    </p>
                    <p className="text-gray-500">
                      Clique no botão <strong>[BUSCAR]</strong> ou <strong>[COTAR COM IA]</strong>{' '}
                      no bloco acima para consultar diretamente a base oficial do PNCP (Portal
                      Nacional de Contratações Públicas).
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="border border-gray-300 overflow-x-auto shadow-2xs">
                      <table className="w-full text-xs text-left border-collapse">
                        <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300 select-none">
                          <tr>
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
                            <th className="p-2 whitespace-nowrap min-w-[130px]">FONTE</th>
                            <th className="p-2 whitespace-nowrap min-w-[90px]">DATA</th>
                            <th className="p-2 min-w-[280px]">ÓRGÃO</th>
                            <th className="p-2 min-w-[340px]">DESCRIÇÃO</th>
                            <th className="p-2 text-center">UNIDADE</th>
                            <th className="p-2 text-right">QUANTIDADE</th>
                            <th className="p-2 text-right whitespace-nowrap">PREÇO UNITÁRIO</th>
                            {valorReferencia > 0 && (
                              <th className="p-2 text-center whitespace-nowrap bg-blue-50/70 border-x border-blue-200">
                                VANTAJOSIDADE (REF. R$ {valorReferencia.toFixed(decimais)})
                              </th>
                            )}
                            <th className="p-2 text-center">SIMILARIDADE</th>
                            <th className="p-2 text-center">ORIGEM</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 bg-white">
                          {amostrasPaginadas.map((p) => {
                            const isSelected = selectedIds.includes(p.id)
                            const isExpurgado = p.status === 'expurgado'
                            const isForaLimites =
                              p.unit_price < limiteInferior || p.unit_price > limiteSuperior

                            // Comparação de Vantajosidade para cada cotação individual
                            const temRef = valorReferencia > 0
                            const diffRs = temRef ? p.unit_price - valorReferencia : 0
                            const diffPct = temRef ? (diffRs / valorReferencia) * 100 : 0
                            const isAcima = diffRs > 0
                            const isIgual = Math.abs(diffRs) < 0.0001
                            const isAbaixo = diffRs < 0

                            return (
                              <tr
                                key={p.id}
                                className={`hover:bg-blue-50/40 transition-colors ${
                                  isSelected ? 'bg-blue-50/20' : ''
                                } ${isExpurgado ? 'opacity-60 bg-red-50/20' : ''} ${
                                  temRef && (isAcima || isIgual)
                                    ? 'border-l-4 border-l-emerald-600'
                                    : ''
                                }`}
                              >
                                {/* Checkbox de seleção para compor o cálculo */}
                                <td className="p-2 text-center">
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={() => handleToggleSelect(p.id)}
                                    className="rounded-none data-[state=checked]:bg-[#124268]"
                                  />
                                </td>

                                {/* FONTE */}
                                <td className="p-2 font-bold text-gray-900 align-top">
                                  <div className="flex flex-col gap-1 items-start">
                                    <Badge
                                      variant="outline"
                                      className={`rounded-none text-[10px] font-bold ${
                                        p.source === 'PNCP'
                                          ? 'bg-blue-50 text-blue-800 border-blue-300'
                                          : p.source === 'Compras.gov.br'
                                            ? 'bg-indigo-50 text-indigo-800 border-indigo-300'
                                            : p.source === 'BPS'
                                              ? 'bg-rose-50 text-rose-800 border-rose-300'
                                              : p.source === 'portal_compras_publicas' ||
                                                  p.source === 'Portal de Compras Públicas' ||
                                                  p.sourceType === 'portal_compras_publicas'
                                                ? 'bg-emerald-50 text-emerald-800 border-emerald-400'
                                                : p.source === 'CMED'
                                                  ? 'bg-purple-50 text-purple-800 border-purple-300'
                                                  : p.source === 'SINAPI'
                                                    ? 'bg-amber-50 text-amber-900 border-amber-300'
                                                    : p.source === 'SICRO'
                                                      ? 'bg-orange-50 text-orange-900 border-orange-300'
                                                      : p.source === 'CONAB'
                                                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                                        : p.source === 'SEINFRA/CE'
                                                          ? 'bg-teal-50 text-teal-800 border-teal-300'
                                                          : p.source === 'SETOP/MG'
                                                            ? 'bg-cyan-50 text-cyan-800 border-cyan-300'
                                                            : 'bg-gray-100 text-gray-800 border-gray-300'
                                      }`}
                                    >
                                      {p.source}
                                    </Badge>
                                    {p.raw_data?.origem_badge ? (
                                      <span
                                        className={`inline-block px-1 py-0.2 text-[8.5px] font-extrabold uppercase tracking-tight rounded-none border ${
                                          p.raw_data.origem_badge.includes('CMED')
                                            ? 'bg-purple-100/90 text-purple-900 border-purple-400'
                                            : p.raw_data.origem_badge.includes('SINAPI')
                                              ? 'bg-amber-100/90 text-amber-950 border-amber-400'
                                              : p.raw_data.origem_badge.includes('SICRO')
                                                ? 'bg-orange-100/90 text-orange-950 border-orange-400'
                                                : p.raw_data.origem_badge.includes('CONAB')
                                                  ? 'bg-emerald-100/90 text-emerald-950 border-emerald-400'
                                                  : p.raw_data.origem_badge.includes('SEINFRA')
                                                    ? 'bg-teal-100/90 text-teal-950 border-teal-400'
                                                    : 'bg-cyan-100/90 text-cyan-950 border-cyan-400'
                                        }`}
                                        title={
                                          p.raw_data.tipo_referencial ||
                                          'Fonte Referencial Oficial (Lei 14.133/2021, Art. 23 §2º)'
                                        }
                                      >
                                        {p.raw_data.origem_badge}
                                      </span>
                                    ) : null}
                                  </div>
                                </td>

                                {/* DATA */}
                                <td className="p-2 text-gray-600 whitespace-nowrap font-mono text-[11px] align-top">
                                  {p.source_date
                                    ? new Date(p.source_date).toLocaleDateString('pt-BR')
                                    : '—'}
                                </td>

                                {/* ÓRGÃO */}
                                <td
                                  className="p-2 text-gray-800 min-w-[280px] max-w-[420px] whitespace-normal break-words align-top"
                                  title={p.government_entity || undefined}
                                >
                                  <div className="font-semibold text-gray-900 leading-snug whitespace-normal break-words text-[11.5px]">
                                    <TermoDestacado
                                      texto={p.government_entity || 'NÃO INFORMADO'}
                                      termoBusca={searchTerm}
                                    />
                                  </div>
                                  {p.raw_data?.municipio_uf && (
                                    <div className="text-[10px] text-gray-500 uppercase mt-0.5 font-medium">
                                      {p.raw_data.municipio_uf}
                                    </div>
                                  )}
                                </td>

                                {/* DESCRIÇÃO */}
                                <td
                                  className="p-2 text-gray-900 font-medium min-w-[340px] max-w-[560px] whitespace-normal break-words align-top"
                                  title={p.description_original || undefined}
                                >
                                  <div className="flex flex-col items-start gap-1">
                                    <Badge
                                      variant="outline"
                                      className={`rounded-none text-[8.5px] font-bold tracking-wider px-1 py-0 shrink-0 ${
                                        p.source === 'portal_compras_publicas' ||
                                        p.source === 'Portal de Compras Públicas' ||
                                        p.sourceType === 'portal_compras_publicas' ||
                                        p.raw_data?.origem_badge?.includes('COMPRAS PÚBLICAS')
                                          ? 'border-emerald-600 text-emerald-900 bg-emerald-100 font-extrabold'
                                          : p.raw_data?.is_referencial
                                            ? 'border-purple-600 text-purple-900 bg-purple-50'
                                            : p.raw_data?.is_real_api
                                              ? 'border-emerald-600 text-emerald-800 bg-emerald-50'
                                              : 'border-blue-400 text-blue-900 bg-blue-50'
                                      }`}
                                    >
                                      {p.source === 'portal_compras_publicas' ||
                                      p.source === 'Portal de Compras Públicas' ||
                                      p.sourceType === 'portal_compras_publicas' ||
                                      p.raw_data?.origem_badge?.includes('COMPRAS PÚBLICAS')
                                        ? 'COMPRAS PÚBLICAS REAL (OFICIAL)'
                                        : p.raw_data?.is_referencial
                                          ? 'TABELA REFERENCIAL'
                                          : p.raw_data?.is_real_api
                                            ? `${p.source} REAL`
                                            : p.source}
                                    </Badge>
                                    <div className="leading-snug whitespace-normal break-words text-[11.5px] text-gray-950 font-medium w-full">
                                      <TermoDestacado
                                        texto={p.description_original || 'ITEM SEM DESCRIÇÃO'}
                                        termoBusca={searchTerm}
                                      />
                                    </div>
                                  </div>
                                  {p.raw_data?.catmat && (
                                    <span className="text-[10px] text-gray-500 font-mono block mt-0.5">
                                      CATMAT: {p.raw_data.catmat}
                                    </span>
                                  )}
                                </td>

                                {/* UNIDADE */}
                                <td className="p-2 text-center font-mono text-gray-700">
                                  {p.unit}
                                </td>

                                {/* QUANTIDADE */}
                                <td className="p-2 text-right font-mono text-gray-700">
                                  {p.quantity.toLocaleString('pt-BR')}
                                </td>

                                {/* PREÇO UNITÁRIO */}
                                <td className="p-2 text-right font-bold font-mono text-gray-900 whitespace-nowrap">
                                  <div>
                                    R${' '}
                                    {p.unit_price.toLocaleString('pt-BR', {
                                      minimumFractionDigits: decimais,
                                      maximumFractionDigits: 4,
                                    })}
                                  </div>
                                  {isForaLimites && isSelected && (
                                    <span className="text-[9px] font-bold text-red-600 font-sans block">
                                      FORA DO JUÍZO CRÍTICO
                                    </span>
                                  )}
                                </td>

                                {/* COLUNA DE COMPARAÇÃO DE VANTAJOSIDADE (SE VALOR REF CADASTRADO) */}
                                {temRef && (
                                  <td className="p-2 text-center whitespace-nowrap bg-blue-50/30 border-x border-blue-100">
                                    {isAcima ? (
                                      <div className="flex flex-col items-center">
                                        <span className="inline-flex items-center gap-1 font-bold font-mono text-[11px] text-emerald-800 bg-emerald-100/90 border border-emerald-300 px-1.5 py-0.5">
                                          <span>▲ ACIMA (+R$ {diffRs.toFixed(decimais)})</span>
                                          <span className="text-[9.5px]">
                                            +{diffPct.toFixed(1)}%
                                          </span>
                                        </span>
                                        <span className="text-[8.5px] font-bold text-emerald-700 uppercase mt-0.5">
                                          ✓ Favorável à Prorrogação
                                        </span>
                                      </div>
                                    ) : isIgual ? (
                                      <div className="flex flex-col items-center">
                                        <span className="inline-flex items-center gap-1 font-bold font-mono text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-300 px-1.5 py-0.5">
                                          <span>= IGUAL À REF.</span>
                                          <span className="text-[9.5px]">0,0%</span>
                                        </span>
                                        <span className="text-[8.5px] font-bold text-emerald-700 uppercase mt-0.5">
                                          ✓ Neutro / Vantajoso
                                        </span>
                                      </div>
                                    ) : (
                                      <div className="flex flex-col items-center">
                                        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-gray-700 bg-gray-100 border border-gray-300 px-1.5 py-0.5">
                                          <span>
                                            ▼ ABAIXO (-R$ {Math.abs(diffRs).toFixed(decimais)})
                                          </span>
                                          <span className="text-[9.5px] font-bold">
                                            {diffPct.toFixed(1)}%
                                          </span>
                                        </span>
                                        <span className="text-[8.5px] text-gray-500 uppercase mt-0.5">
                                          Preço menor que contrato
                                        </span>
                                      </div>
                                    )}
                                  </td>
                                )}

                                {/* SIMILARIDADE */}
                                <td className="p-2 text-center">
                                  <span
                                    className={`font-bold px-1.5 py-0.5 text-[11px] ${
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

                                {/* ORIGEM (VER ORIGEM OU DEEP LINK PNCP) */}
                                <td className="p-2 text-center whitespace-nowrap">
                                  <div className="inline-flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => setDetailModalPrice(p)}
                                      className="text-[#124268] hover:text-[#0c314f] font-bold underline inline-flex items-center gap-1 cursor-pointer text-[11px]"
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
                                          title={
                                            p.source === 'portal_compras_publicas' ||
                                            p.source === 'Portal de Compras Públicas' ||
                                            p.sourceType === 'portal_compras_publicas'
                                              ? 'Abrir processo oficial no Portal de Compras Públicas (portaldecompraspublicas.com.br)'
                                              : 'Abrir página oficial da contratação'
                                          }
                                        >
                                          <ExternalLink className="h-3 w-3 inline" />
                                        </a>
                                      )}
                                    {(!p.source_url ||
                                      (!p.source_url.startsWith('http://') &&
                                        !p.source_url.startsWith('https://'))) &&
                                      (p.source === 'portal_compras_publicas' ||
                                        p.source === 'Portal de Compras Públicas' ||
                                        p.sourceType === 'portal_compras_publicas') && (
                                        <a
                                          href={`https://www.portaldecompraspublicas.com.br/processos?termo=${encodeURIComponent(
                                            searchTerm,
                                          )}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-emerald-700 hover:text-emerald-900 p-0.5 ml-0.5"
                                          title="Abrir processo no Portal de Compras Públicas (portaldecompraspublicas.com.br)"
                                        >
                                          <ExternalLink className="h-3 w-3 inline" />
                                        </a>
                                      )}
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* BARRA DE CONTROLES DE PAGINAÇÃO: 20 AMOSTRAS POR PÁGINA */}
                    {totalAmostrasFiltradas > 0 && (
                      <div className="bg-[#f8fafc] border border-gray-300 p-2 flex flex-wrap items-center justify-between gap-2 text-xs select-none">
                        {/* Lado Esquerdo: Contador de Amostras e Ações Rápidas de Seleção */}
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-gray-700">
                            Mostrando{' '}
                            <strong className="text-gray-900 font-mono">
                              {indiceInicio + 1}–{indiceFim}
                            </strong>{' '}
                            de{' '}
                            <strong className="text-gray-900 font-mono">
                              {totalAmostrasFiltradas.toLocaleString('pt-BR')}
                            </strong>{' '}
                            amostras
                          </span>
                          <span className="text-gray-300 hidden sm:inline">|</span>
                          <span className="text-[11px] text-gray-600">
                            <strong className="text-[#124268] font-mono">
                              {selectedIds.length.toLocaleString('pt-BR')}
                            </strong>{' '}
                            amostra(s) marcada(s) globalmente
                          </span>
                          <div className="flex items-center gap-1.5 ml-1">
                            <button
                              type="button"
                              onClick={() => handleSelectPage(true)}
                              className="text-[10px] text-blue-800 hover:text-blue-950 font-bold underline cursor-pointer"
                              title="Marcar todas as 20 amostras desta página"
                            >
                              + Marcar desta página
                            </button>
                            <span className="text-gray-300 text-[10px]">·</span>
                            <button
                              type="button"
                              onClick={() => handleSelectPage(false)}
                              className="text-[10px] text-gray-600 hover:text-gray-800 underline cursor-pointer"
                              title="Desmarcar amostras desta página"
                            >
                              Desmarcar página
                            </button>
                          </div>
                        </div>

                        {/* Lado Direito: Navegação de Páginas */}
                        <div className="flex items-center gap-1">
                          {/* Botão Primeira Página */}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPaginaAtual(1)}
                            disabled={paginaValida <= 1}
                            className="h-7 w-7 p-0 rounded-none border-gray-300 text-gray-700 disabled:opacity-40"
                            title="Primeira página"
                          >
                            <ChevronsLeft className="h-3.5 w-3.5" />
                          </Button>

                          {/* Botão Anterior */}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPaginaAtual((prev) => Math.max(1, prev - 1))}
                            disabled={paginaValida <= 1}
                            className="h-7 px-2 text-[10.5px] font-bold rounded-none border-gray-300 text-gray-700 disabled:opacity-40 flex items-center gap-1"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Anterior</span>
                          </Button>

                          {/* Números das páginas */}
                          <div className="flex items-center gap-0.5 mx-1">
                            {paginasVisiveis.map((p, idx) => {
                              if (p === '...') {
                                return (
                                  <span
                                    key={`ellipsis-${idx}`}
                                    className="px-1 text-gray-400 font-mono text-[11px]"
                                  >
                                    …
                                  </span>
                                )
                              }
                              const isCur = p === paginaValida
                              return (
                                <button
                                  key={`page-${p}`}
                                  type="button"
                                  onClick={() => setPaginaAtual(p as number)}
                                  className={`h-7 min-w-[28px] px-1.5 text-xs font-mono font-bold transition-colors ${
                                    isCur
                                      ? 'bg-[#124268] text-white'
                                      : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'
                                  }`}
                                >
                                  {p}
                                </button>
                              )
                            })}
                          </div>

                          {/* Botão Próxima */}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setPaginaAtual((prev) => Math.min(totalPaginas, prev + 1))
                            }
                            disabled={paginaValida >= totalPaginas}
                            className="h-7 px-2 text-[10.5px] font-bold rounded-none border-gray-300 text-gray-700 disabled:opacity-40 flex items-center gap-1"
                          >
                            <span className="hidden sm:inline">Próxima</span>
                            <ChevronRight className="h-3.5 w-3.5" />
                          </Button>

                          {/* Botão Última Página */}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPaginaAtual(totalPaginas)}
                            disabled={paginaValida >= totalPaginas}
                            className="h-7 w-7 p-0 rounded-none border-gray-300 text-gray-700 disabled:opacity-40"
                            title="Última página"
                          >
                            <ChevronsRight className="h-3.5 w-3.5" />
                          </Button>

                          {/* Indicador Página X de Y */}
                          <span className="ml-2 text-[11px] text-gray-600 font-medium whitespace-nowrap">
                            Página{' '}
                            <strong className="font-mono text-gray-900">{paginaValida}</strong> de{' '}
                            <strong className="font-mono text-gray-900">{totalPaginas}</strong>
                          </span>

                          {/* Seletor de tamanho de página visual (RF-006) */}
                          <div className="ml-3 flex items-center gap-1 text-[11px] text-gray-600">
                            <span>Exibir:</span>
                            <select
                              value={itensPorPaginaVisual}
                              onChange={(e) => {
                                setItensPorPaginaVisual(Number(e.target.value))
                                setPaginaAtual(1)
                              }}
                              className="h-6 text-[10.5px] border border-gray-300 bg-white px-1 font-mono font-bold"
                            >
                              <option value={20}>20 por página</option>
                              <option value={50}>50 por página</option>
                              <option value={100}>100 por página</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* CORREÇÃO 6 (b): Rótulos explícitos das três contagens no rodapé da grade */}
                    <div className="bg-[#f8fafc] border border-gray-300 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs select-none">
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-700">
                        <span>
                          Total estimado nas fontes:{' '}
                          <strong className="font-mono text-gray-900">
                            {totaisConsolidados?.totalEncontrados || priceResults.length}
                          </strong>
                        </span>
                        <span className="text-gray-300">|</span>
                        <span>
                          Carregadas:{' '}
                          <strong className="font-mono text-gray-900">{priceResults.length}</strong>
                        </span>
                        <span className="text-gray-300">|</span>
                        <span>
                          Após filtros:{' '}
                          <strong className="font-mono text-emerald-700">
                            {amostrasFiltradas.length}
                          </strong>
                        </span>
                      </div>
                      <div className="text-[10px] text-gray-500 font-mono">
                        Base PNCP oficial em conformidade com art. 23 Lei 14.133/2021
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
                          R$ {precoMedia.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {desvioPadrao.toFixed(decimais)}
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
                          {desvioPadrao.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {cv.toFixed(2)}%
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          R$ {precoMin.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          R$ {precoMedia.toFixed(decimais)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-[#124268]">
                          R$ {precoMediana.toFixed(decimais)}
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
                      {precoMediana.toFixed(decimais)}
                    </strong>
                  </p>
                </div>

                <div className="w-full md:w-80 space-y-1 font-mono text-[11px] text-right">
                  <div className="flex items-center justify-between px-2 py-0.5 border bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]">
                    <span className="font-sans font-bold uppercase text-[10px]">MEDIANA:</span>
                    <span>R$ {precoMediana.toFixed(decimais)}</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-0.5 border bg-white border-[#cbd5e1] text-[#374151]">
                    <span className="font-sans font-bold uppercase text-[10px]">MÉDIA:</span>
                    <span>R$ {precoMedia.toFixed(decimais)}</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-0.5 border bg-white border-[#cbd5e1] text-[#374151]">
                    <span className="font-sans font-bold uppercase text-[10px]">MENOR PREÇO:</span>
                    <span>R$ {precoMin.toFixed(decimais)}</span>
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

                  {cv > 25 && (
                    <div className="p-2.5 bg-blue-50 border-l-4 border-blue-500 text-blue-950 flex items-start gap-2">
                      <HelpCircle className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <strong>
                          2. COEFICIENTE DE VARIAÇÃO ELEVADO (CV = {cv.toFixed(2)}% &gt; 25%).
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
                      {detailModalPrice.quantity.toLocaleString('pt-BR')}
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
