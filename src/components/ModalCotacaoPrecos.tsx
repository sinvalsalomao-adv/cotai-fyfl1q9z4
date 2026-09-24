import React, { useState, useMemo } from 'react'
import {
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Plus,
  Eye,
  ExternalLink,
  ChevronDown,
  X,
  FileText,
  AlertCircle,
  Hash,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { executarMotorCalculo, formatarMoeda, formatarData } from '@/lib/calculoEngine'

export interface ModalCotacaoPrecosProps {
  open: boolean
  onClose: () => void
  pesquisa?: Pesquisa | null
  itemTitle?: string
  itemDetails?: {
    descricao: string
    quantidade: number
    unidade: string
    codigo_catalogo?: string
    prazo?: string
  }
  referencias: Referencia[]
  onAtualizarStatus: (ref: Referencia, status: StatusRevisao, motivo?: string) => Promise<void>
  onAdicionarCotacaoManual?: (dados: {
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
  onConcluirCotacao?: () => Promise<void>
}

export default function ModalCotacaoPrecos({
  open,
  onClose,
  pesquisa,
  itemTitle,
  itemDetails,
  referencias,
  onAtualizarStatus,
  onAdicionarCotacaoManual,
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

  const demandaItem: DemandaItem | undefined = pesquisa?.expand?.demanda_item_id
  const descricaoItemExibida =
    itemDetails?.descricao ||
    demandaItem?.descricao ||
    itemTitle ||
    'LINK DE INTERNET VIA FIBRA ÓPTICA 50MB - SERVIÇO DE PROVEDOR DE INTERNET BANDA LARGA.'
  const quantidadeDemandada = itemDetails?.quantidade || demandaItem?.quantidade || 1
  const unidadeDemandada = itemDetails?.unidade || demandaItem?.unidade || 'un'
  const catalogoDemandado = itemDetails?.codigo_catalogo || demandaItem?.catalogo || ''

  // Inicializa o termo de busca com a descrição se vazio
  React.useEffect(() => {
    if (descricaoItemExibida && !termoPesquisa) {
      setTermoPesquisa(descricaoItemExibida)
    }
  }, [descricaoItemExibida])

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
    if (filtroUf.trim()) {
      list = list.filter((r) =>
        r.municipio_uf?.toLowerCase().includes(filtroUf.toLowerCase().trim()),
      )
    }

    if (ordenacao === 'menor_preco') {
      list.sort(
        (a, b) =>
          (a.valor_normalizado || a.valor_original) - (b.valor_normalizado || b.valor_original),
      )
    } else if (ordenacao === 'maior_preco') {
      list.sort(
        (a, b) =>
          (b.valor_normalizado || b.valor_original) - (a.valor_normalizado || a.valor_original),
      )
    } else if (ordenacao === 'data_recente') {
      list.sort(
        (a, b) =>
          new Date(b.data_contratacao || 0).getTime() - new Date(a.data_contratacao || 0).getTime(),
      )
    }

    return list
  }, [referencias, filtroFonte, filtroNatureza, filtroStatus, filtroUf, ordenacao])

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
    if (onAdicionarCotacaoManual) {
      await onAdicionarCotacaoManual(novaAmostra)
    }
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
      if (onConcluirCotacao) {
        await onConcluirCotacao()
      }
      onClose()
    } finally {
      setSalvandoConclusao(false)
    }
  }

  if (!open) return null

  const { juizo_critico, estatisticas_saneadas } = resultadoCalculo

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[97vw] w-[1420px] max-h-[96vh] p-0 overflow-hidden flex flex-col bg-[#eef1f4] text-[#222] border border-[#7d8b99] shadow-2xl rounded-none font-sans text-xs">
        {/* BARRA SUPERIOR AZUL-ESCURA "COTAÇÃO DE PREÇOS" */}
        <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none border-b border-[#0c314f] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-xs sm:text-sm tracking-wider uppercase">
              COTAÇÃO DE PREÇOS
            </span>
            {pesquisa?.numero && (
              <>
                <span className="text-[#84a9c9] text-xs">|</span>
                <span className="text-[#bcd3e6] font-mono text-[11px] uppercase">
                  {pesquisa.numero}
                </span>
              </>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
            title="Fechar Janela"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* CORPO DO MODAL — SEÇÕES EMPILHADAS VERTICALMENTE */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 bg-[#eef1f4]">
          {/* SEÇÃO 1: DESCRIÇÃO DO ITEM A SER COTADO */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <span className="inline-block w-2.5 h-2.5 bg-white/90 border border-[#4a5059] flex-shrink-0" />
              <span>DESCRIÇÃO DO ITEM A SER COTADO</span>
            </div>
            <div className="p-2.5 bg-white space-y-1">
              <p className="text-[12px] font-bold text-[#1f2937] leading-tight tracking-tight uppercase">
                {descricaoItemExibida}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-[#4b5563] pt-1 border-t border-[#e5e7eb]">
                <span>
                  <strong>QUANTIDADE:</strong>{' '}
                  <span className="font-mono font-bold text-[#124268]">
                    {quantidadeDemandada} {unidadeDemandada}
                  </span>
                </span>
                {catalogoDemandado && (
                  <span>
                    <strong>CÓD. CATÁLOGO / CATMAT:</strong>{' '}
                    <span className="font-mono">{catalogoDemandado}</span>
                  </span>
                )}
                {itemDetails?.prazo && (
                  <span>
                    <strong>PRAZO:</strong> {itemDetails.prazo}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-[#6b7280] italic">
                  *Versão oficial congelada da demanda. As consultas de preços preservam a
                  especificação técnica integral.
                </span>
              </div>
            </div>
          </div>

          {/* SEÇÃO 2: ARGUMENTO DE PESQUISA */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <Search className="h-3 w-3 flex-shrink-0" />
              <span>ARGUMENTO DE PESQUISA</span>
            </div>

            {/* Abas Estilo Cesta de Preços */}
            <div className="flex border-b border-[#cbd5e1] bg-[#eef2f6] text-[11px]">
              <button
                type="button"
                onClick={() => setAbaArgumento('palavra_chave')}
                className={`px-3 py-1.5 font-bold uppercase tracking-wider text-[10.5px] transition-colors border-r border-[#cbd5e1] ${
                  abaArgumento === 'palavra_chave'
                    ? 'bg-white text-[#124268] border-b-2 border-b-[#124268]'
                    : 'text-[#475569] hover:bg-[#e2e8f0]'
                }`}
              >
                PESQUISAR POR PALAVRA-CHAVE
              </button>
              <button
                type="button"
                onClick={() => setAbaArgumento('catmat')}
                className={`px-3 py-1.5 font-bold uppercase tracking-wider text-[10.5px] transition-colors border-r border-[#cbd5e1] ${
                  abaArgumento === 'catmat'
                    ? 'bg-white text-[#124268] border-b-2 border-b-[#124268]'
                    : 'text-[#475569] hover:bg-[#e2e8f0]'
                }`}
              >
                PESQUISAR POR CATMAT/CATSER
              </button>
            </div>

            {/* Conteúdo compacto de busca */}
            <div className="p-3 bg-white space-y-2">
              {abaArgumento === 'palavra_chave' ? (
                <div>
                  <label className="text-[11px] font-bold text-[#374151] block mb-1">
                    Para a descrição técnica ou genérica do produto:
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <div className="md:col-span-8">
                      <Input
                        placeholder="Digite o que você procura aqui"
                        value={termoPesquisa}
                        onChange={(e) => setTermoPesquisa(e.target.value)}
                        className="text-xs h-7 rounded-none border-[#94a3b8] bg-white focus-visible:ring-1 focus-visible:ring-[#124268]"
                      />
                    </div>
                    <div className="md:col-span-4 flex items-center gap-1.5">
                      <span className="text-[11px] font-bold text-[#374151] whitespace-nowrap">
                        CNPJ:
                      </span>
                      <Input
                        placeholder="99.999.999/9999-99"
                        value={cnpjPesquisa}
                        onChange={(e) => setCnpjPesquisa(e.target.value)}
                        className="text-xs h-7 font-mono rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>
                  </div>

                  {/* Radio buttons: Contendo as palavras / Expressão exata */}
                  <div className="flex items-center gap-6 mt-2 text-[11px] text-[#374151]">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="tipoPesquisa"
                        checked={tipoPesquisa === 'palavras'}
                        onChange={() => setTipoPesquisa('palavras')}
                        className="text-[#124268] focus:ring-[#124268]"
                      />
                      <span>Contendo as palavras</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="tipoPesquisa"
                        checked={tipoPesquisa === 'exata'}
                        onChange={() => setTipoPesquisa('exata')}
                        className="text-[#124268] focus:ring-[#124268]"
                      />
                      <span>Expressão exata</span>
                    </label>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-[11px] font-bold text-[#374151] block mb-1">
                    Código ou descrição oficial do CATMAT/CATSER:
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <div className="md:col-span-8">
                      <Input
                        placeholder="Ex: 463721 ou Veículo automotor"
                        value={termoCatmat}
                        onChange={(e) => setTermoCatmat(e.target.value)}
                        className="text-xs h-7 rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>
                    <div className="md:col-span-4 flex items-center gap-1.5">
                      <span className="text-[11px] font-bold text-[#374151] whitespace-nowrap">
                        CNPJ:
                      </span>
                      <Input
                        placeholder="99.999.999/9999-99"
                        value={cnpjPesquisa}
                        onChange={(e) => setCnpjPesquisa(e.target.value)}
                        className="text-xs h-7 font-mono rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Botão azul pequeno "PESQUISAR" com ícone de lupa */}
              <div className="flex items-center justify-between pt-1 border-t border-[#e5e7eb]">
                <Button
                  type="button"
                  onClick={handlePesquisar}
                  className="bg-[#124268] hover:bg-[#0c314f] text-white text-[11px] font-bold uppercase tracking-wider px-3 h-7 rounded-none gap-1.5 shadow-none"
                >
                  <Search className="h-3 w-3" />
                  PESQUISAR
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setModalNovaAmostra(true)}
                  className="text-[10.5px] border-[#94a3b8] text-[#124268] hover:bg-[#f1f5f9] h-7 rounded-none font-bold"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  ADICIONAR AMOSTRA MANUAL COM AUDITORIA
                </Button>
              </div>
            </div>
          </div>

          {/* SEÇÕES EMPILHADAS: REFINAR (à esquerda) + RESULTADO DA PESQUISA (à direita) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
            {/* PAINEL ESTREITO: REFINAR */}
            <div className="lg:col-span-3 bg-white border border-[#b8c2cc] shadow-sm">
              <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between select-none">
                <span className="flex items-center gap-1">
                  <Filter className="h-3 w-3 flex-shrink-0" />
                  REFINAR
                </span>
                {(filtroFonte !== 'todas' ||
                  filtroNatureza !== 'todas' ||
                  filtroStatus !== 'todas' ||
                  filtroUf) && (
                  <button
                    onClick={handleLimparFiltros}
                    className="text-[9.5px] text-white/90 underline hover:text-white"
                  >
                    Limpar
                  </button>
                )}
              </div>
              <div className="p-2.5 space-y-2.5 bg-white text-[11px]">
                {!buscaExecutada && referencias.length === 0 ? (
                  <p className="text-[10.5px] text-[#4b5563] leading-relaxed">
                    Quando você preencher um campo de busca em localizar descrição de item e depois
                    clicar no botão pesquisar, o sistema disponibilizará mais opções de filtros.
                  </p>
                ) : (
                  <>
                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">
                        Fonte
                      </Label>
                      <Select value={filtroFonte} onValueChange={setFiltroFonte}>
                        <SelectTrigger className="h-6 text-[10.5px] rounded-none border-[#94a3b8] bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="text-xs">
                          <SelectItem value="todas">Todas as Fontes</SelectItem>
                          <SelectItem value="compras_gov">Compras.gov.br</SelectItem>
                          <SelectItem value="pncp">PNCP</SelectItem>
                          <SelectItem value="bps">BPS (Saúde)</SelectItem>
                          <SelectItem value="cmed">CMED (Regulatório)</SelectItem>
                          <SelectItem value="bec_sp">BEC-SP</SelectItem>
                          <SelectItem value="manual">Cotação Manual</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">
                        Situação
                      </Label>
                      <Select value={filtroStatus} onValueChange={setFiltroStatus}>
                        <SelectTrigger className="h-6 text-[10.5px] rounded-none border-[#94a3b8] bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="text-xs">
                          <SelectItem value="todas">Todas as Situações</SelectItem>
                          <SelectItem value="aceito">Aceitas (Na Cesta)</SelectItem>
                          <SelectItem value="excluido">Expurgadas / Excluídas</SelectItem>
                          <SelectItem value="pendente">Pendente de Revisão</SelectItem>
                          <SelectItem value="necessita_esclarecimento">Em Diligência</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">
                        Natureza
                      </Label>
                      <Select value={filtroNatureza} onValueChange={setFiltroNatureza}>
                        <SelectTrigger className="h-6 text-[10.5px] rounded-none border-[#94a3b8] bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="text-xs">
                          <SelectItem value="todas">Todas as Naturezas</SelectItem>
                          <SelectItem value="contratado">Contratado</SelectItem>
                          <SelectItem value="homologado">Homologado</SelectItem>
                          <SelectItem value="cotacao_comercial">Cotação Comercial</SelectItem>
                          <SelectItem value="regulatorio_tabela">Tabela / Teto CMED</SelectItem>
                          <SelectItem value="estimado">Estimado de Edital</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">UF</Label>
                      <Input
                        placeholder="Ex: SP, MG, RJ..."
                        value={filtroUf}
                        onChange={(e) => setFiltroUf(e.target.value)}
                        className="h-6 text-[10.5px] rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* PAINEL LARGO: RESULTADO DA PESQUISA */}
            <div className="lg:col-span-9 bg-white border border-[#b8c2cc] shadow-sm flex flex-col">
              <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between select-none">
                <span>RESULTADO DA PESQUISA ({amostrasFiltradas.length})</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-white/90 font-bold tracking-wider">
                    ORDENAR POR:
                  </span>
                  <select
                    value={ordenacao}
                    onChange={(e: any) => setOrdenacao(e.target.value)}
                    className="h-5 text-[10px] bg-white text-[#1f2937] rounded-none px-1 font-bold border-0 focus:ring-1 focus:ring-white uppercase"
                  >
                    <option value="menor_preco">MENOR PREÇO UNITÁRIO</option>
                    <option value="maior_preco">MAIOR PREÇO UNITÁRIO</option>
                    <option value="data_recente">DATA MAIS RECENTE</option>
                  </select>
                </div>
              </div>

              <div className="p-3 bg-white">
                {/* Banner amarelo-claro com texto orientativo e borda esquerda marcada */}
                {!buscaExecutada && referencias.length === 0 ? (
                  <div className="p-2.5 bg-[#fefce8] border-l-4 border-l-[#eab308] border border-[#fef08a] text-[11px] text-[#854d0e] flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#ca8a04] flex-shrink-0" />
                    <span>
                      Preencha os campos de localizar descrição de item e depois clique no botão
                      pesquisar para listar amostras de preços.
                    </span>
                  </div>
                ) : amostrasFiltradas.length === 0 ? (
                  <div className="p-6 text-center text-xs text-[#6b7280] font-bold uppercase tracking-wide">
                    VOCÊ NÃO POSSUI AMOSTRAS DE PREÇOS PARA ESTE ITEM
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                    {amostrasFiltradas.map((cand, idx) => {
                      const isAceito = cand.status_revisao === 'aceito'
                      const isExcluido = cand.status_revisao === 'excluido'
                      const isCritica =
                        isAceito &&
                        (cand.valor_original < juizo_critico.limite_inferior ||
                          cand.valor_original > juizo_critico.limite_superior)

                      return (
                        <div
                          key={cand.id}
                          className={`p-2 border text-xs flex flex-col md:flex-row md:items-center justify-between gap-2 ${
                            isAceito
                              ? 'border-[#a7f3d0] bg-[#f0fdf4]'
                              : isExcluido
                                ? 'border-[#fecaca] bg-[#fef2f2]'
                                : 'border-[#e2e8f0] bg-white'
                          }`}
                        >
                          <div className="space-y-0.5 min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-[#111827] text-[11px]">
                                AMOSTRA #{idx + 1}
                              </span>
                              <span className="px-1 py-0.2 bg-[#e2e8f0] text-[#1e293b] font-mono text-[9px] uppercase font-bold border border-[#cbd5e1]">
                                {cand.fonte}
                              </span>
                              {isAceito && (
                                <span className="px-1 py-0.2 bg-[#d1fae5] text-[#065f46] text-[9px] font-bold border border-[#a7f3d0]">
                                  VÁLIDA
                                </span>
                              )}
                              {isExcluido && (
                                <span className="px-1 py-0.2 bg-[#fee2e2] text-[#991b1b] text-[9px] font-bold border border-[#fecaca]">
                                  EXPURGADA
                                </span>
                              )}
                              {isCritica && (
                                <span className="px-1 py-0.2 bg-[#dc2626] text-white text-[9px] font-bold">
                                  CRÍTICA (FORA DOS LIMITES)
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] font-medium text-[#1f2937] truncate">
                              {cand.item_externo}
                            </p>
                            <p className="text-[10px] text-[#6b7280]">
                              Fornecedor: <strong>{cand.fornecedor || 'NÃO INFORMADO'}</strong> •
                              Data: {formatarData(cand.data_contratacao)} • Local:{' '}
                              {cand.municipio_uf || 'NÃO INFORMADO'}
                            </p>
                          </div>

                          <div className="flex items-center gap-3 justify-between md:justify-end flex-shrink-0">
                            <div className="text-right">
                              <span className="text-[9px] text-[#6b7280] block font-bold uppercase">
                                VALOR UNITÁRIO:
                              </span>
                              <span className="font-mono font-bold text-xs sm:text-sm text-[#111827]">
                                {formatarMoeda(cand.valor_normalizado || cand.valor_original)}
                              </span>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setAmostraEvidencia(cand)}
                              className="text-[10.5px] h-6 px-2 rounded-none border-[#94a3b8] text-[#124268] hover:bg-[#f8fafc]"
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

          {/* SEÇÃO 3: ANÁLISE CRÍTICA DAS AMOSTRAS */}
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
                        <th className="p-1.5 border border-[#9ca3af]">DESVIO-PADRÃO</th>
                        <th className="p-1.5 border border-[#9ca3af]">MEDIANA</th>
                        <th className="p-1.5 border border-[#9ca3af]">
                          LIMITE INFERIOR
                          <br />
                          <span className="text-[9px] font-normal lowercase">(70% da mediana)</span>
                        </th>
                        <th className="p-1.5 border border-[#9ca3af]">
                          LIMITE SUPERIOR
                          <br />
                          <span className="text-[9px] font-normal lowercase">
                            (30% acima da mediana)
                          </span>
                        </th>
                        <th className="p-1.5 border border-[#9ca3af]">CRÍTICAS</th>
                        <th className="p-1.5 border border-[#9ca3af]">AMOSTRAS EXPURGADAS</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-xs text-[#111827] divide-y divide-[#cbd5e1]">
                      <tr>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {juizo_critico.n_coletadas}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {juizo_critico.desvio_padrao.toFixed(2)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-[#124268]">
                          {formatarMoeda(juizo_critico.mediana)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] text-[#374151]">
                          {formatarMoeda(juizo_critico.limite_inferior)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] text-[#374151]">
                          {formatarMoeda(juizo_critico.limite_superior)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {juizo_critico.criticas_count > 0 ? (
                            <span className="inline-block px-1.5 py-0.5 rounded-none bg-[#dc2626] text-white font-bold text-[11px]">
                              {juizo_critico.criticas_count}
                            </span>
                          ) : (
                            <span className="text-[#6b7280]">0</span>
                          )}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {juizo_critico.expurgadas_count}
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
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-[#065f46]">
                          {estatisticas_saneadas.n_validas}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {estatisticas_saneadas.desvio_padrao.toFixed(2)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {estatisticas_saneadas.coeficiente_variacao.toFixed(2)}%
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {formatarMoeda(estatisticas_saneadas.menor_preco)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {formatarMoeda(estatisticas_saneadas.media)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-[#124268]">
                          {formatarMoeda(estatisticas_saneadas.mediana)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SUB-BLOCO 3: SÉRIE DE PREÇOS COLETADOS */}
              <div className="space-y-1">
                <span className="text-[10.5px] font-bold text-[#374151] uppercase tracking-wider block">
                  SÉRIE DE PREÇOS COLETADOS
                </span>
                <div className="overflow-x-auto border border-[#cbd5e1]">
                  <table className="w-full text-left text-[11px] border-collapse bg-white">
                    <thead className="bg-[#828892] text-white font-bold text-[10px] uppercase">
                      <tr>
                        <th className="p-1.5 border border-[#9ca3af]">AMOSTRA</th>
                        <th className="p-1.5 border border-[#9ca3af]">SITUAÇÃO</th>
                        <th className="p-1.5 border border-[#9ca3af]">FONTE</th>
                        <th className="p-1.5 border border-[#9ca3af]">MARCA / FORNECEDOR</th>
                        <th className="p-1.5 border border-[#9ca3af]">DATA</th>
                        <th className="p-1.5 border border-[#9ca3af]">VENCIMENTO</th>
                        <th className="p-1.5 border border-[#9ca3af]">MEDIDA</th>
                        <th className="p-1.5 border border-[#9ca3af] text-center">QNT ORIGINAL</th>
                        <th className="p-1.5 border border-[#9ca3af] text-right">VALOR UNITÁRIO</th>
                        <th className="p-1.5 border border-[#9ca3af] text-center">AÇÕES</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#cbd5e1] text-[11px]">
                      {referencias.length === 0 ? (
                        <tr>
                          <td
                            colSpan={10}
                            className="p-8 text-center text-[#6b7280] font-bold uppercase tracking-wide"
                          >
                            VOCÊ NÃO POSSUI AMOSTRAS DE PREÇOS PARA ESTE ITEM
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
                              className={`hover:bg-[#f8fafc] ${isExcluido ? 'bg-[#fef2f2]/60' : ''}`}
                            >
                              <td className="p-1.5 border border-[#cbd5e1] font-bold whitespace-nowrap">
                                #{idx + 1}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] whitespace-nowrap">
                                {isAceito && (
                                  <span className="px-1 py-0.2 bg-[#d1fae5] text-[#065f46] text-[9.5px] font-bold border border-[#a7f3d0]">
                                    VÁLIDA
                                  </span>
                                )}
                                {isExcluido && (
                                  <span className="px-1 py-0.2 bg-[#fee2e2] text-[#991b1b] text-[9.5px] font-bold border border-[#fecaca]">
                                    EXPURGADA
                                  </span>
                                )}
                                {isPendente && (
                                  <span className="px-1 py-0.2 bg-[#fef3c7] text-[#92400e] text-[9.5px] font-bold border border-[#fde68a]">
                                    PENDENTE
                                  </span>
                                )}
                                {isDiligencia && (
                                  <span className="px-1 py-0.2 bg-[#f3e8ff] text-[#6b21a8] text-[9.5px] font-bold border border-[#e9d5ff]">
                                    DILIGÊNCIA
                                  </span>
                                )}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] uppercase font-mono text-[10px] font-bold text-[#124268] whitespace-nowrap">
                                {cand.fonte}
                              </td>
                              <td
                                className="p-1.5 border border-[#cbd5e1] max-w-xs truncate"
                                title={cand.fornecedor}
                              >
                                {cand.fornecedor || 'NÃO INFORMADO'}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono whitespace-nowrap">
                                {formatarData(cand.data_contratacao)}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono text-[#6b7280] whitespace-nowrap">
                                -
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono whitespace-nowrap">
                                {cand.unidade || 'un'}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono text-center whitespace-nowrap">
                                {cand.quantidade || 1}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono font-bold text-right whitespace-nowrap text-[#111827]">
                                {formatarMoeda(cand.valor_normalizado || cand.valor_original)}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] text-center whitespace-nowrap">
                                <div className="flex items-center justify-center gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setAmostraEvidencia(cand)}
                                    className="h-5 w-5 p-0 text-[#124268]"
                                    title="Ver Evidência"
                                  >
                                    <Eye className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onAtualizarStatus(cand, 'aceito')}
                                    className={`h-5 text-[10px] px-1.5 rounded-none ${
                                      isAceito
                                        ? 'bg-[#d1fae5] text-[#065f46] border-[#a7f3d0] font-bold'
                                        : 'text-[#374151] border-[#cbd5e1]'
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
                                    className={`h-5 text-[10px] px-1.5 rounded-none ${
                                      isExcluido
                                        ? 'bg-[#fee2e2] text-[#991b1b] border-[#fecaca] font-bold'
                                        : 'text-[#374151] border-[#cbd5e1]'
                                    }`}
                                  >
                                    Excluir
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

              {/* SUB-BLOCO 4: MEDIDA DE TENDÊNCIA CENTRAL (LINHAS ALINHADAS À DIREITA COM MEDIANA / MÉDIA / MENOR PREÇO) */}
              <div className="border border-[#cbd5e1] bg-[#f8fafc] p-2.5 flex flex-col md:flex-row items-center justify-between gap-3">
                <div className="space-y-0.5 text-[11px]">
                  <span className="font-bold text-[#1f2937] uppercase tracking-wider block">
                    MEDIDA DE TENDÊNCIA CENTRAL
                  </span>
                  <p className="text-[10px] text-[#4b5563]">
                    Preço de referência adotado:{' '}
                    <strong className="text-[#124268] uppercase font-mono">
                      {metodoSelecionado} —{' '}
                      {resultadoCalculo.preco_referencia !== null
                        ? formatarMoeda(resultadoCalculo.preco_referencia)
                        : 'AUSENTE'}
                    </strong>
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setNovoMetodoTemp(metodoSelecionado)
                      setNovaJustificativaMetodoTemp(justificativaMetodo)
                      setModalMudarMetodo(true)
                    }}
                    className="text-[10px] text-[#124268] underline font-bold"
                  >
                    Alterar método ou registrar justificativa da escolha...
                  </button>
                </div>

                <div className="w-full md:w-80 space-y-1 font-mono text-[11px] text-right">
                  <div
                    className={`flex items-center justify-between px-2 py-0.5 border ${
                      metodoSelecionado === 'mediana'
                        ? 'bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]'
                        : 'bg-white border-[#cbd5e1] text-[#374151]'
                    }`}
                  >
                    <span className="font-sans font-bold uppercase text-[10px]">MEDIANA:</span>
                    <span>{formatarMoeda(estatisticas_saneadas.mediana)}</span>
                  </div>
                  <div
                    className={`flex items-center justify-between px-2 py-0.5 border ${
                      metodoSelecionado === 'media'
                        ? 'bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]'
                        : 'bg-white border-[#cbd5e1] text-[#374151]'
                    }`}
                  >
                    <span className="font-sans font-bold uppercase text-[10px]">MÉDIA:</span>
                    <span>{formatarMoeda(estatisticas_saneadas.media)}</span>
                  </div>
                  <div
                    className={`flex items-center justify-between px-2 py-0.5 border ${
                      metodoSelecionado === 'menor'
                        ? 'bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]'
                        : 'bg-white border-[#cbd5e1] text-[#374151]'
                    }`}
                  >
                    <span className="font-sans font-bold uppercase text-[10px]">MENOR PREÇO:</span>
                    <span>{formatarMoeda(estatisticas_saneadas.menor_preco)}</span>
                  </div>
                </div>
              </div>

              {/* SUB-BLOCO 5: CRÍTICA DOS DADOS */}
              <div className="space-y-2 pt-1 border-t border-[#cbd5e1]">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-bold text-[#374151] uppercase tracking-wider">
                    CRÍTICA DOS DADOS
                  </span>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setModalJustificativa(true)}
                  className="bg-[#d1d5db] hover:bg-[#9ca3af] text-[#111827] border-[#9ca3af] font-bold text-[10.5px] uppercase tracking-wider h-7 px-3 rounded-none"
                >
                  <FileText className="h-3 w-3 mr-1" />
                  ADICIONAR JUSTIFICATIVA OU OBSERVAÇÃO
                </Button>

                {/* Texto de regra do Cesta de Preços */}
                <div className="space-y-1 text-[11px] text-[#1f2937]">
                  <p className="font-bold">
                    1. FORAM COLETADAS MENOS DE TRÊS AMOSTRAS VÁLIDAS. É PRECISO JUSTIFICAR ESTE
                    ITEM DO ORÇAMENTO.
                  </p>
                  <p className="text-[10.5px] text-[#4b5563]">
                    <button
                      type="button"
                      onClick={() => setModalJustificativa(true)}
                      className="text-[#124268] underline font-bold"
                    >
                      Clique aqui para justificar a coleta de menos de três amostras válidas.
                    </button>
                    {justificativaPendente ? (
                      <span className="text-[#dc2626] font-bold ml-2">
                        [JUSTIFICATIVA OBRIGATÓRIA PENDENTE]
                      </span>
                    ) : justificativaGeral ? (
                      <span className="text-[#059669] font-bold ml-2">
                        [JUSTIFICATIVA REGISTRADA NO DOSSIÊ]
                      </span>
                    ) : null}
                  </p>
                </div>

                {justificativaGeral && (
                  <div className="p-2 bg-[#f8fafc] border border-[#cbd5e1] text-[11px] text-[#1f2937]">
                    <strong>Texto registrado:</strong> {justificativaGeral}
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
            disabled={botaoConcluirDesabilitado}
            onClick={handleConcluir}
            className={`h-8 px-4 text-[11px] font-bold uppercase tracking-wider rounded-none shadow-none border ${
              botaoConcluirDesabilitado
                ? 'bg-[#d1d5db] text-[#6b7280] border-[#9ca3af] cursor-not-allowed opacity-75'
                : 'bg-[#f3f4f6] text-[#111827] border-[#9ca3af] hover:bg-white'
            }`}
          >
            ✓ CONCLUIR COTAÇÃO E FECHAR JANELA
          </Button>

          <Button
            type="button"
            onClick={onClose}
            className="h-8 px-5 text-[11px] font-bold uppercase tracking-wider rounded-none shadow-none bg-[#124268] hover:bg-[#0c314f] text-white border border-[#0c314f]"
          >
            ✕ FECHAR
          </Button>
        </div>
      </DialogContent>

      {/* MODAL SECUNDÁRIO: EVIDÊNCIA */}
      {amostraEvidencia && (
        <Dialog open={!!amostraEvidencia} onOpenChange={() => setAmostraEvidencia(null)}>
          <DialogContent className="max-w-lg bg-white rounded-none border border-[#64748b] text-xs">
            <DialogHeader>
              <DialogTitle className="text-xs font-bold uppercase text-[#124268]">
                Evidência Digital e Hash da Amostra
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                Rastreabilidade integral da amostra coletada
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 font-mono text-[11px] bg-[#f8fafc] p-2.5 border border-[#cbd5e1]">
              <p>
                <strong>ITEM:</strong> {amostraEvidencia.item_externo}
              </p>
              <p>
                <strong>FORNECEDOR:</strong> {amostraEvidencia.fornecedor || 'NÃO INFORMADO'}
              </p>
              <p>
                <strong>VALOR:</strong>{' '}
                {formatarMoeda(
                  amostraEvidencia.valor_normalizado || amostraEvidencia.valor_original,
                )}
              </p>
              <p>
                <strong>FONTE:</strong> {amostraEvidencia.fonte.toUpperCase()}
              </p>
              <p>
                <strong>DATA:</strong> {formatarData(amostraEvidencia.data_contratacao)}
              </p>
              <p className="break-all">
                <strong>HASH SHA-256:</strong>{' '}
                {amostraEvidencia.hash ||
                  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}
              </p>
              {amostraEvidencia.url && (
                <p className="break-all">
                  <strong>URL:</strong>{' '}
                  <a
                    href={amostraEvidencia.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#124268] underline"
                  >
                    {amostraEvidencia.url}
                  </a>
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                onClick={() => setAmostraEvidencia(null)}
                size="sm"
                className="h-7 text-xs rounded-none bg-[#124268]"
              >
                Fechar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: EXCLUSÃO */}
      {amostraExclusao && (
        <Dialog open={!!amostraExclusao} onOpenChange={() => setAmostraExclusao(null)}>
          <DialogContent className="max-w-md bg-white rounded-none border border-[#dc2626] text-xs">
            <DialogHeader>
              <DialogTitle className="text-xs font-bold uppercase text-[#991b1b]">
                Expurgar Amostra com Decisão Motivada
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                Nenhum preço é excluído silenciosamente. Registre o fundamento técnico.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label className="text-[11px] font-bold">Motivo do Descarte</Label>
              <Textarea
                rows={3}
                value={motivoExclusao}
                onChange={(e) => setMotivoExclusao(e.target.value)}
                placeholder="Ex: Item incompatível com a demanda ou valor manifestamente inexequível..."
                className="text-xs rounded-none"
              />
            </div>
            <DialogFooter className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAmostraExclusao(null)}
                className="h-7 text-xs rounded-none"
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
                className="h-7 text-xs rounded-none font-bold"
              >
                Confirmar Expurgo
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: JUSTIFICATIVA OU OBSERVAÇÃO */}
      {modalJustificativa && (
        <Dialog open={modalJustificativa} onOpenChange={setModalJustificativa}>
          <DialogContent className="max-w-md bg-white rounded-none border border-[#64748b] text-xs">
            <DialogHeader>
              <DialogTitle className="text-xs font-bold uppercase text-[#124268]">
                Crítica dos Dados: Justificativa ou Observação
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                {temMenosDeTres
                  ? 'Obrigatório: quando coletadas menos de 3 amostras válidas, o parecer técnico deve constar expressamente no processo.'
                  : 'Registre anotações técnicas, pareceres ou observações do agente de contratação.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label className="text-[11px] font-bold">Texto da Justificativa</Label>
              <Textarea
                rows={4}
                value={justificativaGeral}
                onChange={(e) => setJustificativaGeral(e.target.value)}
                placeholder="Ex: Foram realizadas buscas exaustivas nas bases governamentais homologadas, contudo a especificidade técnica do item limitou a coleta..."
                className="text-xs rounded-none"
              />
            </div>
            <DialogFooter className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setModalJustificativa(false)}
                className="h-7 text-xs rounded-none"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSalvarJustificativaGeral}
                size="sm"
                className="h-7 text-xs rounded-none bg-[#124268] text-white font-bold"
              >
                Salvar Justificativa
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: ALTERAR MÉTODO */}
      {modalMudarMetodo && (
        <Dialog open={modalMudarMetodo} onOpenChange={setModalMudarMetodo}>
          <DialogContent className="max-w-md bg-white rounded-none border border-[#64748b] text-xs">
            <DialogHeader>
              <DialogTitle className="text-xs font-bold uppercase text-[#124268]">
                Alterar Método de Tendência Central
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                A mediana é a regra geral. A troca exige justificativa expressa no dossiê.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label className="text-[11px] font-bold">Método Desejado</Label>
              <Select
                value={novoMetodoTemp}
                onValueChange={(v: MetodoCalculo) => setNovoMetodoTemp(v)}
              >
                <SelectTrigger className="h-7 text-xs rounded-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="text-xs">
                  <SelectItem value="mediana">Mediana (Padrão legal Lei 14.133)</SelectItem>
                  <SelectItem value="media">Média Aritmética</SelectItem>
                  <SelectItem value="menor">Menor Preço Válido</SelectItem>
                  <SelectItem value="maior">Maior Preço</SelectItem>
                </SelectContent>
              </Select>
              <Label className="text-[11px] font-bold">Justificativa Técnica Obrigatória</Label>
              <Textarea
                rows={3}
                value={novaJustificativaMetodoTemp}
                onChange={(e) => setNovaJustificativaMetodoTemp(e.target.value)}
                placeholder="Justifique por que este método é mais aderente ao objeto..."
                className="text-xs rounded-none"
              />
            </div>
            <DialogFooter className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setModalMudarMetodo(false)}
                className="h-7 text-xs rounded-none"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleConfirmarMudancaMetodo}
                size="sm"
                className="h-7 text-xs rounded-none bg-[#124268] text-white font-bold"
              >
                Aplicar e Salvar Método
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL SECUNDÁRIO: ADICIONAR AMOSTRA MANUAL */}
      {modalNovaAmostra && (
        <Dialog open={modalNovaAmostra} onOpenChange={setModalNovaAmostra}>
          <DialogContent className="max-w-md bg-white rounded-none border border-[#64748b] text-xs">
            <DialogHeader>
              <DialogTitle className="text-xs font-bold uppercase text-[#124268]">
                Cadastrar Amostra Manual
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                Inclusão de proposta formal de fornecedor ou ata
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmeterNovaAmostra} className="space-y-2">
              <div className="space-y-0.5">
                <Label className="text-[10.5px]">Descrição do Item</Label>
                <Input
                  required
                  value={novaAmostra.item_externo}
                  onChange={(e) => setNovaAmostra({ ...novaAmostra, item_externo: e.target.value })}
                  className="h-7 text-xs rounded-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-0.5">
                  <Label className="text-[10.5px]">Valor Unitário (R$)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={novaAmostra.valor_original || ''}
                    onChange={(e) =>
                      setNovaAmostra({
                        ...novaAmostra,
                        valor_original: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="h-7 text-xs font-mono rounded-none"
                  />
                </div>
                <div className="space-y-0.5">
                  <Label className="text-[10.5px]">Natureza do Preço</Label>
                  <Select
                    value={novaAmostra.natureza_preco}
                    onValueChange={(val: NaturezaPreco) =>
                      setNovaAmostra({ ...novaAmostra, natureza_preco: val })
                    }
                  >
                    <SelectTrigger className="h-7 text-xs rounded-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="text-xs">
                      <SelectItem value="cotacao_comercial">Cotação Comercial Formal</SelectItem>
                      <SelectItem value="contratado">Contratado</SelectItem>
                      <SelectItem value="homologado">Homologado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-0.5">
                <Label className="text-[10.5px]">Fornecedor / Razão Social</Label>
                <Input
                  required
                  value={novaAmostra.fornecedor}
                  onChange={(e) => setNovaAmostra({ ...novaAmostra, fornecedor: e.target.value })}
                  className="h-7 text-xs rounded-none"
                />
              </div>
              <div className="space-y-0.5">
                <Label className="text-[10.5px]">Link da Proposta / Documento (URL)</Label>
                <Input
                  placeholder="https://..."
                  value={novaAmostra.url}
                  onChange={(e) => setNovaAmostra({ ...novaAmostra, url: e.target.value })}
                  className="h-7 text-xs rounded-none"
                />
              </div>
              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setModalNovaAmostra(false)}
                  className="h-7 text-xs rounded-none"
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="h-7 text-xs rounded-none bg-[#124268] text-white font-bold"
                >
                  Cadastrar e Incluir
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  )
}
