import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  Building2,
  Plus,
  ShieldCheck,
  MapPin,
  ExternalLink,
  Search,
  CheckCircle2,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { listarOrganizacoes } from '@/services/apiService'
import type { Organizacao } from '@/types'

export default function OrganizacoesLista() {
  const { organizacaoAtual, selecionarOrganizacao } = useAuth()
  const navigate = useNavigate()
  const [organizacoes, setOrganizacoes] = useState<Organizacao[]>([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')

  const carregar = async () => {
    setLoading(true)
    try {
      const data = await listarOrganizacoes()
      setOrganizacoes(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    carregar()
  }, [])

  const filtradas = organizacoes.filter(
    (o) =>
      o.nome.toLowerCase().includes(busca.toLowerCase()) ||
      o.cnpj.includes(busca) ||
      o.municipio_ibge.toLowerCase().includes(busca.toLowerCase()),
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Órgãos e Unidades Administrativas
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Cadastro de prefeituras, consórcios e perfis normativos com isolamento estrito de dados
          </p>
        </div>
        <Button
          onClick={() => navigate('/app/organizacoes/nova')}
          className="bg-[#1B4B8A] hover:bg-[#15406F] text-white"
        >
          <Plus className="h-4 w-4 mr-2" />
          Novo Órgão
        </Button>
      </div>

      {/* Barra de Busca */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Buscar por nome, CNPJ ou município..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="pl-9 text-sm"
        />
      </div>

      {/* Lista de Órgãos */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtradas.map((org) => {
          const isAtivo = organizacaoAtual?.id === org.id
          return (
            <Card
              key={org.id}
              className={`border transition-all ${
                isAtivo
                  ? 'border-[#1B4B8A] shadow-md ring-1 ring-[#1B4B8A]'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="text-base text-gray-900">{org.nome}</CardTitle>
                    <CardDescription className="text-xs text-gray-600 font-mono">
                      CNPJ: {org.cnpj}
                    </CardDescription>
                  </div>
                  {isAtivo ? (
                    <Badge className="bg-[#1B4B8A] text-white text-[10px] gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Órgão Ativo
                    </Badge>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => selecionarOrganizacao(org.id)}
                      className="text-xs h-7"
                    >
                      Selecionar
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-xs text-gray-600">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-gray-400 flex-shrink-0" />
                  <span>{org.municipio_ibge}</span>
                </div>
                <div>
                  <span className="text-gray-500">Unidade: </span>
                  <span className="font-medium text-gray-800">
                    {org.unidade || 'Secretaria Geral'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Origem de Recursos: </span>
                  <Badge variant="secondary" className="text-[10px] capitalize">
                    {org.origem_recursos?.replace(/_/g, ' ') || 'Próprios'}
                  </Badge>
                </div>
                <div className="pt-2 border-t border-gray-100 flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">
                    Norma:{' '}
                    <strong>{org.expand?.perfil_normativo_id?.nome || 'Lei nº 14.133/2021'}</strong>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/app/organizacoes/${org.id}`)}
                    className="text-xs text-[#1B4B8A] h-7"
                  >
                    Ver detalhes
                    <ExternalLink className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
