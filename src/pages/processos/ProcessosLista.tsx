import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { GitBranch, Search, Clock, ArrowRight, ShieldCheck, AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { listarProcessos } from '@/services/apiService'
import type { Processo } from '@/types'
import { formatarData } from '@/lib/calculoEngine'

export default function ProcessosLista() {
  const { organizacaoAtual, user } = useAuth()
  const navigate = useNavigate()
  const [processos, setProcessos] = useState<Processo[]>([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')

  const carregar = async () => {
    if (!organizacaoAtual) return
    setLoading(true)
    try {
      const data = await listarProcessos(organizacaoAtual.id)
      setProcessos(data)
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

  const filtrados = processos.filter(
    (p) =>
      p.numero.toLowerCase().includes(busca.toLowerCase()) ||
      p.expand?.demanda_id?.objeto.toLowerCase().includes(busca.toLowerCase()),
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          Processos Administrativos de Contratação
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Acompanhamento integrado de responsáveis, pendências regulamentares, prazos e próximas
          ações
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Buscar por número do processo ou objeto..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="pl-9 text-sm"
        />
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-gray-500">Carregando processos...</div>
      ) : filtrados.length === 0 ? (
        <div className="p-12 text-center bg-white border border-gray-200 rounded-xl space-y-2">
          <GitBranch className="h-10 w-10 text-gray-300 mx-auto" />
          <p className="text-sm font-semibold text-gray-800">Nenhum processo em tramitação</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm divide-y divide-gray-100 overflow-hidden">
          {filtrados.map((proc) => (
            <div
              key={proc.id}
              onClick={() => navigate(`/app/processos/${proc.id}`)}
              className="p-4 sm:p-5 hover:bg-gray-50/80 cursor-pointer transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 max-w-3xl">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm text-gray-900 font-mono">{proc.numero}</span>
                  <Badge variant="outline" className="text-[10px] uppercase font-mono">
                    {proc.status}
                  </Badge>
                </div>
                <p className="text-xs text-gray-700 font-medium line-clamp-1">
                  Demanda: {proc.expand?.demanda_id?.objeto || 'Demanda Administrativa'}
                </p>
                <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4">
                  <span>
                    Responsável:{' '}
                    <strong>
                      {proc.expand?.responsavel_id?.name || user?.name || 'Comissão de Contratação'}
                    </strong>
                  </span>
                  <span>Prazo Limite: {formatarData(proc.prazo)}</span>
                </div>
              </div>

              <div className="sm:text-right space-y-1.5 flex-shrink-0 self-end md:self-center">
                <div className="inline-flex items-center text-xs px-2.5 py-1 rounded bg-amber-50 text-amber-900 border border-amber-200 font-medium">
                  {proc.pendencia_atual || 'Sem pendências'}
                </div>
                <p className="text-xs text-gray-600">
                  Próxima Ação:{' '}
                  <strong className="text-gray-900">{proc.proxima_acao || 'Aguardando'}</strong>
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
