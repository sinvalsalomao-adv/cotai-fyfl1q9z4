import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  ClipboardList,
  Search,
  FileText,
  CheckCircle,
  AlertTriangle,
  ArrowRight,
  TrendingUp,
  Clock,
  ShieldCheck,
  Plus,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  listarDemandas,
  listarPesquisas,
  listarProcessos,
  listarDocumentos,
} from '@/services/apiService'
import type { Demanda, Pesquisa, Processo, Documento } from '@/types'
import { formatarData } from '@/lib/calculoEngine'

export default function Dashboard() {
  const { user, organizacaoAtual } = useAuth()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [demandas, setDemandas] = useState<Demanda[]>([])
  const [pesquisas, setPesquisas] = useState<Pesquisa[]>([])
  const [processos, setProcessos] = useState<Processo[]>([])
  const [documentos, setDocumentos] = useState<Documento[]>([])

  const carregarDados = async () => {
    if (!organizacaoAtual) return
    setLoading(true)
    try {
      const [d, p, proc, doc] = await Promise.all([
        listarDemandas(organizacaoAtual.id),
        listarPesquisas(organizacaoAtual.id),
        listarProcessos(organizacaoAtual.id),
        listarDocumentos(organizacaoAtual.id),
      ])
      setDemandas(d)
      setPesquisas(p)
      setProcessos(proc)
      setDocumentos(doc)
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

  // Contadores
  const demandasAtivas = demandas.filter(
    (d) => d.status !== 'concluida' && d.status !== 'cancelada',
  ).length
  const pesquisasEmAndamento = pesquisas.filter(
    (p) =>
      p.status === 'em_andamento' || p.status === 'aguardando_revisao' || p.status === 'parcial',
  ).length
  const documentosPendentes = documentos.filter(
    (doc) => doc.status === 'rascunho' || doc.status === 'em_revisao',
  ).length
  const aprovacoesAguardando = documentos.filter((doc) => doc.status === 'em_revisao').length

  const dataAtualFormatada = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full',
  }).format(new Date())

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Painel Geral de Pesquisas e Contratações
          </h1>
          <p className="text-xs text-gray-500 capitalize mt-0.5">
            {dataAtualFormatada} • {organizacaoAtual?.nome || 'Órgão não selecionado'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => navigate('/app/demandas/nova')}
            size="sm"
            className="bg-[#1B4B8A] hover:bg-[#15406F] text-white"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Nova Demanda
          </Button>
          <Button
            onClick={() => navigate('/app/pesquisas/nova')}
            variant="outline"
            size="sm"
            className="border-gray-300"
          >
            <Search className="h-4 w-4 mr-1.5 text-gray-500" />
            Nova Pesquisa
          </Button>
        </div>
      </div>

      {/* Alertas Críticos */}
      <div className="space-y-3">
        <Alert className="border-amber-300 bg-amber-50/80 text-amber-900">
          <AlertTriangle className="h-4 w-4 text-amber-700" />
          <AlertTitle className="text-xs font-semibold text-amber-900">
            Triagem Crítica: Caso PP-PREF-001/2026 (Veículo Hatch 1.0)
          </AlertTitle>
          <AlertDescription className="text-xs text-amber-800">
            A demanda do hatch permanece com 1 item único. Itens incompatíveis do PDF (picapes,
            ambulância, retroescavadeira, trator, carroça) foram classificados para exclusão. O
            total orçado deve produzir 1 × preço de referência, corrigindo o erro histórico de R$
            3.096.703,17.
          </AlertDescription>
        </Alert>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-gray-200 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-xs font-medium text-gray-600">Demandas Ativas</CardTitle>
            <ClipboardList className="h-4 w-4 text-[#1B4B8A]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{demandasAtivas}</div>
            <p className="text-[11px] text-gray-500 flex items-center mt-1">
              <TrendingUp className="h-3 w-3 mr-1 text-emerald-600" />
              Versões estruturadas em tramitação
            </p>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-xs font-medium text-gray-600">
              Pesquisas em Andamento
            </CardTitle>
            <Search className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{pesquisasEmAndamento}</div>
            <p className="text-[11px] text-gray-500 flex items-center mt-1">
              <Clock className="h-3 w-3 mr-1 text-amber-600" />
              Aguardando revisão ou cálculo
            </p>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-xs font-medium text-gray-600">
              Documentos em Revisão
            </CardTitle>
            <FileText className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{documentosPendentes}</div>
            <p className="text-[11px] text-gray-500 flex items-center mt-1">
              <span>DFD, ETP, TR e Relatórios</span>
            </p>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-xs font-medium text-gray-600">
              Aprovações Aguardando
            </CardTitle>
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">{aprovacoesAguardando}</div>
            <p className="text-[11px] text-gray-500 flex items-center mt-1">
              <CheckCircle className="h-3 w-3 mr-1 text-emerald-600" />
              Requer justificativa da autoridade
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Grid Principal: Processos em Destaque & Próximas Ações */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Processos em Destaque (2 Colunas) */}
        <div className="lg:col-span-2 space-y-4">
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3 border-b border-gray-100 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold text-gray-900">
                  Processos em Destaque
                </CardTitle>
                <CardDescription className="text-xs text-gray-500">
                  Acompanhamento de prazos, pendências normativas e próximas ações
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate('/app/processos')}
                className="text-xs text-[#1B4B8A]"
              >
                Ver todos
                <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {processos.length === 0 ? (
                <div className="p-8 text-center text-xs text-gray-500">
                  Nenhum processo cadastrado para este órgão.
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {processos.slice(0, 5).map((proc) => (
                    <div
                      key={proc.id}
                      onClick={() => navigate(`/app/processos/${proc.id}`)}
                      className="p-4 hover:bg-gray-50/80 cursor-pointer transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-gray-900">{proc.numero}</span>
                          <Badge variant="outline" className="text-[10px] uppercase font-mono">
                            {proc.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-600 line-clamp-1">
                          Demanda: {proc.expand?.demanda_id?.objeto || 'Demanda vinculada'}
                        </p>
                        <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4">
                          <span>
                            Responsável:{' '}
                            <strong className="text-gray-700">
                              {proc.expand?.responsavel_id?.name ||
                                user?.name ||
                                'Comissão de Contratação'}
                            </strong>
                          </span>
                          <span>Prazo: {formatarData(proc.prazo)}</span>
                        </div>
                      </div>

                      <div className="sm:text-right space-y-1 flex-shrink-0">
                        <div className="inline-flex items-center text-[11px] px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                          {proc.pendencia_atual || 'Sem pendências'}
                        </div>
                        <p className="text-[11px] text-gray-600">
                          Próxima ação:{' '}
                          <span className="font-medium text-gray-800">
                            {proc.proxima_acao || 'Aguardando tramitação'}
                          </span>
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Próximas Ações Sugeridas (1 Coluna) */}
        <div className="space-y-4">
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3 border-b border-gray-100">
              <CardTitle className="text-sm font-semibold text-gray-900">Ações Sugeridas</CardTitle>
              <CardDescription className="text-xs text-gray-500">
                Tarefas pendentes de intervenção pelo servidor
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 space-y-2.5">
              <div
                onClick={() => {
                  const hatch = pesquisas.find(
                    (p) => p.numero.includes('HATCH') || p.numero.includes('001'),
                  )
                  if (hatch) navigate(`/app/pesquisas/${hatch.id}`)
                  else navigate('/app/pesquisas')
                }}
                className="p-3 rounded-lg border border-gray-200 hover:border-[#1B4B8A] bg-white hover:bg-blue-50/30 cursor-pointer transition-all space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-900">
                    Revisar Candidatos Hatch 1.0
                  </span>
                  <Badge className="bg-amber-100 text-amber-800 text-[10px]">Amostra</Badge>
                </div>
                <p className="text-[11px] text-gray-600">
                  Triar 10 referências: confirmar exclusão de picapes, tratores e ambulâncias do
                  PDF.
                </p>
              </div>

              <div
                onClick={() => {
                  const hatch = pesquisas.find(
                    (p) => p.numero.includes('HATCH') || p.numero.includes('001'),
                  )
                  if (hatch) navigate(`/app/pesquisas/${hatch.id}/calculo`)
                  else navigate('/app/pesquisas')
                }}
                className="p-3 rounded-lg border border-gray-200 hover:border-[#1B4B8A] bg-white hover:bg-blue-50/30 cursor-pointer transition-all space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-900">
                    Conferir Memória de Cálculo
                  </span>
                  <Badge className="bg-blue-100 text-blue-800 text-[10px]">Cálculo</Badge>
                </div>
                <p className="text-[11px] text-gray-600">
                  Aferir medida de tendência central (Mediana por padrão) com n=3 preços válidos e
                  demonstrar total 1 × preço.
                </p>
              </div>

              <div
                onClick={() => navigate('/app/documentos')}
                className="p-3 rounded-lg border border-gray-200 hover:border-[#1B4B8A] bg-white hover:bg-blue-50/30 cursor-pointer transition-all space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-900">
                    Exportar Relatório de Preços
                  </span>
                  <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">Dossiê</Badge>
                </div>
                <p className="text-[11px] text-gray-600">
                  Gerar versão PDF e DOCX do Relatório de Pesquisa com justificativas estruturadas.
                </p>
              </div>

              <div
                onClick={() => navigate('/app/organizacoes')}
                className="p-3 rounded-lg border border-gray-200 hover:border-[#1B4B8A] bg-white hover:bg-blue-50/30 cursor-pointer transition-all space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-900">
                    Perfil Normativo do Órgão
                  </span>
                  <Badge className="bg-gray-100 text-gray-800 text-[10px]">Normas</Badge>
                </div>
                <p className="text-[11px] text-gray-600">
                  Verificar exigências da Lei nº 14.133/2021 e bloqueio para obras/mão de obra.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
