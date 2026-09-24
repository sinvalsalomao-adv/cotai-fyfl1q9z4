import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FileText,
  Plus,
  Search,
  ExternalLink,
  ChevronRight,
  Calendar,
  Building2,
  CheckCircle2,
  Clock,
  SlidersHorizontal,
  FileSpreadsheet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/context/AuthContext'
import type { Budget } from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'

export default function OrcamentosLista() {
  const navigate = useNavigate()
  const { organizacaoAtual } = useAuth()

  const [orcamentos, setOrcamentos] = useState<Budget[]>([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')
  const [abaAtiva, setAbaAtiva] = useState<'pendentes' | 'concluidos' | 'todos'>('pendentes')

  useEffect(() => {
    carregarOrcamentos()
  }, [organizacaoAtual?.id])

  const carregarOrcamentos = async () => {
    setLoading(true)
    try {
      const list = await BudgetService.listarOrcamentos(organizacaoAtual?.id)
      setOrcamentos(list)
    } catch (err) {
      console.error('Erro ao listar orçamentos:', err)
    } finally {
      setLoading(false)
    }
  }

  const orcamentosFiltrados = orcamentos.filter((o) => {
    if (!busca.trim()) return true
    const term = busca.toLowerCase()
    return (
      o.name.toLowerCase().includes(term) ||
      o.internal_number.toLowerCase().includes(term) ||
      o.external_reference.toLowerCase().includes(term) ||
      o.object.toLowerCase().includes(term)
    )
  })

  return (
    <div className="space-y-6">
      {/* Topo do Módulo Cesta de Preços */}
      <div className="bg-white border border-[#b8c2cc] shadow-xs">
        {/* Barra Superior Azul-Escura #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex flex-wrap items-center justify-between gap-3 select-none">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 bg-amber-400 border border-[#0c314f]" />
            <span className="font-bold text-xs uppercase tracking-wider">
              PAINEL DE BORDO — ORÇAMENTO E PESQUISA DE PREÇOS
            </span>
            <span className="text-white/60 text-xs hidden sm:inline">
              • Sistema Cesta de Preços
            </span>
          </div>

          <Button
            type="button"
            onClick={() => navigate('/app/orcamentos/novo')}
            className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-none flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" />+ CRIAR UM NOVO ORÇAMENTO
          </Button>
        </div>

        {/* Saudação e Boas-Vindas Estilo Cesta de Preços (ETAPA 01) */}
        <div className="p-5 border-b border-gray-200 bg-linear-to-r from-gray-50 to-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl sm:text-2xl font-black text-gray-800 tracking-tight uppercase">
              OLÁ, {organizacaoAtual?.responsavel_legal || 'SERVIDOR RESPONSÁVEL'}!
            </h2>
            <p className="text-xs text-gray-500 font-medium">O que você deseja fazer hoje?</p>
          </div>
          <Button
            type="button"
            onClick={() => navigate('/app/orcamentos/novo')}
            className="h-9 px-5 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-xs flex items-center gap-2"
          >
            <Plus className="h-4 w-4 text-amber-400" />+ CRIAR UM NOVO ORÇAMENTO
          </Button>
        </div>

        {/* Abas e Separação: PENDENTES vs CONCLUÍDOS (ETAPA 01) */}
        <div className="bg-gray-100 px-4 pt-3 border-b border-gray-300 flex items-center gap-1 select-none">
          <button
            type="button"
            onClick={() => setAbaAtiva('pendentes')}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wider border-t-2 transition-all flex items-center gap-2 cursor-pointer ${
              abaAtiva === 'pendentes'
                ? 'bg-white text-[#124268] border-[#124268] shadow-xs'
                : 'text-gray-600 border-transparent hover:text-gray-900 hover:bg-gray-200/60'
            }`}
          >
            <Clock className="h-3.5 w-3.5 text-amber-600" />
            ÚLTIMOS ORÇAMENTOS PENDENTES (
            {orcamentos.filter((o) => o.status !== 'concluido').length})
          </button>
          <button
            type="button"
            onClick={() => setAbaAtiva('concluidos')}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wider border-t-2 transition-all flex items-center gap-2 cursor-pointer ${
              abaAtiva === 'concluidos'
                ? 'bg-white text-[#124268] border-[#124268] shadow-xs'
                : 'text-gray-600 border-transparent hover:text-gray-900 hover:bg-gray-200/60'
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            ÚLTIMOS ORÇAMENTOS CONCLUÍDOS (
            {orcamentos.filter((o) => o.status === 'concluido').length})
          </button>
          <button
            type="button"
            onClick={() => setAbaAtiva('todos')}
            className={`px-3 py-2 text-xs font-bold uppercase tracking-wider border-t-2 transition-all flex items-center gap-1.5 cursor-pointer ${
              abaAtiva === 'todos'
                ? 'bg-white text-[#124268] border-[#124268] shadow-xs'
                : 'text-gray-600 border-transparent hover:text-gray-900 hover:bg-gray-200/60'
            }`}
          >
            TODOS ({orcamentos.length})
          </button>
        </div>

        {/* Filtros e Barra de Busca */}
        <div className="p-4 bg-gray-50 border-b border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
            <Input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por nome, processo, número..."
              className="h-9 pl-9 text-xs rounded-none border-gray-300 bg-white"
            />
          </div>

          <div className="text-xs text-gray-500">
            Exibindo{' '}
            {
              orcamentosFiltrados.filter((o) =>
                abaAtiva === 'pendentes'
                  ? o.status !== 'concluido'
                  : abaAtiva === 'concluidos'
                    ? o.status === 'concluido'
                    : true,
              ).length
            }{' '}
            orçamento(s)
          </div>
        </div>

        {/* Tabela de Orçamentos (Separada por Aba conforme Etapa 01) */}
        <div className="p-4 space-y-4">
          {(() => {
            const listaExibida = orcamentosFiltrados.filter((o) =>
              abaAtiva === 'pendentes'
                ? o.status !== 'concluido'
                : abaAtiva === 'concluidos'
                  ? o.status === 'concluido'
                  : true,
            )

            const tituloSecao =
              abaAtiva === 'pendentes'
                ? 'ÚLTIMOS ORÇAMENTOS PENDENTES'
                : abaAtiva === 'concluidos'
                  ? 'ÚLTIMOS ORÇAMENTOS CONCLUÍDOS'
                  : 'TODOS OS ORÇAMENTOS'

            return (
              <div>
                <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
                  <span>{tituloSecao}</span>
                  <span className="text-[11px] font-normal lowercase">
                    {listaExibida.length} registro(s)
                  </span>
                </div>

                {loading ? (
                  <div className="p-12 text-center text-xs text-gray-500">
                    Carregando orçamentos...
                  </div>
                ) : listaExibida.length === 0 ? (
                  <div className="p-14 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-3">
                    <FileSpreadsheet className="h-10 w-10 mx-auto text-gray-400" />
                    <p className="font-bold text-gray-800 text-sm">
                      Nenhum orçamento {abaAtiva === 'concluidos' ? 'concluído' : 'pendente'}{' '}
                      encontrado.
                    </p>
                    <p className="text-gray-500">
                      Inicie um novo orçamento para pesquisar e cotar itens nas fontes públicas.
                    </p>
                    <Button
                      type="button"
                      onClick={() => navigate('/app/orcamentos/novo')}
                      className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
                    >
                      + CRIAR UM NOVO ORÇAMENTO
                    </Button>
                  </div>
                ) : (
                  <div className="border border-gray-300 overflow-x-auto shadow-2xs">
                    <table className="w-full text-xs text-left border-collapse">
                      <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300 select-none">
                        <tr>
                          <th className="p-2.5">NÚMERO</th>
                          <th className="p-2.5">DATA</th>
                          {abaAtiva === 'concluidos' && (
                            <th className="p-2.5 text-center">CONCLUSÃO</th>
                          )}
                          <th className="p-2.5">NOME / OBJETO</th>
                          <th className="p-2.5">REFERÊNCIA EXTERNA</th>
                          <th className="p-2.5 text-center">ITENS</th>
                          <th className="p-2.5 text-center">COTADOS</th>
                          <th className="p-2.5 text-right">VALOR ESTIMADO</th>
                          <th className="p-2.5 text-center">STATUS</th>
                          <th className="p-2.5 text-center w-28">AÇÃO</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {listaExibida.map((orc) => (
                          <tr
                            key={orc.id}
                            onClick={() => navigate(`/app/orcamentos/${orc.id}/itens`)}
                            className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                          >
                            <td className="p-2.5 font-bold font-mono text-[#124268] whitespace-nowrap">
                              {orc.internal_number}
                            </td>
                            <td className="p-2.5 text-gray-600 whitespace-nowrap font-mono text-[11px]">
                              {orc.created
                                ? new Date(orc.created).toLocaleDateString('pt-BR')
                                : '—'}
                            </td>
                            {abaAtiva === 'concluidos' && (
                              <td className="p-2.5 text-center text-emerald-800 font-bold font-mono text-[11px] whitespace-nowrap">
                                {orc.updated
                                  ? new Date(orc.updated).toLocaleDateString('pt-BR')
                                  : '—'}
                              </td>
                            )}
                            <td className="p-2.5">
                              <div className="font-bold text-gray-900">{orc.name}</div>
                              <div className="text-[11px] text-gray-500 line-clamp-1">
                                {orc.object}
                              </div>
                            </td>
                            <td className="p-2.5 font-mono text-gray-800 whitespace-nowrap">
                              {orc.external_reference}
                            </td>
                            <td className="p-2.5 text-center font-mono font-bold">
                              {orc.total_items || 0}
                            </td>
                            <td className="p-2.5 text-center font-mono text-emerald-700 font-bold">
                              {orc.quoted_items || 0}
                            </td>
                            <td className="p-2.5 text-right font-mono font-bold text-gray-900 whitespace-nowrap">
                              R${' '}
                              {(orc.estimated_total_value || 0).toLocaleString('pt-BR', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </td>
                            <td className="p-2.5 text-center whitespace-nowrap">
                              <Badge
                                variant="outline"
                                className={`rounded-none text-[10px] uppercase font-bold ${
                                  orc.status === 'concluido'
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                    : orc.status === 'em_pesquisa'
                                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                                      : 'bg-gray-100 text-gray-800 border-gray-300'
                                }`}
                              >
                                {orc.status}
                              </Badge>
                            </td>
                            <td className="p-2.5 text-center whitespace-nowrap">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs font-bold text-[#124268] hover:bg-blue-50"
                              >
                                Abrir Itens →
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}
