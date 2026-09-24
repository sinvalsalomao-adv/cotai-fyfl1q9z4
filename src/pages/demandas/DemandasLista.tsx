import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { ClipboardList, Plus, Search, CheckCircle2, Lock, ArrowRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { listarDemandas } from '@/services/apiService'
import type { Demanda } from '@/types'
import { formatarData } from '@/lib/calculoEngine'

export default function DemandasLista() {
  const { organizacaoAtual } = useAuth()
  const navigate = useNavigate()
  const [demandas, setDemandas] = useState<Demanda[]>([])
  const [loading, setLoading] = useState(true)
  const [filtro, setFiltro] = useState('')

  const carregar = async () => {
    if (!organizacaoAtual) return
    setLoading(true)
    try {
      const data = await listarDemandas(organizacaoAtual.id)
      setDemandas(data)
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

  const filtradas = demandas.filter(
    (d) =>
      d.numero.toLowerCase().includes(filtro.toLowerCase()) ||
      d.objeto.toLowerCase().includes(filtro.toLowerCase()),
  )

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'confirmada':
        return (
          <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300">
            Confirmada (Versão Congelada)
          </Badge>
        )
      case 'em_pesquisa':
        return <Badge className="bg-blue-100 text-blue-800 border-blue-300">Em Pesquisa</Badge>
      case 'rascunho':
        return <Badge className="bg-gray-100 text-gray-800 border-gray-300">Rascunho</Badge>
      default:
        return (
          <Badge variant="outline" className="capitalize">
            {status}
          </Badge>
        )
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Demandas Administrativas
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Formalização de necessidades, congelamento de versões e vinculação a pesquisas de preços
          </p>
        </div>
        <Button
          onClick={() => navigate('/app/demandas/nova')}
          className="bg-[#1B4B8A] hover:bg-[#15406F] text-white"
        >
          <Plus className="h-4 w-4 mr-2" />
          Nova Demanda
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Buscar por número ou objeto..."
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          className="pl-9 text-sm"
        />
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-gray-500">Carregando demandas...</div>
      ) : filtradas.length === 0 ? (
        <div className="p-12 text-center bg-white border border-gray-200 rounded-xl space-y-2">
          <ClipboardList className="h-10 w-10 text-gray-300 mx-auto" />
          <p className="text-sm font-semibold text-gray-800">Nenhuma demanda encontrada</p>
          <p className="text-xs text-gray-500 max-w-sm mx-auto">
            Inicie o cadastro formal da necessidade para avançar às pesquisas de preços e minutas de
            documentos.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm divide-y divide-gray-100 overflow-hidden">
          {filtradas.map((demanda) => (
            <div
              key={demanda.id}
              onClick={() => navigate(`/app/demandas/${demanda.id}`)}
              className="p-4 sm:p-5 hover:bg-gray-50/80 cursor-pointer transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 max-w-3xl">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm text-gray-900 font-mono">
                    {demanda.numero}
                  </span>
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    v{demanda.versao}.0
                  </Badge>
                  {getStatusBadge(demanda.status)}
                </div>
                <p className="text-xs text-gray-700 line-clamp-2 leading-relaxed">
                  {demanda.objeto}
                </p>
                <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4">
                  <span>
                    Origem:{' '}
                    <strong className="text-gray-700 capitalize">
                      {demanda.origem_recursos.replace(/_/g, ' ')}
                    </strong>
                  </span>
                  <span>Cadastrada em: {formatarData(demanda.created)}</span>
                </div>
              </div>

              <div className="flex items-center gap-3 self-end md:self-center">
                <Button variant="ghost" size="sm" className="text-xs text-[#1B4B8A]">
                  Abrir especificação
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
