import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { CalendarRange, ClipboardList, Plus, ArrowRight, Info, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { listarDemandas } from '@/services/apiService'
import type { Demanda } from '@/types'
import { formatarData } from '@/lib/calculoEngine'

export default function Planejamento() {
  const { organizacaoAtual } = useAuth()
  const navigate = useNavigate()
  const [demandas, setDemandas] = useState<Demanda[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!organizacaoAtual) return
    listarDemandas(organizacaoAtual.id).then((d) => {
      setDemandas(d)
      setLoading(false)
    })
  }, [organizacaoAtual?.id])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Planejamento das Contratações e DFDs
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Vinculação dos Documentos de Formalização de Demanda (DFD) ao ciclo da Lei 14.133
          </p>
        </div>
        <Button
          onClick={() => navigate('/app/demandas/nova')}
          className="bg-[#1B4B8A] hover:bg-[#15406F] text-white"
        >
          <Plus className="h-4 w-4 mr-2" />
          Novo DFD / Demanda
        </Button>
      </div>

      {/* Aviso Regulamentar sobre o PCA */}
      <Alert className="border-blue-300 bg-blue-50 text-blue-950 text-xs">
        <Info className="h-4 w-4 text-blue-700" />
        <AlertTitle className="text-xs font-semibold">
          Evolução Prevista: Plano de Contratações Anual (PCA)
        </AlertTitle>
        <AlertDescription className="text-xs text-blue-900 leading-relaxed mt-1">
          Nesta primeira entrega, a consolidação anual do PCA e o catálogo unificado de compras
          representam uma evolução futura planejada da plataforma. O módulo atual contempla o
          levantamento estruturado de DFDs individuais para cada processo licitatório.
        </AlertDescription>
      </Alert>

      {/* Lista de Demandas/DFDs Cadastrados */}
      <Card className="border-gray-200">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-semibold text-gray-900">
            Documentos de Formalização de Demanda Registrados ({demandas.length})
          </CardTitle>
          <CardDescription className="text-xs">
            Demandas aptas a compor o calendário de aquisições do exercício financeiro
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-xs text-gray-500">Carregando planejamento...</div>
          ) : demandas.length === 0 ? (
            <div className="p-8 text-center text-xs text-gray-500">
              Nenhuma demanda ou DFD registrado para este órgão.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {demandas.map((d) => (
                <div
                  key={d.id}
                  onClick={() => navigate(`/app/demandas/${d.id}`)}
                  className="p-4 hover:bg-gray-50 cursor-pointer flex items-center justify-between gap-4 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <strong className="font-mono text-gray-900">{d.numero}</strong>
                      <Badge variant="outline" className="text-[10px]">
                        DFD v{d.versao}.0
                      </Badge>
                      <Badge className="bg-emerald-100 text-emerald-800 text-[10px] capitalize">
                        {d.status}
                      </Badge>
                    </div>
                    <p className="text-gray-600 line-clamp-1">{d.objeto}</p>
                    <p className="text-[11px] text-gray-400">
                      Cadastrado em {formatarData(d.created)} • Origem:{' '}
                      <span className="capitalize">{d.origem_recursos.replace(/_/g, ' ')}</span>
                    </p>
                  </div>

                  <Button variant="ghost" size="sm" className="text-xs text-[#1B4B8A]">
                    Ver DFD
                    <ArrowRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
