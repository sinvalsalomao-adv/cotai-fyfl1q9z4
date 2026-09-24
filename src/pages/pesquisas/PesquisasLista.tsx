import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  Search,
  Plus,
  ArrowRight,
  Database,
  CheckCircle2,
  AlertTriangle,
  FileSpreadsheet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { listarPesquisas } from '@/services/apiService'
import type { Pesquisa } from '@/types'
import { formatarData } from '@/lib/calculoEngine'

export default function PesquisasLista() {
  const { organizacaoAtual } = useAuth()
  const navigate = useNavigate()
  const [pesquisas, setPesquisas] = useState<Pesquisa[]>([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')

  const carregar = async () => {
    if (!organizacaoAtual) return
    setLoading(true)
    try {
      const data = await listarPesquisas(organizacaoAtual.id)
      setPesquisas(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    carregar()
    const handleOrgChange = () => carregar()
    window.addEventListener('organizacao_changed', handleOrgChange)
    return () => window.removeEventListener('organizacao_changed', handleOrgChange)
  }, [organizacaoAtual?.id])

  const filtradas = pesquisas.filter(
    (p) =>
      p.numero.toLowerCase().includes(busca.toLowerCase()) ||
      p.expand?.demanda_item_id?.descricao.toLowerCase().includes(busca.toLowerCase()),
  )

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'concluida':
        return <Badge className="bg-emerald-100 text-emerald-800">Concluída</Badge>
      case 'aguardando_revisao':
        return <Badge className="bg-amber-100 text-amber-800">Aguardando Revisão</Badge>
      case 'em_andamento':
        return <Badge className="bg-blue-100 text-blue-800">Em Andamento</Badge>
      case 'parcial':
        return <Badge className="bg-amber-100 text-amber-800">Cobertura Parcial</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Pesquisas de Preços Praticados
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Jornada de 4 etapas: Etapa 3 — Coleta de evidências, equivalência técnica, exclusões e
            memória de cálculo
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => navigate('/app/cotacoes/COT-IA-2026/001')}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2 font-medium"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Cotação Inteligente com IA
          </Button>
          <Button
            onClick={() => navigate('/app/pesquisas/nova')}
            className="bg-[#1B4B8A] hover:bg-[#15406F] text-white"
          >
            <Plus className="h-4 w-4 mr-2" />
            Nova Pesquisa
          </Button>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Buscar por número ou descrição do item..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="pl-9 text-sm"
        />
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-gray-500">Carregando pesquisas...</div>
      ) : filtradas.length === 0 ? (
        <div className="p-12 text-center bg-white border border-gray-200 rounded-xl space-y-2">
          <Search className="h-10 w-10 text-gray-300 mx-auto" />
          <p className="text-sm font-semibold text-gray-800">
            Nenhuma pesquisa de preços encontrada
          </p>
          <p className="text-xs text-gray-500 max-w-sm mx-auto">
            Vincule uma pesquisa a um item de demanda confirmada para coletar e homologar preços.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm divide-y divide-gray-100 overflow-hidden">
          {filtradas.map((pesq) => (
            <div
              key={pesq.id}
              onClick={() => navigate(`/app/pesquisas/${pesq.id}`)}
              className="p-4 sm:p-5 hover:bg-gray-50/80 cursor-pointer transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 max-w-3xl">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm text-gray-900 font-mono">{pesq.numero}</span>
                  {getStatusBadge(pesq.status)}
                </div>
                <p className="text-xs text-gray-800 font-medium line-clamp-1">
                  Item Vinculado: {pesq.expand?.demanda_item_id?.descricao || 'Item da demanda'}
                </p>
                <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4">
                  <span>
                    Demanda:{' '}
                    <strong>
                      {pesq.expand?.demanda_item_id?.expand?.demanda_id?.numero ||
                        'PP-PREF-001/2026'}
                    </strong>
                  </span>
                  <span>Início da Coleta: {formatarData(pesq.inicio || pesq.created)}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 self-end md:self-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/app/pesquisas/${pesq.id}/calculo`)
                  }}
                  className="text-xs text-[#1B4B8A] border-gray-300 h-8"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 mr-1 text-[#1B4B8A]" />
                  Memória de Cálculo
                </Button>
                <Button variant="ghost" size="sm" className="text-xs text-[#1B4B8A] h-8">
                  Triagem de Candidatos
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
