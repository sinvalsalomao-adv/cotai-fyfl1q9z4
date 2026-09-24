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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import type {
  BudgetItem,
  BudgetPriceResult,
  BudgetMethodology,
  BudgetStatistics,
  BudgetExpurgatedPrice,
} from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'

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
  const [loadingConfirm, setLoadingConfirm] = useState(false)
  const [statusIaProgresso, setStatusIaProgresso] = useState('')
  const [priceResults, setPriceResults] = useState<BudgetPriceResult[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detailModalPrice, setDetailModalPrice] = useState<BudgetPriceResult | null>(null)
  const [searchExecuted, setSearchExecuted] = useState(false)

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
  const [filtroUf, setFiltroUf] = useState<string>('')
  const [ordenacao, setOrdenacao] = useState<'menor_preco' | 'maior_preco' | 'data_recente'>(
    'menor_preco',
  )

  // Justificativa / Observação da Análise Crítica
  const [mostrandoCampoJustificativa, setMostrandoCampoJustificativa] = useState(false)
  const [justificativaCritica, setJustificativaCritica] = useState('')
  const [salvandoJustificativa, setSalvandoJustificativa] = useState(false)
  const [justificativaSalvaTexto, setJustificativaSalvaTexto] = useState('')

  // Ao abrir, carregar cotações já existentes do item e a metodologia
  useEffect(() => {
    if (isOpen) {
      setSearchTerm(item.last_search_term || item.description)
      carregarDadosIniciais()
    }
  }, [isOpen, item.id])

  const carregarDadosIniciais = async () => {
    try {
      const [meth, list] = await Promise.all([
        BudgetService.obterMetodologia(budgetId),
        BudgetService.listarPrecosDoItem(item.id),
      ])
      setMethodology(meth)

      if (list.length > 0) {
        setPriceResults(list)
        // Selecionar os que estão selecionados ou todos por padrão
        const selecionados = list.filter((p) => p.status !== 'nao_selecionado').map((p) => p.id)
        setSelectedIds(selecionados.length > 0 ? selecionados : list.map((p) => p.id))
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

  // Ação de Pesquisar ou Cotar com IA (INLINE dentro desta janela)
  const handleBuscar = async (isIa: boolean = false) => {
    setLoadingSearch(true)
    setStatusIaProgresso(
      isIa
        ? 'IA consultando bases públicas oficiais (PNCP, Compras.gov, BPS, BEC-SP, CMED)...'
        : 'Consultando bancos públicos homologados...',
    )
    try {
      const resultados = await BudgetService.cotarItemComIA(item, searchTerm)
      setPriceResults(resultados)
      // Por padrão, selecionar todos os preços encontrados compatíveis
      setSelectedIds(resultados.map((p) => p.id))
      setSearchExecuted(true)
    } catch (err: any) {
      console.error('Erro ao pesquisar preços:', err)
      alert('Erro ao consultar as fontes: ' + (err.message || 'Falha de comunicação'))
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

  // Filtros aplicados sobre as amostras retornadas
  const amostrasFiltradas = useMemo(() => {
    let lista = [...priceResults]

    if (filtroFonte !== 'todas') {
      lista = lista.filter(
        (p) => p.source.toLowerCase() === filtroFonte.toLowerCase() || p.source === filtroFonte,
      )
    }

    if (filtroSituacao !== 'todas') {
      if (filtroSituacao === 'selecionados') {
        lista = lista.filter((p) => selectedIds.includes(p.id))
      } else if (filtroSituacao === 'nao_selecionados') {
        lista = lista.filter((p) => !selectedIds.includes(p.id))
      } else if (filtroSituacao === 'expurgados') {
        lista = lista.filter((p) => p.status === 'expurgado')
      }
    }

    if (filtroUf.trim()) {
      const ufBuscada = filtroUf.trim().toUpperCase()
      lista = lista.filter(
        (p) =>
          p.government_entity?.toUpperCase().includes(ufBuscada) ||
          p.raw_data?.municipio_uf?.toUpperCase().includes(ufBuscada),
      )
    }

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
  }, [priceResults, filtroFonte, filtroSituacao, filtroUf, ordenacao, selectedIds])

  // Limpar filtros de refinamento
  const handleLimparFiltros = () => {
    setFiltroFonte('todas')
    setFiltroSituacao('todas')
    setFiltroUf('')
    setOrdenacao('menor_preco')
  }

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

  // Confirmação das Cotações e Execução do Cálculo Determinístico
  const handleConfirmarCotacoes = async () => {
    if (selectedIds.length === 0) {
      alert('Selecione pelo menos uma cotação para o cálculo.')
      return
    }

    setLoadingConfirm(true)
    try {
      const res = await BudgetService.confirmarCotacoesECalcular(item, selectedIds, budgetId)
      setEstatisticasCalculadas(res)

      // Recarrega cotações para refletir status atualizado (expurgado / selecionado)
      const listaAtualizada = await BudgetService.listarPrecosDoItem(item.id)
      setPriceResults(listaAtualizada)

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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#4b5563] pt-1 border-t border-[#e5e7eb]">
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
                {item.unit_price && item.unit_price > 0 && (
                  <span className="ml-auto text-emerald-800 font-bold font-mono">
                    Preço Homologado Atual: R$ {item.unit_price.toFixed(decimais)}
                  </span>
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
                <div className="text-[11px] text-[#4b5563]">
                  {loadingSearch && (
                    <span className="inline-flex items-center gap-1.5 text-[#124268] font-bold animate-pulse">
                      <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                      {statusIaProgresso}
                    </span>
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
            </div>
          </div>

          {/* BANNER INFORMATIVO CESTA DE PREÇOS / FONTES OFICIAIS */}
          <div className="bg-[#fffbeb] border-l-4 border-amber-500 p-2.5 text-[11px] text-amber-900 flex items-start gap-2 border border-[#fef08a]">
            <ShieldAlert className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Fontes Oficiais Consultadas pela IA:</strong> PNCP, Compras.gov.br, BPS, CMED
              e BEC-SP (Art. 23 da Lei nº 14.133/2021). A IA efetua a varredura nas bases oficiais e
              apresenta o resultado nesta janela para validação humana.
            </div>
          </div>

          {/* CARDS DINÂMICOS DE SÍNTESE ESTATÍSTICA DAS AMOSTRAS */}
          {priceResults.length > 0 && (
            <div className="bg-white p-2.5 border border-[#b8c2cc] grid grid-cols-2 sm:grid-cols-5 gap-2 text-center shadow-xs">
              <div className="bg-[#f8fafc] p-2 border border-gray-200">
                <span className="text-[10px] font-bold text-gray-500 uppercase block">
                  AMOSTRAS
                </span>
                <span className="text-base font-bold font-mono text-gray-900 block">
                  {priceResults.length}
                </span>
                <span className="text-[9.5px] text-gray-500">
                  {selectedIds.length} selecionada(s)
                </span>
              </div>
              <div className="bg-[#f8fafc] p-2 border border-gray-200">
                <span className="text-[10px] font-bold text-gray-500 uppercase block">
                  PREÇO MÍNIMO
                </span>
                <span className="text-base font-bold font-mono text-gray-900 block">
                  R$ {precoMin.toFixed(decimais)}
                </span>
                <span className="text-[9.5px] text-gray-500">amostras válidas</span>
              </div>
              <div className="bg-[#f8fafc] p-2 border border-gray-200">
                <span className="text-[10px] font-bold text-gray-500 uppercase block">
                  PREÇO MÁXIMO
                </span>
                <span className="text-base font-bold font-mono text-gray-900 block">
                  R$ {precoMax.toFixed(decimais)}
                </span>
                <span className="text-[9.5px] text-gray-500">amostras válidas</span>
              </div>
              <div className="bg-[#f8fafc] p-2 border border-gray-200">
                <span className="text-[10px] font-bold text-gray-500 uppercase block">MÉDIA</span>
                <span className="text-base font-bold font-mono text-gray-900 block">
                  R$ {precoMedia.toFixed(decimais)}
                </span>
                <span className="text-[9.5px] text-gray-500">CV: {cv.toFixed(2)}%</span>
              </div>
              <div className="bg-[#e0f2fe] p-2 border border-[#7dd3fc]">
                <span className="text-[10px] font-bold text-[#124268] uppercase block">
                  MEDIANA (REFERÊNCIA)
                </span>
                <span className="text-base font-bold font-mono text-[#124268] block">
                  R$ {precoMediana.toFixed(decimais)}
                </span>
                <span className="text-[9.5px] text-blue-700 font-medium">Preço de Referência</span>
              </div>
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
                {(filtroFonte !== 'todas' ||
                  filtroSituacao !== 'todas' ||
                  filtroUf.trim().length > 0) && (
                  <button
                    type="button"
                    onClick={handleLimparFiltros}
                    className="text-[9.5px] text-white/90 underline hover:text-white"
                  >
                    Limpar
                  </button>
                )}
              </div>

              <div className="p-2.5 space-y-2.5 bg-white text-[11px]">
                {priceResults.length === 0 ? (
                  <p className="text-[10.5px] text-[#4b5563] leading-relaxed">
                    Quando você preencher o termo de busca e clicar em [BUSCAR] ou [COTAR COM IA], o
                    sistema disponibilizará as opções de refinamento nesta barra lateral.
                  </p>
                ) : (
                  <>
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Fonte da Cotação
                      </label>
                      <select
                        value={filtroFonte}
                        onChange={(e) => setFiltroFonte(e.target.value)}
                        className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                      >
                        <option value="todas">Todas as Fontes</option>
                        <option value="PNCP">PNCP</option>
                        <option value="Compras.gov.br">Compras.gov.br</option>
                        <option value="BPS">BPS (Saúde)</option>
                        <option value="BEC-SP">BEC-SP</option>
                        <option value="CMED">CMED (Regulatório)</option>
                      </select>
                    </div>

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

                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-[#374151] uppercase block">
                        Filtrar por UF / Órgão
                      </label>
                      <Input
                        placeholder="Ex: SP, RN, DF..."
                        value={filtroUf}
                        onChange={(e) => setFiltroUf(e.target.value)}
                        className="h-7 text-[10.5px] rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* PAINEL À DIREITA: RESULTADO DA PESQUISA (9 COLUNAS) */}
            <div className="lg:col-span-9 bg-white border border-[#b8c2cc] shadow-sm flex flex-col">
              <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between select-none">
                <span>
                  RESULTADO DA PESQUISA — {amostrasFiltradas.length} DE {priceResults.length}{' '}
                  AMOSTRA(S)
                </span>
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

              <div className="p-3 bg-white">
                {priceResults.length === 0 ? (
                  <div className="p-10 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-2">
                    <Search className="h-8 w-8 mx-auto text-gray-400" />
                    <p className="font-semibold text-gray-700">
                      {searchExecuted
                        ? 'Não foram encontradas cotações com o termo informado.'
                        : 'Nenhuma cotação pesquisada ainda para este item.'}
                    </p>
                    <p className="text-gray-500">
                      Clique no botão <strong>[COTAR COM IA]</strong> no bloco acima para consultar
                      automaticamente o PNCP, Compras.gov, BPS, BEC-SP e CMED.
                    </p>
                  </div>
                ) : (
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
                              className="rounded-none data-[state=checked]:bg-[#124268]"
                            />
                          </th>
                          <th className="p-2 whitespace-nowrap">FONTE</th>
                          <th className="p-2 whitespace-nowrap">DATA</th>
                          <th className="p-2">ÓRGÃO</th>
                          <th className="p-2">FORNECEDOR</th>
                          <th className="p-2">DESCRIÇÃO</th>
                          <th className="p-2 text-center">UNIDADE</th>
                          <th className="p-2 text-right">QUANTIDADE</th>
                          <th className="p-2 text-right whitespace-nowrap">PREÇO UNITÁRIO</th>
                          <th className="p-2 text-center">SIMILARIDADE</th>
                          <th className="p-2 text-center">ORIGEM</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {amostrasFiltradas.map((p) => {
                          const isSelected = selectedIds.includes(p.id)
                          const isExpurgado = p.status === 'expurgado'
                          const isForaLimites =
                            p.unit_price < limiteInferior || p.unit_price > limiteSuperior

                          return (
                            <tr
                              key={p.id}
                              className={`hover:bg-blue-50/40 transition-colors ${
                                isSelected ? 'bg-blue-50/20' : ''
                              } ${isExpurgado ? 'opacity-60 bg-red-50/20' : ''}`}
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
                              <td className="p-2 font-bold text-gray-900 whitespace-nowrap">
                                <Badge
                                  variant="outline"
                                  className={`rounded-none text-[10px] font-bold ${
                                    p.source === 'PNCP'
                                      ? 'bg-blue-50 text-blue-800 border-blue-300'
                                      : p.source === 'BPS'
                                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                        : p.source === 'Compras.gov.br'
                                          ? 'bg-indigo-50 text-indigo-800 border-indigo-300'
                                          : p.source === 'CMED'
                                            ? 'bg-amber-50 text-amber-800 border-amber-300'
                                            : 'bg-gray-100 text-gray-800 border-gray-300'
                                  }`}
                                >
                                  {p.source}
                                </Badge>
                              </td>

                              {/* DATA */}
                              <td className="p-2 text-gray-600 whitespace-nowrap font-mono text-[11px]">
                                {p.source_date
                                  ? new Date(p.source_date).toLocaleDateString('pt-BR')
                                  : '—'}
                              </td>

                              {/* ÓRGÃO */}
                              <td
                                className="p-2 text-gray-800 max-w-[140px] truncate"
                                title={p.government_entity}
                              >
                                <div className="font-medium text-gray-900 truncate">
                                  {p.government_entity || 'NÃO INFORMADO'}
                                </div>
                              </td>

                              {/* FORNECEDOR */}
                              <td
                                className="p-2 text-gray-700 max-w-[140px] truncate"
                                title={p.supplier}
                              >
                                <div className="truncate font-medium">
                                  {p.supplier || 'NÃO INFORMADO'}
                                </div>
                                <div className="text-[10px] text-gray-500 font-mono">
                                  CNPJ: {p.supplier_document || 'NÃO INFORMADO'}
                                </div>
                              </td>

                              {/* DESCRIÇÃO */}
                              <td
                                className="p-2 text-gray-900 font-medium max-w-[180px] truncate"
                                title={p.description_original}
                              >
                                <div className="truncate">{p.description_original}</div>
                                {p.raw_data?.catmat && (
                                  <span className="text-[10px] text-gray-500 font-mono">
                                    {p.raw_data.catmat}
                                  </span>
                                )}
                              </td>

                              {/* UNIDADE */}
                              <td className="p-2 text-center font-mono text-gray-700">{p.unit}</td>

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

                              {/* ORIGEM (VER ORIGEM) */}
                              <td className="p-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => setDetailModalPrice(p)}
                                  className="text-[#124268] hover:text-[#0c314f] font-bold underline inline-flex items-center gap-1 cursor-pointer text-[11px]"
                                >
                                  VER ORIGEM
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Botão de confirmação de cotações DENTRO do painel de pesquisa */}
                <div className="pt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 mt-2">
                  <div className="text-[11px] text-gray-600">
                    {selectedIds.length} amostra(s) marcada(s) para cálculo de {priceResults.length}{' '}
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

              {detailModalPrice.source_url && (
                <div className="pt-2 border-t border-gray-200 flex justify-between items-center">
                  <span className="text-[11px] text-gray-500">Documento / Link Oficial:</span>
                  <a
                    href={detailModalPrice.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#124268] hover:underline font-bold text-xs inline-flex items-center gap-1"
                  >
                    Abrir URL da Fonte
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              )}
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
