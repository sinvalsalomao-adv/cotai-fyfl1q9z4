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
import { Badge } from '@/components/ui/badge'
import type { Budget, BudgetItem, BudgetMethodology } from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'
import { ModalImportarPlanilha } from '@/components/ModalImportarPlanilha'
import { ModalPesquisarPrecos } from '@/components/ModalPesquisarPrecos'

export default function OrcamentoItens() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [budget, setBudget] = useState<Budget | null>(null)
  const [methodology, setMethodology] = useState<BudgetMethodology | null>(null)
  const [itens, setItens] = useState<BudgetItem[]>([])
  const [loading, setLoading] = useState(true)

  // Modais
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [isNovoItemModalOpen, setIsNovoItemModalOpen] = useState(false)
  const [itemParaEditar, setItemParaEditar] = useState<BudgetItem | null>(null)
  const [itemParaPesquisar, setItemParaPesquisar] = useState<BudgetItem | null>(null)

  // Filtro de Curva ABC
  const [filtroCurvaAbc, setFiltroCurvaAbc] = useState<'TODOS' | 'A' | 'B' | 'C'>('TODOS')

  // Progresso do "COTAR TODOS COM IA"
  const [processandoLote, setProcessandoLote] = useState(false)
  const [statusProgressoLote, setStatusProgressoLote] = useState<string>('')

  // Formulário do Modal "Novo Item / Editar Item"
  const [formDescricao, setFormDescricao] = useState('')
  const [formUnidade, setFormUnidade] = useState('')
  const [formQuantidade, setFormQuantidade] = useState<number>(1)
  const [formMarca, setFormMarca] = useState('')
  const [formTipo, setFormTipo] = useState<'PRODUTO' | 'SERVICO'>('PRODUTO')

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

  const handleSalvarItemManual = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id || !formDescricao.trim() || !formUnidade.trim() || formQuantidade <= 0) {
      alert('Preencha os campos obrigatórios (Descrição, Unidade e Quantidade).')
      return
    }

    try {
      if (itemParaEditar) {
        await BudgetService.atualizarItem(
          itemParaEditar.id,
          {
            description: formDescricao,
            unit: formUnidade,
            quantity: formQuantidade,
            brand: formMarca,
            type: formTipo,
          },
          id,
        )
      } else {
        await BudgetService.adicionarItem({
          budget_id: id,
          description: formDescricao,
          unit: formUnidade,
          quantity: formQuantidade,
          brand: formMarca,
          type: formTipo,
        })
      }

      setIsNovoItemModalOpen(false)
      setItemParaEditar(null)
      limparFormItem()
      await carregarDados(id)
    } catch (err: any) {
      alert('Erro ao salvar item: ' + (err.message || 'Verifique os dados.'))
    }
  }

  const abrirEdicaoItem = (item: BudgetItem) => {
    setItemParaEditar(item)
    setFormDescricao(item.description)
    setFormUnidade(item.unit)
    setFormQuantidade(item.quantity)
    setFormMarca(item.brand || '')
    setFormTipo(item.type)
    setIsNovoItemModalOpen(true)
  }

  const limparFormItem = () => {
    setFormDescricao('')
    setFormUnidade('')
    setFormQuantidade(1)
    setFormMarca('')
    setFormTipo('PRODUTO')
    setItemParaEditar(null)
  }

  const handleExcluirItem = async (item: BudgetItem) => {
    if (!id) return
    if (!confirm(`Deseja realmente remover o Item ${item.sequence} — "${item.description}"?`)) {
      return
    }

    try {
      await BudgetService.excluirItem(item.id, id)
      await carregarDados(id)
    } catch (err) {
      alert('Erro ao excluir item.')
    }
  }

  const handleImportarPlanilhaSucesso = async (
    novosItens: Array<{
      description: string
      unit: string
      quantity: number
      brand?: string
      type: 'PRODUTO' | 'SERVICO'
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
          // Confirmar todas as cotações encontradas e rodar o cálculo
          const todosIds = resultados.map((r) => r.id)
          await BudgetService.confirmarCotacoesECalcular(itemAtual, todosIds, id)
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

        {/* Barra de Ações: IMPORTAR PLANILHA / ADICIONAR ITEM / COTAR TODOS COM IA */}
        <div className="p-4 bg-white border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => {
                limparFormItem()
                setIsNovoItemModalOpen(true)
              }}
              className="h-9 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none"
            >
              <Plus className="h-3.5 w-3.5 mr-1 text-amber-400" />+ ADICIONAR ITEM
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={() => setIsImportModalOpen(true)}
              className="h-9 px-4 text-xs font-bold uppercase rounded-none border-gray-400 text-gray-800 bg-white hover:bg-gray-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 mr-1 text-emerald-600" />
              IMPORTAR PLANILHA (.XLSX / .CSV)
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

        {/* TELA PRINCIPAL DOS ITENS — Tabela Rigorosa */}
        <div className="p-4 space-y-3">
          <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
            <span>ITENS DO ORÇAMENTO</span>
            <span className="text-[11px] font-normal lowercase">
              {itensExibidos.length} de {totalItens} item(ns) listado(s)
            </span>
          </div>

          {itens.length === 0 ? (
            <div className="p-16 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-3">
              <FileSpreadsheet className="h-10 w-10 mx-auto text-gray-400" />
              <p className="font-bold text-gray-800 text-sm">
                Nenhum item cadastrado neste orçamento.
              </p>
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
                  onClick={() => {
                    limparFormItem()
                    setIsNovoItemModalOpen(true)
                  }}
                  className="h-9 px-4 text-xs font-bold uppercase rounded-none border-gray-400 bg-white"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  ADICIONAR MANUAL
                </Button>
              </div>
            </div>
          ) : (
            <div className="border border-gray-300 overflow-x-auto shadow-2xs">
              <table className="w-full text-xs text-left border-collapse">
                <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300 select-none">
                  <tr>
                    <th className="p-2.5 text-center w-24">LOTE/ITEM</th>
                    <th className="p-2.5">DESCRIÇÃO</th>
                    <th className="p-2.5 text-center">MEDIDA DE FORNECIMENTO</th>
                    <th className="p-2.5 text-right">QUANTIDADE</th>
                    <th className="p-2.5 text-right">PREÇO UNITÁRIO</th>
                    <th className="p-2.5 text-right">PREÇO TOTAL</th>
                    <th className="p-2.5 text-center">CURVA ABC</th>
                    <th className="p-2.5 text-center">COTAÇÕES</th>
                    <th className="p-2.5 text-center w-28">AÇÕES</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {itensExibidos.map((item) => {
                    const isCotado = item.status === 'cotado'
                    const temPreco = item.unit_price && item.unit_price > 0
                    const qtdCot = item.quotation_count || 0

                    return (
                      <tr
                        key={item.id}
                        className={`hover:bg-blue-50/40 transition-colors ${
                          isCotado ? 'bg-emerald-50/10' : ''
                        }`}
                      >
                        {/* LOTE/ITEM: numeração sequencial automática 01, 02, 03... */}
                        <td className="p-2.5 text-center font-bold font-mono text-gray-900 bg-gray-50/80">
                          {String(item.sequence).padStart(2, '0')}
                        </td>

                        {/* DESCRIÇÃO: exatamente a cadastrada */}
                        <td className="p-2.5">
                          <div className="font-bold text-gray-900">{item.description}</div>
                          <div className="text-[11px] text-gray-500 flex items-center gap-2">
                            <span>
                              Tipo: <strong>{item.type}</strong>
                            </span>
                            {item.brand && (
                              <span>
                                • Marca: <strong>{item.brand}</strong>
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

                        {/* PREÇO UNITÁRIO: R$ 0,00 antes da pesquisa; depois o calculado */}
                        <td className="p-2.5 text-right font-mono font-bold whitespace-nowrap">
                          {temPreco ? (
                            <span className="text-[#124268]">
                              R${' '}
                              {item.unit_price!.toLocaleString('pt-BR', {
                                minimumFractionDigits: decimals,
                                maximumFractionDigits: decimals,
                              })}
                            </span>
                          ) : (
                            <span className="text-gray-400">R$ 0,00</span>
                          )}
                        </td>

                        {/* PREÇO TOTAL: Quantidade × Preço Unitário */}
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

                        {/* CURVA ABC: A / B / C / "—" */}
                        <td className="p-2.5 text-center">
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
                              Classe {item.abc_class}
                            </span>
                          ) : (
                            <span className="text-gray-400 font-mono">—</span>
                          )}
                        </td>

                        {/* COTAÇÕES: indicador visual (🔴 0, 🟡 2, 🟢 3+) */}
                        <td className="p-2.5 text-center whitespace-nowrap">
                          {qtdCot === 0 ? (
                            <span className="inline-flex items-center gap-1 font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 text-[11px]">
                              🔴 0 cotações
                            </span>
                          ) : qtdCot < 3 ? (
                            <span className="inline-flex items-center gap-1 font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px]">
                              🟡 {qtdCot} cotação(ões)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px]">
                              🟢 {qtdCot} cotações
                            </span>
                          )}
                        </td>

                        {/* AÇÕES: EDITAR e LUPA 🔍 (principal botão) */}
                        <td className="p-2.5 text-center whitespace-nowrap space-x-1.5">
                          {/* LUPA 🔍: Abre o pop-up Pesquisar Preços */}
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => setItemParaPesquisar(item)}
                            className="h-8 w-8 p-0 rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-2xs inline-flex items-center justify-center"
                            title="Pesquisar Preços / Cotar com IA"
                          >
                            <Search className="h-4 w-4" />
                          </Button>

                          {/* EDITAR: Pop-up Editar Item */}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => abrirEdicaoItem(item)}
                            className="h-8 w-8 p-0 rounded-none border-gray-400 text-gray-700 hover:bg-gray-100 inline-flex items-center justify-center"
                            title="Editar Item"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </Button>

                          {/* EXCLUIR */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleExcluirItem(item)}
                            className="h-8 w-8 p-0 text-gray-400 hover:text-red-600 inline-flex items-center justify-center"
                            title="Excluir Item"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* MODAL: NOVO ITEM OU EDITAR ITEM */}
      {isNovoItemModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-lg rounded-none overflow-hidden">
            <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none">
              <span className="font-bold text-xs uppercase tracking-wider">
                {itemParaEditar ? 'EDITAR ITEM' : 'NOVO ITEM'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setIsNovoItemModalOpen(false)
                  limparFormItem()
                }}
                className="text-white/80 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSalvarItemManual} className="p-4 space-y-3.5 text-xs">
              <div>
                <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                  DESCRIÇÃO DO ITEM *
                </label>
                <Input
                  value={formDescricao}
                  onChange={(e) => setFormDescricao(e.target.value)}
                  placeholder="Ex: DIPIRONA SÓDICA 500MG COMPRIMIDO"
                  className="h-9 text-xs rounded-none border-gray-400 uppercase"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    UNIDADE DE MEDIDA *
                  </label>
                  <Input
                    value={formUnidade}
                    onChange={(e) => setFormUnidade(e.target.value)}
                    placeholder="Ex: CX, COMP, UN, SERV"
                    className="h-9 text-xs rounded-none border-gray-400 uppercase"
                    required
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    QUANTIDADE *
                  </label>
                  <Input
                    type="number"
                    min="1"
                    value={formQuantidade || ''}
                    onChange={(e) => setFormQuantidade(parseFloat(e.target.value) || 1)}
                    className="h-9 text-xs rounded-none border-gray-400"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    MARCA (OPCIONAL)
                  </label>
                  <Input
                    value={formMarca}
                    onChange={(e) => setFormMarca(e.target.value)}
                    placeholder="Ex: Genérico / Prati"
                    className="h-9 text-xs rounded-none border-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    TIPO *
                  </label>
                  <select
                    value={formTipo}
                    onChange={(e) => setFormTipo(e.target.value as any)}
                    className="h-9 w-full text-xs rounded-none border border-gray-400 bg-white px-2 font-medium text-gray-800"
                  >
                    <option value="PRODUTO">PRODUTO</option>
                    <option value="SERVICO">SERVIÇO</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-gray-300 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setIsNovoItemModalOpen(false)
                    limparFormItem()
                  }}
                  className="h-8 px-4 text-xs font-bold uppercase rounded-none border-gray-400 bg-white"
                >
                  CANCELAR
                </Button>
                <Button
                  type="submit"
                  className="h-8 px-5 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
                >
                  {itemParaEditar ? 'SALVAR ALTERAÇÃO' : 'ADICIONAR ITEM'}
                </Button>
              </div>
            </form>
          </div>
        </div>
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
