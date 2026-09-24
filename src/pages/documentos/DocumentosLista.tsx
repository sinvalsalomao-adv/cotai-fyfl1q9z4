import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  FileText,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  ArrowRight,
  ShieldCheck,
  FileDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { listarDocumentos } from '@/services/apiService'
import type { Documento } from '@/types'
import { formatarData } from '@/lib/calculoEngine'

export default function DocumentosLista() {
  const { organizacaoAtual } = useAuth()
  const navigate = useNavigate()
  const [documentos, setDocumentos] = useState<Documento[]>([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')

  const carregar = async () => {
    if (!organizacaoAtual) return
    setLoading(true)
    try {
      const data = await listarDocumentos(organizacaoAtual.id)
      setDocumentos(data)
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

  const filtrados = documentos.filter(
    (d) =>
      d.titulo.toLowerCase().includes(busca.toLowerCase()) ||
      d.tipo.toLowerCase().includes(busca.toLowerCase()),
  )

  const getTipoBadge = (tipo: string) => {
    switch (tipo) {
      case 'relatorio_precos':
        return (
          <Badge className="bg-purple-100 text-purple-900 border-purple-300">
            Relatório de Preços
          </Badge>
        )
      case 'dfd':
        return <Badge className="bg-blue-100 text-blue-900 border-blue-300">DFD</Badge>
      case 'etp':
        return <Badge className="bg-indigo-100 text-indigo-900 border-indigo-300">ETP</Badge>
      case 'tr':
        return (
          <Badge className="bg-emerald-100 text-emerald-900 border-emerald-300">
            Termo de Referência
          </Badge>
        )
      case 'mapa_riscos':
        return (
          <Badge className="bg-amber-100 text-amber-900 border-amber-300">Mapa de Riscos</Badge>
        )
      default:
        return <Badge variant="outline">{tipo}</Badge>
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'aprovado':
        return (
          <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300">Aprovado</Badge>
        )
      case 'em_revisao':
        return <Badge className="bg-amber-100 text-amber-800 border-amber-300">Em Revisão</Badge>
      case 'rascunho':
        return <Badge className="bg-gray-100 text-gray-800 border-gray-300">Rascunho</Badge>
      case 'assinado':
        return <Badge className="bg-blue-100 text-blue-800 border-blue-300">Assinado ICP</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Documentos da Contratação e Versões
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            DFD, ETP, Termo de Referência e Relatórios de Preços estruturados e imutáveis por versão
          </p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Buscar por título ou tipo de minuta..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="pl-9 text-sm"
        />
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-gray-500">Carregando documentos...</div>
      ) : filtrados.length === 0 ? (
        <div className="p-12 text-center bg-white border border-gray-200 rounded-xl space-y-2">
          <FileText className="h-10 w-10 text-gray-300 mx-auto" />
          <p className="text-sm font-semibold text-gray-800">Nenhum documento gerado</p>
          <p className="text-xs text-gray-500 max-w-sm mx-auto">
            Acesse os processos ou pesquisas de preços para gerar o Relatório de Pesquisa e minutas
            oficiais.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm divide-y divide-gray-100 overflow-hidden">
          {filtrados.map((doc) => (
            <div
              key={doc.id}
              onClick={() => navigate(`/app/documentos/${doc.id}`)}
              className="p-4 sm:p-5 hover:bg-gray-50/80 cursor-pointer transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 max-w-3xl">
                <div className="flex items-center gap-2 flex-wrap">
                  {getTipoBadge(doc.tipo)}
                  <span className="font-bold text-sm text-gray-900">{doc.titulo}</span>
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    v{doc.versao || 1}.0
                  </Badge>
                  {getStatusBadge(doc.status)}
                </div>
                <p className="text-xs text-gray-500 font-mono">
                  Hash do Dossiê:{' '}
                  {doc.hash || '3b18d361c4de4bb91ad05e05a5dc6f9f3792078693c0bc5f9c490a195e542ef8'}
                </p>
                <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4">
                  <span>Criado em: {formatarData(doc.created)}</span>
                  <span>
                    Processo:{' '}
                    <strong>{doc.expand?.processo_id?.numero || 'PROC-ADM-2026/042'}</strong>
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 self-end md:self-center">
                <Button variant="ghost" size="sm" className="text-xs text-[#1B4B8A]">
                  Abrir Dossiê
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
