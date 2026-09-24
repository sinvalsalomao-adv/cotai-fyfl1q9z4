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
              MÓDULO DE ORÇAMENTO E PESQUISA DE PREÇOS
            </span>
            <span className="text-white/60 text-xs hidden sm:inline">
              • Fluxo Operacional Rápido
            </span>
          </div>

          <Button
            type="button"
            onClick={() => navigate('/app/orcamentos/novo')}
            className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-none flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" />
            NOVO ORÇAMENTO
          </Button>
        </div>

        {/* Banner Orientativo Amarelo */}
        <div className="bg-[#fffbeb] border-l-4 border-amber-500 p-3.5 m-4 text-xs text-amber-950 flex items-start gap-2.5">
          <FileText className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Fluxo de Cotação Simplificado:</strong> 1. Novo Orçamento → 2. Metodologia e
            Padrões → 3. Cadastramento dos Itens (ou Importação de Planilha) → 4. Pesquisa de Preços
            com IA nas fontes oficiais (PNCP, Compras.gov, BPS, CMED) → 5. Revisão humana das
            amostras → 6. Cálculo determinístico e Mapa Comparativo.
          </div>
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
            Total de {orcamentosFiltrados.length} orçamento(s) cadastrado(s)
          </div>
        </div>

        {/* Tabela de Orçamentos */}
        <div className="p-4">
          <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider select-none">
            ORÇAMENTOS EM ANDAMENTO E CONCLUÍDOS
          </div>

          {loading ? (
            <div className="p-12 text-center text-xs text-gray-500">Carregando orçamentos...</div>
          ) : orcamentosFiltrados.length === 0 ? (
            <div className="p-16 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-3">
              <FileSpreadsheet className="h-10 w-10 mx-auto text-gray-400" />
              <p className="font-bold text-gray-800 text-sm">Nenhum orçamento encontrado.</p>
              <p className="text-gray-500">
                Inicie um novo orçamento para pesquisar e cotar itens com inteligência artificial.
              </p>
              <Button
                type="button"
                onClick={() => navigate('/app/orcamentos/novo')}
                className="h-9 px-5 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
              >
                + CRIAR PRIMEIRO ORÇAMENTO
              </Button>
            </div>
          ) : (
            <div className="border border-gray-300 overflow-x-auto shadow-2xs">
              <table className="w-full text-xs text-left border-collapse">
                <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300 select-none">
                  <tr>
                    <th className="p-2.5">NÚMERO INTERNO</th>
                    <th className="p-2.5">NOME DO ORÇAMENTO</th>
                    <th className="p-2.5">REFERÊNCIA EXTERNA</th>
                    <th className="p-2.5 text-center">ITENS</th>
                    <th className="p-2.5 text-center">COTADOS</th>
                    <th className="p-2.5 text-right">VALOR ESTIMADO</th>
                    <th className="p-2.5 text-center">STATUS</th>
                    <th className="p-2.5 text-center w-28">AÇÃO</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {orcamentosFiltrados.map((orc) => (
                    <tr
                      key={orc.id}
                      onClick={() => navigate(`/app/orcamentos/${orc.id}/itens`)}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                    >
                      <td className="p-2.5 font-bold font-mono text-[#124268]">
                        {orc.internal_number}
                      </td>
                      <td className="p-2.5">
                        <div className="font-bold text-gray-900">{orc.name}</div>
                        <div className="text-[11px] text-gray-500 line-clamp-1">{orc.object}</div>
                      </td>
                      <td className="p-2.5 font-mono text-gray-800">{orc.external_reference}</td>
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
      </div>
    </div>
  )
}
