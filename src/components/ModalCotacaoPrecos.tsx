import React, { useState, useMemo } from 'react'
import {
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Plus,
  Eye,
  FileSpreadsheet,
  Lock,
  ExternalLink,
  Info,
  Clock,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  X,
  FileText,
  AlertCircle,
  Tag,
  Building2,
  Hash,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  Pesquisa,
  Referencia,
  StatusRevisao,
  NaturezaPreco,
  FonteReferencia,
  MetodoCalculo,
  DemandaItem,
} from '@/types'
import {
  executarMotorCalculo,
  formatarMoeda,
  formatarData,
  roundToTwoDecimals,
} from '@/lib/calculoEngine'

interface ModalCotacaoPrecosProps {
  open: boolean
  onClose: () => void
  pesquisa: Pesquisa
  referencias: Referencia[]
  onAtualizarStatus: (ref: Referencia, status: StatusRevisao, motivo?: string) => Promise<void>
  onAdicionarCotaçãoManual: (dados: {
    fonte: FonteReferencia
    id_externo: string
    item_externo: string
    natureza_preco: NaturezaPreco
    valor_original: number
    fornecedor: string
    url: string
    unidade: string
    quantidade: number
  }) => Promise<void>
  onSalvarCalculo?: (dados: { metodo: MetodoCalculo; justificativa: string }) => Promise<void>
  onConcluirCotacao: () => Promise<void>
}

