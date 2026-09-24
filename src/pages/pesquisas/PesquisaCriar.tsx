import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  Search,
  ArrowLeft,
  ArrowRight,
  Database,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Globe,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { listarDemandas, listarItensDaDemanda, criarPesquisa } from '@/services/apiService'
import type { Demanda, DemandaItem } from '@/types'

export default function PesquisaCriar() {
  const { organizacaoAtual, user } = useAuth()
  const navigate = useNavigate()

  const [demandas, setDemandas] = useState<Demanda[]>([])
  const [demandaId, setDemandaId] = useState<string>('')
  const [itens, setItens] = useState<DemandaItem[]>([])
  const [demandaItemId, setDemandaItemId] = useState<string>('')

  const [numero, setNumero] = useState(
    `PESQ-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`,
  )
  const [conectores, setConectores] = useState({
    compras_gov: true,
    pncp: true,
    manual: true,
  })
  const [termoBusca, setTermoBusca] = useState('')
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    if (!organizacaoAtual) return
    listarDemandas(organizacaoAtual.id).then((list) => {
      // Priorizar demandas confirmadas
      const confirmadas = list.filter(
        (d) => d.status === 'confirmada' || d.status === 'em_pesquisa',
      )
      setDemandas(confirmadas.length > 0 ? confirmadas : list)
      if (confirmadas.length > 0) {
        setDemandaId(confirmadas[0].id)
      }
    })
  }, [organizacaoAtual?.id])

  useEffect(() => {
    if (!demandaId) {
      setItens([])
      return
    }
    listarItensDaDemanda(demandaId).then((itList) => {
      setItens(itList)
      if (itList.length > 0) {
        setDemandaItemId(itList[0].id)
        setTermoBusca(itList[0].descricao)
      }
    })
  }, [demandaId])

  const handleCriar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!demandaItemId) return
    setSalvando(true)
    try {
      const pesq = await criarPesquisa({
        demanda_item_id: demandaItemId,
        numero,
        status: 'aguardando_revisao',
        conectores: {
          compras_gov: { selecionado: conectores.compras_gov, status: 'cobertura_completa' },
          pncp: { selecionado: conectores.pncp, status: 'cobertura_completa' },
          manual: { selecionado: conectores.manual, status: 'ativo' },
        },
        filtros: {
          termo: termoBusca,
          periodo_meses: 12,
        },
        cobertura: {
          compras_gov: { status: 'cobertura_completa', paginas: 1 },
          pncp: { status: 'cobertura_completa', paginas: 1 },
          manual: { status: 'ativo', registros: 0 },
        },
        falhas: [],
        inicio: new Date().toISOString(),
        responsavel_id: user?.id,
      })
      navigate(`/app/pesquisas/${pesq.id}`)
    } catch (err: any) {
      alert(`Erro ao criar pesquisa: ${err?.message}`)
    } finally {
      setSalvando(false)
    }
  }

  const itemSelecionado = itens.find((i) => i.id === demandaItemId)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/app/pesquisas')}
          className="text-gray-600"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Voltar
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-gray-900">
            Iniciar Nova Pesquisa de Preços
          </h1>
          <p className="text-xs text-gray-500">
            Vinculação estrita à versão congelada do item da demanda
          </p>
        </div>
      </div>

      <form onSubmit={handleCriar} className="space-y-6">
        <Card className="border-gray-200">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              1. Seleção da Demanda e Item Congelado
            </CardTitle>
            <CardDescription className="text-xs">
              A pesquisa só pode ser executada para itens já confirmados na Etapa 2.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-700">Demanda Vinculada</Label>
              <Select value={demandaId} onValueChange={(val) => setDemandaId(val)}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="Selecione a demanda confirmada..." />
                </SelectTrigger>
                <SelectContent>
                  {demandas.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.numero} (v{d.versao}.0) — {d.objeto.slice(0, 60)}...
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-700">
                Item Específico da Demanda
              </Label>
              <Select value={demandaItemId} onValueChange={(val) => setDemandaItemId(val)}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="Selecione o item..." />
                </SelectTrigger>
                <SelectContent>
                  {itens.map((it, idx) => (
                    <SelectItem key={it.id} value={it.id}>
                      Item #{idx + 1}: {it.descricao} ({it.quantidade} {it.unidade})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {itemSelecionado && (
              <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 space-y-1.5 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-gray-900">
                  <Lock className="h-3.5 w-3.5 text-emerald-700" />
                  <span>Especificação Congelada: {itemSelecionado.descricao}</span>
                </div>
                <p className="text-gray-600">
                  Quantidade:{' '}
                  <strong>
                    {itemSelecionado.quantidade} {itemSelecionado.unidade}
                  </strong>
                </p>
                {itemSelecionado.caracteristicas_essenciais && (
                  <p className="text-gray-600">
                    Requisitos Essenciais: {itemSelecionado.caracteristicas_essenciais}
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-gray-700">
                  Identificador da Pesquisa
                </Label>
                <Input
                  required
                  value={numero}
                  onChange={(e) => setNumero(e.target.value)}
                  className="text-sm font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-gray-700">
                  Termo Principal de Busca
                </Label>
                <Input
                  required
                  value={termoBusca}
                  onChange={(e) => setTermoBusca(e.target.value)}
                  className="text-sm"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Conectores e Fontes de Coleta */}
        <Card className="border-gray-200">
          <CardHeader>
            <CardTitle className="text-base font-semibold">2. Fontes e Conectores</CardTitle>
            <CardDescription className="text-xs">
              Conectores prioritários conforme Art. 23 da Lei 14.133/2021
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Compras.gov.br */}
            <div className="flex items-start space-x-3 p-3 rounded-lg border border-gray-200 bg-white">
              <Checkbox
                id="compras_gov"
                checked={conectores.compras_gov}
                onCheckedChange={(checked) =>
                  setConectores({ ...conectores, compras_gov: !!checked })
                }
              />
              <div className="space-y-1 text-xs">
                <label htmlFor="compras_gov" className="font-semibold text-gray-900 cursor-pointer">
                  Compras.gov.br (Catálogo CATMAT e Preços Praticados)
                </label>
                <p className="text-gray-500">
                  API pública oficial e Swagger de dados abertos confirmados.
                </p>
              </div>
            </div>

            {/* PNCP */}
            <div className="flex items-start space-x-3 p-3 rounded-lg border border-gray-200 bg-white">
              <Checkbox
                id="pncp"
                checked={conectores.pncp}
                onCheckedChange={(checked) => setConectores({ ...conectores, pncp: !!checked })}
              />
              <div className="space-y-1 text-xs">
                <label htmlFor="pncp" className="font-semibold text-gray-900 cursor-pointer">
                  PNCP Consulta e Detalhes de Contratações
                </label>
                <p className="text-gray-500">
                  Consulta aberta ao Portal Nacional de Contratações Públicas.
                </p>
              </div>
            </div>

            {/* Anexo Manual */}
            <div className="flex items-start space-x-3 p-3 rounded-lg border border-gray-200 bg-white">
              <Checkbox
                id="manual"
                checked={conectores.manual}
                onCheckedChange={(checked) => setConectores({ ...conectores, manual: !!checked })}
              />
              <div className="space-y-1 text-xs">
                <label htmlFor="manual" className="font-semibold text-gray-900 cursor-pointer">
                  Anexo Manual com Evidência (Cotações Diretas e Pesquisa de Mercado)
                </label>
                <p className="text-gray-500">
                  Permite upload de orçamentos formalizados, proposta de fornecedor e notas fiscais.
                </p>
              </div>
            </div>

            {/* Conectores desabilitados por especificação */}
            <div className="opacity-60 pointer-events-none space-y-2 pt-2 border-t">
              <div className="p-2.5 rounded-lg border border-dashed border-gray-300 bg-gray-50 text-xs flex justify-between items-center">
                <span>Portal de Compras Públicas (PCP)</span>
                <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                  PublicKey pendente (runtime_enabled=false)
                </span>
              </div>
              <div className="p-2.5 rounded-lg border border-dashed border-gray-300 bg-gray-50 text-xs flex justify-between items-center">
                <span>Cesta de Preços</span>
                <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                  API não confirmada (runtime_enabled=false)
                </span>
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-end border-t pt-4">
            <Button
              type="submit"
              disabled={salvando || !demandaItemId}
              className="bg-[#1B4B8A] hover:bg-[#15406F] text-white text-xs"
            >
              <Search className="h-4 w-4 mr-1.5" />
              {salvando ? 'Criando Pesquisa...' : 'Iniciar Coleta e Triagem'}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  )
}
