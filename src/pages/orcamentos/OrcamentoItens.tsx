import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  X,
  FileSpreadsheet,
  Plus,
  Search,
  Sparkles,
  Edit2,
  Trash2,
  Download,
  Upload,
  AlertTriangle,
  CheckCircle2,
  SlidersHorizontal,
  ChevronRight,
  Filter,
  Eye,
  RefreshCw,
  FileCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import type {
  Budget,
  BudgetItem,
  BudgetMethodology,
  BudgetPriceResult,
  BudgetExpurgatedPrice,
} from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'
import { BudgetPdfGeneratorService } from '@/lib/budgetPdfGeneratorService'
import pb from '@/lib/pocketbase/client'
import { ModalImportarPlanilha } from '@/components/ModalImportarPlanilha'
import { ModalPesquisarPrecos } from '@/components/ModalPesquisarPrecos'
import { ModalItemOrcamento } from '@/components/ModalItemOrcamento'
import { ModalAnaliseCritica } from '@/components/ModalAnaliseCritica'
import { useAuth } from '@/context/AuthContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Copy, ListOrdered, Activity, Check } from 'lucide-react'

export default function OrcamentoItens() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [budget, setBudget] = useState<Budget | null>(null)
  const [methodology, setMethodology] = useState<BudgetMethodology | null>(null)
  const [itens, setItens] = useState<BudgetItem[]>([])
  const [loading, setLoading] = useState(true)

  // Modais Cesta de Preços
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [isItemModalOpen, setIsItemModalOpen] = useState(false)
  const [itemParaEditar, setItemParaEditar] = useState<BudgetItem | null>(null)
  const [itemParaPesquisar, setItemParaPesquisar] = useState<BudgetItem | null>(null)
  const [itemParaAnaliseCritica, setItemParaAnaliseCritica] = useState<BudgetItem | null>(null)

  // Seleção múltipla para apagar itens marcados
  const [itensMarcados, setItensMarcados] = useState<string[]>([])

  // ETAPA 12: Conclusão do Orçamento Estimativo
  const [justificativaConclusao, setJustificativaConclusao] = useState('')
  const [concluindoOrcamento, setConcluindoOrcamento] = useState(false)
  const [sucessoConclusao, setSucessoConclusao] = useState(false)
  const [modalPdfConclusaoAberto, setModalPdfConclusaoAberto] = useState(false)

  // Filtro de Curva ABC
  const [filtroCurvaAbc, setFiltroCurvaAbc] = useState<'TODOS' | 'A' | 'B' | 'C'>('TODOS')

  // Progresso do "COTAR TODOS COM IA"
  const [processandoLote, setProcessandoLote] = useState(false)
  const [statusProgressoLote, setStatusProgressoLote] = useState<string>('')

  useEffect(() => {
    if (id) {
      carregarDados(id)
    }
  }, [id])

  const carregarDados = async (budgetId: string) => {
    setLoading(true)
    try {
      const [b, meth, its] = await Promise.all([
        BudgetService.obterOrcamento(budgetId),
        BudgetService.obterMetodologia(budgetId),
        BudgetService.listarItens(budgetId),
      ])
      setBudget(b)
      setMethodology(meth)
      setItens(its)
    } catch (err) {
      console.error('Erro ao carregar itens do orçamento:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleSalvarItem = async (dados: {
    description: string
    unit: string
    quantity: number
    brand?: string
    type: 'PRODUTO' | 'SERVICO'
    tipoQuantidade?: 'INTEIRO' | 'FRACIONADO'
    tipoMarca?: 'DE_REFERENCIA' | 'VINCULATIVA'
    reference_price?: number
    alterar_dados_fontes?: boolean
  }) => {
    if (!id) return

    if (itemParaEditar) {
      await BudgetService.atualizarItem(
        itemParaEditar.id,
        {
          description: dados.description,
          unit: dados.unit,
          quantity: dados.quantity,
          brand: dados.brand,
          type: dados.type,
          reference_price: dados.reference_price,
          alterar_dados_fontes: dados.alterar_dados_fontes,
        },
        id,
        user?.id,
      )
    } else {
      await BudgetService.adicionarItem({
        budget_id: id,
        description: dados.description,
        unit: dados.unit,
        quantity: dados.quantity,
        brand: dados.brand,
        type: dados.type,
        reference_price: dados.reference_price,
        alterar_dados_fontes: dados.alterar_dados_fontes,
        user_id: user?.id,
      })
    }

    setIsItemModalOpen(false)
    setItemParaEditar(null)
    await carregarDados(id)
  }

  const abrirAdicionarItem = () => {
    setItemParaEditar(null)
    setIsItemModalOpen(true)
  }

  const abrirEdicaoItem = (item: BudgetItem) => {
    setItemParaEditar(item)
    setIsItemModalOpen(true)
  }

  // ETAPA 06: Duplicar item
  const handleDuplicarItem = async (item: BudgetItem) => {
    if (!id) return
    try {
      await BudgetService.duplicarItem(item.id, id, user?.id)
      await carregarDados(id)
    } catch (err: any) {
      alert('Erro ao duplicar item: ' + (err.message || 'Falha'))
    }
  }

  // ETAPA 06: Renumerar itens
  const handleRenumerar = async () => {
    if (!id) return
    try {
      await BudgetService.renumerarItens(id, user?.id)
      await carregarDados(id)
      alert('Itens renumerados com sucesso!')
    } catch (err: any) {
      alert('Erro ao renumerar itens: ' + (err.message || 'Falha'))
    }
  }

  // ETAPA 06: Apagar item
  const handleExcluirItem = async (item: BudgetItem) => {
    if (!id) return
    if (
      !confirm(
        `Deseja realmente apagar o Item ${String(item.sequence).padStart(2, '0')} — "${item.description}"?`,
      )
    ) {
      return
    }

    try {
      if (!pb.authStore.isValid) {
        alert('Sua sessão expirou. Por favor, realize o login novamente.')
        navigate('/login')
        return
      }
      await BudgetService.excluirItem(item.id, id, user?.id)
      await carregarDados(id)
    } catch (err: any) {
      console.error('Falha ao excluir item:', err)
      if (err?.status === 401 || err?.status === 403 || !pb.authStore.isValid) {
        alert('Sua sessão expirou ou não possui autorização. Por favor, autentique-se novamente.')
        navigate('/login')
      } else {
        alert('Erro ao excluir item: ' + (err?.message || 'Verifique suas permissões ou conexão.'))
      }
    }
  }

  // Apagar itens marcados
  const handleApagarItensMarcados = async () => {
    if (!id || itensMarcados.length === 0) return
    if (!confirm(`Deseja apagar os ${itensMarcados.length} itens marcados?`)) return

    try {
      if (!pb.authStore.isValid) {
        alert('Sua sessão expirou. Por favor, realize o login novamente.')
        navigate('/login')
        return
      }
      for (const itemId of itensMarcados) {
        await BudgetService.excluirItem(itemId, id, user?.id)
      }
      setItensMarcados([])
      await carregarDados(id)
    } catch (err: any) {
      console.error('Falha ao apagar itens marcados:', err)
      if (err?.status === 401 || err?.status === 403 || !pb.authStore.isValid) {
        alert('Sua sessão expirou ou não possui autorização. Por favor, autentique-se novamente.')
        navigate('/login')
      } else {
        alert('Erro ao apagar itens marcados: ' + (err?.message || 'Verifique suas permissões.'))
      }
    }
  }

  // Apagar todos os itens
  const handleApagarTodosItens = async () => {
    if (!id || itens.length === 0) return
    if (
      !confirm(
        `ATENÇÃO: Deseja apagar TODOS os ${itens.length} itens deste orçamento? Esta ação é irreversível.`,
      )
    )
      return

    try {
      if (!pb.authStore.isValid) {
        alert('Sua sessão expirou. Por favor, realize o login novamente.')
        navigate('/login')
        return
      }
      for (const it of itens) {
        await BudgetService.excluirItem(it.id, id, user?.id)
      }
      setItensMarcados([])
      await carregarDados(id)
    } catch (err: any) {
      console.error('Falha ao apagar todos os itens:', err)
      if (err?.status === 401 || err?.status === 403 || !pb.authStore.isValid) {
        alert('Sua sessão expirou ou não possui autorização. Por favor, autentique-se novamente.')
        navigate('/login')
      } else {
        alert('Erro ao apagar todos os itens: ' + (err?.message || 'Verifique suas permissões.'))
      }
    }
  }

  // Selecionar/desmarcar item individual
  const toggleMarcaItem = (itemId: string) => {
    setItensMarcados((prev) =>
      prev.includes(itemId) ? prev.filter((i) => i !== itemId) : [...prev, itemId],
    )
  }

  // Carrega cotações e expurgos para compor o PDF completo
  const coletarDadosCompletosPdf = async () => {
    if (!id || !budget) return null
    const mapCot: Record<string, BudgetPriceResult[]> = {}
    const mapExp: Record<string, BudgetExpurgatedPrice[]> = {}

    for (const it of itens) {
      const prices = await BudgetService.listarPrecosSelecionadosDoItem(it.id)
      mapCot[it.id] = prices
      try {
        const exps = await pb
          .collection('budget_expurgated_prices')
          .getList<BudgetExpurgatedPrice>(1, 100, {
            filter: `budget_item_id = "${it.id}"`,
            expand: 'price_result_id',
          })
        mapExp[it.id] = exps.items
      } catch {
        mapExp[it.id] = []
      }
    }

    const orgao = budget.expand?.organization_id as any
    const orgaoNome = orgao?.nome || 'PREFEITURA MUNICIPAL DE FLORÂNIA - RN'
    const setorResponsavel =
      orgao?.setor_responsavel || 'DEPARTAMENTO DE PLANEJAMENTO - ASSISTENTE DE COMPRAS'
    const endereco = orgao?.endereco || 'RUA TEONIA AMARAL, 290 290 CENTRO'
    const cep = orgao?.cep || '59.335-000'
    const municipioUf = orgao?.municipio || 'FLORÂNIA/RN'
    const cnpj = orgao?.cnpj || '08.140.751/0001-44'

    return {
      budget,
      methodology,
      itens,
      cotacoesPorItem: mapCot,
      expurgadosPorItem: mapExp,
      orgaoNome,
      setorResponsavel,
      endereco,
      cep,
      municipioUf,
      cnpj,
      responsavelNome: user?.name || 'Comissão de Contratação / Servidor Designado',
      justificativaConclusao,
    }
  }

  // Estado para alertar caso popup tenha sido bloqueado
  const [popupBloqueado, setPopupBloqueado] = useState(false)

  // ETAPA 12: Conclusão do Orçamento Estimativo com Geração de PDF por Cidade/Órgão
  const handleConcluirOrcamento = async () => {
    if (!id) return

    setConcluindoOrcamento(true)
    try {
      const orcAtualizado = await BudgetService.concluirOrcamento(id, {
        observacao_justificativa: justificativaConclusao,
        responsavel_nome: user?.name,
        userId: user?.id,
      })

      // Registrar auditoria específica da geração do PDF
      await BudgetService.registrarLog({
        budget_id: id,
        user_id: user?.id,
        action: 'GERAR_PDF_ORCAMENTO',
        entity_type: 'budgets',
        entity_id: id,
        description: `Documento oficial do orçamento estimativo gerado em PDF, organizado por órgão/cidade com ${itens.length} item(ns).`,
        metadata: {
          data_geracao: new Date().toISOString(),
          total_itens: itens.length,
          valor_total: orcAtualizado.estimated_total_value,
        },
      })

      setSucessoConclusao(true)
      await carregarDados(id)

      // Gerar e disponibilizar automaticamente o PDF organizado por Órgão/Cidade
      const dadosPdf = await coletarDadosCompletosPdf()
      if (dadosPdf) {
        const resultado = BudgetPdfGeneratorService.gerarPdfOrcamento(dadosPdf)
        setPopupBloqueado(resultado.bloqueadoPorPopup)
      }

      setModalPdfConclusaoAberto(true)
    } catch (e: any) {
      alert('Erro ao concluir orçamento: ' + (e.message || 'Verifique os dados.'))
    } finally {
      setConcluindoOrcamento(false)
    }
  }

  // Ação de download/visualização direta do PDF em qualquer momento
  const handleBaixarPdfManual = async () => {
    try {
      const dadosPdf = await coletarDadosCompletosPdf()
      if (dadosPdf) {
        const resultado = BudgetPdfGeneratorService.gerarPdfOrcamento(dadosPdf)
        setPopupBloqueado(resultado.bloqueadoPorPopup)
        if (resultado.bloqueadoPorPopup) {
          alert(
            'Seu navegador bloqueou a abertura da janela de impressão. O arquivo foi baixado automaticamente para o seu dispositivo!',
          )
        }
      }
    } catch (err: any) {
      console.error('Erro ao gerar PDF do orçamento:', err)
      alert('Falha ao gerar PDF: ' + (err?.message || 'Erro inesperado. Tente novamente.'))
    }
  }

  // Força download direto sem tentar popup
  const handleDownloadArquivoDireto = async () => {
    try {
      const dadosPdf = await coletarDadosCompletosPdf()
      if (dadosPdf) {
        BudgetPdfGeneratorService.baixarArquivoHtmlPdf(dadosPdf)
      }
    } catch (err: any) {
      console.error('Erro ao baixar arquivo do orçamento:', err)
      alert('Falha ao baixar arquivo: ' + (err?.message || 'Erro inesperado.'))
    }
  }

  const handleImportarPlanilhaSucesso = async (
    novosItens: Array<{
      description: string
      unit: string
      quantity: number
      brand?: string
      type: 'PRODUTO' | 'SERVICO'
      cidade_orgao?: string
      lote?: string
    }>,
  ) => {
    if (!id) return
    for (const it of novosItens) {
      await BudgetService.adicionarItem({
        budget_id: id,
        description: it.description,
        unit: it.unit,
        quantity: it.quantity,
        brand: it.brand,
        type: it.type,
        cidade_orgao: it.cidade_orgao,
        lote: it.lote,
      })
    }
    await carregarDados(id)
  }

  // Executar cotação em lote com IA para os itens pendentes
  const handleCotarTodosComIa = async () => {
    if (!id) return
    const itensPendentes = itens.filter((i) => i.status !== 'cotado')
    if (itensPendentes.length === 0) {
      alert('Todos os itens deste orçamento já foram cotados.')
      return
    }

    setProcessandoLote(true)
    try {
      for (let i = 0; i < itensPendentes.length; i++) {
        const itemAtual = itensPendentes[i]
        setStatusProgressoLote(
          `Processando: Item ${i + 1}/${itensPendentes.length} — ${itemAtual.description}`,
        )

        // 1. Cotar com IA
        const resultados = await BudgetService.cotarItemComIA(itemAtual)

        if (resultados.length > 0) {
          // Aplicar seleção determinística global de no máximo 3 melhores amostras
          const refAtual =
            itemAtual.reference_price && itemAtual.reference_price > 0
              ? itemAtual.reference_price
              : undefined
          const inf = methodology?.percentage_lower ?? 30
          const sup = methodology?.percentage_upper ?? 30
          const melhoresIds = BudgetService.selecionarMelhoresAmostrasGlobais(
            resultados,
            refAtual,
            3,
            { limiteInferiorPct: inf, limiteSuperiorPct: sup },
          )
          // NUNCA completar com amostras fora da faixa para bater 3.
          // Se houver menos de 3 elegíveis, passa exatamente as elegíveis.
          const idsParaCalcular = melhoresIds.length > 0 ? melhoresIds : [resultados[0].id]
          await BudgetService.confirmarCotacoesECalcular(itemAtual, idsParaCalcular, id)
        }
      }

      await carregarDados(id)
      alert('Cotação em lote finalizada com sucesso!')
    } catch (err: any) {
      console.error('Erro no processamento em lote:', err)
      alert('Erro ao cotar itens em lote: ' + (err.message || 'Erro inesperado'))
    } finally {
      setProcessandoLote(false)
      setStatusProgressoLote('')
    }
  }

  // Resumo de contadores
  const totalItens = itens.length
  const cotadosCount = itens.filter((i) => i.status === 'cotado').length
  const pendentesCount = totalItens - cotadosCount
  const valorTotalEstimado = itens.reduce((s, it) => s + (it.total_price || 0), 0)
  const decimals = methodology?.decimal_places || 2

  // Filtragem pela Curva ABC
  const itensExibidos = itens.filter((it) => {
    if (filtroCurvaAbc === 'TODOS') return true
    return it.abc_class === filtroCurvaAbc
  })

  return (
    <div className="space-y-6">
      {/* Topo do Módulo Cesta de Preços */}
      <div className="bg-white border border-[#b8c2cc] shadow-xs">
        {/* Barra Superior Azul-Escura #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex flex-wrap items-center justify-between gap-2 select-none">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 bg-amber-400 border border-[#0c314f]" />
            <span className="font-bold text-xs uppercase tracking-wider">
              ITENS DO ORÇAMENTO — {budget?.internal_number}
            </span>
            <span className="text-white/60 text-xs hidden sm:inline">• {budget?.name}</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleBaixarPdfManual}
              className="h-7 text-[11px] font-bold uppercase rounded-none border-white/30 bg-white/10 hover:bg-white/20 text-white"
            >
              <Download className="h-3 w-3 mr-1 text-amber-300" />
              Gerar PDF (Cidade/Órgão)
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate(`/app/orcamentos/${id}/metodologia`)}
              className="h-7 text-[11px] font-bold uppercase rounded-none border-white/30 bg-white/10 hover:bg-white/20 text-white"
            >
              <SlidersHorizontal className="h-3 w-3 mr-1 text-amber-300" />
              Metodologia
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => navigate(`/app/orcamentos/${id}/mapa`)}
              className="h-7 text-[11px] font-bold uppercase rounded-none bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-none"
            >
              <FileCheck className="h-3.5 w-3.5 mr-1 text-slate-950" />
              Mapa Comparativo
            </Button>
          </div>
        </div>

        {/* Resumo do Orçamento no Topo: ITENS / COTADOS / PENDENTES / VALOR ESTIMADO */}
        <div className="bg-gray-100 p-4 border-b border-gray-300 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center select-none">
          <div className="bg-white p-3 border border-gray-300 shadow-2xs">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block">
              TOTAL DE ITENS
            </span>
            <span className="text-xl font-bold font-mono text-gray-900 block">{totalItens}</span>
          </div>
          <div className="bg-white p-3 border border-gray-300 shadow-2xs">
            <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider block">
              ITENS COTADOS
            </span>
            <span className="text-xl font-bold font-mono text-emerald-700 block">
              {cotadosCount}
            </span>
          </div>
          <div className="bg-white p-3 border border-gray-300 shadow-2xs">
            <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wider block">
              ITENS PENDENTES
            </span>
            <span className="text-xl font-bold font-mono text-amber-700 block">
              {pendentesCount}
            </span>
          </div>
          <div className="bg-white p-3 border border-gray-300 shadow-2xs">
            <span className="text-[10px] font-bold text-[#124268] uppercase tracking-wider block">
              VALOR ESTIMADO TOTAL
            </span>
            <span className="text-xl font-bold font-mono text-[#124268] block">
              R${' '}
              {valorTotalEstimado.toLocaleString('pt-BR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        </div>

        {/* Barra de Ações: + CRIAR NOVO ITEM / CRIAR NOVO LOTE / IMPORTAR PLANILHA / RENUMERAR */}
        <div className="p-4 bg-white border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={abrirAdicionarItem}
              className="h-9 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none"
            >
              <Plus className="h-3.5 w-3.5 mr-1 text-amber-400" />+ CRIAR NOVO ITEM
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={() => setIsImportModalOpen(true)}
              className="h-9 px-4 text-xs font-bold uppercase rounded-none border-gray-400 text-gray-800 bg-white hover:bg-gray-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 mr-1 text-emerald-600" />
              IMPORTAR PLANILHA DE ITENS
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={handleRenumerar}
              title="Renumerar sequencialmente todos os itens (01, 02, 03...)"
              className="h-9 px-3 text-xs font-bold uppercase rounded-none border-gray-400 text-gray-700 bg-white hover:bg-gray-50"
            >
              <ListOrdered className="h-3.5 w-3.5 mr-1 text-[#124268]" />
              RENUMERAR ITENS
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={handleCotarTodosComIa}
              disabled={processandoLote || pendentesCount === 0}
              className="h-9 px-5 text-xs font-bold uppercase rounded-none bg-emerald-700 hover:bg-emerald-800 text-white shadow-none flex items-center gap-2"
            >
              <Sparkles className="h-4 w-4 text-amber-300 animate-pulse" />
              <span>{processandoLote ? 'COTANDO ITENS...' : 'COTAR TODOS COM IA'}</span>
            </Button>
          </div>
        </div>

        {/* Indicador de progresso em lote quando ativo */}
        {processandoLote && (
          <div className="bg-emerald-50 border-b border-emerald-200 p-3 px-4 text-xs text-emerald-900 flex items-center gap-2 animate-pulse">
            <RefreshCw className="h-4 w-4 animate-spin text-emerald-700" />
            <span className="font-bold">{statusProgressoLote}</span>
          </div>
        )}

        {/* Filtros da Curva ABC */}
        {cotadosCount > 0 && (
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2 text-xs select-none">
            <span className="font-bold text-gray-500 uppercase text-[10px] flex items-center gap-1">
              <Filter className="h-3 w-3" /> Filtrar Curva ABC:
            </span>
            {(['TODOS', 'A', 'B', 'C'] as const).map((classe) => (
              <button
                key={classe}
                type="button"
                onClick={() => setFiltroCurvaAbc(classe)}
                className={`px-2.5 py-0.5 text-xs font-bold rounded-none uppercase transition-colors cursor-pointer ${
                  filtroCurvaAbc === classe
                    ? 'bg-[#124268] text-white'
                    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-100'
                }`}
              >
                {classe === 'TODOS' ? 'Todos os Itens' : `Itens ${classe}`}
              </button>
            ))}
          </div>
        )}

        {/* TELA PRINCIPAL DOS ITENS (ETAPA 05 DO DOCUMENTO CESTA DE PREÇOS) */}
        <div className="p-4 space-y-3">
          <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
            <span>CADASTRAMENTO DE ITENS DO ORÇAMENTO</span>
            <span className="text-[11px] font-normal lowercase">
              {itensExibidos.length} de {totalItens} item(ns) listado(s)
            </span>
          </div>

          {itens.length === 0 ? (
            <div className="p-16 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-3">
              <FileSpreadsheet className="h-10 w-10 mx-auto text-gray-400" />
              <p className="font-bold text-gray-800 text-sm">SEU ORÇAMENTO ESTÁ VAZIO.</p>
              <p className="text-gray-500 max-w-md mx-auto">
                Você pode importar uma planilha com a lista completa ou cadastrar item a item
                manualmente.
              </p>
              <div className="flex justify-center gap-3 pt-2">
                <Button
                  type="button"
                  onClick={() => setIsImportModalOpen(true)}
                  className="h-9 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
                >
                  <Upload className="h-3.5 w-3.5 mr-1" />
                  IMPORTAR PLANILHA
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={abrirAdicionarItem}
                  className="h-9 px-4 text-xs font-bold uppercase rounded-none border-gray-400 bg-white"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />+ CRIAR NOVO ITEM
                </Button>
              </div>
            </div>
          ) : (
            <div>
              {/* Tabela de Itens Fiel ao Cesta de Preços (Etapa 05 e 06) */}
              <div className="border border-gray-300 overflow-x-auto shadow-2xs">
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300 select-none">
                    <tr>
                      <th className="p-2.5 text-center w-10">
                        <input
                          type="checkbox"
                          checked={itensMarcados.length === itens.length && itens.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) setItensMarcados(itens.map((i) => i.id))
                            else setItensMarcados([])
                          }}
                          className="rounded-none text-[#124268]"
                        />
                      </th>
                      <th className="p-2.5 text-center w-24">LOTE/ITEM</th>
                      <th className="p-2.5">DESCRIÇÃO</th>
                      <th className="p-2.5 text-center">MEDIDA DE FORNECIMENTO</th>
                      <th className="p-2.5 text-right">QNT</th>
                      <th
                        className="p-2.5 text-right bg-blue-50/70 border-x border-blue-100"
                        title="Valor Vigente / Contratado para análise de vantajosidade de prorrogação"
                      >
                        VALOR REF. (CONTRATO)
                      </th>
                      <th className="p-2.5 text-right">PREÇO UNITÁRIO (R$)</th>
                      <th className="p-2.5 text-right">PREÇO TOTAL (R$)</th>
                      <th className="p-2.5 text-center">CURVA ABC</th>
                      <th className="p-2.5 text-center w-36">AÇÕES</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {itensExibidos.map((item) => {
                      const isCotado = item.status === 'cotado'
                      const temPreco = item.unit_price && item.unit_price > 0
                      const qtdCot = item.quotation_count || 0
                      const isMarcado = itensMarcados.includes(item.id)
                      const temRef =
                        item.reference_price !== undefined &&
                        item.reference_price !== null &&
                        item.reference_price > 0

                      return (
                        <tr
                          key={item.id}
                          className={`hover:bg-blue-50/40 transition-colors ${
                            isCotado ? 'bg-emerald-50/10' : ''
                          } ${isMarcado ? 'bg-blue-50/30' : ''}`}
                        >
                          {/* Checkbox de seleção */}
                          <td className="p-2.5 text-center">
                            <input
                              type="checkbox"
                              checked={isMarcado}
                              onChange={() => toggleMarcaItem(item.id)}
                              className="rounded-none text-[#124268]"
                            />
                          </td>

                          {/* LOTE/ITEM: numeração 00/001, 00/002 */}
                          <td className="p-2.5 text-center font-bold font-mono text-gray-900 bg-gray-50/80">
                            {item.lote ? `${item.lote}/` : '00/'}
                            {String(item.sequence).padStart(3, '0')}
                          </td>

                          {/* DESCRIÇÃO */}
                          <td className="p-2.5">
                            <div className="font-bold text-gray-900">{item.description}</div>
                            <div className="text-[11px] text-gray-500 flex flex-wrap items-center gap-2">
                              {item.cidade_orgao && (
                                <span className="text-[10px] font-bold text-[#124268] bg-slate-100 px-1.5 py-0.5 border border-slate-300">
                                  Cidade/Órgão: {item.cidade_orgao}
                                </span>
                              )}
                              <span>
                                Tipo: <strong>{item.type}</strong>
                              </span>
                              {item.brand && (
                                <span>
                                  • Marca: <strong>{item.brand}</strong>
                                </span>
                              )}
                              {temRef && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-800 bg-blue-50 px-1.5 py-0.5 border border-blue-200">
                                  <span>Vantajosidade Ativa:</span>
                                  <span className="font-mono">
                                    R$ {item.reference_price!.toFixed(decimals)}
                                  </span>
                                </span>
                              )}
                              {item.alterar_dados_fontes && (
                                <span className="text-[10px] text-blue-700 bg-blue-50 px-1 py-0.5 border border-blue-200">
                                  Dados em fontes alteráveis
                                </span>
                              )}
                            </div>
                            {item.alert_messages && item.alert_messages.length > 0 && (
                              <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-700 font-bold">
                                <AlertTriangle className="h-3 w-3 text-amber-600 flex-shrink-0" />
                                <span>{item.alert_messages[0]}</span>
                              </div>
                            )}
                          </td>

                          {/* MEDIDA DE FORNECIMENTO */}
                          <td className="p-2.5 text-center font-mono font-bold text-gray-700">
                            {item.unit}
                          </td>

                          {/* QUANTIDADE */}
                          <td className="p-2.5 text-right font-mono text-gray-900">
                            {item.quantity.toLocaleString('pt-BR')}
                          </td>

                          {/* VALOR DE REFERÊNCIA (VALORES VANTAJOSOS / PRORROGAÇÃO) */}
                          <td className="p-2.5 text-right font-mono whitespace-nowrap bg-blue-50/40 border-x border-blue-100">
                            {temRef ? (
                              <div className="flex flex-col items-end">
                                <span className="font-bold text-blue-900">
                                  R${' '}
                                  {item.reference_price!.toLocaleString('pt-BR', {
                                    minimumFractionDigits: decimals,
                                    maximumFractionDigits: decimals,
                                  })}
                                </span>
                                <span className="text-[9px] text-blue-600 font-sans uppercase">
                                  Contrato Vigente
                                </span>
                              </div>
                            ) : (
                              <span className="text-gray-400 italic text-[11px]">Não inf.</span>
                            )}
                          </td>

                          {/* PREÇO UNITÁRIO */}
                          <td className="p-2.5 text-right font-mono font-bold whitespace-nowrap">
                            {temPreco ? (
                              <div className="flex flex-col items-end">
                                <span className="text-[#124268]">
                                  R${' '}
                                  {item.unit_price!.toLocaleString('pt-BR', {
                                    minimumFractionDigits: decimals,
                                    maximumFractionDigits: decimals,
                                  })}
                                </span>
                                {temRef && (
                                  <span
                                    className={`text-[9.5px] font-sans font-bold ${
                                      item.unit_price! >= item.reference_price!
                                        ? 'text-emerald-700'
                                        : 'text-amber-700'
                                    }`}
                                  >
                                    {item.unit_price! >= item.reference_price!
                                      ? `+R$ ${(item.unit_price! - item.reference_price!).toFixed(decimals)} (Vantajoso)`
                                      : `-R$ ${(item.reference_price! - item.unit_price!).toFixed(decimals)}`}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-gray-400">R$ 0,00</span>
                            )}
                          </td>

                          {/* PREÇO TOTAL */}
                          <td className="p-2.5 text-right font-mono font-bold whitespace-nowrap">
                            {temPreco ? (
                              <span className="text-gray-900">
                                R${' '}
                                {item.total_price!.toLocaleString('pt-BR', {
                                  minimumFractionDigits: decimals,
                                  maximumFractionDigits: decimals,
                                })}
                              </span>
                            ) : (
                              <span className="text-gray-400">R$ 0,00</span>
                            )}
                          </td>

                          {/* CURVA ABC */}
                          <td className="p-2.5 text-center whitespace-nowrap">
                            {item.abc_class && item.abc_class !== '—' ? (
                              <span
                                className={`inline-block px-2 py-0.5 font-bold font-mono text-[11px] rounded-none ${
                                  item.abc_class === 'A'
                                    ? 'bg-red-100 text-red-800 border border-red-300'
                                    : item.abc_class === 'B'
                                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                                      : 'bg-blue-100 text-blue-800 border border-blue-300'
                                }`}
                              >
                                CLASSE {item.abc_class}
                              </span>
                            ) : (
                              <span className="text-gray-400 font-mono text-[11px]">
                                SEM CLASSE
                              </span>
                            )}
                          </td>

                          {/* AÇÕES FIÉIS AO CESTA DE PREÇOS (ETAPAS 05 e 06): Lupa, Análise Crítica, Editar, Outras Opções */}
                          <td className="p-2.5 text-center whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              {/* 1. LUPA 🔍: Inicia a pesquisa/cotação do item (Etapa 06/09) */}
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => setItemParaPesquisar(item)}
                                className="h-7 w-7 p-0 rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-2xs inline-flex items-center justify-center"
                                title="Pesquisar/Cotar este item (Lupa)"
                              >
                                <Search className="h-3.5 w-3.5" />
                              </Button>

                              {/* 2. ANÁLISE CRÍTICA 📊: Abre a janela de análise crítica (Etapa 08) */}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setItemParaAnaliseCritica(item)}
                                className="h-7 w-7 p-0 rounded-none border-gray-400 text-[#124268] hover:bg-blue-50 inline-flex items-center justify-center"
                                title="Análise Crítica dos Dados Coletados"
                              >
                                <Activity className="h-3.5 w-3.5 text-amber-600" />
                              </Button>

                              {/* 3. EDITAR ✏️: Abre a janela Alterar Item (Etapa 07) */}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => abrirEdicaoItem(item)}
                                className="h-7 w-7 p-0 rounded-none border-gray-400 text-gray-700 hover:bg-gray-100 inline-flex items-center justify-center"
                                title="Alterar Item"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </Button>

                              {/* 4. MENU "OUTRAS OPÇÕES" DO ITEM (ETAPA 06): Duplicar, Renumerar, Apagar */}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 w-7 p-0 rounded-none border-gray-400 text-gray-700 hover:bg-gray-100 inline-flex items-center justify-center"
                                    title="Outras opções do item"
                                  >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="w-48 text-xs rounded-none"
                                >
                                  <DropdownMenuItem
                                    onClick={() => handleDuplicarItem(item)}
                                    className="cursor-pointer flex items-center gap-2"
                                  >
                                    <Copy className="h-3.5 w-3.5 text-blue-700" />
                                    <span>Duplicar item</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={handleRenumerar}
                                    className="cursor-pointer flex items-center gap-2"
                                  >
                                    <ListOrdered className="h-3.5 w-3.5 text-gray-700" />
                                    <span>Renumerar</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => handleExcluirItem(item)}
                                    className="cursor-pointer flex items-center gap-2 text-red-600 focus:bg-red-50 focus:text-red-700"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    <span>Apagar</span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Botões Inferiores da Tabela: APAGAR ITENS MARCADOS e APAGAR TODOS OS ITENS */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                <div className="text-xs text-gray-600">
                  Valor total dos itens:{' '}
                  <strong className="text-gray-900 font-mono">
                    R$ {valorTotalEstimado.toFixed(decimals)}
                  </strong>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleApagarItensMarcados}
                    disabled={itensMarcados.length === 0}
                    className="h-8 px-3 text-xs font-bold uppercase rounded-none border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40"
                  >
                    ✕ APAGAR ITENS MARCADOS ({itensMarcados.length})
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleApagarTodosItens}
                    disabled={itens.length === 0}
                    className="h-8 px-3 text-xs font-bold uppercase rounded-none border-red-500 text-red-800 bg-red-50/50 hover:bg-red-100 disabled:opacity-40"
                  >
                    ✕ APAGAR TODOS OS ITENS
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ======================================================== */}
        {/* ETAPAS 04 E 12: COLETA DE AMOSTRAS E CONCLUSÃO DO ORÇAMENTO */}
        {/* ======================================================== */}
        <div className="p-4 space-y-4 border-t-2 border-gray-300 bg-gray-50/70">
          {/* Seção 4: COLETA DE AMOSTRAS */}
          <div className="space-y-3">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider select-none">
              4. COLETA DE AMOSTRAS
            </div>

            <div className="space-y-2">
              {/* Coleta Direta com Fornecedores (CDF) */}
              <div className="border border-gray-300 bg-white p-3 space-y-2">
                <div className="font-bold text-xs uppercase text-gray-800 flex items-center justify-between">
                  <span>• COTAÇÃO DIRETA COM FORNECEDORES (CDF)</span>
                  <span className="text-[11px] text-gray-500 font-normal">
                    Formulário de coleta e solicitação formal de propostas comerciais
                  </span>
                </div>
                <p className="text-[11px] text-gray-600">
                  Envio e recebimento de propostas de preços de empresas privadas, com prazo de
                  validade da cotação e comprovação documental.
                </p>
              </div>

              {/* Contratações Similares Feitas pela Administração Pública */}
              <div className="border border-gray-300 bg-white p-3 space-y-2">
                <div className="font-bold text-xs uppercase text-gray-800 flex items-center justify-between">
                  <span>• CONTRATAÇÕES SIMILARES FEITAS PELA ADMINISTRAÇÃO PÚBLICA</span>
                  <span className="text-[11px] text-gray-500 font-normal">
                    PNCP, Compras.gov.br, BPS, BEC-SP, CMED
                  </span>
                </div>
                <p className="text-[11px] text-gray-600">
                  Pesquisa automática com inteligência artificial nas bases governamentais
                  homologadas, em estrita obediência ao art. 23, § 1º, II da Lei nº 14.133/2021.
                </p>
              </div>

              {/* Sítios de Comércio Eletrônico */}
              <div className="border border-gray-300 bg-white p-3 space-y-2">
                <div className="font-bold text-xs uppercase text-gray-800 flex items-center justify-between">
                  <span>• SÍTIOS DE COMÉRCIO ELETRÔNICO</span>
                  <span className="text-[11px] text-gray-500 font-normal">
                    Preços públicos de lojas e comércio amplo
                  </span>
                </div>
                <p className="text-[11px] text-gray-600">
                  Coleta com data, hora e endereço eletrônico registrado para garantir
                  rastreabilidade conforme normativas do setor público.
                </p>
              </div>
            </div>
          </div>

          {/* Seção 5: GERAR ORÇAMENTO ESTIMATIVO / JUSTIFICATIVA / CONCLUSÃO (ETAPA 12) */}
          <div className="space-y-3 pt-2">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider select-none flex items-center justify-between">
              <span>5. GERAR ORÇAMENTO ESTIMATIVO — CONCLUSÃO</span>
              {budget?.status === 'concluido' && (
                <span className="bg-emerald-500 text-white px-2 py-0.5 text-[10px] font-bold">
                  ORÇAMENTO CONCLUÍDO
                </span>
              )}
            </div>

            <div className="bg-white border border-gray-300 p-4 space-y-3 text-xs">
              <div>
                <label className="block text-gray-800 font-bold uppercase text-[11px] mb-1">
                  Observação / Justificativa geral do orçamento estimativo{' '}
                  <span className="text-gray-400 font-normal lowercase">(opcional)</span>:
                </label>
                <Textarea
                  rows={4}
                  value={justificativaConclusao}
                  onChange={(e) => setJustificativaConclusao(e.target.value)}
                  placeholder="Opcional. Registre as justificativas pertinentes à metodologia aplicada, critérios adotados no juízo crítico, prazos de vigência e conformidade com a Lei Federal nº 14.133/2021..."
                  className="text-xs rounded-none border-gray-400 bg-white"
                />
                <span className="text-[10px] text-gray-500 block mt-1">
                  Campo opcional. Se preenchida, esta observação integrará os relatórios oficiais,
                  dossiês e o mapa comparativo.
                </span>
              </div>

              <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200">
                <div className="text-gray-600 text-xs">
                  Status atual:{' '}
                  <strong className="uppercase text-gray-900">{budget?.status}</strong> • Total
                  cotado:{' '}
                  <strong className="text-emerald-700 font-mono">
                    R$ {valorTotalEstimado.toFixed(decimals)}
                  </strong>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => navigate(`/app/orcamentos/${id}/mapa`)}
                    className="h-9 px-4 text-xs font-bold uppercase rounded-none border-gray-400 bg-white hover:bg-gray-100"
                  >
                    <FileCheck className="h-4 w-4 mr-1.5 text-gray-700" />
                    VER MAPA COMPARATIVO
                  </Button>

                  <Button
                    type="button"
                    onClick={handleConcluirOrcamento}
                    disabled={concluindoOrcamento || itens.length === 0}
                    className="h-9 px-6 text-xs font-bold uppercase rounded-none bg-emerald-700 hover:bg-emerald-800 text-white shadow-none flex items-center gap-2"
                  >
                    <Check className="h-4 w-4 text-amber-300" />
                    <span>
                      {concluindoOrcamento ? 'CONCLUINDO...' : 'CONCLUIR ORÇAMENTO ESTIMATIVO'}
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL FIEL: CADASTRAR OU ALTERAR ITEM DO ORÇAMENTO (ETAPAS 04 E 07) */}
      <ModalItemOrcamento
        isOpen={isItemModalOpen}
        onClose={() => {
          setIsItemModalOpen(false)
          setItemParaEditar(null)
        }}
        itemParaEditar={itemParaEditar}
        orgaoPadraoNome={budget?.expand?.organization_id?.nome}
        municipioPadraoNome={budget?.expand?.organization_id?.municipio_ibge}
        onSalvar={handleSalvarItem}
      />

      {/* MODAL DE CONFIRMAÇÃO E FEEDBACK DA GERAÇÃO DO PDF */}
      {modalPdfConclusaoAberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white border-2 border-[#124268] shadow-2xl max-w-lg w-full p-6 space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center gap-3 border-b border-gray-200 pb-3">
              <div className="h-10 w-10 bg-emerald-100 border border-emerald-300 flex items-center justify-center flex-shrink-0 text-emerald-700">
                <Check className="h-6 w-6 stroke-[3]" />
              </div>
              <div>
                <h3 className="font-bold text-sm sm:text-base text-gray-900 uppercase">
                  Orçamento Concluído com Sucesso!
                </h3>
                <p className="text-xs text-gray-500">
                  O documento oficial em PDF foi gerado automaticamente e organizado por
                  órgão/cidade.
                </p>
              </div>
            </div>

            <div className="bg-slate-50 border border-slate-200 p-3.5 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500 uppercase font-bold text-[10px]">Orçamento:</span>
                <span className="font-mono font-bold text-gray-900">{budget?.internal_number}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 uppercase font-bold text-[10px]">Total Cotado:</span>
                <span className="font-mono font-bold text-emerald-700">
                  R$ {valorTotalEstimado.toFixed(decimals)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 uppercase font-bold text-[10px]">Organização:</span>
                <span className="font-bold text-gray-800">
                  {budget?.expand?.organization_id?.nome || 'Órgão Contratante'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 uppercase font-bold text-[10px]">Status:</span>
                <span className="font-bold text-emerald-700 uppercase">
                  Concluído & Registrado em Auditoria
                </span>
              </div>
            </div>

            {popupBloqueado ? (
              <div className="bg-amber-50 border border-amber-300 p-3 text-xs text-amber-900 space-y-1">
                <p className="font-bold">
                  ⚠️ O navegador bloqueou a abertura automática da janela de impressão.
                </p>
                <p className="text-[11px] text-amber-800">
                  O arquivo foi baixado automaticamente. Você também pode abri-lo pelo botão
                  &quot;Baixar Arquivo PDF&quot; abaixo ou permitir popups nas configurações do
                  navegador.
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-600 leading-relaxed">
                A janela de impressão do PDF foi aberta. Você também pode baixar ou imprimir
                novamente a qualquer momento através do Mapa Comparativo ou na página inicial.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-gray-200">
              <Button
                type="button"
                variant="outline"
                onClick={() => setModalPdfConclusaoAberto(false)}
                className="h-8 text-xs font-bold uppercase rounded-none border-gray-300"
              >
                Continuar
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleDownloadArquivoDireto}
                className="h-8 text-xs font-bold uppercase rounded-none border-gray-400 bg-white hover:bg-gray-100 flex items-center gap-1.5"
              >
                <Download className="h-3.5 w-3.5 text-emerald-600" />
                <span>Baixar Arquivo</span>
              </Button>
              <Button
                type="button"
                onClick={handleBaixarPdfManual}
                className="h-8 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white flex items-center gap-1.5"
              >
                <Download className="h-3.5 w-3.5 text-amber-300" />
                <span>Reabrir Impressão</span>
              </Button>
              <Button
                type="button"
                onClick={() => navigate(`/app/orcamentos/${id}/mapa`)}
                className="h-8 text-xs font-bold uppercase rounded-none bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold"
              >
                Ver Mapa Comparativo
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL FIEL: ANÁLISE CRÍTICA DOS DADOS COLETADOS (ETAPA 08) */}
      {itemParaAnaliseCritica && id && (
        <ModalAnaliseCritica
          item={itemParaAnaliseCritica}
          budgetId={id}
          isOpen={!!itemParaAnaliseCritica}
          onClose={() => setItemParaAnaliseCritica(null)}
          onAtualizar={async () => {
            await carregarDados(id)
          }}
        />
      )}

      {/* MODAL: IMPORTAR PLANILHA */}
      {id && (
        <ModalImportarPlanilha
          budgetId={id}
          isOpen={isImportModalOpen}
          onClose={() => setIsImportModalOpen(false)}
          onImportSuccess={handleImportarPlanilhaSucesso}
        />
      )}

      {/* POP-UP: PESQUISAR PREÇOS / COTAR COM IA (Lupa 🔍) */}
      {itemParaPesquisar && id && (
        <ModalPesquisarPrecos
          item={itemParaPesquisar}
          budgetId={id}
          isOpen={!!itemParaPesquisar}
          onClose={() => setItemParaPesquisar(null)}
          onSuccess={async () => {
            setItemParaPesquisar(null)
            await carregarDados(id)
          }}
        />
      )}
    </div>
  )
}
