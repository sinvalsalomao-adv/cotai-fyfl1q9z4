import React, { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  Calculator,
  Plus,
  Clock,
  CheckCircle2,
  Building2,
  FileSpreadsheet,
  ArrowRight,
  ChevronRight,
  Search,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { BudgetService, type Budget } from '@/services/budgetService'
import { BudgetPdfGeneratorService } from '@/lib/budgetPdfGeneratorService'
import { pb } from '@/lib/pocketbase/client'

export default function Dashboard() {
  const { user, organizacaoAtual } = useAuth()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [orcamentos, setOrcamentos] = useState<Budget[]>([])
  const [orcamentoDemoId, setOrcamentoDemoId] = useState<string | null>(null)

  // Gerar e baixar PDF de qualquer orçamento concluído
  const handleGerarPdfItem = async (e: React.MouseEvent, orc: Budget) => {
    e.stopPropagation()
    try {
      const [itens, meth] = await Promise.all([
        BudgetService.listarItens(orc.id),
        BudgetService.obterMetodologia(orc.id),
      ])

      const mapCot: Record<string, any[]> = {}
      const mapExp: Record<string, any[]> = {}
      for (const it of itens) {
        mapCot[it.id] = await BudgetService.listarPrecosSelecionadosDoItem(it.id)
        try {
          const exps = await pb.collection('budget_expurgated_prices').getList(1, 100, {
            filter: `budget_item_id = "${it.id}"`,
            expand: 'price_result_id',
          })
          mapExp[it.id] = exps.items
        } catch {
          mapExp[it.id] = []
        }
      }

      const res = BudgetPdfGeneratorService.gerarPdfOrcamento({
        budget: orc,
        methodology: meth,
        itens,
        cotacoesPorItem: mapCot,
        expurgadosPorItem: mapExp,
        orgaoNome:
          organizacaoAtual?.nome || orc.expand?.organization_id?.nome || 'Órgão Contratante',
        municipioUf: organizacaoAtual?.municipio_ibge || 'NÃO INFORMADO',
        cnpj: organizacaoAtual?.cnpj || 'NÃO INFORMADO',
        responsavelNome: user?.name || 'Servidor Designado',
      })

      if (res.bloqueadoPorPopup) {
        alert(
          'A janela de impressão foi bloqueada pelo navegador, mas o arquivo foi baixado automaticamente.',
        )
      }
    } catch (err) {
      console.error('Erro ao gerar PDF do orçamento:', err)
      alert('Falha ao abrir PDF do orçamento.')
    }
  }

  const carregarDados = async () => {
    if (!organizacaoAtual) return
    setLoading(true)
    try {
      const list = await BudgetService.listarOrcamentos(organizacaoAtual.id)
      setOrcamentos(list)

      // Identificar o orçamento demo COT-IA / ORC-2026/001 se existir
      const demo = list.find(
        (o) =>
          o.internal_number === 'ORC-2026/001' ||
          o.external_reference?.includes('123/2026') ||
          o.name?.toLowerCase().includes('medicamento'),
      )
      if (demo) {
        setOrcamentoDemoId(demo.id)
      } else if (list.length > 0) {
        setOrcamentoDemoId(list[0].id)
      }
    } catch (err) {
      console.error('Erro ao carregar dados do dashboard:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    carregarDados()

    const handleOrgChange = () => {
      carregarDados()
    }
    window.addEventListener('organizacao_changed', handleOrgChange)
    return () => window.removeEventListener('organizacao_changed', handleOrgChange)
  }, [organizacaoAtual?.id])

  // Cotações / Orçamentos pendentes (em andamento) vs realizadas (concluídas)
  const orcamentosPendentes = orcamentos.filter((o) => o.status !== 'concluido')
  const orcamentosRealizados = orcamentos.filter((o) => o.status === 'concluido')

  // Estatísticas rápidas
  const totalEstimadoGeral = orcamentos.reduce(
    (acc, curr) => acc + (curr.estimated_total_value || 0),
    0,
  )
  const totalItensGeral = orcamentos.reduce((acc, curr) => acc + (curr.total_items || 0), 0)

  const dataAtualFormatada = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full',
  }).format(new Date())

  return (
    <div className="space-y-6">
      {/* 1. Header institucional limpo com saudação e ação principal */}
      <div className="bg-white border border-[#b8c2cc] shadow-xs">
        {/* Barra de Seção Cesta de Preços */}
        <div className="bg-[#124268] text-white px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 select-none">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 bg-amber-400 border border-[#0c314f]" />
            <span className="font-bold text-xs uppercase tracking-wider">
              PAINEL INICIAL — SISTEMA DE PESQUISA DE PREÇOS E COTAÇÕES
            </span>
          </div>
          <span className="font-mono text-[11px] bg-white/15 px-2 py-0.5 text-amber-300">
            LEI 14.133/2021
          </span>
        </div>

        {/* Saudação limpa e objetiva */}
        <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-gray-900 tracking-tight uppercase">
              OLÁ, {organizacaoAtual?.responsavel_legal || user?.name || 'SERVIDOR RESPONSÁVEL'}!
            </h1>
            <p className="text-xs text-gray-500 mt-0.5 capitalize">
              {dataAtualFormatada} • {organizacaoAtual?.nome || 'Órgão não selecionado'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              onClick={() => navigate('/app/orcamentos/novo')}
              className="bg-[#124268] hover:bg-[#0c314f] text-white font-bold uppercase text-xs rounded-none h-9 px-4 shadow-xs flex items-center gap-2"
            >
              <Plus className="h-4 w-4 text-amber-400" />
              Novo Orçamento
            </Button>
            <Button
              onClick={() => navigate('/app/orcamentos')}
              variant="outline"
              className="border-gray-300 hover:bg-gray-100 text-gray-700 font-bold uppercase text-xs rounded-none h-9 px-4"
            >
              Ver Todos
            </Button>
          </div>
        </div>
      </div>

      {/* 2. Resumos de Status Essenciais (3 cards limpos) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Card Cotações Pendentes */}
        <div className="bg-white border-l-4 border-l-amber-500 border border-gray-200 p-4 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Cotações Pendentes
            </span>
            <div className="text-2xl font-black text-gray-900 mt-1">
              {orcamentosPendentes.length}
            </div>
            <p className="text-[11px] text-amber-700 font-medium mt-0.5">
              Em andamento ou rascunho
            </p>
          </div>
          <div className="h-10 w-10 bg-amber-50 border border-amber-200 rounded-none flex items-center justify-center text-amber-600">
            <Clock className="h-5 w-5" />
          </div>
        </div>

        {/* Card Cotações Realizadas */}
        <div className="bg-white border-l-4 border-l-emerald-600 border border-gray-200 p-4 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Cotações Realizadas
            </span>
            <div className="text-2xl font-black text-gray-900 mt-1">
              {orcamentosRealizados.length}
            </div>
            <p className="text-[11px] text-emerald-700 font-medium mt-0.5">
              Concluídas e homologadas
            </p>
          </div>
          <div className="h-10 w-10 bg-emerald-50 border border-emerald-200 rounded-none flex items-center justify-center text-emerald-600">
            <CheckCircle2 className="h-5 w-5" />
          </div>
        </div>

        {/* Card Total Estimado Acumulado */}
        <div className="bg-white border-l-4 border-l-[#124268] border border-gray-200 p-4 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Volume Estimado Total
            </span>
            <div className="text-2xl font-black text-[#124268] mt-1 font-mono">
              R${' '}
              {totalEstimadoGeral.toLocaleString('pt-BR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {totalItensGeral} item(ns) cadastrados no órgão
            </p>
          </div>
          <div className="h-10 w-10 bg-blue-50 border border-blue-200 rounded-none flex items-center justify-center text-[#124268]">
            <Calculator className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* 3. Grid Principal: Lado ESQUERDO (os 2 painéis pedidos) + Lado DIREITO (complementar discreto) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* COLUNA ESQUERDA: Cotações Pendentes & Cotações Realizadas empilhadas */}
        <div className="lg:col-span-8 space-y-6">
          {/* Painel 1: COTAÇÕES PENDENTES (Em andamento) */}
          <div className="bg-white border border-[#b8c2cc] shadow-xs">
            <div className="bg-[#828892] text-white px-3.5 py-2 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
              <span className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-300" />
                <span>COTAÇÕES PENDENTES (EM ANDAMENTO)</span>
              </span>
              <Badge className="bg-amber-400 text-slate-950 font-mono font-bold text-[11px] rounded-none hover:bg-amber-400">
                {orcamentosPendentes.length} pendente(s)
              </Badge>
            </div>

            <div className="p-0">
              {loading ? (
                <div className="p-8 text-center text-xs text-gray-500">
                  Carregando cotações pendentes...
                </div>
              ) : orcamentosPendentes.length === 0 ? (
                <div className="p-8 text-center bg-gray-50/50 text-gray-500 text-xs space-y-2">
                  <Clock className="h-8 w-8 mx-auto text-gray-400" />
                  <p className="font-bold text-gray-800 text-sm">
                    Nenhuma cotação pendente no momento
                  </p>
                  <p className="text-gray-500 text-[11px]">
                    Todos os seus orçamentos foram concluídos ou você ainda não iniciou novas
                    cotações.
                  </p>
                  <Button
                    onClick={() => navigate('/app/orcamentos/novo')}
                    size="sm"
                    className="bg-[#124268] hover:bg-[#0c314f] text-white text-xs font-bold uppercase rounded-none mt-2"
                  >
                    + Criar Novo Orçamento
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-gray-200">
                  {orcamentosPendentes.map((orc) => (
                    <div
                      key={orc.id}
                      onClick={() => navigate(`/app/orcamentos/${orc.id}/itens`)}
                      className="p-3.5 sm:p-4 hover:bg-blue-50/50 cursor-pointer transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold font-mono text-xs text-[#124268] group-hover:underline">
                            {orc.internal_number}
                          </span>
                          {orc.external_reference && (
                            <span className="text-[11px] font-mono bg-gray-100 text-gray-700 px-1.5 py-0.5 border border-gray-300">
                              Ref: {orc.external_reference}
                            </span>
                          )}
                          <Badge
                            variant="outline"
                            className={`rounded-none text-[10px] uppercase font-bold ${
                              orc.status === 'em_pesquisa'
                                ? 'bg-amber-50 text-amber-800 border-amber-300'
                                : 'bg-gray-100 text-gray-800 border-gray-300'
                            }`}
                          >
                            {orc.status === 'em_pesquisa' ? 'Em Cotação' : orc.status}
                          </Badge>
                        </div>

                        <h3 className="font-bold text-xs sm:text-sm text-gray-900 truncate">
                          {orc.name}
                        </h3>

                        {orc.object && (
                          <p className="text-xs text-gray-600 line-clamp-1">{orc.object}</p>
                        )}

                        <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                          <span>
                            Órgão:{' '}
                            <strong className="text-gray-700">
                              {organizacaoAtual?.nome || '—'}
                            </strong>
                          </span>
                          <span>
                            Itens cotados:{' '}
                            <strong className="text-[#124268]">
                              {orc.quoted_items || 0} / {orc.total_items || 0}
                            </strong>
                          </span>
                          <span>
                            Criado em:{' '}
                            {orc.created ? new Date(orc.created).toLocaleDateString('pt-BR') : '—'}
                          </span>
                        </div>
                      </div>

                      <div className="sm:text-right flex sm:flex-col items-center sm:items-end justify-between flex-shrink-0 gap-1 border-t sm:border-t-0 pt-2 sm:pt-0">
                        <div className="text-xs sm:text-sm font-mono font-bold text-gray-900">
                          R${' '}
                          {(orc.estimated_total_value || 0).toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </div>
                        <span className="inline-flex items-center text-xs font-bold text-[#124268] group-hover:text-[#0c314f]">
                          Continuar Cotação
                          <ArrowRight className="h-3.5 w-3.5 ml-1 transition-transform group-hover:translate-x-0.5" />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {orcamentosPendentes.length > 0 && (
              <div className="p-2.5 bg-gray-50 border-t border-gray-200 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/app/orcamentos')}
                  className="text-xs font-bold text-[#124268] hover:bg-blue-50 h-7"
                >
                  Ver todos os orçamentos no módulo →
                </Button>
              </div>
            )}
          </div>

          {/* Painel 2: COTAÇÕES REALIZADAS (Terminadas / Concluídas) */}
          <div className="bg-white border border-[#b8c2cc] shadow-xs">
            <div className="bg-[#124268] text-white px-3.5 py-2 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span>COTAÇÕES REALIZADAS (CONCLUÍDAS)</span>
              </span>
              <Badge className="bg-emerald-500 text-white font-mono font-bold text-[11px] rounded-none hover:bg-emerald-500">
                {orcamentosRealizados.length} realizada(s)
              </Badge>
            </div>

            <div className="p-0">
              {loading ? (
                <div className="p-8 text-center text-xs text-gray-500">
                  Carregando cotações realizadas...
                </div>
              ) : orcamentosRealizados.length === 0 ? (
                <div className="p-8 text-center bg-gray-50/50 text-gray-500 text-xs space-y-2">
                  <CheckCircle2 className="h-8 w-8 mx-auto text-gray-400" />
                  <p className="font-bold text-gray-800 text-sm">Nenhuma cotação realizada ainda</p>
                  <p className="text-gray-500 text-[11px]">
                    Ao concluir uma cotação estimativa com juízo crítico e mapa, ela aparecerá aqui
                    com seu valor homologado.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-200">
                  {orcamentosRealizados.map((orc) => (
                    <div
                      key={orc.id}
                      onClick={() => navigate(`/app/orcamentos/${orc.id}/itens`)}
                      className="p-3.5 sm:p-4 hover:bg-emerald-50/40 cursor-pointer transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold font-mono text-xs text-[#124268] group-hover:underline">
                            {orc.internal_number}
                          </span>
                          {orc.external_reference && (
                            <span className="text-[11px] font-mono bg-gray-100 text-gray-700 px-1.5 py-0.5 border border-gray-300">
                              Ref: {orc.external_reference}
                            </span>
                          )}
                          <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px] uppercase font-bold rounded-none hover:bg-emerald-100">
                            Concluído
                          </Badge>
                        </div>

                        <h3 className="font-bold text-xs sm:text-sm text-gray-900 truncate">
                          {orc.name}
                        </h3>

                        {orc.object && (
                          <p className="text-xs text-gray-600 line-clamp-1">{orc.object}</p>
                        )}

                        <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                          <span>
                            Órgão:{' '}
                            <strong className="text-gray-700">
                              {organizacaoAtual?.nome || '—'}
                            </strong>
                          </span>
                          <span>
                            Itens:{' '}
                            <strong className="text-emerald-800">
                              {orc.quoted_items || orc.total_items || 0} cotados
                            </strong>
                          </span>
                          <span>
                            Concluído em:{' '}
                            {orc.updated ? new Date(orc.updated).toLocaleDateString('pt-BR') : '—'}
                          </span>
                        </div>
                      </div>

                      <div className="sm:text-right flex sm:flex-col items-center sm:items-end justify-between flex-shrink-0 gap-1 border-t sm:border-t-0 pt-2 sm:pt-0">
                        <div className="text-xs sm:text-sm font-mono font-bold text-emerald-800">
                          R${' '}
                          {(orc.estimated_total_value || 0).toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </div>
                        <div className="flex items-center gap-1.5 pt-1">
                          <button
                            type="button"
                            onClick={(e) => handleGerarPdfItem(e, orc)}
                            title="Baixar/Visualizar PDF por Órgão/Cidade"
                            className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-800 bg-amber-300 hover:bg-amber-400 px-2 py-0.5 border border-amber-500 shadow-2xs"
                          >
                            <FileText className="h-3 w-3" />
                            <span>PDF</span>
                          </button>
                          <span className="inline-flex items-center text-xs font-bold text-[#124268] group-hover:text-[#0c314f]">
                            Ver Relatório
                            <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {orcamentosRealizados.length > 0 && (
              <div className="p-2.5 bg-gray-50 border-t border-gray-200 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/app/orcamentos')}
                  className="text-xs font-bold text-[#124268] hover:bg-blue-50 h-7"
                >
                  Consultar histórico completo de orçamentos →
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* COLUNA DIREITA: Ações Rápidas Essenciais & Atalho Discreto para a Demo */}
        <div className="lg:col-span-4 space-y-5">
          {/* Acesso rápido ao fluxo principal */}
          <div className="bg-white border border-[#b8c2cc] shadow-xs">
            <div className="bg-[#124268] text-white px-3.5 py-2 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
              <span>AÇÕES RÁPIDAS</span>
              <span className="text-[10px] text-amber-300 font-mono">ATALHOS</span>
            </div>
            <div className="p-3.5 space-y-2.5">
              <Button
                onClick={() => navigate('/app/orcamentos/novo')}
                className="w-full justify-start bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold uppercase text-xs rounded-none shadow-xs h-10 px-3"
              >
                <Plus className="h-4 w-4 mr-2" />
                Criar Novo Orçamento
              </Button>

              <Button
                onClick={() => navigate('/app/orcamentos')}
                variant="outline"
                className="w-full justify-start border-gray-300 hover:bg-gray-50 text-gray-800 font-bold uppercase text-xs rounded-none h-10 px-3"
              >
                <FileSpreadsheet className="h-4 w-4 mr-2 text-[#124268]" />
                Listar Todos os Orçamentos
              </Button>

              <Button
                onClick={() => navigate('/app/demandas/nova')}
                variant="outline"
                className="w-full justify-start border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-xs rounded-none h-9 px-3"
              >
                <Plus className="h-3.5 w-3.5 mr-2 text-gray-500" />
                Nova Demanda de Contratação
              </Button>

              <Button
                onClick={() => navigate('/app/pesquisas/nova')}
                variant="outline"
                className="w-full justify-start border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-xs rounded-none h-9 px-3"
              >
                <Search className="h-3.5 w-3.5 mr-2 text-gray-500" />
                Pesquisar Preços nas Fontes Oficiais
              </Button>
            </div>
          </div>

          {/* Atalho Discreto para a Demonstração Homologada (conforme pedido do usuário) */}
          <div className="bg-white border border-gray-200 p-3.5 shadow-xs space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 px-2 py-0.5 border border-amber-200">
                Caso Homologado
              </span>
              <span className="text-[11px] font-mono text-gray-500">ORC-2026/001</span>
            </div>
            <div>
              <h4 className="text-xs font-bold text-gray-900 uppercase">
                Prorrogação de Medicamentos
              </h4>
              <p className="text-[11px] text-gray-500 leading-snug mt-0.5">
                Exemplo completo com cotação por item, juízo crítico (70% - 130% da mediana) e mapa
                comparativo.
              </p>
            </div>
            <Link
              to={orcamentoDemoId ? `/app/orcamentos/${orcamentoDemoId}/itens` : '/app/orcamentos'}
              className="inline-flex items-center justify-between w-full text-xs font-bold text-[#124268] hover:text-[#0c314f] bg-blue-50 hover:bg-blue-100/70 p-2 border border-blue-200 transition-colors"
            >
              <span>Abrir Cotação Demo</span>
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          {/* Card com regras de conformidade e isolamento do órgão */}
          <div className="bg-gray-50 border border-gray-200 p-3.5 text-xs text-gray-600 space-y-2">
            <div className="flex items-center gap-1.5 text-gray-800 font-bold uppercase text-[11px]">
              <Building2 className="h-3.5 w-3.5 text-[#124268]" />
              <span>Conformidade Legal & Fontes</span>
            </div>
            <p className="text-[11px] text-gray-500 leading-normal">
              Pesquisas integradas às fontes oficiais federais e estaduais (PNCP, Compras.gov.br,
              BPS, CMED, BEC-SP) conforme Art. 23 da Lei nº 14.133/2021.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
