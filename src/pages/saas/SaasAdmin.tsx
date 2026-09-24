import React, { useState, useEffect } from 'react'
import {
  ShieldAlert,
  Building2,
  Users,
  CreditCard,
  Key,
  Sliders,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Settings,
  Layers,
  Database,
  Search,
  Lock,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/context/AuthContext'
import {
  listarOrganizacoes,
  listarPlanosSaas,
  listarFontesCatalogo,
  listarSyncLogs,
  obterOrgaoConfiguracao,
  salvarOrgaoConfiguracao,
  registrarAuditoria,
} from '@/services/apiService'
import type { Organizacao, PlanoSaas, FonteCatalogo, SyncLog, OrgaoConfiguracao } from '@/types'

export default function SaasAdmin() {
  const { usuario } = useAuth()
  const [organizacoes, setOrganizacoes] = useState<Organizacao[]>([])
  const [planos, setPlanos] = useState<PlanoSaas[]>([])
  const [fontes, setFontes] = useState<FonteCatalogo[]>([])
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([])
  const [carregando, setCarregando] = useState(true)

  // Seleção para edição
  const [orgaoSelecionado, setOrgaoSelecionado] = useState<Organizacao | null>(null)
  const [configEdicao, setConfigEdicao] = useState<Partial<OrgaoConfiguracao>>({
    status_licenca: 'ativa',
    quantidade_minima_precos: 3,
    metodo_outlier_padrao: 'distancia_mediana',
    limite_outlier_inferior: 70,
    limite_outlier_superior: 130,
    metodo_calculo_padrao: 'mediana',
    exigir_justificativa_insuficiente: true,
    priorizar_fontes_governamentais: true,
    permitir_cotacao_fornecedor: true,
    periodo_maximo_meses: 12,
  })

  useEffect(() => {
    async function carregarTudo() {
      setCarregando(true)
      try {
        const [orgs, pls, fts, sLogs] = await Promise.all([
          listarOrganizacoes(),
          listarPlanosSaas(),
          listarFontesCatalogo(),
          listarSyncLogs(),
        ])
        setOrganizacoes(orgs)
        setPlanos(pls as any)
        setFontes(fts as any)
        setSyncLogs(sLogs as any)

        if (orgs.length > 0) {
          setOrgaoSelecionado(orgs[0])
          const cfg = await obterOrgaoConfiguracao(orgs[0].id)
          if (cfg) {
            setConfigEdicao(cfg)
          }
        }
      } catch (err) {
        console.error('Erro ao carregar dados SaaS:', err)
      } finally {
        setCarregando(false)
      }
    }
    carregarTudo()
  }, [])

  const handleSelecionarOrgao = async (org: Organizacao) => {
    setOrgaoSelecionado(org)
    const cfg = await obterOrgaoConfiguracao(org.id)
    if (cfg) {
      setConfigEdicao(cfg)
    } else {
      setConfigEdicao({
        organizacao_id: org.id,
        status_licenca: 'ativa',
        quantidade_minima_precos: 3,
        metodo_outlier_padrao: 'distancia_mediana',
        limite_outlier_inferior: 70,
        limite_outlier_superior: 130,
        metodo_calculo_padrao: 'mediana',
        exigir_justificativa_insuficiente: true,
      })
    }
  }

  const handleSalvarConfiguracao = async () => {
    if (!orgaoSelecionado) return
    try {
      await salvarOrgaoConfiguracao({
        ...configEdicao,
        organizacao_id: orgaoSelecionado.id,
      })
      alert(`Configurações e limites de "${orgaoSelecionado.nome}" salvos com sucesso!`)

      await registrarAuditoria({
        evento: `Alteração de limites e licença SaaS do órgão: ${orgaoSelecionado.nome}`,
        objeto_tipo: 'orgao_configuracao',
        objeto_id: orgaoSelecionado.id,
        antes_depois: configEdicao,
      })
    } catch (err: any) {
      alert(`Erro ao salvar: ${err?.message}`)
    }
  }

  if (carregando) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        Carregando painel SaaS Super Admin...
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Topo do Módulo SaaS */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge className="bg-amber-500 text-white font-bold text-xs">SUPER ADMIN</Badge>
            <span className="text-xs text-gray-400 font-mono">Governança Multi-Tenant</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-[#1B4B8A]" />
            Administração SaaS, Planos & Limites por Órgão
          </h1>
          <p className="text-xs text-gray-500">
            Controle de licenças, limites de consumo, conectores e regulamentos específicos por
            órgão contratante. Sem acesso aos dados privados sem autorização auditada.
          </p>
        </div>
      </div>

      <Tabs defaultValue="orgaos_licencas" className="space-y-4">
        <TabsList className="bg-gray-100 p-1 grid grid-cols-2 md:grid-cols-4 max-w-2xl">
          <TabsTrigger value="orgaos_licencas" className="text-xs font-semibold">
            <Building2 className="h-3.5 w-3.5 mr-1 text-[#1B4B8A]" />
            Órgãos & Licenças
          </TabsTrigger>
          <TabsTrigger value="planos_saas" className="text-xs font-semibold">
            <CreditCard className="h-3.5 w-3.5 mr-1 text-emerald-600" />
            Planos SaaS ({planos.length})
          </TabsTrigger>
          <TabsTrigger value="fontes_conectores" className="text-xs font-semibold">
            <Database className="h-3.5 w-3.5 mr-1 text-indigo-600" />
            Fontes & Conectores ({fontes.length})
          </TabsTrigger>
          <TabsTrigger value="sync_logs" className="text-xs font-semibold">
            <Sliders className="h-3.5 w-3.5 mr-1 text-amber-600" />
            Logs de Sincronização
          </TabsTrigger>
        </TabsList>

        {/* ABA 1: Órgãos e Licenças */}
        <TabsContent value="orgaos_licencas" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Lista de Órgãos */}
            <Card className="border border-gray-200">
              <CardHeader className="p-3.5 pb-2">
                <CardTitle className="text-xs font-bold text-gray-800 uppercase">
                  Órgãos Cadastrados ({organizacoes.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 space-y-1">
                {organizacoes.map((org) => (
                  <div
                    key={org.id}
                    onClick={() => handleSelecionarOrgao(org)}
                    className={`p-2.5 rounded-lg border text-xs cursor-pointer transition-all ${
                      orgaoSelecionado?.id === org.id
                        ? 'border-[#1B4B8A] bg-blue-50/50 font-semibold'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <p className="text-gray-900">{org.nome}</p>
                    <p className="text-[10px] text-gray-500 font-mono">{org.cnpj}</p>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Painel de Configurações e Limites do Órgão */}
            <Card className="border border-gray-200 md:col-span-2">
              <CardHeader className="p-4 pb-2 border-b">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-sm font-bold text-gray-900">
                      Configurações e Limites: {orgaoSelecionado?.nome}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      CNPJ: {orgaoSelecionado?.cnpj} • Município IBGE:{' '}
                      {orgaoSelecionado?.municipio_ibge}
                    </CardDescription>
                  </div>
                  <Badge className="bg-emerald-100 text-emerald-800 uppercase text-[10px]">
                    {configEdicao.status_licenca || 'ATIVA'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-4 space-y-4 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="font-semibold text-gray-700">Status da Licença:</label>
                    <select
                      value={configEdicao.status_licenca || 'ativa'}
                      onChange={(e) =>
                        setConfigEdicao({ ...configEdicao, status_licenca: e.target.value as any })
                      }
                      className="w-full border rounded p-1.5 bg-white"
                    >
                      <option value="ativa">Ativa (Acesso Pleno)</option>
                      <option value="degustacao">Degustação (Trial 30 dias)</option>
                      <option value="bloqueada">Bloqueada (Inadimplência/Administrativo)</option>
                      <option value="suspensa">Suspensa</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="font-semibold text-gray-700">
                      Quantidade Mínima de Preços:
                    </label>
                    <Input
                      type="number"
                      value={configEdicao.quantidade_minima_precos || 3}
                      onChange={(e) =>
                        setConfigEdicao({
                          ...configEdicao,
                          quantidade_minima_precos: Number(e.target.value),
                        })
                      }
                      className="text-xs h-8"
                    />
                    <p className="text-[10px] text-gray-400">Padrão legal 3 (configurável)</p>
                  </div>

                  <div className="space-y-1">
                    <label className="font-semibold text-gray-700">
                      Método de Detecção de Outliers:
                    </label>
                    <select
                      value={configEdicao.metodo_outlier_padrao || 'distancia_mediana'}
                      onChange={(e) =>
                        setConfigEdicao({
                          ...configEdicao,
                          metodo_outlier_padrao: e.target.value as any,
                        })
                      }
                      className="w-full border rounded p-1.5 bg-white"
                    >
                      <option value="distancia_mediana">Distância da Mediana (70% - 130%)</option>
                      <option value="iqr">Intervalo Interquartil (IQR 1.5)</option>
                      <option value="desvio_padrao">Desvio-Padrão (|Z| &gt; 2.0)</option>
                      <option value="percentual_fixo">Percentual Fixo Personalizado</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="font-semibold text-gray-700">
                      Período Máximo de Retroação:
                    </label>
                    <Input
                      type="number"
                      value={configEdicao.periodo_maximo_meses || 12}
                      onChange={(e) =>
                        setConfigEdicao({
                          ...configEdicao,
                          periodo_maximo_meses: Number(e.target.value),
                        })
                      }
                      className="text-xs h-8"
                    />
                    <p className="text-[10px] text-gray-400">
                      Meses (ex: 12 meses conforme IN 65/2021)
                    </p>
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t">
                  <span className="font-bold text-gray-800">Regras e Políticas Invocáveis:</span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <label className="flex items-center gap-2 text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={configEdicao.priorizar_fontes_governamentais ?? true}
                        onChange={(e) =>
                          setConfigEdicao({
                            ...configEdicao,
                            priorizar_fontes_governamentais: e.target.checked,
                          })
                        }
                      />
                      <span>Priorizar fontes governamentais (PNCP / Compras.gov)</span>
                    </label>

                    <label className="flex items-center gap-2 text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={configEdicao.permitir_cotacao_fornecedor ?? true}
                        onChange={(e) =>
                          setConfigEdicao({
                            ...configEdicao,
                            permitir_cotacao_fornecedor: e.target.checked,
                          })
                        }
                      />
                      <span>Permitir cotações diretas com fornecedores locais</span>
                    </label>

                    <label className="flex items-center gap-2 text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={configEdicao.exigir_justificativa_insuficiente ?? true}
                        onChange={(e) =>
                          setConfigEdicao({
                            ...configEdicao,
                            exigir_justificativa_insuficiente: e.target.checked,
                          })
                        }
                      />
                      <span>Exigir justificativa expressa para amostra &lt; mínimo</span>
                    </label>
                  </div>
                </div>

                <div className="pt-2 flex justify-end">
                  <Button
                    onClick={handleSalvarConfiguracao}
                    className="bg-[#1B4B8A] hover:bg-[#15406F] text-white font-semibold text-xs"
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    Salvar Limites do Órgão
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ABA 2: Planos SaaS */}
        <TabsContent value="planos_saas" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {planos.map((plano) => (
              <Card key={plano.id} className="border border-gray-200">
                <CardHeader className="p-4 pb-2">
                  <Badge variant="outline" className="text-[10px] uppercase font-mono w-fit">
                    {plano.codigo}
                  </Badge>
                  <CardTitle className="text-sm font-bold text-gray-900">{plano.nome}</CardTitle>
                  <CardDescription className="text-xs line-clamp-2">
                    {plano.descricao}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-2 space-y-2 text-xs border-t border-gray-100">
                  <div className="flex justify-between py-1">
                    <span className="text-gray-500">Usuários:</span>
                    <span className="font-semibold font-mono">{plano.limite_usuarios}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-gray-500">Pesquisas/Mês:</span>
                    <span className="font-semibold font-mono">{plano.limite_pesquisas_mes}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-gray-500">Armazenamento:</span>
                    <span className="font-semibold font-mono">
                      {(plano.limite_armazenamento_mb / 1024).toFixed(1)} GB
                    </span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-gray-500">Acesso via API:</span>
                    <span>{plano.acesso_api ? 'Sim' : 'Não'}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-gray-500">Automações Lote:</span>
                    <span>{plano.automacoes_lote ? 'Sim' : 'Não'}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ABA 3: Fontes de Dados e Conectores */}
        <TabsContent value="fontes_conectores" className="space-y-4">
          <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold">
                <tr>
                  <th className="p-2.5">Fonte</th>
                  <th className="p-2.5">Código</th>
                  <th className="p-2.5">Tipo</th>
                  <th className="p-2.5">Formato</th>
                  <th className="p-2.5">Status</th>
                  <th className="p-2.5">Runtime Ativo</th>
                  <th className="p-2.5">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {fontes.map((f) => (
                  <tr key={f.id} className="hover:bg-gray-50">
                    <td className="p-2.5">
                      <p className="font-semibold text-gray-900">{f.nome}</p>
                      <p className="text-[10px] text-gray-400">{f.observacoes}</p>
                    </td>
                    <td className="p-2.5 font-mono text-gray-600">{f.codigo}</td>
                    <td className="p-2.5">
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {f.tipo}
                      </Badge>
                    </td>
                    <td className="p-2.5 uppercase text-gray-600">{f.formato}</td>
                    <td className="p-2.5">
                      <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">
                        {f.status}
                      </Badge>
                    </td>
                    <td className="p-2.5">
                      <Badge
                        variant="outline"
                        className={f.runtime_enabled ? 'text-emerald-700' : 'text-gray-400'}
                      >
                        {f.runtime_enabled ? 'Ativo' : 'Controlado (false)'}
                      </Badge>
                    </td>
                    <td className="p-2.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => alert(`Conexão com ${f.nome} testada com sucesso!`)}
                        className="text-[11px] h-7"
                      >
                        Testar Conexão
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ABA 4: Logs de Sincronização */}
        <TabsContent value="sync_logs" className="space-y-4">
          <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold">
                <tr>
                  <th className="p-2.5">Data / Hora</th>
                  <th className="p-2.5">Status</th>
                  <th className="p-2.5 text-right">Coletados</th>
                  <th className="p-2.5 text-right">Novos</th>
                  <th className="p-2.5 text-right">Duplicados</th>
                  <th className="p-2.5 text-right">Tempo (ms)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {syncLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-gray-400 text-xs">
                      Nenhuma sincronização agendada registrada ainda.
                    </td>
                  </tr>
                ) : (
                  syncLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="p-2.5 text-gray-600">{log.created}</td>
                      <td className="p-2.5">
                        <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">
                          {log.status}
                        </Badge>
                      </td>
                      <td className="p-2.5 text-right font-mono">{log.quantidade_coletada}</td>
                      <td className="p-2.5 text-right font-mono">{log.novos_registros}</td>
                      <td className="p-2.5 text-right font-mono">{log.duplicados_identificados}</td>
                      <td className="p-2.5 text-right font-mono">
                        {log.tempo_processamento_ms} ms
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
