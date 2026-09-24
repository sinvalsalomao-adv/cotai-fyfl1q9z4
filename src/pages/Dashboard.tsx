import React, { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
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
  Calculator,
  Sparkles,
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
  const [orcamentoDemoId, setOrcamentoDemoId] = useState<string | null>(null)

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

      // Identificar o orçamento demo COT-IA / ORC-2026/001 se existir
      try {
        const { BudgetService } = await import('@/services/budgetService')
        const orcs = await BudgetService.listarOrcamentos(organizacaoAtual.id)
        const demo = orcs.find(
          (o) =>
            o.internal_number === 'ORC-2026/001' ||
            o.external_reference?.includes('123/2026') ||
            o.name?.toLowerCase().includes('medicamento'),
        )
        if (demo) {
          setOrcamentoDemoId(demo.id)
        } else if (orcs.length > 0) {
          setOrcamentoDemoId(orcs[0].id)
        }
      } catch (e) {
        console.warn('Erro ao localizar orcamento demo:', e)
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
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => navigate('/app/orcamentos/novo')}
            size="sm"
            className="bg-[#124268] hover:bg-[#0c314f] text-white font-bold"
          >
            <Calculator className="h-4 w-4 mr-1.5 text-amber-400" />
            Novo Orçamento
          </Button>
          <Button
            onClick={() => navigate('/app/demandas/nova')}
            size="sm"
            variant="outline"
            className="border-gray-300"
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

      {/* Banner Demonstrativo & Critério de Aceite */}
      <div className="p-4 bg-gradient-to-r from-blue-900 via-[#1B4B8A] to-indigo-900 text-white rounded-xl shadow-md space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge className="bg-amber-400 text-slate-900 font-bold text-[10px]">
                AMBIENTE DEMO HOMOLOGADO
              </Badge>
              <span className="text-xs text-white/80">
                Itens Demo: Dipirona 500mg, Paracetamol 750mg, Álcool 70%, Papel A4, Desktop,
                Impressora
              </span>
            </div>
            <h2 className="text-base font-bold">
              Fluxo Completo do Critério de Aceite: Dipirona 500 mg comprimido
            </h2>
            <p className="text-xs text-white/80 max-w-2xl">
              Identificação estruturada (CATMAT/BPS/CMED) → Consulta PNCP/Compras.gov/BPS/BEC-SP →
              Normalização → Detecção de Outliers (IQR/Mediana) → Memória de Cálculo → Relatório 16
              Seções (PDF/XLSX).
            </p>
          </div>
          <Button
            onClick={() => {
              const pesqDipirona = pesquisas.find(
                (p) =>
                  p.numero.includes('DIP') ||
                  p.expand?.demanda_item_id?.descricao.toLowerCase().includes('dipirona'),
              )
              if (pesqDipirona) {
                navigate(`/app/pesquisas/${pesqDipirona.id}`)
              } else if (pesquisas.length > 0) {
                navigate(`/app/pesquisas/${pesquisas[0].id}`)
              } else {
                navigate('/app/pesquisas/nova')
              }
            }}
            className="bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs shadow"
          >
            Abrir Workspace da Pesquisa (Dipirona)
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </div>
      </div>

      {/* Banner de Acesso Rápido ao Novo Módulo de Orçamento e Pesquisa de Preços */}
      <div className="bg-white border border-[#b8c2cc] shadow-sm">
        <div className="bg-[#124268] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 bg-amber-400 border border-[#0c314f]" />
            <span>NOVO MÓDULO DE ORÇAMENTO E PESQUISA DE PREÇOS — FLUXO OPERACIONAL</span>
          </span>
          <span className="font-mono text-[11px] bg-white/20 px-2 py-0.5 text-amber-300">
            LEI 14.133/2021
          </span>
        </div>
        <div className="p-3.5 bg-white flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
          <div className="space-y-1">
            <p className="font-bold text-[#1f2937] text-sm uppercase">
              Fluxo Rápido: Novo Orçamento → Metodologia → Itens/Planilha → Cotar com IA → Validação
              Humana
            </p>
            <p className="text-[#4b5563]">
              Pesquisa automática nas fontes oficiais (PNCP, Compras.gov.br, BPS, CMED, BEC-SP),
              saneamento por juízo crítico (desvio padrão ou percentual configurável) e mapa
              comparativo.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              onClick={() => navigate('/app/orcamentos/novo')}
              className="bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold uppercase text-xs rounded-none shadow-none"
            >
              + Novo Orçamento
            </Button>
            <Button
              onClick={() => navigate('/app/orcamentos')}
              variant="outline"
              className="border-gray-400 text-gray-800 font-bold uppercase text-xs rounded-none bg-white hover:bg-gray-50"
            >
              Ver Orçamentos →
            </Button>
          </div>
        </div>
      </div>

      {/* Banner de Acesso Direto à Cotação no Layout Cesta de Preços */}
      <div className="bg-white border border-[#b8c2cc] shadow-sm">
        <div className="bg-[#124268] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 bg-amber-400 border border-[#0c314f]" />
            <span>ORÇAMENTO DE DEMONSTRAÇÃO HOMOLOGADO — CESTA DE PREÇOS</span>
          </span>
          <span className="font-mono text-[11px] bg-white/20 px-2 py-0.5">
            ORC-2026/001 • COT-IA
          </span>
        </div>
        <div className="p-3 bg-white flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
          <div className="space-y-0.5">
            <p className="font-bold text-[#1f2937] text-sm uppercase">
              Prorrogação de Medicamentos e Insumos da Atenção Básica
            </p>
            <p className="text-[#4b5563]">
              Itens cadastrados com cotação inline por item (lupa 🔍) nas fontes oficiais (PNCP,
              Compras.gov, BPS), juízo crítico 70%/130% da mediana e mapa comparativo.
            </p>
          </div>
          <Link
            to={orcamentoDemoId ? `/app/orcamentos/${orcamentoDemoId}/itens` : '/app/orcamentos'}
            className="inline-flex items-center justify-center bg-[#124268] hover:bg-[#0c314f] text-white text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-none shadow-none flex-shrink-0"
          >
            Abrir Itens do Orçamento Demo →
          </Link>
        </div>
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
