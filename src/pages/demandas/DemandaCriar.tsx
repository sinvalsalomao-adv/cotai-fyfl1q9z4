import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  ClipboardList,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  Save,
  Lock,
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
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { criarDemanda, criarItemDemanda } from '@/services/apiService'
import type { OrigemRecursos } from '@/types'

interface ItemForm {
  descricao: string
  quantidade: number
  unidade: string
  caracteristicas_essenciais: string
  prazo_entrega: string
  local_entrega: string
  catalogo: string
}

export default function DemandaCriar() {
  const { organizacaoAtual, user } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [salvando, setSalvando] = useState(false)

  // Etapa 1: Dados Gerais
  const [numero, setNumero] = useState(
    `DEM-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`,
  )
  const [origemRecursos, setOrigemRecursos] = useState<OrigemRecursos>(
    organizacaoAtual?.origem_recursos || 'recursos_proprios',
  )
  const [objeto, setObjeto] = useState('')

  // Etapa 2: Itens
  const [itens, setItens] = useState<ItemForm[]>([
    {
      descricao: '',
      quantidade: 1,
      unidade: 'un',
      caracteristicas_essenciais: '',
      prazo_entrega: '30 dias',
      local_entrega: organizacaoAtual?.endereco || 'Almoxarifado Central',
      catalogo: '',
    },
  ])

  // Etapa 3: Questões Faltantes (Lista de lacunas a revisar antes do congelamento)
  const [questoesFaltantes, setQuestoesFaltantes] = useState<string[]>([
    'Verificar se o catálogo CATMAT sugerido atende rigorosamente às exigências essenciais',
  ])
  const [novaQuestao, setNovaQuestao] = useState('')

  const addItem = () => {
    setItens([
      ...itens,
      {
        descricao: '',
        quantidade: 1,
        unidade: 'un',
        caracteristicas_essenciais: '',
        prazo_entrega: '30 dias',
        local_entrega: organizacaoAtual?.endereco || 'Almoxarifado Central',
        catalogo: '',
      },
    ])
  }

  const removeItem = (index: number) => {
    if (itens.length > 1) {
      setItens(itens.filter((_, i) => i !== index))
    }
  }

  const updateItem = (index: number, field: keyof ItemForm, value: any) => {
    const updated = [...itens]
    updated[index] = { ...updated[index], [field]: value }
    setItens(updated)
  }

  const addQuestao = () => {
    if (novaQuestao.trim()) {
      setQuestoesFaltantes([...questoesFaltantes, novaQuestao.trim()])
      setNovaQuestao('')
    }
  }

  const handleFinalizarEConfirmar = async () => {
    if (!organizacaoAtual) return
    setSalvando(true)
    try {
      // 1. Criar Demanda Confirmada (Versão 1 congelada)
      const novaDemanda = await criarDemanda({
        organizacao_id: organizacaoAtual.id,
        numero,
        versao: 1,
        origem_recursos: origemRecursos,
        objeto,
        status: 'confirmada',
        responsavel_id: user?.id,
        questoes_faltantes: questoesFaltantes,
      })

      // 2. Criar itens vinculados
      for (const it of itens) {
        await criarItemDemanda({
          demanda_id: novaDemanda.id,
          descricao: it.descricao,
          quantidade: Number(it.quantidade) || 1,
          unidade: it.unidade,
          caracteristicas_essenciais: it.caracteristicas_essenciais,
          prazo_entrega: it.prazo_entrega,
          local_entrega: it.local_entrega,
          catalogo: it.catalogo,
          versao: 1,
          confirmado: true,
        })
      }

      navigate(`/app/demandas/${novaDemanda.id}`)
    } catch (err: any) {
      alert(`Erro ao criar demanda: ${err?.message}`)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/app/demandas')}
            className="text-gray-600"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Voltar
          </Button>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-gray-900">
              Nova Demanda Administrativa
            </h1>
            <p className="text-xs text-gray-500">
              Jornada de 4 etapas: Etapa 2 — Formalização e Congelamento da Necessidade
            </p>
          </div>
        </div>
      </div>

      {/* Stepper Visual */}
      <div className="flex items-center justify-between bg-white p-3 rounded-lg border border-gray-200 text-xs">
        <div
          className={`flex items-center gap-2 font-medium ${
            step >= 1 ? 'text-[#1B4B8A]' : 'text-gray-400'
          }`}
        >
          <div
            className={`h-6 w-6 rounded-full flex items-center justify-center text-xs ${
              step >= 1 ? 'bg-[#1B4B8A] text-white' : 'bg-gray-100 text-gray-500'
            }`}
          >
            1
          </div>
          <span>Dados Gerais</span>
        </div>
        <div className="h-0.5 flex-1 bg-gray-200 mx-3" />
        <div
          className={`flex items-center gap-2 font-medium ${
            step >= 2 ? 'text-[#1B4B8A]' : 'text-gray-400'
          }`}
        >
          <div
            className={`h-6 w-6 rounded-full flex items-center justify-center text-xs ${
              step >= 2 ? 'bg-[#1B4B8A] text-white' : 'bg-gray-100 text-gray-500'
            }`}
          >
            2
          </div>
          <span>Itens da Demanda</span>
        </div>
        <div className="h-0.5 flex-1 bg-gray-200 mx-3" />
        <div
          className={`flex items-center gap-2 font-medium ${
            step >= 3 ? 'text-[#1B4B8A]' : 'text-gray-400'
          }`}
        >
          <div
            className={`h-6 w-6 rounded-full flex items-center justify-center text-xs ${
              step >= 3 ? 'bg-[#1B4B8A] text-white' : 'bg-gray-100 text-gray-500'
            }`}
          >
            3
          </div>
          <span>Confirmação e Congelamento</span>
        </div>
      </div>

      {/* ETAPA 1: Dados Gerais */}
      {step === 1 && (
        <Card className="border-gray-200">
          <CardHeader>
            <CardTitle className="text-base font-semibold">1. Dados Gerais da Demanda</CardTitle>
            <CardDescription className="text-xs">
              Identificação do órgão, número do protocolo e especificação sucinta do objeto
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-gray-700">Órgão Solicitante</Label>
                <Input
                  disabled
                  value={organizacaoAtual?.nome || ''}
                  className="text-sm bg-gray-50"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-gray-700">Número Interno</Label>
                <Input
                  required
                  value={numero}
                  onChange={(e) => setNumero(e.target.value)}
                  className="text-sm font-mono"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-700">Origem dos Recursos</Label>
              <Select
                value={origemRecursos}
                onValueChange={(val: OrigemRecursos) => setOrigemRecursos(val)}
              >
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recursos_proprios">Recursos próprios</SelectItem>
                  <SelectItem value="transferencia_voluntaria_federal">
                    Transferência voluntária federal (IN 65)
                  </SelectItem>
                  <SelectItem value="emenda_parlamentar">Emenda parlamentar</SelectItem>
                  <SelectItem value="outro">Outro recurso vinculado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-700">
                Objeto Completo da Demanda
              </Label>
              <Textarea
                rows={3}
                required
                placeholder="Ex: Aquisição de veículos leves para transporte de equipes técnicas..."
                value={objeto}
                onChange={(e) => setObjeto(e.target.value)}
                className="text-sm"
              />
            </div>
          </CardContent>
          <CardFooter className="flex justify-end border-t pt-4">
            <Button
              type="button"
              disabled={!objeto.trim()}
              onClick={() => setStep(2)}
              className="bg-[#1B4B8A] hover:bg-[#15406F] text-white"
            >
              Avançar para Itens
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          </CardFooter>
        </Card>
      )}

      {/* ETAPA 2: Itens da Demanda */}
      {step === 2 && (
        <div className="space-y-4">
          <Card className="border-gray-200">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <div>
                <CardTitle className="text-base font-semibold">2. Itens Solicitados</CardTitle>
                <CardDescription className="text-xs">
                  Cada item terá sua pesquisa de preços independente. Não agregue itens
                  incompatíveis.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addItem}
                className="text-xs text-[#1B4B8A]"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Adicionar Item
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              {itens.map((item, idx) => (
                <div
                  key={idx}
                  className="p-4 rounded-xl border border-gray-200 bg-gray-50/50 space-y-4 relative"
                >
                  <div className="flex items-center justify-between border-b pb-2">
                    <span className="font-bold text-xs text-[#1B4B8A]">ITEM #{idx + 1}</span>
                    {itens.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeItem(idx)}
                        className="text-red-600 hover:text-red-700 h-7"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        Remover
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div className="md:col-span-3 space-y-1">
                      <Label className="text-xs font-medium text-gray-700">Descrição do Item</Label>
                      <Input
                        required
                        placeholder="Ex: Veículo automotor hatch 1.0 flex zero km"
                        value={item.descricao}
                        onChange={(e) => updateItem(idx, 'descricao', e.target.value)}
                        className="text-sm bg-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs font-medium text-gray-700">Qtd</Label>
                        <Input
                          type="number"
                          min="1"
                          required
                          value={item.quantidade}
                          onChange={(e) => updateItem(idx, 'quantidade', e.target.value)}
                          className="text-sm bg-white"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs font-medium text-gray-700">Unidade</Label>
                        <Select
                          value={item.unidade}
                          onValueChange={(val) => updateItem(idx, 'unidade', val)}
                        >
                          <SelectTrigger className="text-sm bg-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="un">un (unidade)</SelectItem>
                            <SelectItem value="pct">pct (pacote)</SelectItem>
                            <SelectItem value="cx">cx (caixa)</SelectItem>
                            <SelectItem value="mes">mês</SelectItem>
                            <SelectItem value="km">km</SelectItem>
                            <SelectItem value="kg">kg</SelectItem>
                            <SelectItem value="m">m</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-700">
                      Características Essenciais (Incompatibilidades desclassificam candidatos)
                    </Label>
                    <Textarea
                      rows={2}
                      placeholder="Ex: Motor 1.0 flex, 4 portas, ar-condicionado, direção elétrica, cor branca sólida..."
                      value={item.caracteristicas_essenciais}
                      onChange={(e) =>
                        updateItem(idx, 'caracteristicas_essenciais', e.target.value)
                      }
                      className="text-sm bg-white"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs font-medium text-gray-700">Prazo de Entrega</Label>
                      <Input
                        value={item.prazo_entrega}
                        onChange={(e) => updateItem(idx, 'prazo_entrega', e.target.value)}
                        className="text-sm bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-medium text-gray-700">Local de Entrega</Label>
                      <Input
                        value={item.local_entrega}
                        onChange={(e) => updateItem(idx, 'local_entrega', e.target.value)}
                        className="text-sm bg-white"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-700">
                      Sugestão de Catálogo (CATMAT/CATSER)
                    </Label>
                    <Input
                      placeholder="Ex: CATMAT 463721 — VEÍCULO AUTOMOTOR, TIPO HATCH 1.0"
                      value={item.catalogo}
                      onChange={(e) => updateItem(idx, 'catalogo', e.target.value)}
                      className="text-sm bg-white"
                    />
                  </div>
                </div>
              ))}
            </CardContent>
            <CardFooter className="flex justify-between border-t pt-4">
              <Button variant="outline" onClick={() => setStep(1)} className="text-xs">
                <ArrowLeft className="h-4 w-4 mr-1" />
                Voltar
              </Button>
              <Button
                onClick={() => setStep(3)}
                disabled={itens.some((i) => !i.descricao.trim())}
                className="bg-[#1B4B8A] hover:bg-[#15406F] text-white text-xs"
              >
                Avançar para Confirmação
                <ArrowRight className="h-4 w-4 ml-1.5" />
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}

      {/* ETAPA 3: Confirmação e Congelamento */}
      {step === 3 && (
        <Card className="border-gray-200">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              3. Revisão de Lacunas e Congelamento da Versão
            </CardTitle>
            <CardDescription className="text-xs">
              Conforme a Seção 2 da especificação: o usuário confirma a especificação antes da
              pesquisa para congelar a versão. Alterações posteriores exigem nova versão.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="bg-blue-50/60 border border-blue-200 rounded-lg p-4 space-y-2 text-xs">
              <div className="flex items-center gap-2 text-[#1B4B8A] font-semibold">
                <Lock className="h-4 w-4" />
                <span>Resumo da Demanda a ser Congelada (v1.0)</span>
              </div>
              <p className="text-gray-700">
                <strong>Número:</strong> {numero} • <strong>Origem:</strong> {origemRecursos}
              </p>
              <p className="text-gray-700">
                <strong>Objeto:</strong> {objeto}
              </p>
              <p className="text-gray-700">
                <strong>Quantidade de Itens:</strong> {itens.length} item(ns)
              </p>
            </div>

            {/* Questões Faltantes (Lacunas Explícitas) */}
            <div className="space-y-3">
              <Label className="text-xs font-semibold text-gray-800 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Questões Faltantes / Lacunas Identificadas para Esclarecimento
              </Label>
              <div className="space-y-2">
                {questoesFaltantes.map((q, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2 rounded-md bg-amber-50/60 border border-amber-200 text-xs text-amber-900"
                  >
                    <span>• {q}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setQuestoesFaltantes(questoesFaltantes.filter((_, i) => i !== idx))
                      }
                      className="text-amber-700 hover:text-amber-900 text-[11px] font-bold"
                    >
                      remover
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder="Adicionar questão ou pendência técnica faltante..."
                  value={novaQuestao}
                  onChange={(e) => setNovaQuestao(e.target.value)}
                  className="text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addQuestao}
                  className="text-xs"
                >
                  Adicionar
                </Button>
              </div>
            </div>

            <Alert className="border-emerald-300 bg-emerald-50 text-emerald-900 text-xs">
              <CheckCircle2 className="h-4 w-4 text-emerald-700" />
              <AlertTitle className="text-xs font-semibold">Efeito do Congelamento:</AlertTitle>
              <AlertDescription className="text-[11px] text-emerald-800">
                Ao clicar em "Confirmar Demanda", os itens, unidades e requisitos serão gravados
                como Versão 1 imutável. A pesquisa de preços subsequente estará formalmente atrelada
                a esses quantitativos.
              </AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter className="flex justify-between border-t pt-4">
            <Button variant="outline" onClick={() => setStep(2)} className="text-xs">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Voltar
            </Button>
            <Button
              onClick={handleFinalizarEConfirmar}
              disabled={salvando}
              className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold"
            >
              <Lock className="h-4 w-4 mr-1.5" />
              {salvando ? 'Congelando Versão...' : 'Confirmar Demanda e Congelar Versão'}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  )
}
