import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  FileSpreadsheet,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Save,
  Calculator,
  ShieldCheck,
  TrendingDown,
  Layers,
  Info,
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
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  obterPesquisa,
  listarReferencias,
  obterCalculoDaPesquisa,
  salvarCalculo,
} from '@/services/apiService'
import type { Pesquisa, Referencia, MetodoCalculo, Calculo } from '@/types'
import { executarMotorCalculo, formatarMoeda, formatarData } from '@/lib/calculoEngine'

export default function PesquisaCalculo() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [pesquisa, setPesquisa] = useState<Pesquisa | null>(null)
  const [referencias, setReferencias] = useState<Referencia[]>([])
  const [calculoSalvo, setCalculoSalvo] = useState<Calculo | null>(null)
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)

  // Parâmetros do motor
  const [metodo, setMetodo] = useState<MetodoCalculo>('mediana')
  const [justificativa, setJustificativa] = useState(
    'Adotada a MEDIANA dos preços válidos aceitos conforme Lei nº 14.133/2021, Art. 23, §1º, por refletir com maior robustez estatística a tendência central de mercado, imune a eventuais assimetrias.',
  )

  useEffect(() => {
    if (!id) return
    const carregar = async () => {
      setLoading(true)
      try {
        const [p, refs, calc] = await Promise.all([
          obterPesquisa(id),
          listarReferencias(id),
          obterCalculoDaPesquisa(id),
        ])
        setPesquisa(p)
        setReferencias(refs)
        setCalculoSalvo(calc)
        if (calc?.metodo) setMetodo(calc.metodo)
        if (calc?.justificativa_metodo) setJustificativa(calc.justificativa_metodo)
      } finally {
        setLoading(false)
      }
    }
    carregar()
  }, [id])

  if (loading || !pesquisa) {
    return (
      <div className="p-8 text-center text-xs text-gray-500">Carregando motor de cálculo...</div>
    )
  }

  const demandaItem = pesquisa.expand?.demanda_item_id
  const quantidadeDemandada = demandaItem?.quantidade || 1
  const aceitos = referencias.filter((r) => r.status_revisao === 'aceito')
  const excluidos = referencias.filter((r) => r.status_revisao === 'excluido')

  // Execução Determinística do Motor (Seção 5 & Modelo Cesta)
  const resultado = executarMotorCalculo(aceitos, quantidadeDemandada, metodo, justificativa)
  resultado.juizo_critico.expurgadas_count = excluidos.length

  const handleSalvarCalculo = async () => {
    if (!id) return
    setSalvando(true)
    try {
      const calcData: Partial<Calculo> = {
        id: calculoSalvo?.id,
        pesquisa_id: id,
        metodo,
        valores_entrada: resultado.entradas,
        arredondamento: resultado.arredondamento,
        resultado: resultado.preco_referencia || 0,
        total_item: resultado.total_item || 0,
        total_demanda: resultado.total_demanda || 0,
        versao_motor: resultado.versao_motor,
        justificativa_metodo: justificativa,
        status: 'aprovado',
        metricas_n: resultado.metricas_n,
        analise_outliers: {
          juizo_critico: resultado.juizo_critico,
          estatisticas_saneadas: resultado.estatisticas_saneadas,
          outliers: resultado.outliers,
        },
      }
      const saved = await salvarCalculo(calcData)
      setCalculoSalvo(saved)
      alert('Memória de cálculo determinística homologada e aprovada com sucesso!')
    } catch (err: any) {
      alert(`Erro ao aprovar cálculo: ${err?.message}`)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/app/pesquisas/${pesquisa.id}`)}
            className="text-gray-600"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Voltar à Pesquisa
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-gray-900 font-mono">
                Memória de Cálculo Determinística
              </h1>
              <Badge className="bg-[#1B4B8A] text-white text-[11px]">
                {resultado.versao_motor}
              </Badge>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Pesquisa: <strong>{pesquisa.numero}</strong> • Item: {demandaItem?.descricao}
            </p>
          </div>
        </div>

        <Button
          onClick={handleSalvarCalculo}
          disabled={salvando || !resultado.amostra_valida}
          className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold"
        >
          <CheckCircle2 className="h-4 w-4 mr-1.5" />
          {salvando ? 'Homologando...' : 'Aprovar Cálculo e Atualizar Dossiê'}
        </Button>
      </div>

      {/* Regra de Ouro da Especificação: Aviso do Caso Hatch */}
      <Alert className="border-blue-300 bg-blue-50 text-blue-950 text-xs">
        <Info className="h-4 w-4 text-blue-700" />
        <AlertTitle className="text-xs font-semibold">
          Regra Determinística Fundamental (Seção 1 & 5 da Especificação):
        </AlertTitle>
        <AlertDescription className="text-xs text-blue-900 leading-relaxed mt-1">
          Total do item ={' '}
          <strong>quantidade demandada ({quantidadeDemandada}) × preço de referência</strong>. É
          expressamente vedado somar quantidades das contratações pesquisadas. Se a amostra for
          insuficiente, o preço de referência é marcado como <strong>AUSENTE</strong>, nunca
          exibindo valor zero.
        </AlertDescription>
      </Alert>

      {/* Alerta de Amostra Insuficiente se n < 3 */}
      {resultado.metricas_n.alerta_insuficiencia && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 text-xs">
          <AlertTriangle className="h-4 w-4 text-amber-700" />
          <AlertTitle className="text-xs font-semibold">Sinalização de Amostra Reduzida</AlertTitle>
          <AlertDescription className="text-xs text-amber-800">
            {resultado.metricas_n.alerta_insuficiencia}
          </AlertDescription>
        </Alert>
      )}

      {/* Grid de Totais e Preço de Referência */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-gray-200 bg-white">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Preço de Referência Unitário</CardDescription>
            <CardTitle className="text-2xl font-bold text-gray-900">
              {resultado.preco_referencia !== null
                ? formatarMoeda(resultado.preco_referencia)
                : 'AUSENTE (amostra insuficiente)'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-[11px] text-gray-500">
            Medida de Tendência Central:{' '}
            <strong className="uppercase text-gray-800">{metodo}</strong>
          </CardContent>
        </Card>

        <Card className="border-gray-200 bg-white">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Quantidade Demandada</CardDescription>
            <CardTitle className="text-2xl font-bold text-[#1B4B8A]">
              {quantidadeDemandada} {demandaItem?.unidade || 'un'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-[11px] text-gray-500">
            Versão congelada da demanda
          </CardContent>
        </Card>

        <Card className="border-gray-200 bg-emerald-50/50 border-emerald-200">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs text-emerald-800">
              Valor Total Estimado do Item
            </CardDescription>
            <CardTitle className="text-2xl font-bold text-emerald-900">
              {resultado.total_item !== null ? formatarMoeda(resultado.total_item) : 'AUSENTE'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-[11px] text-emerald-800">
            Cálculo: {quantidadeDemandada} × {formatarMoeda(resultado.preco_referencia)}
          </CardContent>
        </Card>
      </div>

      {/* NOVO BLOCO: Juízo Crítico (Modelo Cesta de Preços) */}
      <Card className="border-gray-200 overflow-hidden">
        <CardHeader className="bg-gray-50 border-b border-gray-100 pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">
              Juízo Crítico das Amostras (Parâmetros Cesta de Preços)
            </CardTitle>
            <Badge variant="outline" className="text-[10px]">
              Limites 70% e 30% da Mediana
            </Badge>
          </div>
          <CardDescription className="text-xs">
            Amostras fora dos limites de 70% e 30% da mediana ficam assinaladas como
            suspeitas/críticas — expurgo exige decisão humana justificada.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-center text-xs">
              <thead className="bg-gray-100 text-gray-700 font-semibold text-[11px] border-b">
                <tr>
                  <th className="p-2.5">Nº Coletadas</th>
                  <th className="p-2.5">Desvio-Padrão</th>
                  <th className="p-2.5">Mediana</th>
                  <th className="p-2.5">Limite Inferior (70%)</th>
                  <th className="p-2.5">Limite Superior (30%)</th>
                  <th className="p-2.5">Críticas</th>
                  <th className="p-2.5">Amostras Expurgadas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 font-mono">
                <tr>
                  <td className="p-2.5 font-bold">{resultado.juizo_critico.n_coletadas}</td>
                  <td className="p-2.5">{resultado.juizo_critico.desvio_padrao.toFixed(2)}</td>
                  <td className="p-2.5 font-bold">
                    {formatarMoeda(resultado.juizo_critico.mediana)}
                  </td>
                  <td className="p-2.5 text-gray-700">
                    {formatarMoeda(resultado.juizo_critico.limite_inferior)}
                  </td>
                  <td className="p-2.5 text-gray-700">
                    {formatarMoeda(resultado.juizo_critico.limite_superior)}
                  </td>
                  <td className="p-2.5">
                    {resultado.juizo_critico.criticas_count > 0 ? (
                      <span className="inline-block px-2 py-0.5 rounded bg-red-600 text-white font-bold text-xs">
                        {resultado.juizo_critico.criticas_count}
                      </span>
                    ) : (
                      <span className="text-gray-500">0</span>
                    )}
                  </td>
                  <td className="p-2.5 font-bold text-gray-800">
                    {resultado.juizo_critico.expurgadas_count}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* NOVO BLOCO: Método Estatístico Aplicado às Amostras Saneadas */}
      <Card className="border-gray-200 overflow-hidden">
        <CardHeader className="bg-gray-50 border-b border-gray-100 pb-3">
          <CardTitle className="text-sm font-semibold">
            Método Estatístico Aplicado às Amostras Saneadas
          </CardTitle>
          <CardDescription className="text-xs">
            Medidas consolidadas sobre os dados válidos após saneamento e triagem humana
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-center text-xs">
              <thead className="bg-gray-100 text-gray-700 font-semibold text-[11px] border-b">
                <tr>
                  <th className="p-2.5">Nº Amostras Válidas</th>
                  <th className="p-2.5">Desvio-Padrão</th>
                  <th className="p-2.5">Coef. Variação (CV%)</th>
                  <th className="p-2.5">Menor Preço</th>
                  <th className="p-2.5">Média Aritmética</th>
                  <th className="p-2.5">Mediana (Padrão)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 font-mono">
                <tr>
                  <td className="p-2.5 font-bold text-emerald-800">
                    {resultado.estatisticas_saneadas.n_validas}
                  </td>
                  <td className="p-2.5">
                    {resultado.estatisticas_saneadas.desvio_padrao.toFixed(2)}
                  </td>
                  <td className="p-2.5 font-bold">
                    {resultado.estatisticas_saneadas.coeficiente_variacao.toFixed(2)}%
                  </td>
                  <td className="p-2.5">
                    {formatarMoeda(resultado.estatisticas_saneadas.menor_preco)}
                  </td>
                  <td className="p-2.5">{formatarMoeda(resultado.estatisticas_saneadas.media)}</td>
                  <td className="p-2.5 font-bold text-[#1B4B8A]">
                    {formatarMoeda(resultado.estatisticas_saneadas.mediana)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Métricas N Independentes */}
      <Card className="border-gray-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            Métricas de Suficiência Amostral (Exibidas Separadamente)
          </CardTitle>
          <CardDescription className="text-xs">
            Conforme seção 1: n de preços, n de transações e n de plataformas apurados
            individualmente
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="p-3 rounded-lg bg-gray-50 border border-gray-100">
              <span className="text-xl font-bold text-gray-900 font-mono">
                {resultado.metricas_n.n_precos}
              </span>
              <p className="text-[11px] text-gray-600 mt-0.5">Preços Válidos</p>
            </div>
            <div className="p-3 rounded-lg bg-gray-50 border border-gray-100">
              <span className="text-xl font-bold text-gray-900 font-mono">
                {resultado.metricas_n.n_transacoes}
              </span>
              <p className="text-[11px] text-gray-600 mt-0.5">Transações Distintas</p>
            </div>
            <div className="p-3 rounded-lg bg-gray-50 border border-gray-100">
              <span className="text-xl font-bold text-gray-900 font-mono">
                {resultado.metricas_n.n_plataformas}
              </span>
              <p className="text-[11px] text-gray-600 mt-0.5">Plataformas Utilizadas</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Seleção do Método e Justificativa */}
      <Card className="border-gray-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Método e Regra Aplicável</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-700">
                Método de Tendência Central
              </Label>
              <Select value={metodo} onValueChange={(val: MetodoCalculo) => setMetodo(val)}>
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mediana">
                    Mediana (Recomendado pela IN 65 e Lei 14.133)
                  </SelectItem>
                  <SelectItem value="media">Média Aritmética</SelectItem>
                  <SelectItem value="menor">Menor Preço Válido</SelectItem>
                  <SelectItem value="maior">Maior Preço (Casos especiais)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-gray-700">
                Política de Arredondamento
              </Label>
              <Input
                disabled
                value={resultado.arredondamento}
                className="text-xs bg-gray-50 font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-gray-700">
              Justificativa Obrigatória do Método (Registrada em Dossiê)
            </Label>
            <Textarea
              rows={3}
              value={justificativa}
              onChange={(e) => setJustificativa(e.target.value)}
              className="text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* Tabela de Amostras Aceitas */}
      <Card className="border-gray-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            Amostra Efetivamente Aceita para o Cálculo ({aceitos.length})
          </CardTitle>
          <CardDescription className="text-xs">
            Apenas referências aceitas compõem os dados de entrada
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-50 border-y text-gray-600 font-medium">
                <tr>
                  <th className="p-3">Fonte</th>
                  <th className="p-3">Natureza</th>
                  <th className="p-3">Fornecedor</th>
                  <th className="p-3">Data</th>
                  <th className="p-3 text-right">Valor Unitário</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {aceitos.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50/50">
                    <td className="p-3 uppercase font-mono font-semibold text-[#1B4B8A]">
                      {c.fonte}
                    </td>
                    <td className="p-3 capitalize">{c.natureza_preco}</td>
                    <td className="p-3 max-w-xs truncate">{c.fornecedor}</td>
                    <td className="p-3">{formatarData(c.data_contratacao)}</td>
                    <td className="p-3 text-right font-bold text-gray-900 font-mono">
                      {formatarMoeda(c.valor_original)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Memória de Cálculo Auditável */}
      <Card className="border-gray-200 bg-gray-900 text-white">
        <CardHeader className="pb-2 border-b border-gray-800">
          <CardTitle className="text-xs font-mono tracking-wider uppercase text-emerald-400">
            Dossiê de Memória de Cálculo Imutável
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap text-gray-300">
            {resultado.memoria_texto}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