export default function ModalCotacaoPrecos({
  open,
  onClose,
  pesquisa,
  referencias,
  onAtualizarStatus,
  onAdicionarCotaçãoManual,
  onSalvarCalculo,
  onConcluirCotacao,
}: ModalCotacaoPrecosProps) {
  // Abas de Argumento de Pesquisa: 'palavra_chave' | 'catmat'
  const [abaArgumento, setAbaArgumento] = useState<'palavra_chave' | 'catmat'>('palavra_chave')
  const [termoPesquisa, setTermoPesquisa] = useState('')
  const [termoCatmat, setTermoCatmat] = useState('')
  const [cnpjPesquisa, setCnpjPesquisa] = useState('')
  const [tipoPesquisa, setTipoPesquisa] = useState<'palavras' | 'exata'>('palavras')
  const [buscaExecutada, setBuscaExecutada] = useState(false)

  // Filtros Refinar
  const [filtroFonte, setFiltroFonte] = useState<string>('todas')
  const [filtroNatureza, setFiltroNatureza] = useState<string>('todas')
  const [filtroStatus, setFiltroStatus] = useState<string>('todas')
  const [filtroUf, setFiltroUf] = useState<string>('')

  // Ordenação
  const [ordenacao, setOrdenacao] = useState<'menor_preco' | 'maior_preco' | 'data_recente'>(
    'menor_preco',
  )

  // Medida de Tendência Central
  const [metodoSelecionado, setMetodoSelecionado] = useState<MetodoCalculo>('mediana')
  const [justificativaMetodo, setJustificativaMetodo] = useState('')
  const [modalMudarMetodo, setModalMudarMetodo] = useState(false)
  const [novoMetodoTemp, setNovoMetodoTemp] = useState<MetodoCalculo>('media')
  const [novaJustificativaMetodoTemp, setNovaJustificativaMetodoTemp] = useState('')

  // Crítica dos dados / Justificativa geral
  const [modalJustificativa, setModalJustificativa] = useState(false)
  const [justificativaGeral, setJustificativaGeral] = useState('')

  // Modal de Evidência e Hash
  const [amostraEvidencia, setAmostraEvidencia] = useState<Referencia | null>(null)

  // Modal de Exclusão
  const [amostraExclusao, setAmostraExclusao] = useState<Referencia | null>(null)
  const [motivoExclusao, setMotivoExclusao] = useState('')

  // Modal Cadastro de Cotação Manual
  const [modalNovaAmostra, setModalNovaAmostra] = useState(false)
  const [novaAmostra, setNovaAmostra] = useState<{
    fonte: FonteReferencia
    id_externo: string
    item_externo: string
    natureza_preco: NaturezaPreco
    valor_original: number
    fornecedor: string
    url: string
    unidade: string
    quantidade: number
  }>({
    fonte: 'manual',
    id_externo: '',
    item_externo: '',
    natureza_preco: 'cotacao_comercial',
    valor_original: 0,
    fornecedor: '',
    url: '',
    unidade: 'un',
    quantidade: 1,
  })

  const [salvandoConclusao, setSalvandoConclusao] = useState(false)

  const demandaItem: DemandaItem | undefined = pesquisa.expand?.demanda_item_id
  const quantidadeDemandada = demandaItem?.quantidade || 1

  // Candidatos aceitos para cálculo
  const aceitos = useMemo(
    () => referencias.filter((r) => r.status_revisao === 'aceito'),
    [referencias],
  )
  const excluidos = useMemo(
    () => referencias.filter((r) => r.status_revisao === 'excluido'),
    [referencias],
  )

  // Execução do motor determinístico
  const resultadoCalculo = useMemo(() => {
    const res = executarMotorCalculo(
      aceitos,
      quantidadeDemandada,
      metodoSelecionado,
      justificativaGeral ||
        justificativaMetodo ||
        (aceitos.length < 3 ? '' : 'Conformidade com a Lei nº 14.133/2021'),
    )
    // Atualizar contagem de expurgadas com as que realmente foram excluídas no processo
    res.juizo_critico.expurgadas_count = excluidos.length
    return res
  }, [
    aceitos,
    excluidos.length,
    quantidadeDemandada,
    metodoSelecionado,
    justificativaGeral,
    justificativaMetodo,
  ])

  // Amostras filtradas para exibição no "Resultado da Pesquisa" e na "Série de Preços"
  const amostrasFiltradas = useMemo(() => {
    let list = [...referencias]

    if (filtroFonte !== 'todas') {
      list = list.filter((r) => r.fonte === filtroFonte)
    }
    if (filtroNatureza !== 'todas') {
      list = list.filter((r) => r.natureza_preco === filtroNatureza)
    }
    if (filtroStatus !== 'todas') {
      list = list.filter((r) => r.status_revisao === filtroStatus)
    }

    // Ordenação
    if (ordenacao === 'menor_preco') {
      list.sort((a, b) => a.valor_original - b.valor_original)
    } else if (ordenacao === 'maior_preco') {
      list.sort((a, b) => b.valor_original - a.valor_original)
    } else if (ordenacao === 'data_recente') {
      list.sort(
        (a, b) =>
          new Date(b.data_contratacao || 0).getTime() - new Date(a.data_contratacao || 0).getTime(),
      )
    }

    return list
  }, [referencias, filtroFonte, filtroNatureza, filtroStatus, ordenacao])

  // Verificação de pendências impeditivas para "CONCLUIR COTAÇÃO"
  const temMenosDeTres = aceitos.length < 3
  const justificativaPendente =
    temMenosDeTres && (!justificativaGeral || justificativaGeral.trim().length < 10)
  const botaoConcluirDesabilitado =
    justificativaPendente || aceitos.length === 0 || salvandoConclusao

  const handlePesquisar = () => {
    setBuscaExecutada(true)
  }

  const handleLimparFiltros = () => {
    setFiltroFonte('todas')
    setFiltroNatureza('todas')
    setFiltroStatus('todas')
    setFiltroUf('')
    setOrdenacao('menor_preco')
  }

  const handleSubmeterNovaAmostra = async (e: React.FormEvent) => {
    e.preventDefault()
    await onAdicionarCotaçãoManual(novaAmostra)
    setModalNovaAmostra(false)
    setNovaAmostra({
      fonte: 'manual',
      id_externo: '',
      item_externo: '',
      natureza_preco: 'cotacao_comercial',
      valor_original: 0,
      fornecedor: '',
      url: '',
      unidade: 'un',
      quantidade: 1,
    })
  }

  const handleConfirmarMudancaMetodo = async () => {
    if (!novaJustificativaMetodoTemp || novaJustificativaMetodoTemp.trim().length < 10) {
      alert(
        'Para alterar o método de tendência central, é obrigatório registrar uma justificativa fundamentada.',
      )
      return
    }
    setMetodoSelecionado(novoMetodoTemp)
    setJustificativaMetodo(novaJustificativaMetodoTemp)
    setModalMudarMetodo(false)
    if (onSalvarCalculo) {
      await onSalvarCalculo({
        metodo: novoMetodoTemp,
        justificativa: novaJustificativaMetodoTemp,
      })
    }
  }

  const handleSalvarJustificativaGeral = async () => {
    if (!justificativaGeral.trim()) {
      alert('Preencha a justificativa ou observação.')
      return
    }
    setModalJustificativa(false)
    if (onSalvarCalculo) {
      await onSalvarCalculo({
        metodo: metodoSelecionado,
        justificativa: justificativaGeral,
      })
    }
  }

  const handleConcluir = async () => {
    if (botaoConcluirDesabilitado) return
    setSalvandoConclusao(true)
    try {
      if (onSalvarCalculo) {
        await onSalvarCalculo({
          metodo: metodoSelecionado,
          justificativa:
            justificativaGeral || justificativaMetodo || 'Conformidade com a Lei nº 14.133/2021',
        })
      }
      await onConcluirCotacao()
      onClose()
    } finally {
      setSalvandoConclusao(false)
    }
  }

  if (!open) return null

  const { juizo_critico, estatisticas_saneadas } = resultadoCalculo

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[96vw] w-[1380px] max-h-[94vh] p-0 overflow-hidden flex flex-col bg-[#F3F4F6] text-gray-900 border-0 shadow-2xl">
        {/* Barra de Título Superior Azul Cesta */}
        <div className="bg-[#174873] text-white px-5 py-3 flex items-center justify-between shadow select-none">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm tracking-wide uppercase">Cotação de Preços</span>
            <span className="text-xs text-blue-200">|</span>
            <span className="text-xs text-blue-100 font-mono">Item #{pesquisa.numero}</span>
          </div>
          <button
            onClick={onClose}
            className="text-blue-100 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
            title="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Corpo do Modal com Scroll Interno */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* SEÇÃO 1: DESCRIÇÃO DO ITEM A SER COTADO */}
          <div className="bg-white rounded border border-gray-300 shadow-sm overflow-hidden">
            <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 bg-gray-300 rounded-sm" />
              Descrição do Item a ser Cotado
            </div>
            <div className="p-3 bg-white space-y-2">
              <p className="text-xs font-semibold text-gray-800 leading-snug">
                {demandaItem?.descricao || 'Descrição do item não disponível'}
              </p>
              <div className="flex flex-wrap items-center gap-4 text-[11px] text-gray-600 pt-1 border-t border-gray-100">
                <span>
                  <strong>Quantidade Demandada:</strong>{' '}
                  <span className="font-mono font-bold text-[#174873]">
                    {quantidadeDemandada} {demandaItem?.unidade || 'un'}
                  </span>
                </span>
                {demandaItem?.catalogo && (
                  <span>
                    <strong>Catálogo:</strong>{' '}
                    <span className="font-mono">{demandaItem.catalogo}</span>
                  </span>
                )}
                {demandaItem?.prazo_entrega && (
                  <span>
                    <strong>Prazo:</strong> {demandaItem.prazo_entrega}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-gray-500 italic">
                  *Versão congelada da demanda. A busca nunca altera a demanda original.
                </span>
              </div>
            </div>
          </div>

          {/* SEÇÃO 2: ARGUMENTO DE PESQUISA */}
          <div className="bg-white rounded border border-gray-300 shadow-sm overflow-hidden">
            <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center gap-2">
              <Search className="h-3.5 w-3.5" />
              Argumento de Pesquisa
            </div>

            {/* Abas */}
            <div className="flex border-b border-gray-200 bg-gray-50 text-xs">
              <button
                type="button"
                onClick={() => setAbaArgumento('palavra_chave')}
                className={`px-4 py-2 font-semibold uppercase tracking-wider transition-colors ${
                  abaArgumento === 'palavra_chave'
                    ? 'bg-white text-[#174873] border-b-2 border-[#174873]'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Pesquisar por Palavra-Chave
              </button>
              <button
                type="button"
                onClick={() => setAbaArgumento('catmat')}
                className={`px-4 py-2 font-semibold uppercase tracking-wider transition-colors ${
                  abaArgumento === 'catmat'
                    ? 'bg-white text-[#174873] border-b-2 border-[#174873]'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Pesquisar por CATMAT/CATSER
              </button>
            </div>

            {/* Conteúdo do Argumento */}
            <div className="p-3 bg-white space-y-3">
              {abaArgumento === 'palavra_chave' ? (
                <div>
                  <p className="text-[11px] font-semibold text-gray-700 mb-1">
                    Parte da descrição técnica ou genérica do produto:
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
                    <div className="md:col-span-8">
                      <Input
                        placeholder="Digite o que você procura aqui"
                        value={termoPesquisa}
                        onChange={(e) => setTermoPesquisa(e.target.value)}
                        className="text-xs h-9 bg-white"
                      />
                    </div>
                    <div className="md:col-span-4">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 font-semibold whitespace-nowrap">
                          CNPJ:
                        </span>
                        <Input
                          placeholder="99.999.999/9999-99"
                          value={cnpjPesquisa}
                          onChange={(e) => setCnpjPesquisa(e.target.value)}
                          className="text-xs h-9 font-mono bg-white"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Radio buttons: Contratação por palavras vs Expressão exata */}
                  <div className="flex items-center gap-6 mt-2 text-xs text-gray-700">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="tipoPesquisa"
                        checked={tipoPesquisa === 'palavras'}
                        onChange={() => setTipoPesquisa('palavras')}
                        className="text-[#174873] focus:ring-[#174873]"
                      />
                      <span>Contratação por palavras</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="tipoPesquisa"
                        checked={tipoPesquisa === 'exata'}
                        onChange={() => setTipoPesquisa('exata')}
                        className="text-[#174873] focus:ring-[#174873]"
                      />
                      <span>Expressão exata</span>
                    </label>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-[11px] font-semibold text-gray-700 mb-1">
                    Código ou descrição oficial do CATMAT/CATSER:
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
                    <div className="md:col-span-8">
                      <Input
                        placeholder="Ex: 463721 ou Veículo automotor"
                        value={termoCatmat}
                        onChange={(e) => setTermoCatmat(e.target.value)}
                        className="text-xs h-9 bg-white"
                      />
                    </div>
                    <div className="md:col-span-4">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 font-semibold whitespace-nowrap">
                          CNPJ:
                        </span>
                        <Input
                          placeholder="99.999.999/9999-99"
                          value={cnpjPesquisa}
                          onChange={(e) => setCnpjPesquisa(e.target.value)}
                          className="text-xs h-9 font-mono bg-white"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Botões de Ação da Busca */}
              <div className="flex items-center justify-between pt-1 border-t border-gray-100">
                <Button
                  type="button"
                  onClick={handlePesquisar}
                  className="bg-[#174873] hover:bg-[#12385b] text-white text-xs font-bold uppercase tracking-wider px-4 h-8"
                >
                  <Search className="h-3.5 w-3.5 mr-1.5" />
                  Pesquisar
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setModalNovaAmostra(true)}
                  className="text-xs border-blue-300 text-[#174873] hover:bg-blue-50 h-8"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Adicionar Amostra Manual (Evidência Digital)
                </Button>
              </div>
            </div>
          </div>

          {/* SEÇÃO 3 & 4: PAINEL DIVIDIDO (REFINAR + RESULTADO DA PESQUISA) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* PAINEL LATERAL: REFINAR */}
            <div className="lg:col-span-3 bg-white rounded border border-gray-300 shadow-sm overflow-hidden">
              <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Filter className="h-3.5 w-3.5" />
                  Refinar
                </span>
                {(filtroFonte !== 'todas' ||
                  filtroNatureza !== 'todas' ||
                  filtroStatus !== 'todas') && (
                  <button
                    onClick={handleLimparFiltros}
                    className="text-[10px] text-gray-200 underline hover:text-white"
                  >
                    Limpar
                  </button>
                )}
              </div>
              <div className="p-3 space-y-3 text-xs bg-gray-50/50">
                {!buscaExecutada && referencias.length === 0 ? (
                  <p className="text-[11px] text-gray-500 leading-relaxed italic">
                    Quando você preencher o campo de busca em{' '}
                    <strong>localizar descrição de item</strong> e depois clicar no botão{' '}
                    <strong>pesquisar</strong>, o sistema disponibilizará mais opções de filtros.
                  </p>
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label className="text-[11px] font-semibold text-gray-700">Fonte</Label>
                      <Select value={filtroFonte} onValueChange={setFiltroFonte}>
                        <SelectTrigger className="h-8 text-xs bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todas">Todas as Fontes</SelectItem>
                          <SelectItem value="compras_gov">Compras.gov.br</SelectItem>
                          <SelectItem value="pncp">PNCP</SelectItem>
                          <SelectItem value="manual">Cotação Manual</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[11px] font-semibold text-gray-700">Natureza</Label>
                      <Select value={filtroNatureza} onValueChange={setFiltroNatureza}>
                        <SelectTrigger className="h-8 text-xs bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todas">Todas as Naturezas</SelectItem>
                          <SelectItem value="contratado">Contratado</SelectItem>
                          <SelectItem value="homologado">Homologado</SelectItem>
                          <SelectItem value="cotacao_comercial">Cotação Comercial</SelectItem>
                          <SelectItem value="estimado">Estimado de Edital</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[11px] font-semibold text-gray-700">Situação</Label>
                      <Select value={filtroStatus} onValueChange={setFiltroStatus}>
                        <SelectTrigger className="h-8 text-xs bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="todas">Todas as Situações</SelectItem>
                          <SelectItem value="aceito">Aceitas para Cálculo</SelectItem>
                          <SelectItem value="excluido">Expurgadas / Excluídas</SelectItem>
                          <SelectItem value="pendente">Revisão Pendente</SelectItem>
                          <SelectItem value="necessita_esclarecimento">Em Diligência</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="pt-2 border-t border-gray-200 text-[10px] text-gray-500">
                      Conectores ativos: PNCP, Compras.gov.br e Cotação Manual com auditoria
                      digital.
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* RESULTADO DA PESQUISA */}
            <div className="lg:col-span-9 bg-white rounded border border-gray-300 shadow-sm overflow-hidden flex flex-col">
              <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between">
                <span>Resultado da Pesquisa ({amostrasFiltradas.length})</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-200 uppercase tracking-normal">
                    Ordenar por:
                  </span>
                  <select
                    value={ordenacao}
                    onChange={(e: any) => setOrdenacao(e.target.value)}
                    className="h-6 text-[10px] bg-white text-gray-900 rounded px-1.5 font-medium border-0 focus:ring-1 focus:ring-white"
                  >
                    <option value="menor_preco">MENOR PREÇO UNITÁRIO</option>
                    <option value="maior_preco">MAIOR PREÇO UNITÁRIO</option>
                    <option value="data_recente">DATA MAIS RECENTE</option>
                  </select>
                </div>
              </div>

              <div className="p-3 bg-white">
                {/* Banner Amarelo do Cesta antes da primeira busca quando lista está vazia */}
                {!buscaExecutada && referencias.length === 0 ? (
                  <div className="p-3 rounded bg-[#FEF9C3] border border-[#FDE047] text-xs text-[#854D0E] flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#CA8A04] flex-shrink-0" />
                    <span>
                      Preencha os campos de <strong>"localizar descrição do item"</strong> e depois
                      clique no botão <strong>"pesquisar"</strong> para listar amostras de preços.
                    </span>
                  </div>
                ) : amostrasFiltradas.length === 0 ? (
                  <div className="p-6 text-center text-xs text-gray-500">
                    Você não possui amostras de preços para este item
                  </div>
                ) : (
                  /* Cards resumidos das amostras no resultado */
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {amostrasFiltradas.map((cand, idx) => {
                      const isAceito = cand.status_revisao === 'aceito'
                      const isExcluido = cand.status_revisao === 'excluido'
                      const isCritico =
                        isAceito &&
                        (cand.valor_original < juizo_critico.limite_inferior ||
                          cand.valor_original > juizo_critico.limite_superior)

                      return (
                        <div
                          key={cand.id}
                          className={`p-2.5 rounded border text-xs flex flex-col md:flex-row md:items-center justify-between gap-2 transition-all ${
                            isAceito
                              ? 'border-emerald-300 bg-white'
                              : isExcluido
                                ? 'border-red-200 bg-red-50/20'
                                : 'border-amber-300 bg-amber-50/20'
                          }`}
                        >
                          <div className="space-y-0.5 flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-gray-800">Amostra #{idx + 1}</span>
                              <Badge
                                variant="outline"
                                className="font-mono text-[9px] uppercase px-1 py-0 text-[#174873]"
                              >
                                {cand.fonte.replace('_', '.')}
                              </Badge>
                              {isAceito && (
                                <Badge className="bg-emerald-100 text-emerald-800 text-[9px] px-1.5 py-0 border-emerald-300">
                                  Válida
                                </Badge>
                              )}
                              {isExcluido && (
                                <Badge className="bg-red-100 text-red-800 text-[9px] px-1.5 py-0 border-red-300">
                                  Expurgada
                                </Badge>
                              )}
                              {isCritico && (
                                <Badge className="bg-red-600 text-white text-[9px] px-1.5 py-0 font-bold">
                                  Fora dos limites (Crítica)
                                </Badge>
                              )}
                            </div>
                            <p className="text-gray-700 truncate font-medium">
                              {cand.item_externo || 'Sem descrição externa'}
                            </p>
                            <p className="text-[10px] text-gray-500">
                              Fornecedor: <strong>{cand.fornecedor || 'Não informado'}</strong> •
                              Data: {formatarData(cand.data_contratacao)}
                            </p>
                          </div>

                          <div className="flex items-center gap-3 justify-between md:justify-end">
                            <div className="text-right">
                              <span className="text-[10px] text-gray-500 block">Unitário:</span>
                              <span className="font-mono font-bold text-sm text-gray-900">
                                {formatarMoeda(cand.valor_original)}
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setAmostraEvidencia(cand)}
                              className="text-[11px] h-7 text-[#174873] hover:bg-blue-50"
                            >
                              <Eye className="h-3 w-3 mr-1" />
                              Evidência
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SEÇÃO 5: ANÁLISE CRÍTICA DAS AMOSTRAS (JUÍZO CRÍTICO + MÉTODO ESTATÍSTICO) */}
          <div className="bg-white rounded border border-gray-300 shadow-sm overflow-hidden">
            <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              Análise Crítica das Amostras
            </div>

            <div className="divide-y divide-gray-200">
              {/* Bloco a) Juízo Crítico */}
              <div className="p-3 bg-white space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-800 uppercase tracking-wide">
                    Juízo Crítico
                  </span>
                  <span className="text-[10px] text-gray-500">
                    *Amostras fora dos limites são suspeitas/críticas — expurgo exige decisão humana
                    justificada
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-center text-xs border border-gray-200">
                    <thead className="bg-[#E5E7EB] text-gray-700 font-semibold text-[11px]">
                      <tr>
                        <th className="p-2 border">Nº DE AMOSTRAS COLETADAS</th>
                        <th className="p-2 border">DESVIO-PADRÃO</th>
                        <th className="p-2 border">MEDIANA</th>
                        <th className="p-2 border">LIMITE INFERIOR (70% da mediana)</th>
                        <th className="p-2 border">LIMITE SUPERIOR (30% da mediana)</th>
                        <th className="p-2 border">CRÍTICAS</th>
                        <th className="p-2 border">AMOSTRAS EXPURGADAS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 font-mono text-xs">
                      <tr className="bg-white">
                        <td className="p-2 border font-bold">{juizo_critico.n_coletadas}</td>
                        <td className="p-2 border">{juizo_critico.desvio_padrao.toFixed(2)}</td>
                        <td className="p-2 border font-bold text-gray-900">
                          {formatarMoeda(juizo_critico.mediana)}
                        </td>
                        <td className="p-2 border text-gray-700">
                          {formatarMoeda(juizo_critico.limite_inferior)}
                          <span className="text-[10px] text-gray-500 block font-sans">
                            (70% da mediana)
                          </span>
                        </td>
                        <td className="p-2 border text-gray-700">
                          {formatarMoeda(juizo_critico.limite_superior)}
                          <span className="text-[10px] text-gray-500 block font-sans">
                            (30% da mediana)
                          </span>
                        </td>
                        <td className="p-2 border">
                          {juizo_critico.criticas_count > 0 ? (
                            <span className="inline-block px-2 py-0.5 rounded bg-red-600 text-white font-bold text-xs">
                              {juizo_critico.criticas_count}
                            </span>
                          ) : (
                            <span className="text-gray-500">0</span>
                          )}
                        </td>
                        <td className="p-2 border font-bold text-gray-800">
                          {juizo_critico.expurgadas_count}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bloco b) Método Estatístico Aplicado às Amostras Saneadas */}
              <div className="p-3 bg-gray-50/70 space-y-2">
                <span className="text-xs font-bold text-gray-800 uppercase tracking-wide">
                  Método Estatístico Aplicado às Amostras Saneadas
                </span>

                <div className="overflow-x-auto">
                  <table className="w-full text-center text-xs border border-gray-200">
                    <thead className="bg-[#E5E7EB] text-gray-700 font-semibold text-[11px]">
                      <tr>
                        <th className="p-2 border">Nº DE AMOSTRAS VÁLIDAS</th>
                        <th className="p-2 border">DESVIO-PADRÃO</th>
                        <th className="p-2 border">COEFICIENTE DE VARIAÇÃO</th>
                        <th className="p-2 border">MENOR PREÇO</th>
                        <th className="p-2 border">MÉDIA</th>
                        <th className="p-2 border">MEDIANA</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 font-mono text-xs">
                      <tr className="bg-white">
                        <td className="p-2 border font-bold text-emerald-800">
                          {estatisticas_saneadas.n_validas}
                        </td>
                        <td className="p-2 border">
                          {estatisticas_saneadas.desvio_padrao.toFixed(2)}
                        </td>
                        <td className="p-2 border font-bold">
                          {estatisticas_saneadas.coeficiente_variacao.toFixed(2)}%
                        </td>
                        <td className="p-2 border">
                          {formatarMoeda(estatisticas_saneadas.menor_preco)}
                        </td>
                        <td className="p-2 border">{formatarMoeda(estatisticas_saneadas.media)}</td>
                        <td className="p-2 border font-bold text-[#174873]">
                          {formatarMoeda(estatisticas_saneadas.mediana)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          {/* SEÇÃO 6: SÉRIE DE PREÇOS COLETADOS */}
          <div className="bg-white rounded border border-gray-300 shadow-sm overflow-hidden">
            <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between">
              <span>Série de Preços Coletados</span>
              <span className="text-[10px] text-gray-200">
                Ações por linha para Aceitar / Excluir com Justificativa / Diligência
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#E5E7EB] text-gray-700 font-semibold text-[11px]">
                  <tr>
                    <th className="p-2.5 border-b">Amostra</th>
                    <th className="p-2.5 border-b">Situação</th>
                    <th className="p-2.5 border-b">Fonte</th>
                    <th className="p-2.5 border-b">Marca / Fornecedor</th>
                    <th className="p-2.5 border-b">Data</th>
                    <th className="p-2.5 border-b">Vencimento</th>
                    <th className="p-2.5 border-b">Medida</th>
                    <th className="p-2.5 border-b text-center">Qnt. Original</th>
                    <th className="p-2.5 border-b text-right">Valor Unitário</th>
                    <th className="p-2.5 border-b text-center">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 text-xs">
                  {referencias.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="p-8 text-center text-gray-500 italic">
                        Você não possui amostras de preços para este item
                      </td>
                    </tr>
                  ) : (
                    referencias.map((cand, idx) => {
                      const isAceito = cand.status_revisao === 'aceito'
                      const isExcluido = cand.status_revisao === 'excluido'
                      const isPendente = cand.status_revisao === 'pendente'
                      const isDiligencia = cand.status_revisao === 'necessita_esclarecimento'

                      return (
                        <tr
                          key={cand.id}
                          className={`hover:bg-gray-50/70 transition-colors ${
                            isExcluido ? 'bg-red-50/30' : ''
                          }`}
                        >
                          <td className="p-2.5 font-bold text-gray-800 whitespace-nowrap">
                            #{idx + 1}
                          </td>
                          <td className="p-2.5 whitespace-nowrap">
                            {isAceito && (
                              <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px]">
                                Válida
                              </Badge>
                            )}
                            {isExcluido && (
                              <Badge className="bg-red-100 text-red-800 border-red-300 text-[10px]">
                                Expurgada
                              </Badge>
                            )}
                            {isPendente && (
                              <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[10px]">
                                Pendente
                              </Badge>
                            )}
                            {isDiligencia && (
                              <Badge className="bg-purple-100 text-purple-800 border-purple-300 text-[10px]">
                                Diligência
                              </Badge>
                            )}
                          </td>
                          <td className="p-2.5 uppercase font-mono text-[10px] text-[#174873] font-semibold whitespace-nowrap">
                            {cand.fonte.replace('_', '.')}
                          </td>
                          <td className="p-2.5 max-w-xs truncate" title={cand.fornecedor}>
                            {cand.fornecedor || 'Não informado'}
                          </td>
                          <td className="p-2.5 font-mono text-[11px] whitespace-nowrap">
                            {formatarData(cand.data_contratacao)}
                          </td>
                          <td className="p-2.5 font-mono text-[11px] text-gray-500 whitespace-nowrap">
                            -
                          </td>
                          <td className="p-2.5 font-mono text-[11px] whitespace-nowrap">
                            {cand.unidade || 'un'}
                          </td>
                          <td className="p-2.5 font-mono text-center whitespace-nowrap">
                            {cand.quantidade || 1}
                          </td>
                          <td className="p-2.5 font-mono font-bold text-right whitespace-nowrap text-gray-900">
                            {formatarMoeda(cand.valor_original)}
                          </td>
                          <td className="p-2.5 whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setAmostraEvidencia(cand)}
                                className="h-6 w-6 p-0 text-[#174873]"
                                title="Ver Evidência"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => onAtualizarStatus(cand, 'aceito')}
                                className={`h-6 text-[10px] px-1.5 ${
                                  isAceito
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                    : 'text-gray-700 hover:text-emerald-700'
                                }`}
                              >
                                Aceitar
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setAmostraExclusao(cand)
                                  setMotivoExclusao(
                                    cand.motivo_exclusao || 'Item incompatível com a demanda',
                                  )
                                }}
                                className={`h-6 text-[10px] px-1.5 ${
                                  isExcluido
                                    ? 'bg-red-50 text-red-800 border-red-300'
                                    : 'text-gray-700 hover:text-red-700'
                                }`}
                              >
                                Excluir
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  onAtualizarStatus(
                                    cand,
                                    'necessita_esclarecimento',
                                    'Necessita diligência com fornecedor',
                                  )
                                }
                                className="h-6 text-[10px] px-1 text-amber-700"
                                title="Diligência"
                              >
                                Diligência
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* SEÇÃO 7: MEDIDA DE TENDÊNCIA CENTRAL */}
          <div className="bg-white rounded border border-gray-300 shadow-sm overflow-hidden">
            <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between">
              <span>
                Método Estatístico Aplicado às Amostras Saneadas / Medida de Tendência Central
              </span>
              <button
                type="button"
                onClick={() => {
                  setNovoMetodoTemp(metodoSelecionado)
                  setNovaJustificativaMetodoTemp(justificativaMetodo)
                  setModalMudarMetodo(true)
                }}
                className="text-[10px] text-blue-100 hover:text-white underline font-normal"
              >
                Alterar método de cálculo...
              </button>
            </div>

            <div className="p-3 bg-white">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                {/* Lado esquerdo: Destaque da medida escolhida */}
                <div className="md:col-span-6 border-r border-gray-200 pr-4">
                  <span className="text-[11px] font-semibold text-gray-500 uppercase block tracking-wider">
                    Medida de Tendência Central Adotada (Preço de Referência)
                  </span>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono text-[#174873]">
                      {resultadoCalculo.preco_referencia !== null
                        ? formatarMoeda(resultadoCalculo.preco_referencia)
                        : 'AUSENTE (amostra insuficiente)'}
                    </span>
                    <Badge className="bg-[#174873] text-white uppercase text-[10px]">
                      {metodoSelecionado}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-gray-600 mt-1">
                    Total Estimado do Item:{' '}
                    <strong className="font-mono text-gray-900">
                      {resultadoCalculo.total_item !== null
                        ? `${quantidadeDemandada} × ${formatarMoeda(resultadoCalculo.preco_referencia)} = ${formatarMoeda(resultadoCalculo.total_item)}`
                        : 'Preço ausente'}
                    </strong>
                  </p>
                  {justificativaMetodo && (
                    <p className="text-[10px] text-gray-500 italic mt-1 bg-gray-50 p-1.5 rounded border border-gray-200">
                      Justificativa: {justificativaMetodo}
                    </p>
                  )}
                </div>

                {/* Lado direito: Tabela de medidas comparativas */}
                <div className="md:col-span-6 space-y-1.5 font-mono text-xs">
                  <div
                    className={`flex items-center justify-between p-1.5 rounded ${
                      metodoSelecionado === 'mediana'
                        ? 'bg-blue-50 font-bold border border-blue-200'
                        : ''
                    }`}
                  >
                    <span className="text-gray-700">MEDIANA (padrão normativo):</span>
                    <span className="text-gray-900">
                      {formatarMoeda(estatisticas_saneadas.mediana)}
                    </span>
                  </div>
                  <div
                    className={`flex items-center justify-between p-1.5 rounded ${
                      metodoSelecionado === 'media'
                        ? 'bg-blue-50 font-bold border border-blue-200'
                        : ''
                    }`}
                  >
                    <span className="text-gray-700">MÉDIA ARITMÉTICA:</span>
                    <span className="text-gray-900">
                      {formatarMoeda(estatisticas_saneadas.media)}
                    </span>
                  </div>
                  <div
                    className={`flex items-center justify-between p-1.5 rounded ${
                      metodoSelecionado === 'menor'
                        ? 'bg-blue-50 font-bold border border-blue-200'
                        : ''
                    }`}
                  >
                    <span className="text-gray-700">MENOR PREÇO:</span>
                    <span className="text-gray-900">
                      {formatarMoeda(estatisticas_saneadas.menor_preco)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* SEÇÃO 8: CRÍTICA DOS DADOS */}
          <div className="bg-white rounded border border-gray-300 shadow-sm overflow-hidden">
            <div className="bg-[#6B7280] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between">
              <span>Crítica dos Dados</span>
            </div>

            <div className="p-3 bg-white space-y-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setModalJustificativa(true)}
                className="text-xs border-gray-300 text-gray-800 hover:bg-gray-50 h-8 font-semibold"
              >
                <FileText className="h-3.5 w-3.5 mr-1.5 text-[#174873]" />
                Adicionar justificativa ou observação
              </Button>

              {/* Aviso Amarelo do Cesta quando coletadas menos de 3 amostras */}
              {temMenosDeTres && (
                <div className="p-3 rounded bg-[#FEF9C3] border border-[#FDE047] text-xs text-[#854D0E] space-y-1">
                  <div className="flex items-center gap-2 font-bold">
                    <AlertTriangle className="h-4 w-4 text-[#CA8A04] flex-shrink-0" />
                    <span>
                      1. Foram coletadas menos de três amostras de preços. É preciso justificar este
                      item do orçamento.
                    </span>
                  </div>
                  <p className="text-[11px] text-[#A16207] pl-6">
                    <button
                      type="button"
                      onClick={() => setModalJustificativa(true)}
                      className="underline font-semibold hover:text-[#854D0E]"
                    >
                      Clique aqui para justificar as exclusões das amostras ou a insuficiência
                      amostral.
                    </button>
                    {justificativaPendente ? (
                      <span className="text-red-700 font-bold ml-2">
                        [PENDÊNCIA OBRIGATÓRIA: Preço de referência permanece AUSENTE até o registro
                        formal]
                      </span>
                    ) : (
                      <span className="text-emerald-700 font-bold ml-2">
                        [Justificativa registrada: cotação apta para conclusão]
                      </span>
                    )}
                  </p>
                </div>
              )}

              {justificativaGeral && (
                <div className="p-2.5 rounded bg-gray-50 border border-gray-200 text-xs text-gray-800 space-y-1">
                  <span className="font-semibold text-gray-900 block">
                    Justificativa / Parecer Registrado:
                  </span>
                  <p className="whitespace-pre-wrap leading-relaxed">{justificativaGeral}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RODAPÉ DO MODAL CESTA DE PREÇOS */}
        <div className="bg-white border-t border-gray-300 px-5 py-3 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-inner">
          <div className="text-xs text-gray-600">
            {justificativaPendente ? (
              <span className="text-red-600 font-semibold flex items-center gap-1.5">
                <AlertCircle className="h-4 w-4" />
                Pendência: Justificativa de amostra insuficiente obrigatória para liberar o preço e
                a conclusão.
              </span>
            ) : aceitos.length === 0 ? (
              <span className="text-amber-700 font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                Sem amostras válidas aceitas para cálculo.
              </span>
            ) : (
              <span className="text-emerald-700 font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                Cotação saneada e em conformidade determinística com a Lei 14.133/2021.
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              className="text-xs uppercase tracking-wider font-semibold h-9 px-4 border-gray-300"
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Fechar
            </Button>
            <Button
              type="button"
              disabled={botaoConcluirDesabilitado}
              onClick={handleConcluir}
              className={`text-xs uppercase tracking-wider font-bold h-9 px-5 text-white ${
                botaoConcluirDesabilitado
                  ? 'bg-gray-400 cursor-not-allowed opacity-60'
                  : 'bg-[#174873] hover:bg-[#12385b]'
              }`}
            >
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
              {salvandoConclusao ? 'Salvando...' : 'Concluir Cotação e Fechar Janela'}
            </Button>
          </div>
        </div>
      </DialogContent>

      {/* MODAL SECUNDÁRIO: EVIDÊNCIA E HASH */}
      {amostraEvidencia && (
        <Dialog open={!!amostraEvidencia} onOpenChange={() => setAmostraEvidencia(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold text-gray-900 uppercase">
                Evidência e Auditoria da Amostra
              </DialogTitle>
              <DialogDescription className="text-xs">
                Dados coletados com comprovação digital e hash imutável
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-xs text-gray-700 font-mono bg-gray-50 p-3 rounded border">
              <p>
                <strong>Item:</strong> {amostraEvidencia.item_externo}
              </p>
              <p>
                <strong>Fornecedor:</strong> {amostraEvidencia.fornecedor}
              </p>
              <p>
                <strong>Valor Unitário:</strong> {formatarMoeda(amostraEvidencia.valor_original)}
              </p>
              <p>
                <strong>Fonte:</strong> {amostraEvidencia.fonte}
              </p>
              <p>
                <strong>Natureza:</strong> {amostraEvidencia.natureza_preco}
              </p>
              <p>
                <strong>Data Contratação:</strong> {formatarData(amostraEvidencia.data_contratacao)}
              </p>
              <p className="break-all">
                <strong>Hash Evidência (SHA-256):</strong>{' '}
                {amostraEvidencia.hash ||
                  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}
              </p>
              <p className="break-all">
                <strong>URL:</strong>{' '}
                <a
                  href={amostraEvidencia.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#174873] underline"
                >
                  {amostraEvidencia.url || 'https://pncp.gov.br'}
                </a>
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => setAmostraEvidencia(null)} size="sm" className="text-xs">
                Fechar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: EXCLUSÃO COM MOTIVO OBRIGATÓRIO */}
      {amostraExclusao && (
        <Dialog open={!!amostraExclusao} onOpenChange={() => setAmostraExclusao(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold text-red-900 uppercase">
                Expurgar Amostra com Justificativa
              </DialogTitle>
              <DialogDescription className="text-xs">
                Conforme as regras do motor determinístico, a exclusão é sempre uma decisão humana
                motivada.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Motivo da Incompatibilidade / Descarte</Label>
                <Textarea
                  rows={3}
                  value={motivoExclusao}
                  onChange={(e) => setMotivoExclusao(e.target.value)}
                  placeholder="Ex: Item incompatível com a demanda..."
                  className="text-xs"
                />
              </div>

              <div className="space-y-1">
                <span className="text-[11px] text-gray-500 font-semibold">
                  Motivos padronizados:
                </span>
                <div className="flex flex-wrap gap-1">
                  <Badge
                    variant="outline"
                    className="cursor-pointer text-[10px] hover:bg-gray-100"
                    onClick={() => setMotivoExclusao('Item incompatível com a demanda')}
                  >
                    Item incompatível com a demanda
                  </Badge>
                  <Badge
                    variant="outline"
                    className="cursor-pointer text-[10px] hover:bg-gray-100"
                    onClick={() => setMotivoExclusao('Preço manifestamente inexequível')}
                  >
                    Manifestamente inexequível
                  </Badge>
                  <Badge
                    variant="outline"
                    className="cursor-pointer text-[10px] hover:bg-gray-100"
                    onClick={() => setMotivoExclusao('Valor flagrantemente excessivo (outlier)')}
                  >
                    Flagrantemente excessivo
                  </Badge>
                  <Badge
                    variant="outline"
                    className="cursor-pointer text-[10px] hover:bg-gray-100"
                    onClick={() => setMotivoExclusao('Duplicata confirmada de outra base')}
                  >
                    Duplicata de outra base
                  </Badge>
                </div>
              </div>
            </div>
            <DialogFooter className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAmostraExclusao(null)}
                className="text-xs"
              >
                Cancelar
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  await onAtualizarStatus(amostraExclusao, 'excluido', motivoExclusao)
                  setAmostraExclusao(null)
                }}
                className="text-xs"
              >
                Confirmar Expurgo
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: ALTERAR MÉTODO DE TENDÊNCIA CENTRAL */}
      {modalMudarMetodo && (
        <Dialog open={modalMudarMetodo} onOpenChange={setModalMudarMetodo}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold text-gray-900 uppercase">
                Alterar Método de Tendência Central
              </DialogTitle>
              <DialogDescription className="text-xs">
                O padrão legal é a MEDIANA. A troca do método exige justificativa registrada em
                dossiê.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Método Desejado</Label>
                <Select
                  value={novoMetodoTemp}
                  onValueChange={(val: MetodoCalculo) => setNovoMetodoTemp(val)}
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mediana">
                      Mediana (Recomendado pela Lei 14.133 e IN 65)
                    </SelectItem>
                    <SelectItem value="media">Média Aritmética</SelectItem>
                    <SelectItem value="menor">Menor Preço Válido</SelectItem>
                    <SelectItem value="maior">Maior Preço</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Justificativa Técnica Obrigatória</Label>
                <Textarea
                  rows={3}
                  value={novaJustificativaMetodoTemp}
                  onChange={(e) => setNovaJustificativaMetodoTemp(e.target.value)}
                  placeholder="Justifique por que este método é mais aderente ao certame..."
                  className="text-xs"
                />
              </div>
            </div>
            <DialogFooter className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setModalMudarMetodo(false)}
                className="text-xs"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleConfirmarMudancaMetodo}
                size="sm"
                className="bg-[#174873] hover:bg-[#12385b] text-white text-xs font-bold"
              >
                Aplicar e Salvar Método
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: JUSTIFICATIVA OU OBSERVAÇÃO / INSUFICIÊNCIA */}
      {modalJustificativa && (
        <Dialog open={modalJustificativa} onOpenChange={setModalJustificativa}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold text-gray-900 uppercase">
                Crítica dos Dados: Justificativa ou Observação
              </DialogTitle>
              <DialogDescription className="text-xs">
                {temMenosDeTres
                  ? 'Obrigatório: quando coletadas menos de 3 amostras válidas, o parecer técnico deve constar expressamente no processo.'
                  : 'Registre anotações técnicas, justificativas de exclusão de amostras ou observações do agente.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Texto da Justificativa</Label>
                <Textarea
                  rows={4}
                  value={justificativaGeral}
                  onChange={(e) => setJustificativaGeral(e.target.value)}
                  placeholder="Ex: Foram realizadas buscas exaustivas nas bases PNCP e Compras.gov.br, contudo a especificidade técnica do item limitou a coleta..."
                  className="text-xs"
                />
              </div>
            </div>
            <DialogFooter className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setModalJustificativa(false)}
                className="text-xs"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSalvarJustificativaGeral}
                size="sm"
                className="bg-[#174873] hover:bg-[#12385b] text-white text-xs font-bold"
              >
                Salvar Justificativa
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: ADICIONAR AMOSTRA MANUAL */}
      {modalNovaAmostra && (
        <Dialog open={modalNovaAmostra} onOpenChange={setModalNovaAmostra}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold text-gray-900 uppercase">
                Adicionar Amostra Manual com Evidência
              </DialogTitle>
              <DialogDescription className="text-xs">
                Cadastro de cotação direta de fornecedor, ata ou contrato público
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmeterNovaAmostra} className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Descrição do Item</Label>
                <Input
                  required
                  placeholder="Ex: Dipirona 500mg/ml solução injetável..."
                  value={novaAmostra.item_externo}
                  onChange={(e) => setNovaAmostra({ ...novaAmostra, item_externo: e.target.value })}
                  className="text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Valor Unitário (R$)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    placeholder="0.00"
                    value={novaAmostra.valor_original || ''}
                    onChange={(e) =>
                      setNovaAmostra({
                        ...novaAmostra,
                        valor_original: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Natureza do Preço</Label>
                  <Select
                    value={novaAmostra.natureza_preco}
                    onValueChange={(val: NaturezaPreco) =>
                      setNovaAmostra({ ...novaAmostra, natureza_preco: val })
                    }
                  >
                    <SelectTrigger className="text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cotacao_comercial">Cotação Comercial Formal</SelectItem>
                      <SelectItem value="contratado">Contratado</SelectItem>
                      <SelectItem value="homologado">Homologado</SelectItem>
                      <SelectItem value="estimado">Estimado de Edital</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Fornecedor / Razão Social / CNPJ</Label>
                <Input
                  required
                  placeholder="Ex: Distribuidora Medic Farma Ltda (CNPJ...)"
                  value={novaAmostra.fornecedor}
                  onChange={(e) => setNovaAmostra({ ...novaAmostra, fornecedor: e.target.value })}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Link da Proposta / Evidência Digital (URL)</Label>
                <Input
                  placeholder="https://..."
                  value={novaAmostra.url}
                  onChange={(e) => setNovaAmostra({ ...novaAmostra, url: e.target.value })}
                  className="text-xs"
                />
              </div>

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setModalNovaAmostra(false)}
                  className="text-xs"
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="bg-[#174873] hover:bg-[#12385b] text-white text-xs font-bold"
                >
                  Cadastrar e Incluir na Série
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  )
}
