import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  Building2,
  ShieldCheck,
  Save,
  ArrowLeft,
  AlertTriangle,
  FileText,
  Search,
  CheckCircle2,
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
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  obterOrganizacao,
  criarOrganizacao,
  atualizarOrganizacao,
  listarPerfisNormativos,
} from '@/services/apiService'
import { buscarMunicipiosIbge } from '@/lib/ibgeService'
import type { Organizacao, PerfilNormativo, OrigemRecursos } from '@/types'

// Função para formatar máscara de CNPJ preservando texto e zeros à esquerda
function formatarCnpjTexto(valor: string): string {
  const digitos = valor.replace(/\D/g, '').slice(0, 14)
  if (digitos.length <= 2) return digitos
  if (digitos.length <= 5) return `${digitos.slice(0, 2)}.${digitos.slice(2)}`
  if (digitos.length <= 8)
    return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5)}`
  if (digitos.length <= 12)
    return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8)}`
  return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12, 14)}`
}

export default function OrganizacaoDetalhe() {
  const { id } = useParams<{ id: string }>()
  const isNova = id === 'nova' || !id
  const navigate = useNavigate()
  const { recarregarDadosOrg, selecionarOrganizacao } = useAuth()

  const [loading, setLoading] = useState(!isNova)
  const [salvando, setSalvando] = useState(false)
  const [perfis, setPerfis] = useState<PerfilNormativo[]>([])
  const [municipiosOpcoes, setMunicipiosOpcoes] = useState<{ id: string; label: string }[]>([])
  const [municipioBusca, setMunicipioBusca] = useState('')

  const [formData, setFormData] = useState<Partial<Organizacao>>({
    nome: '',
    cnpj: '',
    municipio_ibge: '',
    endereco: '',
    unidade: '',
    responsavel_legal: '',
    origem_recursos: 'recursos_proprios',
    perfil_normativo_id: '',
  })

  useEffect(() => {
    const init = async () => {
      try {
        const pList = await listarPerfisNormativos()
        setPerfis(pList)

        const ibgeList = await buscarMunicipiosIbge()
        setMunicipiosOpcoes(ibgeList)

        if (!isNova && id) {
          const org = await obterOrganizacao(id)
          setFormData(org)
        } else if (pList.length > 0) {
          setFormData((prev) => ({ ...prev, perfil_normativo_id: pList[0].id }))
        }
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [id, isNova])

  const handleBuscarMunicipio = async (termo: string) => {
    setMunicipioBusca(termo)
    if (termo.length >= 2) {
      const res = await buscarMunicipiosIbge(termo)
      setMunicipiosOpcoes(res)
    }
  }

  const handleSalvar = async (e: React.FormEvent) => {
    e.preventDefault()
    setSalvando(true)
    try {
      if (isNova) {
        const criada = await criarOrganizacao(formData)
        await recarregarDadosOrg()
        selecionarOrganizacao(criada.id)
        navigate(`/app/organizacoes/${criada.id}`)
      } else if (id) {
        await atualizarOrganizacao(id, formData)
        await recarregarDadosOrg()
      }
    } catch (err: any) {
      alert(`Erro ao salvar órgão: ${err?.message || 'Verifique se o CNPJ é único.'}`)
    } finally {
      setSalvando(false)
    }
  }

  const perfilSelecionado = perfis.find((p) => p.id === formData.perfil_normativo_id)

  if (loading) {
    return <div className="p-8 text-center text-xs text-gray-500">Carregando dados do órgão...</div>
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/app/organizacoes')}
            className="text-gray-600"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Voltar
          </Button>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-gray-900">
              {isNova ? 'Cadastrar Novo Órgão Contratante' : formData.nome}
            </h1>
            <p className="text-xs text-gray-500 font-mono">
              CNPJ: {formData.cnpj || 'Em preenchimento'} (preservando zeros à esquerda)
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="dados" className="space-y-4">
        <TabsList className="bg-gray-100 p-1">
          <TabsTrigger value="dados" className="text-xs">
            Dados Cadastrais e Responsáveis
          </TabsTrigger>
          <TabsTrigger value="perfil" className="text-xs">
            Perfil Normativo (Lei 14.133 / IN 65)
          </TabsTrigger>
          <TabsTrigger value="isolamento" className="text-xs">
            Garantia de Isolamento
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Dados */}
        <TabsContent value="dados">
          <form onSubmit={handleSalvar}>
            <Card className="border-gray-200">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Informações Gerais do Órgão</CardTitle>
                <CardDescription className="text-xs">
                  Município padronizado pelo IBGE e CNPJ armazenado como texto para preservar
                  formatação
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-gray-700">
                      Nome Oficial do Órgão / Entidade
                    </Label>
                    <Input
                      required
                      placeholder="Ex: Prefeitura Municipal de..."
                      value={formData.nome || ''}
                      onChange={(e) => setFormData({ ...formData, nome: e.target.value })}
                      className="text-sm"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-gray-700">
                      CNPJ (Texto, preserva zeros)
                    </Label>
                    <Input
                      required
                      placeholder="00.000.000/0000-00"
                      value={formData.cnpj || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, cnpj: formatarCnpjTexto(e.target.value) })
                      }
                      className="text-sm font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-gray-700">
                      Município Padronizado (API Pública IBGE)
                    </Label>
                    <Input
                      required
                      placeholder="Digite para filtrar município..."
                      value={formData.municipio_ibge || ''}
                      onChange={(e) => {
                        setFormData({ ...formData, municipio_ibge: e.target.value })
                        handleBuscarMunicipio(e.target.value)
                      }}
                      className="text-sm"
                    />
                    {municipiosOpcoes.length > 0 && municipioBusca.length >= 2 && (
                      <div className="border border-gray-200 rounded-md max-h-36 overflow-y-auto bg-white shadow-sm text-xs divide-y">
                        {municipiosOpcoes.map((m) => (
                          <div
                            key={m.id}
                            className="p-2 hover:bg-blue-50 cursor-pointer"
                            onClick={() => {
                              setFormData({ ...formData, municipio_ibge: m.label })
                              setMunicipioBusca('')
                            }}
                          >
                            {m.label}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-gray-700">
                      Unidade Administrativa
                    </Label>
                    <Input
                      placeholder="Ex: Secretaria Municipal de Administração"
                      value={formData.unidade || ''}
                      onChange={(e) => setFormData({ ...formData, unidade: e.target.value })}
                      className="text-sm"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-gray-700">Endereço da Sede</Label>
                  <Input
                    placeholder="Rua, número, bairro e CEP"
                    value={formData.endereco || ''}
                    onChange={(e) => setFormData({ ...formData, endereco: e.target.value })}
                    className="text-sm"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-gray-700">
                      Responsável Legal (Autoridade)
                    </Label>
                    <Input
                      placeholder="Nome e cargo do gestor"
                      value={formData.responsavel_legal || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, responsavel_legal: e.target.value })
                      }
                      className="text-sm"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-gray-700">
                      Origem Padrão dos Recursos
                    </Label>
                    <Select
                      value={formData.origem_recursos || 'recursos_proprios'}
                      onValueChange={(val: OrigemRecursos) =>
                        setFormData({ ...formData, origem_recursos: val })
                      }
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="recursos_proprios">
                          Recursos próprios municipais
                        </SelectItem>
                        <SelectItem value="transferencia_voluntaria_federal">
                          Transferência voluntária federal (IN 65)
                        </SelectItem>
                        <SelectItem value="emenda_parlamentar">Emenda parlamentar</SelectItem>
                        <SelectItem value="outro">Outra fonte vinculada</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex justify-end gap-2 border-t pt-4">
                <Button
                  type="submit"
                  disabled={salvando}
                  className="bg-[#1B4B8A] hover:bg-[#15406F] text-white"
                >
                  <Save className="h-4 w-4 mr-1.5" />
                  {salvando ? 'Salvando...' : 'Salvar Alterações'}
                </Button>
              </CardFooter>
            </Card>
          </form>
        </TabsContent>

        {/* Tab 2: Perfil Normativo */}
        <TabsContent value="perfil">
          <Card className="border-gray-200 space-y-4 p-6">
            <div>
              <CardTitle className="text-base font-semibold">Perfil Normativo do Órgão</CardTitle>
              <CardDescription className="text-xs mt-1">
                Regras vigentes, métodos estatísticos autorizados e parâmetros jurídicos
                configurados
              </CardDescription>
            </div>

            <div className="space-y-3">
              <Label className="text-xs font-medium text-gray-700">Vincular Perfil Normativo</Label>
              <Select
                value={formData.perfil_normativo_id || ''}
                onValueChange={(val) => setFormData({ ...formData, perfil_normativo_id: val })}
              >
                <SelectTrigger className="text-sm max-w-md">
                  <SelectValue placeholder="Selecione o perfil normativo..." />
                </SelectTrigger>
                <SelectContent>
                  {perfis.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {perfilSelecionado && (
              <div className="p-4 rounded-lg bg-gray-50 border border-gray-200 space-y-3 text-xs">
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="font-semibold text-gray-900">{perfilSelecionado.nome}</span>
                  <span className="text-[11px] font-mono text-gray-600">
                    Norma: {perfilSelecionado.norma_id.toUpperCase()}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-gray-600">
                  <div>
                    <span className="text-gray-500">Método Permitido:</span>{' '}
                    <strong className="text-gray-800 uppercase">
                      {perfilSelecionado.metodo_permitido ||
                        'Medida de tendência central (Mediana por padrão)'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-gray-500">Autoridade Competente:</span>{' '}
                    <strong className="text-gray-800">
                      {perfilSelecionado.autoridade_competente || 'Secretário Municipal'}
                    </strong>
                  </div>
                </div>

                <Alert className="border-amber-300 bg-amber-50 text-amber-900 text-xs py-2">
                  <AlertTriangle className="h-4 w-4 text-amber-700" />
                  <AlertTitle className="text-xs font-semibold">
                    Restrição Normativa de Escopo (Seção 6 da Especificação):
                  </AlertTitle>
                  <AlertDescription className="text-[11px] text-amber-800">
                    Obras e serviços de engenharia e contratos com dedicação exclusiva de mão de
                    obra exigem planilhas específicas (SINAPI/SICRO/CCT) e NÃO estão liberados no
                    motor genérico nesta v1.
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </Card>
        </TabsContent>

        {/* Tab 3: Isolamento */}
        <TabsContent value="isolamento">
          <Card className="border-gray-200 p-6 space-y-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <ShieldCheck className="h-6 w-6" />
              <CardTitle className="text-base font-semibold">
                Isolamento Rígido entre Órgãos
              </CardTitle>
            </div>
            <p className="text-xs text-gray-600 leading-relaxed">
              Conforme a seção 7 da especificação, todos os registros de processos, demandas,
              pesquisas, referências e documentos pertencem estritamente à organização ativa.
            </p>
            <div className="bg-gray-50 border border-gray-200 rounded-md p-3 text-xs space-y-1 font-mono text-gray-700">
              <p>ID da Organização: {formData.id || '(novo)'}</p>
              <p>Chave Canônica CNPJ: {formData.cnpj}</p>
              <p>Validação no Banco: PocketBase listRule / viewRule por organizacao_id</p>
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
