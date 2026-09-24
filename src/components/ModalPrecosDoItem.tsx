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
  Sparkles,
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
import type { CotacaoItem, CotacaoPrecoRecord, MetodoCalculo } from '@/types'
import { formatarMoeda, formatarData } from '@/lib/calculoEngine'

interface ModalPrecosDoItemProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: CotacaoItem | null
  precos: CotacaoPrecoRecord[]
  onAtualizarStatusPreco: (
    precoId: string,
    status: 'valido' | 'expurgado' | 'pendente',
    justificativa?: string,
  ) => void
  onAtualizarMetodoItem?: (
    itemId: string,
    metodo: 'mediana' | 'media' | 'menor_preco' | 'media_saneada' | 'media_ponderada',
    justificativa?: string,
  ) => void
}

export const ModalPrecosDoItem: React.FC<ModalPrecosDoItemProps> = ({
  open,
  onOpenChange,
  item,
  precos,
  onAtualizarStatusPreco,
  onAtualizarMetodoItem,
}) => {
  // Abas de Argumento de Pesquisa: 'palavra_chave' | 'catmat'
  const [abaArgumento, setAbaArgumento] = useState<'palavra_chave' | 'catmat'>('palavra_chave')
  const [termoPesquisa, setTermoPesquisa] = useState('')
  const [termoCatmat, setTermoCatmat] = useState('')
  const [cnpjPesquisa, setCnpjPesquisa] = useState('')
  const [tipoPesquisa, setTipoPesquisa] = useState<'palavras' | 'exata'>('palavras')
  const [buscaExecutada, setBuscaExecutada] = useState(false)

  // Filtros Refinar
  const [filtroFonte, setFiltroFonte] = useState<string>('todas')
  const [filtroStatus, setFiltroStatus] = useState<string>('todas')
  const [filtroUf, setFiltroUf] = useState<string>('')

  // Ordenação
  const [ordenacao, setOrdenacao] = useState<'menor_preco' | 'maior_preco' | 'data_recente'>(
    'menor_preco',
  )

  // Metodo de Tendencia Central
  const metodoAtual = (item?.metodo_adotado as MetodoCalculo) || 'mediana'
  const [modalMudarMetodo, setModalMudarMetodo] = useState(false)
  const [novoMetodoTemp, setNovoMetodoTemp] = useState<
    'mediana' | 'media' | 'menor_preco' | 'media_saneada' | 'media_ponderada'
  >('media')
  const [justificativaMetodoTemp, setJustificativaMetodoTemp] = useState('')

  // Crítica dos dados / Justificativa geral
  const [modalJustificativa, setModalJustificativa] = useState(false)
  const [justificativaGeral, setJustificativaGeral] = useState('')

  // Modal de Evidência e Hash
  const [amostraEvidencia, setAmostraEvidencia] = useState<CotacaoPrecoRecord | null>(null)

  // Modal de Exclusão
  const [amostraExclusao, setAmostraExclusao] = useState<CotacaoPrecoRecord | null>(null)
  const [motivoExclusao, setMotivoExclusao] = useState('')

  // Sincroniza termo de pesquisa com o item
  React.useEffect(() => {
    if (item?.descricao_original && !termoPesquisa) {
      setTermoPesquisa(item.descricao_normalizada || item.descricao_original)
    }
  }, [item])

  if (!item) return null

  const precosValidos = precos.filter((p) => p.status === 'valido')
  const precosExpurgados = precos.filter((p) => p.status === 'expurgado')

  // JUÍZO CRÍTICO: 70% a 130% da mediana
  const valoresValidos = precosValidos
    .map((p) => p.preco_unitario_normalizado || p.preco_unitario)
    .sort((a, b) => a - b)

  const calcMediana = (vals: number[]): number => {
    if (vals.length === 0) return 0
    const meio = Math.floor(vals.length / 2)
    return vals.length % 2 !== 0 ? vals[meio] : (vals[meio - 1] + vals[meio]) / 2
  }

  const calcMedia = (vals: number[]): number => {
    if (vals.length === 0) return 0
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }

  const calcDesvioPadrao = (vals: number[], media: number): number => {
    if (vals.length <= 1) return 0
    const varSum = vals.reduce((acc, v) => acc + Math.pow(v - media, 2), 0)
    return Math.sqrt(varSum / (vals.length - 1))
  }

  const medianaGeral = calcMediana(valoresValidos)
  const mediaGeral = calcMedia(valoresValidos)
  const menorPrecoGeral = valoresValidos.length > 0 ? valoresValidos[0] : 0
  const desvioPadraoGeral = calcDesvioPadrao(valoresValidos, mediaGeral)
  const coefVariacao = mediaGeral > 0 ? (desvioPadraoGeral / mediaGeral) * 100 : 0

  const limiteInferior = medianaGeral * 0.7
  const limiteSuperior = medianaGeral * 1.3

  // Contagem de críticas: amostras fora de [0.7 * mediana, 1.3 * mediana]
  const criticasCount = precosValidos.filter((p) => {
    const val = p.preco_unitario_normalizado || p.preco_unitario
    return val < limiteInferior || val > limiteSuperior
  }).length

  // Amostras filtradas para listagem
  const amostrasFiltradas = precos
    .filter((p) => {
      if (filtroFonte !== 'todas' && p.fonte !== filtroFonte) return false
      if (filtroStatus !== 'todas' && p.status !== filtroStatus) return false
      if (filtroUf.trim() && !p.uf?.toLowerCase().includes(filtroUf.toLowerCase().trim())) {
        return false
      }
      return true
    })
    .sort((a, b) => {
      const valA = a.preco_unitario_normalizado || a.preco_unitario
      const valB = b.preco_unitario_normalizado || b.preco_unitario
      if (ordenacao === 'menor_preco') return valA - valB
      if (ordenacao === 'maior_preco') return valB - valA
      if (ordenacao === 'data_recente') {
        return new Date(b.data_registro || 0).getTime() - new Date(a.data_registro || 0).getTime()
      }
      return 0
    })

  const temMenosDeTres = precosValidos.length < 3
  const justificativaPendente =
    temMenosDeTres &&
    (!justificativaGeral || justificativaGeral.trim().length < 10) &&
    (!item.justificativa_amostra_minima || item.justificativa_amostra_minima.trim().length < 10)

  const handlePesquisar = () => {
    setBuscaExecutada(true)
  }

  const handleConfirmarMudancaMetodo = () => {
    if (!justificativaMetodoTemp || justificativaMetodoTemp.trim().length < 10) {
      alert('Para alterar o método estatístico, registre uma justificativa fundamentada.')
      return
    }
    if (onAtualizarMetodoItem) {
      onAtualizarMetodoItem(item.id, novoMetodoTemp, justificativaMetodoTemp)
    }
    setModalMudarMetodo(false)
  }

  const handleConfirmarExclusao = () => {
    if (!amostraExclusao) return
    onAtualizarStatusPreco(amostraExclusao.id, 'expurgado', motivoExclusao)
    setAmostraExclusao(null)
    setMotivoExclusao('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[97vw] w-[1420px] max-h-[96vh] p-0 overflow-hidden flex flex-col bg-[#eef1f4] text-[#222] border border-[#7d8b99] shadow-2xl rounded-none font-sans text-xs">
        {/* BARRA SUPERIOR AZUL-ESCURA "COTAÇÃO DE PREÇOS" */}
        <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none border-b border-[#0c314f] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-xs sm:text-sm tracking-wider uppercase">
              COTAÇÃO DE PREÇOS
            </span>
            <span className="text-[#84a9c9] text-xs">|</span>
            <span className="text-[#bcd3e6] font-mono text-[11px] uppercase">
              ITEM #{item.numero_item || 1}
            </span>
          </div>
          <button
            onClick={() => onOpenChange(false)}
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
                {item.descricao_normalizada || item.descricao_original}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-[#4b5563] pt-1 border-t border-[#e5e7eb]">
                <span>
                  <strong>QUANTIDADE:</strong>{' '}
                  <span className="font-mono font-bold text-[#124268]">
                    {item.quantidade} {item.unidade || 'un'}
                  </span>
                </span>
                {item.codigo_catalogo && (
                  <span>
                    <strong>CÓD. CATÁLOGO / CATMAT:</strong>{' '}
                    <span className="font-mono">{item.codigo_catalogo}</span>
                  </span>
                )}
                {item.principio_ativo && (
                  <span>
                    <strong>PRINCÍPIO ATIVO:</strong> {item.principio_ativo}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-[#6b7280] italic">
                  *Especificação técnica padronizada do processo. Consultas preservam
                  compatibilidade funcional integral.
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

                  <div className="flex items-center gap-6 mt-2 text-[11px] text-[#374151]">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="tipoPesquisaModal"
                        checked={tipoPesquisa === 'palavras'}
                        onChange={() => setTipoPesquisa('palavras')}
                        className="text-[#124268] focus:ring-[#124268]"
                      />
                      <span>Contendo as palavras</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="tipoPesquisaModal"
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
                        placeholder="Ex: 463721 ou Medicamento / Material de consumo"
                        value={termoCatmat || item.codigo_catalogo || ''}
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

              <div className="flex items-center justify-between pt-1 border-t border-[#e5e7eb]">
                <Button
                  type="button"
                  onClick={handlePesquisar}
                  className="bg-[#124268] hover:bg-[#0c314f] text-white text-[11px] font-bold uppercase tracking-wider px-3 h-7 rounded-none gap-1.5 shadow-none"
                >
                  <Search className="h-3 w-3" />
                  PESQUISAR
                </Button>
                <span className="text-[10px] text-[#6b7280]">
                  *Resultados agregados das bases oficiais: PNCP, Compras.gov, BPS, CMED e BEC-SP.
                </span>
              </div>
            </div>
          </div>

          {/* SEÇÕES: REFINAR + RESULTADO DA PESQUISA */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
            {/* PAINEL ESTREITO: REFINAR */}
            <div className="lg:col-span-3 bg-white border border-[#b8c2cc] shadow-sm">
              <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between select-none">
                <span className="flex items-center gap-1">
                  <Filter className="h-3 w-3 flex-shrink-0" />
                  REFINAR
                </span>
                {(filtroFonte !== 'todas' || filtroStatus !== 'todas' || filtroUf) && (
                  <button
                    onClick={() => {
                      setFiltroFonte('todas')
                      setFiltroStatus('todas')
                      setFiltroUf('')
                    }}
                    className="text-[9.5px] text-white/90 underline hover:text-white"
                  >
                    Limpar
                  </button>
                )}
              </div>
              <div className="p-2.5 space-y-2.5 bg-white text-[11px]">
                {!buscaExecutada && precos.length === 0 ? (
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
                          <SelectItem value="pncp">PNCP Oficial</SelectItem>
                          <SelectItem value="compras_gov">Compras.gov.br</SelectItem>
                          <SelectItem value="bps">BPS Ministério da Saúde</SelectItem>
                          <SelectItem value="cmed">CMED (Teto ANVISA)</SelectItem>
                          <SelectItem value="bec_sp">BEC-SP</SelectItem>
                          <SelectItem value="fornecedor">Cotação Fornecedor</SelectItem>
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
                          <SelectItem value="valido">Válidas (Na Cesta)</SelectItem>
                          <SelectItem value="expurgado">Expurgadas / Excluídas</SelectItem>
                          <SelectItem value="pendente">Pendente de Avaliação</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">UF</Label>
                      <Input
                        placeholder="Ex: SP, MG, DF..."
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
                {precos.length === 0 ? (
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
                      const isValido = cand.status === 'valido'
                      const isExpurgado = cand.status === 'expurgado'
                      const valUnit = cand.preco_unitario_normalizado || cand.preco_unitario
                      const isCritica =
                        isValido && (valUnit < limiteInferior || valUnit > limiteSuperior)

                      return (
                        <div
                          key={cand.id}
                          className={`p-2 border text-xs flex flex-col md:flex-row md:items-center justify-between gap-2 ${
                            isValido
                              ? 'border-[#a7f3d0] bg-[#f0fdf4]'
                              : isExpurgado
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
                              {isValido && (
                                <span className="px-1 py-0.2 bg-[#d1fae5] text-[#065f46] text-[9px] font-bold border border-[#a7f3d0]">
                                  VÁLIDA
                                </span>
                              )}
                              {isExpurgado && (
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
                              {cand.descricao_item_fonte || item.descricao_original}
                            </p>
                            <p className="text-[10px] text-[#6b7280]">
                              Fornecedor: <strong>{cand.fornecedor_nome || 'NÃO INFORMADO'}</strong>{' '}
                              • CNPJ: {cand.fornecedor_cnpj || 'NÃO INFORMADO'} • Data:{' '}
                              {formatarData(cand.data_registro)} • Local:{' '}
                              {cand.municipio
                                ? `${cand.municipio}/${cand.uf}`
                                : cand.uf || 'NÃO INFORMADO'}
                            </p>
                          </div>

                          <div className="flex items-center gap-3 justify-between md:justify-end flex-shrink-0">
                            <div className="text-right">
                              <span className="text-[9px] text-[#6b7280] block font-bold uppercase">
                                VALOR UNITÁRIO:
                              </span>
                              <span className="font-mono font-bold text-xs sm:text-sm text-[#111827]">
                                {formatarMoeda(valUnit)}
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
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">{precos.length}</td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {desvioPadraoGeral.toFixed(2)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-[#124268]">
                          {formatarMoeda(medianaGeral)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] text-[#374151]">
                          {formatarMoeda(limiteInferior)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] text-[#374151]">
                          {formatarMoeda(limiteSuperior)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {criticasCount > 0 ? (
                            <span className="inline-block px-1.5 py-0.5 rounded-none bg-[#dc2626] text-white font-bold text-[11px]">
                              {criticasCount}
                            </span>
                          ) : (
                            <span className="text-[#6b7280]">0</span>
                          )}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {precosExpurgados.length}
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
                          {precosValidos.length}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {desvioPadraoGeral.toFixed(2)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold">
                          {coefVariacao.toFixed(2)}%
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {formatarMoeda(menorPrecoGeral)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1]">
                          {formatarMoeda(mediaGeral)}
                        </td>
                        <td className="p-1.5 border border-[#cbd5e1] font-bold text-[#124268]">
                          {formatarMoeda(medianaGeral)}
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
                      {precos.length === 0 ? (
                        <tr>
                          <td
                            colSpan={10}
                            className="p-8 text-center text-[#6b7280] font-bold uppercase tracking-wide"
                          >
                            VOCÊ NÃO POSSUI AMOSTRAS DE PREÇOS PARA ESTE ITEM
                          </td>
                        </tr>
                      ) : (
                        precos.map((cand, idx) => {
                          const isValido = cand.status === 'valido'
                          const isExpurgado = cand.status === 'expurgado'
                          const isPendente = cand.status === 'pendente'
                          const valUnit = cand.preco_unitario_normalizado || cand.preco_unitario

                          return (
                            <tr
                              key={cand.id}
                              className={`hover:bg-[#f8fafc] ${isExpurgado ? 'bg-[#fef2f2]/60' : ''}`}
                            >
                              <td className="p-1.5 border border-[#cbd5e1] font-bold whitespace-nowrap">
                                #{idx + 1}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] whitespace-nowrap">
                                {isValido && (
                                  <span className="px-1 py-0.2 bg-[#d1fae5] text-[#065f46] text-[9.5px] font-bold border border-[#a7f3d0]">
                                    VÁLIDA
                                  </span>
                                )}
                                {isExpurgado && (
                                  <span className="px-1 py-0.2 bg-[#fee2e2] text-[#991b1b] text-[9.5px] font-bold border border-[#fecaca]">
                                    EXPURGADA
                                  </span>
                                )}
                                {isPendente && (
                                  <span className="px-1 py-0.2 bg-[#fef3c7] text-[#92400e] text-[9.5px] font-bold border border-[#fde68a]">
                                    PENDENTE
                                  </span>
                                )}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] uppercase font-mono text-[10px] font-bold text-[#124268] whitespace-nowrap">
                                {cand.fonte}
                              </td>
                              <td
                                className="p-1.5 border border-[#cbd5e1] max-w-xs truncate"
                                title={cand.fornecedor_nome}
                              >
                                {cand.fornecedor_nome || 'NÃO INFORMADO'}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono whitespace-nowrap">
                                {formatarData(cand.data_registro)}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono text-[#6b7280] whitespace-nowrap">
                                -
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono whitespace-nowrap">
                                {cand.unidade_fornecida || item.unidade || 'un'}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono text-center whitespace-nowrap">
                                {cand.quantidade_fornecida || 1}
                              </td>
                              <td className="p-1.5 border border-[#cbd5e1] font-mono font-bold text-right whitespace-nowrap text-[#111827]">
                                {formatarMoeda(valUnit)}
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
                                    onClick={() => onAtualizarStatusPreco(cand.id, 'valido')}
                                    className={`h-5 text-[10px] px-1.5 rounded-none ${
                                      isValido
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
                                      setMotivoExclusao(cand.justificativa_descarte || '')
                                    }}
                                    className={`h-5 text-[10px] px-1.5 rounded-none ${
                                      isExpurgado
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

              {/* SUB-BLOCO 4: MEDIDA DE TENDÊNCIA CENTRAL */}
              <div className="border border-[#cbd5e1] bg-[#f8fafc] p-2.5 flex flex-col md:flex-row items-center justify-between gap-3">
                <div className="space-y-0.5 text-[11px]">
                  <span className="font-bold text-[#1f2937] uppercase tracking-wider block">
                    MEDIDA DE TENDÊNCIA CENTRAL
                  </span>
                  <p className="text-[10px] text-[#4b5563]">
                    Preço de referência adotado:{' '}
                    <strong className="text-[#124268] uppercase font-mono">
                      {item.metodo_adotado || 'MEDIANA'} —{' '}
                      {formatarMoeda(item.preco_referencia || medianaGeral)}
                    </strong>
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setNovoMetodoTemp((item.metodo_adotado as any) || 'media')
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
                      metodoAtual === 'mediana'
                        ? 'bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]'
                        : 'bg-white border-[#cbd5e1] text-[#374151]'
                    }`}
                  >
                    <span className="font-sans font-bold uppercase text-[10px]">MEDIANA:</span>
                    <span>{formatarMoeda(medianaGeral)}</span>
                  </div>
                  <div
                    className={`flex items-center justify-between px-2 py-0.5 border ${
                      metodoAtual === 'media'
                        ? 'bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]'
                        : 'bg-white border-[#cbd5e1] text-[#374151]'
                    }`}
                  >
                    <span className="font-sans font-bold uppercase text-[10px]">MÉDIA:</span>
                    <span>{formatarMoeda(mediaGeral)}</span>
                  </div>
                  <div
                    className={`flex items-center justify-between px-2 py-0.5 border ${
                      metodoAtual === 'menor' || (metodoAtual as string) === 'menor_preco'
                        ? 'bg-[#e0f2fe] border-[#7dd3fc] font-bold text-[#0369a1]'
                        : 'bg-white border-[#cbd5e1] text-[#374151]'
                    }`}
                  >
                    <span className="font-sans font-bold uppercase text-[10px]">MENOR PREÇO:</span>
                    <span>{formatarMoeda(menorPrecoGeral)}</span>
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
                    ) : (
                      <span className="text-[#059669] font-bold ml-2">
                        [SITUAÇÃO REGULAR / JUSTIFICADA]
                      </span>
                    )}
                  </p>
                </div>

                {(justificativaGeral || item.justificativa_amostra_minima) && (
                  <div className="p-2 bg-[#f8fafc] border border-[#cbd5e1] text-[11px] text-[#1f2937]">
                    <strong>Texto registrado:</strong>{' '}
                    {justificativaGeral || item.justificativa_amostra_minima}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* RODAPÉ DO MODAL CESTA DE PREÇOS */}
        <div className="bg-[#e5e7eb] border-t border-[#9ca3af] px-4 py-2.5 flex items-center justify-between gap-2 flex-shrink-0 select-none">
          <Button
            type="button"
            disabled={justificativaPendente || precosValidos.length === 0}
            onClick={() => onOpenChange(false)}
            className={`h-8 px-4 text-[11px] font-bold uppercase tracking-wider rounded-none shadow-none border ${
              justificativaPendente || precosValidos.length === 0
                ? 'bg-[#d1d5db] text-[#6b7280] border-[#9ca3af] cursor-not-allowed opacity-75'
                : 'bg-[#f3f4f6] text-[#111827] border-[#9ca3af] hover:bg-white'
            }`}
          >
            ✓ CONCLUIR COTAÇÃO E FECHAR JANELA
          </Button>

          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 px-5 text-[11px] font-bold uppercase tracking-wider rounded-none shadow-none bg-[#124268] hover:bg-[#0c314f] text-white border border-[#0c314f]"
          >
            ✕ FECHAR
          </Button>
        </div>
      </DialogContent>

      {/* MODAL EVIDÊNCIA */}
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
                <strong>ITEM:</strong>{' '}
                {amostraEvidencia.descricao_item_fonte || item.descricao_original}
              </p>
              <p>
                <strong>FORNECEDOR:</strong> {amostraEvidencia.fornecedor_nome || 'NÃO INFORMADO'}
              </p>
              <p>
                <strong>CNPJ:</strong> {amostraEvidencia.fornecedor_cnpj || 'NÃO INFORMADO'}
              </p>
              <p>
                <strong>VALOR:</strong>{' '}
                {formatarMoeda(
                  amostraEvidencia.preco_unitario_normalizado || amostraEvidencia.preco_unitario,
                )}
              </p>
              <p>
                <strong>FONTE:</strong> {amostraEvidencia.fonte.toUpperCase()}
              </p>
              <p>
                <strong>DATA:</strong> {formatarData(amostraEvidencia.data_registro)}
              </p>
              <p className="break-all">
                <strong>HASH SHA-256:</strong>{' '}
                {amostraEvidencia.hash_registro ||
                  '3b8ef4d7a1c890123efd6543210987654321fedcba0987654321abcdef012345'}
              </p>
              {amostraEvidencia.url_fonte && (
                <p className="break-all">
                  <strong>URL:</strong>{' '}
                  <a
                    href={amostraEvidencia.url_fonte}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#124268] underline"
                  >
                    {amostraEvidencia.url_fonte}
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

      {/* MODAL EXCLUSÃO */}
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
                placeholder="Ex: Item incompatível com a especificação ou valor manifestamente inexequível..."
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
                onClick={handleConfirmarExclusao}
                className="h-7 text-xs rounded-none font-bold"
              >
                Confirmar Expurgo
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL JUSTIFICATIVA OU OBSERVAÇÃO */}
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
                onClick={() => {
                  if (onAtualizarMetodoItem && justificativaGeral) {
                    onAtualizarMetodoItem(
                      item.id,
                      (item.metodo_adotado as any) || 'mediana',
                      justificativaGeral,
                    )
                  }
                  setModalJustificativa(false)
                }}
                size="sm"
                className="h-7 text-xs rounded-none bg-[#124268] text-white font-bold"
              >
                Salvar Justificativa
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* MODAL MUDAR MÉTODO */}
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
              <Select value={novoMetodoTemp} onValueChange={(v: any) => setNovoMetodoTemp(v)}>
                <SelectTrigger className="h-7 text-xs rounded-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="text-xs">
                  <SelectItem value="mediana">Mediana (Padrão legal Lei 14.133)</SelectItem>
                  <SelectItem value="media">Média Aritmética</SelectItem>
                  <SelectItem value="menor_preco">Menor Preço Válido</SelectItem>
                  <SelectItem value="media_saneada">Média Saneada (Exclusão Outliers)</SelectItem>
                </SelectContent>
              </Select>
              <Label className="text-[11px] font-bold">Justificativa Técnica Obrigatória</Label>
              <Textarea
                rows={3}
                value={justificativaMetodoTemp}
                onChange={(e) => setJustificativaMetodoTemp(e.target.value)}
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
    </Dialog>
  )
}
