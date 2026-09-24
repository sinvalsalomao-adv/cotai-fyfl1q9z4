import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  GitBranch,
  ArrowLeft,
  ClipboardList,
  Search,
  FileText,
  Clock,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { obterProcesso, listarPesquisas, listarDocumentos } from '@/services/apiService'
import type { Processo, Pesquisa, Documento } from '@/types'
import { formatarData } from '@/lib/calculoEngine'

export default function ProcessoDetalhe() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [processo, setProcesso] = useState<Processo | null>(null)
  const [pesquisas, setPesquisas] = useState<Pesquisa[]>([])
  const [documentos, setDocumentos] = useState<Documento[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    const carregar = async () => {
      setLoading(true)
      try {
        const proc = await obterProcesso(id)
        setProcesso(proc)
        const [pList, docList] = await Promise.all([
          listarPesquisas(proc.organizacao_id),
          listarDocumentos(proc.organizacao_id),
        ])
        setPesquisas(pList)
        setDocumentos(docList.filter((d) => d.processo_id === proc.id))
      } finally {
        setLoading(false)
      }
    }
    carregar()
  }, [id])

  if (loading || !processo) {
    return <div className="p-8 text-center text-xs text-gray-500">Carregando processo...</div>
  }

  const demanda = processo.expand?.demanda_id

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/app/processos')}
          className="text-gray-600"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Voltar
        </Button>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-gray-900 font-mono">
              {processo.numero}
            </h1>
            <Badge variant="outline" className="text-xs uppercase font-mono">
              {processo.status}
            </Badge>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Prazo: {formatarData(processo.prazo)} • Responsável:{' '}
            <strong>{processo.expand?.responsavel_id?.name || 'Comissão Especial'}</strong>
          </p>
        </div>
      </div>

      {/* Card de Tramitação Atual */}
      <Card className="border-amber-200 bg-amber-50/40">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-900">
              Pendência Regulamentar Atual
            </span>
            <p className="text-sm font-semibold text-gray-900">
              {processo.pendencia_atual || 'Sem pendências cadastradas'}
            </p>
          </div>
          <div className="sm:text-right">
            <span className="text-[11px] text-gray-500 block">Próxima Ação Requerida:</span>
            <strong className="text-xs text-[#1B4B8A]">
              {processo.proxima_acao || 'Aguardando tramitação'}
            </strong>
          </div>
        </CardContent>
      </Card>

      {/* Visão Agregada: Demanda, Pesquisas e Documentos */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Demanda */}
        <Card className="border-gray-200 hover:border-gray-300 transition-all">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <ClipboardList className="h-5 w-5 text-[#1B4B8A]" />
              <Badge variant="outline" className="text-[10px]">
                Demanda
              </Badge>
            </div>
            <CardTitle className="text-sm font-semibold mt-2">
              {demanda?.numero || 'Demanda Vinculada'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs text-gray-600">
            <p className="line-clamp-2">{demanda?.objeto}</p>
            {demanda && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/app/demandas/${demanda.id}`)}
                className="w-full text-xs"
              >
                Ver Demanda Congelada
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Pesquisas Vinculadas */}
        <Card className="border-gray-200 hover:border-gray-300 transition-all">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <Search className="h-5 w-5 text-amber-600" />
              <Badge variant="outline" className="text-[10px]">
                Pesquisas ({pesquisas.length})
              </Badge>
            </div>
            <CardTitle className="text-sm font-semibold mt-2">Pesquisas de Preços</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs text-gray-600">
            <p>Fontes oficiais conectadas, triagem de candidatos e memória de cálculo.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/app/pesquisas')}
              className="w-full text-xs"
            >
              Ver Pesquisas
              <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </CardContent>
        </Card>

        {/* Documentos Estruturados */}
        <Card className="border-gray-200 hover:border-gray-300 transition-all">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <FileText className="h-5 w-5 text-emerald-600" />
              <Badge variant="outline" className="text-[10px]">
                Dossiês ({documentos.length})
              </Badge>
            </div>
            <CardTitle className="text-sm font-semibold mt-2">Minutas e Dossiês</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs text-gray-600">
            <p>Relatório de Pesquisa de Preços, DFD, ETP e Termo de Referência.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/app/documentos')}
              className="w-full text-xs"
            >
              Ver Documentos
              <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
