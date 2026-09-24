import React, { useState, useEffect } from 'react'
import {
  ShieldCheck,
  Scale,
  FileCheck,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Settings,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/context/AuthContext'
import {
  obterOrgaoConfiguracao,
  salvarOrgaoConfiguracao,
  registrarAuditoria,
} from '@/services/apiService'
import type { OrgaoConfiguracao } from '@/types'

export default function RegulamentosOrgao() {
  const { activeOrg } = useAuth()
  const [config, setConfig] = useState<Partial<OrgaoConfiguracao>>({
    quantidade_minima_precos: 3,
    metodo_outlier_padrao: 'distancia_mediana',
    limite_outlier_inferior: 70,
    limite_outlier_superior: 130,
    metodo_calculo_padrao: 'mediana',
    exigir_justificativa_insuficiente: true,
    priorizar_fontes_governamentais: true,
    permitir_cotacao_fornecedor: true,
    periodo_maximo_meses: 12,
    cabecalho_relatorio: 'ESTADO DE SÃO PAULO — PREFEITURA MUNICIPAL',
    rodape_relatorio:
      'Documento gerado em conformidade com o Art. 23 da Lei Federal nº 14.133/2021.',
    responsavel_assinatura_nome: 'Carlos Eduardo Silveira',
    responsavel_assinatura_cargo: 'Agente de Contratação / Pesquisador de Preços',
  })
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    async function carregar() {
      if (!activeOrg?.id) return
      setCarregando(true)
      try {
        const cfg = await obterOrgaoConfiguracao(activeOrg.id)
        if (cfg) {
          setConfig(cfg)
        }
      } catch (e) {
        console.error('Erro ao carregar configurações do órgão:', e)
      } finally {
        setCarregando(false)
      }
    }
    carregar()
  }, [activeOrg?.id])

  const handleSalvar = async () => {
    if (!activeOrg?.id) return
    try {
      await salvarOrgaoConfiguracao({
        ...config,
        organizacao_id: activeOrg.id,
      })
      alert('Regulamentos e regras de pesquisa salvos com sucesso!')

      await registrarAuditoria({
        evento: 'Atualização de regulamentos e regras de pesquisa do órgão',
        objeto_tipo: 'orgao_configuracao',
        objeto_id: activeOrg.id,
        antes_depois: config,
      })
    } catch (err: any) {
      alert(`Erro ao salvar: ${err?.message}`)
    }
  }

  if (carregando) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        Carregando regulamentos do órgão...
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-12 max-w-5xl mx-auto">
      <div className="border-b border-gray-200 pb-4">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <Scale className="h-5 w-5 text-[#1B4B8A]" />
          Regulamento Local & Parâmetros Normativos da Pesquisa
        </h1>
        <p className="text-xs text-gray-500">
          A Lei Federal nº 14.133/2021 e a IN SEGES/ME nº 65/2021 são referências configuráveis pelo
          órgão contratante.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card 1: Quantidade Mínima e Outliers */}
        <Card className="border border-gray-200">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-bold text-gray-800 uppercase">
              Amostra Mínima & Detecção de Outliers
            </CardTitle>
            <CardDescription className="text-[11px]">
              Conjunto de preços configurável — nunca assumir regra estática cega.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-2 space-y-3 text-xs">
            <div className="space-y-1">
              <label className="font-semibold text-gray-700">Quantidade Mínima de Preços:</label>
              <Input
                type="number"
                value={config.quantidade_minima_precos || 3}
                onChange={(e) =>
                  setConfig({ ...config, quantidade_minima_precos: Number(e.target.value) })
                }
                className="text-xs"
              />
              <p className="text-[10px] text-gray-500">
                Abaixo dessa quantidade, o sistema bloqueia e exige justificativa formal.
              </p>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-gray-700">Metodologia para Outliers:</label>
              <select
                value={config.metodo_outlier_padrao || 'distancia_mediana'}
                onChange={(e) =>
                  setConfig({ ...config, metodo_outlier_padrao: e.target.value as any })
                }
                className="w-full border rounded p-2 text-xs bg-white"
              >
                <option value="distancia_mediana">Distância da Mediana (70% a 130%)</option>
                <option value="iqr">Intervalo Interquartil (IQR Boxplot 1.5)</option>
                <option value="desvio_padrao">Desvio-Padrão (|Z| &gt; 2.0)</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="font-semibold text-gray-700">Limite Inferior (%):</label>
                <Input
                  type="number"
                  value={config.limite_outlier_inferior || 70}
                  onChange={(e) =>
                    setConfig({ ...config, limite_outlier_inferior: Number(e.target.value) })
                  }
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="font-semibold text-gray-700">Limite Superior (%):</label>
                <Input
                  type="number"
                  value={config.limite_outlier_superior || 130}
                  onChange={(e) =>
                    setConfig({ ...config, limite_outlier_superior: Number(e.target.value) })
                  }
                  className="text-xs"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Card 2: Identidade do Relatório Oficial */}
        <Card className="border border-gray-200">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-bold text-gray-800 uppercase">
              Identidade Visual & Assinatura nos Relatórios
            </CardTitle>
            <CardDescription className="text-[11px]">
              Textos oficiais aplicados no cabeçalho e rodapé do Relatório Técnico de 16 Seções.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-2 space-y-3 text-xs">
            <div className="space-y-1">
              <label className="font-semibold text-gray-700">Cabeçalho Institucional:</label>
              <Input
                value={config.cabecalho_relatorio || ''}
                onChange={(e) => setConfig({ ...config, cabecalho_relatorio: e.target.value })}
                className="text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-gray-700">Rodapé de Autenticidade:</label>
              <Input
                value={config.rodape_relatorio || ''}
                onChange={(e) => setConfig({ ...config, rodape_relatorio: e.target.value })}
                className="text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="font-semibold text-gray-700">Nome do Servidor:</label>
                <Input
                  value={config.responsavel_assinatura_nome || ''}
                  onChange={(e) =>
                    setConfig({ ...config, responsavel_assinatura_nome: e.target.value })
                  }
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="font-semibold text-gray-700">Cargo / Função:</label>
                <Input
                  value={config.responsavel_assinatura_cargo || ''}
                  onChange={(e) =>
                    setConfig({ ...config, responsavel_assinatura_cargo: e.target.value })
                  }
                  className="text-xs"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={handleSalvar}
          className="bg-[#1B4B8A] hover:bg-[#15406F] text-white font-semibold text-xs"
        >
          <CheckCircle2 className="h-4 w-4 mr-1.5" />
          Salvar Regulamentos do Órgão
        </Button>
      </div>
    </div>
  )
}
