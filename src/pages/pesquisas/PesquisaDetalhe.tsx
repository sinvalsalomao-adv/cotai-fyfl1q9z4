import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  FileText,
  Search,
  ShoppingCart,
  BarChart3,
  Scale,
  FileCheck,
  ShieldCheck,
  History,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Trash2,
  Eye,
  Download,
  Printer,
  Sparkles,
  ExternalLink,
  ChevronRight,
  Plus,
  RefreshCw,
  Building,
  Tag,
  Layers,
  Percent,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Slider } from '@/components/ui/slider'
import { TermoDestacado, calcularDiasVencimento } from '@/components/TermoDestacado'
import { useAuth } from '@/context/AuthContext'
import {
  obterPesquisa,
  listarReferenciasDaPesquisa,
  criarReferencia,
  atualizarReferencia,
  obterCalculoPorPesquisa,
  salvarCalculo,
  registrarAuditoria,
  obterOrgaoConfiguracao,
} from '@/services/apiService'
import type {
  Pesquisa,
  Referencia,
  Calculo,
  MetodoCalculo,
  StatusRevisao,
  OrgaoConfiguracao,
} from '@/types'
import {
  executarMotorCalculo,
  ResultadoCalculo,
  formatarMoeda,
  formatarData,
  PriceNormalizationEngine,
} from '@/lib/calculoEngine'
import { PriceConnectorsHub } from '@/lib/priceConnectorsHub'
import { ExporterService } from '@/lib/exporterService'
import ModalIdentificacaoItem from '@/components/ModalIdentificacaoItem'
import ModalImportacaoItens from '@/components/ModalImportacaoItens'
import pb from '@/lib/pocketbase/client'

export default function PesquisaDetalhe() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { usuario, activeOrg } = useAuth()

  const [pesquisa, setPesquisa] = useState<Pesquisa | null>(null)
  const [referencias, setReferencias] = useState<Referencia[]>([])
  const [calculoSalvo, setCalculoSalvo] = useState<Calculo | null>(null)
  const [configOrgao, setConfigOrgao] = useState<OrgaoConfiguracao | null>(null)
  const [carregando, setCarregando] = useState(true)

  // Abas de Workspace
  const [abaAtiva, setAbaAtiva] = useState<
    | 'itens'
    | 'resultados'
    | 'cesta'
    | 'estatistica'
    | 'mapa'
    | 'curva_abc'
    | 'relatorio'
    | 'evidencias'
    | 'historico'
  >('resultados')

  // Estado do Motor de Preços
  const [metodoSelecionado, setMetodoSelecionado] = useState<MetodoCalculo>('mediana')
  const [justificativaMetodo, setJustificativaMetodo] = useState('')
  const [resultadoMotor, setResultadoMotor] = useState<ResultadoCalculo | null>(null)
  const [memoriaAberta, setMemoriaAberta] = useState(false)

  // Filtros e refinamento padrão Cesta de Preços
  const [filtroTexto, setFiltroTexto] = useState('')
  const [filtroFonte, setFiltroFonte] = useState('todas')
  const [filtroSituacao, setFiltroSituacao] = useState<
    'todas' | 'selecionados' | 'pendentes' | 'excluidos'
  >('todas')
  const [filtroPeriodoMeses, setFiltroPeriodoMeses] = useState<number>(12)
  const [filtroPorteOpcao, setFiltroPorteOpcao] = useState<'TODAS' | 'ME_EPP'>('TODAS')
  const [filtroUf, setFiltroUf] = useState('')
  const [filtroPrecoMin, setFiltroPrecoMin] = useState('')
  const [filtroPrecoMax, setFiltroPrecoMax] = useState('')
  const [filtroPrecoSlider, setFiltroPrecoSlider] = useState<[number, number]>([0, 1000])
  const [sliderPrecoMaximoAbsoluto, setSliderPrecoMaximoAbsoluto] = useState<number>(1000)
  const [ordenacao, setOrdenacao] = useState<'menor_preco' | 'maior_preco' | 'data_recente'>(
    'menor_preco',
  )
  const [filtroApenasValidos, setFiltroApenasValidos] = useState(false)
  const [painelRefinarAberto, setPainelRefinarAberto] = useState(true)

  // Modais
  const [modalIdentificacaoAberto, setModalIdentificacaoAberto] = useState(false)
  const [modalImportacaoAberto, setModalImportacaoAberto] = useState(false)
  const [modalJustificarExclusao, setModalJustificarExclusao] = useState<{
    aberto: boolean
    refId: string
    motivo: string
  }>({ aberto: false, refId: '', motivo: '' })

  const [consultandoFontes, setConsultandoFontes] = useState(false)

  // Carrega os dados da pesquisa
  useEffect(() => {
    async function carregarDados() {
      if (!id) return
      setCarregando(true)
      try {
        const [pesq, refs, calc, cfg] = await Promise.all([
          obterPesquisa(id),
          listarReferenciasDaPesquisa(id),
          obterCalculoPorPesquisa(id),
          activeOrg?.id ? obterOrgaoConfiguracao(activeOrg.id) : null,
        ])
        setPesquisa(pesq)
        setReferencias(refs)
        setCalculoSalvo(calc)
        setConfigOrgao(cfg as any)

        if (calc?.metodo) {
          setMetodoSelecionado(calc.metodo)
          setJustificativaMetodo(calc.justificativa_metodo || '')
        }
      } catch (err) {
        console.error('Erro ao carregar pesquisa:', err)
      } finally {
        setCarregando(false)
      }
    }
    carregarDados()
  }, [id, activeOrg?.id])

  // Atualiza slider quando as referências forem carregadas
  useEffect(() => {
    if (referencias.length > 0) {
      const vals = referencias
        .map((r) => r.valor_normalizado || r.valor_original)
        .filter((v) => !isNaN(v) && v >= 0)
      if (vals.length > 0) {
        const min = Math.min(...vals)
        const max = Math.max(...vals)
        const teto = Math.ceil(max * 1.05) || 100
        setSliderPrecoMaximoAbsoluto(teto)
        if (!filtroPrecoMin && !filtroPrecoMax) {
          setFiltroPrecoSlider([min, teto])
        }
      }
    }
  }, [referencias])

  const handleAplicarFaixaPreco = () => {
    setFiltroPrecoMin(filtroPrecoSlider[0].toFixed(2))
    setFiltroPrecoMax(filtroPrecoSlider[1].toFixed(2))
  }

  const handleLimparFiltros = () => {
    setFiltroTexto('')
    setFiltroFonte('todas')
    setFiltroSituacao('todas')
    setFiltroPeriodoMeses(12)
    setFiltroPorteOpcao('TODAS')
    setFiltroUf('')
    setFiltroPrecoMin('')
    setFiltroPrecoMax('')
    setFiltroPrecoSlider([0, sliderPrecoMaximoAbsoluto])
    setOrdenacao('menor_preco')
  }

  // Recalcula o motor de preços sempre que referências, método ou justificativa mudam
  useEffect(() => {
    if (!pesquisa) return
    const qtdItem = pesquisa.expand?.demanda_item_id?.quantidade || 1000

    // Filtra amostras aceitas para a composição estatística
    const aceitas = referencias.filter((r) => r.status_revisao === 'aceito')

    const res = executarMotorCalculo(aceitas, qtdItem, metodoSelecionado, justificativaMetodo, {
      quantidadeMinima: configOrgao?.quantidade_minima_precos || 3,
      metodoOutlier: configOrgao?.metodo_outlier_padrao || 'distancia_mediana',
      limiteInferiorPercentual: configOrgao?.limite_outlier_inferior || 70,
      limiteSuperiorPercentual: configOrgao?.limite_outlier_superior || 130,
    })
    setResultadoMotor(res)
  }, [pesquisa, referencias, metodoSelecionado, justificativaMetodo, configOrgao])

  // Ação de Consultar Fontes Automáticas (PNCP, Compras.gov, BPS, CMED, BEC-SP)
  const handleConsultarFontes = async () => {
    if (!pesquisa) return
    setConsultandoFontes(true)
    try {
      const termo =
        pesquisa.expand?.demanda_item_id?.descricao ||
        pesquisa.expand?.demanda_item_id?.principio_ativo ||
        'Dipirona'

      const resultadoBusca = await PriceConnectorsHub.consultarMultiplasFontes(pesquisa.id, {
        termo,
        periodo_meses: configOrgao?.periodo_maximo_meses || 12,
      })

      // Filtrar amostras novas que ainda não existam na pesquisa
      const novasAmostrasParaGravar = resultadoBusca.todosRegistros.filter((reg) => {
        return !referencias.some(
          (r) =>
            r.fonte === reg.fonte &&
            (r.id_externo === reg.id_externo || r.fornecedor === reg.fornecedor),
        )
      })

      // Gravação em lote única via endpoint atômico POST /backend/v1/price-results/batch-save
      // com retentativa com backoff curto (máx 3 tentativas)
      if (novasAmostrasParaGravar.length > 0) {
        const baseUrl = pb.baseUrl || ''
        const urlBatch = baseUrl
          ? `${baseUrl}/backend/v1/price-results/batch-save`
          : `/backend/v1/price-results/batch-save`

        const payloadBatch = {
          pesquisa_id: pesquisa.id,
          amostras: novasAmostrasParaGravar.map((reg) => ({
            fonte: reg.fonte,
            id_externo: reg.id_externo,
            item_externo: reg.item_externo,
            natureza_preco: reg.natureza_preco,
            valor_original: reg.valor_original,
            valor_normalizado: reg.valor_normalizado,
            unidade: reg.unidade,
            quantidade: reg.quantidade,
            data_contratacao: reg.data_contratacao,
            fornecedor: reg.fornecedor,
            cnpj_fornecedor: reg.cnpj_fornecedor,
            orgao_comprador: reg.orgao_comprador,
            municipio_uf: reg.municipio_uf,
            modalidade_licitacao: reg.modalidade_licitacao,
            processo_origem: reg.processo_origem,
            marca_modelo: reg.marca_modelo,
            codigo_catalogo: reg.codigo_catalogo,
            url: reg.url,
            hash: reg.hash,
            status_revisao: reg.status_revisao,
            source_identifier: reg.source_identifier,
            source_capture_date: reg.source_capture_date,
            confidence_score: reg.confidence_score,
            similarity_score: reg.similarity_score,
            possivel_duplicata: reg.possivel_duplicata,
            detalhes_tecnicos: reg.detalhes_tecnicos || {},
          })),
        }

        const authToken = pb.authStore?.token || ''
        let batchSucesso = false
        let tentativasBatch = 0
        const maxTentativasBatch = 3

        while (!batchSucesso && tentativasBatch < maxTentativasBatch) {
          tentativasBatch++
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 15000)
            const respBatch = await fetch(urlBatch, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...(authToken ? { Authorization: authToken } : {}),
              },
              body: JSON.stringify(payloadBatch),
              signal: controller.signal,
            })
            clearTimeout(timeoutId)

            if (respBatch.ok) {
              const resJson = await respBatch.json()
              batchSucesso = true
              if (resJson.divergencia) {
                console.warn(
                  `[BATCH-SAVE] Divergência na pesquisa ${pesquisa.id}: recebidas=${resJson.recebidas}, gravadas=${resJson.gravadas}`,
                )
              }
              break
            } else {
              console.warn(
                `[BATCH-SAVE] Tentativa ${tentativasBatch} retornou status ${respBatch.status}`,
              )
            }
          } catch (errBatch: any) {
            console.warn(
              `[BATCH-SAVE] Tentativa ${tentativasBatch} falhou:`,
              errBatch?.message || errBatch,
            )
          }

          if (!batchSucesso && tentativasBatch < maxTentativasBatch) {
            await new Promise((resolve) => setTimeout(resolve, 300 * tentativasBatch))
          }
        }
      }

      const atualizadas = await listarReferenciasDaPesquisa(pesquisa.id)
      setReferencias(atualizadas)

      await registrarAuditoria({
        evento: `Consulta de preços executada nas fontes com ${resultadoBusca.todosRegistros.length} resultados`,
        objeto_tipo: 'pesquisa',
        objeto_id: pesquisa.id,
        antes_depois: {
          novas_coletadas: novasAmostrasParaGravar.length,
          fontes: resultadoBusca.resultadosPorFonte.map((r) => r.conector_codigo),
        },
      })
    } catch (err: any) {
      alert(`Erro ao consultar fontes: ${err?.message}`)
    } finally {
      setConsultandoFontes(false)
    }
  }

  // Ação: Decisão Humana sobre Preço (Aceitar / Descartar com justificativa obrigatória)
  const handleDecidirPreco = async (
    ref: Referencia,
    novoStatus: StatusRevisao,
    motivo: string = '',
  ) => {
    if (novoStatus === 'excluido' && (!motivo || motivo.trim().length < 5)) {
      setModalJustificarExclusao({ aberto: true, refId: ref.id, motivo: '' })
      return
    }

    try {
      const atualizada = await atualizarReferencia(ref.id, {
        status_revisao: novoStatus,
        motivo_exclusao: novoStatus === 'excluido' ? motivo : '',
      })

      setReferencias((prev) => prev.map((r) => (r.id === ref.id ? atualizada : r)))

      await registrarAuditoria({
        evento: `Preço ${novoStatus === 'aceito' ? 'incorporado à cesta' : 'excluído da cesta com justificativa'}`,
        objeto_tipo: 'referencia',
        objeto_id: ref.id,
        antes_depois: {
          de: ref.status_revisao,
          para: novoStatus,
          motivo,
          fornecedor: ref.fornecedor,
          valor: ref.valor_normalizado,
        },
      })
    } catch (err: any) {
      alert(`Erro ao atualizar preço: ${err?.message}`)
    }
  }

  // Salvar Cálculo Oficial
  const handleSalvarCalculo = async () => {
    if (!pesquisa || !resultadoMotor) return
    try {
      const calcData = {
        id: calculoSalvo?.id,
        pesquisa_id: pesquisa.id,
        metodo: metodoSelecionado,
        valores_entrada: resultadoMotor.entradas,
        resultado: resultadoMotor.preco_referencia || 0,
        total_item: resultadoMotor.total_item || 0,
        versao_motor: resultadoMotor.versao_motor,
        justificativa_metodo: justificativaMetodo,
        status: 'aprovado' as const,
        metricas_n: resultadoMotor.metricas_n,
        analise_outliers: resultadoMotor.outliers,
      }
      const salvo = await salvarCalculo(calcData)
      setCalculoSalvo(salvo)
      alert('Cálculo e memória estatística homologados com sucesso!')

      await registrarAuditoria({
        evento: 'Cálculo de preço de referência homologado pelo servidor',
        objeto_tipo: 'calculo',
        objeto_id: salvo.id,
        antes_depois: {
          metodo: metodoSelecionado,
          preco_unitario: resultadoMotor.preco_referencia,
          total: resultadoMotor.total_item,
        },
      })
    } catch (err: any) {
      alert(`Erro ao salvar cálculo: ${err?.message}`)
    }
  }

  // Ação de Exportar Relatório Técnico Completo de 16 Seções
  const handleExportarRelatorio = (formato: 'pdf' | 'xlsx' | 'csv' | 'docx') => {
    if (!pesquisa || !resultadoMotor) return

    const itemDesc = pesquisa.expand?.demanda_item_id?.descricao || 'Dipirona Sódica 500mg'
    const qtdItem = pesquisa.expand?.demanda_item_id?.quantidade || 1000
    const undItem = pesquisa.expand?.demanda_item_id?.unidade || 'un'

    const dados16: any = {
      orgaoNome: activeOrg?.nome || 'Prefeitura Municipal de Exemplo',
      orgaoCnpj: activeOrg?.cnpj || '11.222.333/0001-44',
      processoNumero:
        pesquisa.expand?.demanda_item_id?.expand?.demanda_id?.numero || 'PROC-2026-001',
      pesquisaNumero: pesquisa.numero,
      dataGeracao: new Date().toLocaleDateString('pt-BR'),
      responsavelNome: usuario?.name || 'Servidor Responsável',
      responsavelCargo: 'Agente de Contratação / Pesquisador de Preços',
      objeto:
        pesquisa.expand?.demanda_item_id?.expand?.demanda_id?.objeto || `Aquisição de ${itemDesc}`,
      metodologia:
        'Pesquisa realizada com base no Art. 23 da Lei Federal nº 14.133/2021 e IN SEGES/ME nº 65/2021.',
      fontesConsultadas: [
        'PNCP',
        'Compras.gov.br',
        'BPS (Ministério da Saúde)',
        'CMED (ANVISA)',
        'BEC-SP',
      ],
      itens: [
        {
          numero: 1,
          descricao: itemDesc,
          quantidade: qtdItem,
          unidade: undItem,
          precoReferencia: resultadoMotor.preco_referencia,
          totalItem: resultadoMotor.total_item,
          metodo: metodoSelecionado,
        },
      ],
      precosColetados: referencias,
      precosExcluidos: referencias.filter((r) => r.status_revisao === 'excluido'),
      estatisticas: resultadoMotor.estatisticas,
      memoriaCalculoTexto: resultadoMotor.memoria_texto,
      valorTotalEstimadoGeral: resultadoMotor.total_item,
    }

    const texto16 = ExporterService.construirTextoRelatorio16(dados16)

    if (formato === 'pdf') {
      ExporterService.imprimirOuGerarPdf(`Relatorio_Tecnico_16_${pesquisa.numero}`, texto16)
    } else if (formato === 'docx') {
      ExporterService.exportarDocx(
        `Relatorio_Tecnico_${pesquisa.numero}`,
        `Relatório Técnico de Preços — ${pesquisa.numero}`,
        texto16,
      )
    } else if (formato === 'xlsx' || formato === 'csv') {
      const colunas = [
        'Item',
        'Fonte',
        'ID Externo',
        'Descrição',
        'Fornecedor',
        'CNPJ',
        'Órgão Comprador',
        'Data Contratação',
        'Valor Original',
        'Valor Normalizado',
        'Unidade',
        'Status Revisão',
        'Motivo Exclusão',
      ]
      const linhas = referencias.map((r, i) => [
        i + 1,
        r.fonte.toUpperCase(),
        r.id_externo || 'NÃO INFORMADO',
        r.item_externo,
        r.fornecedor || 'NÃO INFORMADO',
        r.cnpj_fornecedor || 'NÃO INFORMADO',
        r.orgao_comprador || 'NÃO INFORMADO',
        formatarData(r.data_contratacao),
        r.valor_original,
        r.valor_normalizado || r.valor_original,
        r.unidade || 'un',
        r.status_revisao.toUpperCase(),
        r.motivo_exclusao || '',
      ])

      if (formato === 'xlsx') {
        ExporterService.exportarXlsx(`Pesquisa_Precos_${pesquisa.numero}`, colunas, linhas)
      } else {
        ExporterService.exportarCsv(`Pesquisa_Precos_${pesquisa.numero}`, colunas, linhas)
      }
    }
  }

  if (carregando) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        Carregando workspace da pesquisa de preços...
      </div>
    )
  }

  if (!pesquisa) {
    return (
      <div className="p-8 text-center text-sm text-red-500">
        Pesquisa não encontrada. <Button onClick={() => navigate('/pesquisas')}>Voltar</Button>
      </div>
    )
  }

  const itemAtual = pesquisa.expand?.demanda_item_id
  const termoPesquisado =
    itemAtual?.descricao || itemAtual?.principio_ativo || pesquisa?.numero || ''

  const totalColetados = referencias.length
  const totalSelecionados = referencias.filter((r) => r.status_revisao === 'aceito').length
  const totalExcluidos = referencias.filter((r) => r.status_revisao === 'excluido').length
  const totalPendentes = referencias.filter((r) => r.status_revisao === 'pendente').length

  // Filtragem unificada na grade da página de detalhe
  const referenciasFiltradas = referencias
    .filter((r) => {
      // 1. Fonte
      if (filtroFonte !== 'todas') {
        const fNormal = r.fonte?.toLowerCase() || ''
        const filtroNormal = filtroFonte.toLowerCase()
        if (!fNormal.includes(filtroNormal) && !filtroNormal.includes(fNormal)) {
          return false
        }
      }

      // 2. Situação
      if (filtroSituacao === 'selecionados' && r.status_revisao !== 'aceito') return false
      if (filtroSituacao === 'excluidos' && r.status_revisao !== 'excluido') return false
      if (filtroSituacao === 'pendentes' && r.status_revisao !== 'pendente') return false

      // 3. Período em meses
      if (filtroPeriodoMeses > 0 && r.data_contratacao) {
        const dataAmostra = new Date(r.data_contratacao)
        if (!isNaN(dataAmostra.getTime())) {
          const agora = new Date()
          const limite = new Date(agora)
          limite.setMonth(limite.getMonth() - filtroPeriodoMeses)
          if (dataAmostra < limite) return false
        }
      }

      // 4. Porte ME / EPP
      if (filtroPorteOpcao === 'ME_EPP') {
        const forn = (r.fornecedor || '').toLowerCase()
        const det =
          typeof r.detalhes_tecnicos === 'object'
            ? JSON.stringify(r.detalhes_tecnicos).toLowerCase()
            : String(r.detalhes_tecnicos || '').toLowerCase()
        const ehMe =
          forn.includes(' me') ||
          forn.includes(' epp') ||
          forn.includes('ltda me') ||
          det.includes('microempresa') ||
          det.includes('pequeno porte') ||
          det.includes('me') ||
          det.includes('epp')
        if (!ehMe) return false
      }

      // 5. UF
      if (filtroUf.trim()) {
        const ufAmostra = (r.municipio_uf || '').toUpperCase()
        if (!ufAmostra.includes(filtroUf.trim().toUpperCase())) return false
      }

      // 6. Faixa de preço (R$)
      const preco = r.valor_normalizado || r.valor_original || 0
      if (filtroPrecoMin) {
        const minVal = parseFloat(filtroPrecoMin.replace(',', '.'))
        if (!isNaN(minVal) && preco < minVal) return false
      }
      if (filtroPrecoMax) {
        const maxVal = parseFloat(filtroPrecoMax.replace(',', '.'))
        if (!isNaN(maxVal) && preco > maxVal) return false
      }

      // 7. Texto livre
      if (filtroTexto.trim()) {
        const t = filtroTexto.toLowerCase()
        const itemDesc = (r.item_externo || '').toLowerCase()
        const forn = (r.fornecedor || '').toLowerCase()
        const orgao = (r.orgao_comprador || '').toLowerCase()
        const mun = (r.municipio_uf || '').toLowerCase()
        const cat = (r.codigo_catalogo || '').toLowerCase()
        if (
          !itemDesc.includes(t) &&
          !forn.includes(t) &&
          !orgao.includes(t) &&
          !mun.includes(t) &&
          !cat.includes(t)
        ) {
          return false
        }
      }

      return true
    })
    .sort((a, b) => {
      const precoA = a.valor_normalizado || a.valor_original || 0
      const precoB = b.valor_normalizado || b.valor_original || 0
      if (ordenacao === 'menor_preco') return precoA - precoB
      if (ordenacao === 'maior_preco') return precoB - precoA
      if (ordenacao === 'data_recente') {
        const dtA = a.data_contratacao ? new Date(a.data_contratacao).getTime() : 0
        const dtB = b.data_contratacao ? new Date(b.data_contratacao).getTime() : 0
        return dtB - dtA
      }
      return 0
    })

  const temFiltroAtivo =
    filtroTexto.trim().length > 0 ||
    filtroFonte !== 'todas' ||
    filtroSituacao !== 'todas' ||
    filtroPeriodoMeses !== 12 ||
    filtroPorteOpcao !== 'TODAS' ||
    filtroUf.trim().length > 0 ||
    Boolean(filtroPrecoMin) ||
    Boolean(filtroPrecoMax)

  return (
    <div className="space-y-6 pb-12">
      {/* Barra de Navegação e Topo da Pesquisa */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/pesquisas')}
              className="text-gray-500 hover:text-gray-900 -ml-2 h-7"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Pesquisas
            </Button>
            <span className="text-gray-300">/</span>
            <Badge className="bg-[#1B4B8A] text-white font-mono text-xs">{pesquisa.numero}</Badge>
            <Badge variant="outline" className="text-xs uppercase">
              {pesquisa.status}
            </Badge>
          </div>
          <h1 className="text-xl font-bold text-gray-900">
            {itemAtual?.descricao || 'Pesquisa de Preços do Item'}
          </h1>
          <p className="text-xs text-gray-500 flex items-center gap-2">
            <span>
              Processo: <strong>{itemAtual?.expand?.demanda_id?.numero || 'PROC-2026-DEMO'}</strong>
            </span>
            <span>•</span>
            <span>
              Quantidade Demandada:{' '}
              <strong>
                {itemAtual?.quantidade || 1000} {itemAtual?.unidade || 'un'}
              </strong>
            </span>
          </p>
        </div>

        {/* Ações Globais */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => setModalIdentificacaoAberto(true)}
            variant="outline"
            size="sm"
            className="text-xs border-[#1B4B8A] text-[#1B4B8A] font-semibold"
          >
            <Sparkles className="h-3.5 w-3.5 mr-1 text-amber-500" />
            Identificar / Padronizar Item
          </Button>

          <Button
            onClick={handleConsultarFontes}
            disabled={consultandoFontes}
            size="sm"
            className="bg-[#1B4B8A] hover:bg-[#15406F] text-white text-xs font-semibold"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1.5 ${consultandoFontes ? 'animate-spin' : ''}`}
            />
            {consultandoFontes ? 'Consultando Bases...' : 'Consultar Fontes Públicas'}
          </Button>

          <Button
            onClick={() => handleExportarRelatorio('pdf')}
            size="sm"
            variant="outline"
            className="text-xs text-gray-700 font-semibold"
          >
            <Printer className="h-3.5 w-3.5 mr-1" />
            Imprimir Relatório (16 Seções)
          </Button>
        </div>
      </div>

      {/* Cards de Resumo Executivo */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="border border-gray-200">
          <CardContent className="p-3">
            <span className="text-[11px] text-gray-500 uppercase font-semibold">
              Preços Coletados
            </span>
            <div className="text-xl font-bold text-gray-900">{totalColetados}</div>
            <span className="text-[10px] text-gray-400">Em 5 fontes integradas</span>
          </CardContent>
        </Card>

        <Card className="border border-emerald-200 bg-emerald-50/30">
          <CardContent className="p-3">
            <span className="text-[11px] text-emerald-700 uppercase font-semibold">
              Preços na Cesta
            </span>
            <div className="text-xl font-bold text-emerald-800">{totalSelecionados}</div>
            <span className="text-[10px] text-emerald-600 font-medium">Amostra Válida</span>
          </CardContent>
        </Card>

        <Card className="border border-rose-200 bg-rose-50/30">
          <CardContent className="p-3">
            <span className="text-[11px] text-rose-700 uppercase font-semibold">
              Preços Descartados
            </span>
            <div className="text-xl font-bold text-rose-800">{totalExcluidos}</div>
            <span className="text-[10px] text-rose-600">Com justificativa</span>
          </CardContent>
        </Card>

        <Card className="border border-amber-200 bg-amber-50/30">
          <CardContent className="p-3">
            <span className="text-[11px] text-amber-700 uppercase font-semibold">
              Pendentes Revisão
            </span>
            <div className="text-xl font-bold text-amber-800">{totalPendentes}</div>
            <span className="text-[10px] text-amber-600">Exige decisão</span>
          </CardContent>
        </Card>

        <Card className="border border-blue-300 bg-blue-50/50">
          <CardContent className="p-3">
            <span className="text-[11px] text-blue-900 uppercase font-bold">Preço Estimado</span>
            <div className="text-xl font-bold text-[#1B4B8A]">
              {resultadoMotor?.preco_referencia !== null
                ? formatarMoeda(resultadoMotor?.preco_referencia)
                : 'AUSENTE'}
            </div>
            <span className="text-[10px] text-blue-700 font-medium">
              Total: {formatarMoeda(resultadoMotor?.total_item)}
            </span>
          </CardContent>
        </Card>
      </div>

      {/* Alerta de Amostra Mínima */}
      {resultadoMotor?.metricas_n.alerta_insuficiencia && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-start gap-3 ${
            resultadoMotor.metricas_n.status_amostra === 'CRITICO' ||
            resultadoMotor.metricas_n.status_amostra === 'SEM_REFERENCIA'
              ? 'bg-red-50 border-red-300 text-red-900'
              : 'bg-amber-50 border-amber-300 text-amber-900'
          }`}
        >
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
          <div className="space-y-1 flex-1">
            <p className="font-semibold">{resultadoMotor.metricas_n.alerta_insuficiencia}</p>
            <p className="text-[11px] opacity-90">
              Conforme o regulamento configurado do órgão, pesquisas com menos de{' '}
              {configOrgao?.quantidade_minima_precos || 3} amostras exigem justificativa do servidor
              no campo abaixo para autorizar o valor de referência.
            </p>
          </div>
        </div>
      )}

      {/* Workspace Completo com Abas */}
      <Tabs value={abaAtiva} onValueChange={(v) => setAbaAtiva(v as any)}>
        <TabsList className="grid grid-cols-3 md:grid-cols-9 bg-gray-100 p-1">
          <TabsTrigger value="resultados" className="text-xs font-semibold">
            <Search className="h-3 w-3 mr-1" />
            Resultados
          </TabsTrigger>
          <TabsTrigger value="cesta" className="text-xs font-semibold">
            <ShoppingCart className="h-3 w-3 mr-1 text-emerald-600" />
            Minha Cesta ({totalSelecionados})
          </TabsTrigger>
          <TabsTrigger value="estatistica" className="text-xs font-semibold">
            <BarChart3 className="h-3 w-3 mr-1 text-blue-600" />
            Estatística
          </TabsTrigger>
          <TabsTrigger value="mapa" className="text-xs font-semibold">
            <Scale className="h-3 w-3 mr-1 text-indigo-600" />
            Mapa Comparativo
          </TabsTrigger>
          <TabsTrigger value="curva_abc" className="text-xs font-semibold">
            <Percent className="h-3 w-3 mr-1 text-violet-600" />
            Curva ABC
          </TabsTrigger>
          <TabsTrigger value="relatorio" className="text-xs font-semibold">
            <FileText className="h-3 w-3 mr-1 text-teal-600" />
            Relatório
          </TabsTrigger>
          <TabsTrigger value="evidencias" className="text-xs font-semibold">
            <ShieldCheck className="h-3 w-3 mr-1 text-cyan-600" />
            Evidências
          </TabsTrigger>
          <TabsTrigger value="historico" className="text-xs font-semibold">
            <History className="h-3 w-3 mr-1 text-amber-600" />
            Histórico
          </TabsTrigger>
          <TabsTrigger value="itens" className="text-xs font-semibold">
            <Layers className="h-3 w-3 mr-1" />
            Itens Demanda
          </TabsTrigger>
        </TabsList>

        {/* ABA: RESULTADOS (Experiência visual unificada com o Modal de Pesquisa / Cesta de Preços) */}
        <TabsContent value="resultados" className="space-y-3 pt-2">
          {/* Layout em 2 colunas: Painel REFINAR à esquerda + Grade de Resultados à direita */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
            {/* PAINEL REFINAR (3 COLUNAS) */}
            <div className="lg:col-span-3 bg-white border border-[#b8c2cc] shadow-sm">
              <div className="bg-[#124268] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-3.5 bg-amber-400 inline-block" />
                  <span>REFINAR</span>
                </div>
                <div className="flex items-center gap-2">
                  {temFiltroAtivo && (
                    <button
                      type="button"
                      onClick={handleLimparFiltros}
                      className="text-[10px] text-amber-200 hover:text-white underline font-normal lowercase"
                    >
                      limpar
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPainelRefinarAberto(!painelRefinarAberto)}
                    className="text-white hover:text-amber-200 font-mono text-xs px-1"
                    title={painelRefinarAberto ? 'Recolher painel' : 'Expandir painel'}
                  >
                    {painelRefinarAberto ? '−' : '+'}
                  </button>
                </div>
              </div>

              {painelRefinarAberto && (
                <div className="p-2.5 space-y-2.5 text-xs bg-[#f8fafc]">
                  {/* Busca textual livre */}
                  <div className="space-y-0.5">
                    <label className="text-[10px] font-bold text-[#374151] uppercase block">
                      Filtrar na grade
                    </label>
                    <div className="relative">
                      <Search className="absolute left-2 top-2 h-3 w-3 text-gray-400" />
                      <Input
                        value={filtroTexto}
                        onChange={(e) => setFiltroTexto(e.target.value)}
                        placeholder="Termo, fornecedor, órgão..."
                        className="pl-7 h-7 text-[11px] rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>
                  </div>

                  {/* 1. Fonte / Origem */}
                  <div className="space-y-0.5">
                    <label className="text-[10px] font-bold text-[#374151] uppercase block">
                      Origem / Fonte das Amostras
                    </label>
                    <select
                      value={filtroFonte}
                      onChange={(e) => setFiltroFonte(e.target.value)}
                      className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                    >
                      <option value="todas">Todas as Fontes</option>
                      <option value="pncp">PNCP (Federal/Estadual/Mun.)</option>
                      <option value="compras_gov">Compras.gov.br</option>
                      <option value="portal_compras_publicas">
                        Portal de Compras Públicas (PCP Oficial)
                      </option>
                      <option value="bps">BPS (Saúde / SUS)</option>
                      <option value="cmed">CMED (Teto Regulatório ANVISA)</option>
                      <option value="sinapi">SINAPI (Custo Construção Civil)</option>
                      <option value="sicro">SICRO (Custo Rodoviário DNIT)</option>
                      <option value="conab">CONAB / CEASA (Abastecimento)</option>
                      <option value="seinfra">SEINFRA/CE (Ceará)</option>
                      <option value="setop">SETOP/MG (Minas Gerais)</option>
                      <option value="bec_sp">BEC-SP</option>
                      <option value="manual">Cotação Comercial</option>
                    </select>
                  </div>

                  {/* 2. Situação da Amostra */}
                  <div className="space-y-0.5">
                    <label className="text-[10px] font-bold text-[#374151] uppercase block">
                      Situação da Amostra
                    </label>
                    <select
                      value={filtroSituacao}
                      onChange={(e) => setFiltroSituacao(e.target.value as any)}
                      className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                    >
                      <option value="todas">Todas as Amostras</option>
                      <option value="selecionados">Na Cesta (Marcadas p/ Cálculo)</option>
                      <option value="pendentes">Pendentes de Revisão</option>
                      <option value="excluidos">Descartadas / Excluídas</option>
                    </select>
                  </div>

                  {/* 3. Período por Meses (Padrão 12 meses Cesta de Preços) */}
                  <div className="space-y-0.5 pt-1 border-t border-gray-200">
                    <label className="text-[10px] font-bold text-[#374151] uppercase block flex items-center justify-between">
                      <span>Período da Contratação</span>
                      {filtroPeriodoMeses > 0 && (
                        <span className="text-[9px] text-[#124268] font-bold lowercase">
                          últimos {filtroPeriodoMeses} meses
                        </span>
                      )}
                    </label>
                    <select
                      value={filtroPeriodoMeses}
                      onChange={(e) => setFiltroPeriodoMeses(Number(e.target.value))}
                      className="w-full h-7 text-[11px] rounded-none border border-[#94a3b8] bg-white text-gray-800 px-1.5 font-medium"
                    >
                      <option value={0}>Todas as datas (sem limite)</option>
                      <option value={12}>Últimos 12 meses (padrão)</option>
                      <option value={11}>Últimos 11 meses</option>
                      <option value={10}>Últimos 10 meses</option>
                      <option value={9}>Últimos 9 meses</option>
                      <option value={8}>Últimos 8 meses</option>
                      <option value={7}>Últimos 7 meses</option>
                      <option value={6}>Últimos 6 meses</option>
                      <option value={5}>Últimos 5 meses</option>
                      <option value={4}>Últimos 4 meses</option>
                      <option value={3}>Últimos 3 meses</option>
                    </select>
                  </div>

                  {/* 4. Faixa de Preços (R$) com Slider duplo sincronizado + Botão APLICAR */}
                  <div className="space-y-1.5 pt-1 border-t border-gray-200">
                    <label className="text-[10px] font-bold text-[#374151] uppercase block">
                      Faixa de Preços
                    </label>
                    <div className="px-1 pt-1 pb-2">
                      <Slider
                        min={0}
                        max={sliderPrecoMaximoAbsoluto}
                        step={1}
                        value={[filtroPrecoSlider[0], filtroPrecoSlider[1]]}
                        onValueChange={(val: [number, number]) => {
                          setFiltroPrecoSlider(val)
                          setFiltroPrecoMin(val[0].toFixed(2))
                          setFiltroPrecoMax(val[1].toFixed(2))
                        }}
                        className="w-full cursor-pointer"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex-1">
                        <span className="text-[9px] text-gray-500 block uppercase">Desde:</span>
                        <Input
                          placeholder="0,00"
                          value={filtroPrecoMin}
                          onChange={(e) => {
                            setFiltroPrecoMin(e.target.value)
                            const parsed = parseFloat(e.target.value.replace(',', '.'))
                            if (!isNaN(parsed)) {
                              setFiltroPrecoSlider([parsed, filtroPrecoSlider[1]])
                            }
                          }}
                          className="h-6 text-[10px] font-mono rounded-none border-[#94a3b8] bg-white px-1"
                        />
                      </div>
                      <div className="flex-1">
                        <span className="text-[9px] text-gray-500 block uppercase">Até:</span>
                        <Input
                          placeholder="0,00"
                          value={filtroPrecoMax}
                          onChange={(e) => {
                            setFiltroPrecoMax(e.target.value)
                            const parsed = parseFloat(e.target.value.replace(',', '.'))
                            if (!isNaN(parsed)) {
                              setFiltroPrecoSlider([filtroPrecoSlider[0], parsed])
                            }
                          }}
                          className="h-6 text-[10px] font-mono rounded-none border-[#94a3b8] bg-white px-1"
                        />
                      </div>
                      <div className="pt-3">
                        <Button
                          type="button"
                          onClick={handleAplicarFaixaPreco}
                          className="h-6 px-2 text-[10px] font-bold rounded-none bg-[#124268] hover:bg-[#0c314f] text-white uppercase shadow-none"
                        >
                          APLICAR
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* 5. Porte da Empresa (TODAS / ME-EPP) */}
                  <div className="space-y-1 pt-1 border-t border-gray-200">
                    <label className="text-[10px] font-bold text-[#374151] uppercase block">
                      Porte da Empresa
                    </label>
                    <div className="flex items-center gap-4 text-[10px] font-bold">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="filtroPorteOpcaoDetalhe"
                          value="TODAS"
                          checked={filtroPorteOpcao === 'TODAS'}
                          onChange={() => setFiltroPorteOpcao('TODAS')}
                          className="text-[#124268] focus:ring-[#124268] h-3.5 w-3.5"
                        />
                        <span className="text-gray-700 uppercase">TODAS</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="filtroPorteOpcaoDetalhe"
                          value="ME_EPP"
                          checked={filtroPorteOpcao === 'ME_EPP'}
                          onChange={() => setFiltroPorteOpcao('ME_EPP')}
                          className="text-[#124268] focus:ring-[#124268] h-3.5 w-3.5"
                        />
                        <span className="text-gray-700 uppercase">ME / EPP</span>
                      </label>
                    </div>
                  </div>

                  {/* 6. Unidade Federativa (UF) */}
                  <div className="space-y-0.5 pt-1 border-t border-gray-200">
                    <label className="text-[10px] font-bold text-[#374151] uppercase block">
                      Unidade Federativa (UF)
                    </label>
                    <Input
                      placeholder="Ex: SP, RN, DF, MG, RJ..."
                      value={filtroUf}
                      onChange={(e) => setFiltroUf(e.target.value)}
                      className="h-7 text-[10.5px] uppercase font-mono rounded-none border-[#94a3b8] bg-white"
                    />
                  </div>

                  {/* Rastreabilidade e Amostras fora do filtro */}
                  {referenciasFiltradas.length < referencias.length && (
                    <div className="bg-amber-50 p-2 border border-amber-200 text-[9.5px] text-amber-900 leading-snug">
                      <strong>Rastreabilidade preservada:</strong>{' '}
                      {referencias.length - referenciasFiltradas.length} amostra(s) fora deste
                      filtro permanecem registradas no banco (sem exclusão silenciosa).
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* GRADE DE RESULTADOS (9 COLUNAS) */}
            <div className="lg:col-span-9 bg-white border border-[#b8c2cc] shadow-sm flex flex-col">
              {/* Cabeçalho da grade cinza #828892 estilo Cesta de Preços */}
              <div className="bg-[#828892] text-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide flex flex-wrap items-center justify-between gap-1 select-none">
                <div className="flex items-center gap-2">
                  <span>
                    RESULTADO DA PESQUISA — {referenciasFiltradas.length} DE {referencias.length}{' '}
                    AMOSTRA(S)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-white/90 font-bold tracking-wider">
                    ORDENAR POR:
                  </span>
                  <select
                    value={ordenacao}
                    onChange={(e: any) => setOrdenacao(e.target.value)}
                    className="h-5 text-[10px] bg-white text-[#1f2937] rounded-none px-1 font-bold border-0 uppercase"
                  >
                    <option value="menor_preco">MENOR PREÇO UNITÁRIO</option>
                    <option value="maior_preco">MAIOR PREÇO UNITÁRIO</option>
                    <option value="data_recente">DATA MAIS RECENTE</option>
                  </select>
                </div>
              </div>

              {/* Tabela de Amostras com Highlight do termo, Vigência e Metadados NCM/critério */}
              <div className="p-2.5 bg-white overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse border border-gray-300">
                  <thead className="bg-gray-100 border-b border-gray-300 text-gray-700 font-bold uppercase text-[10px] select-none">
                    <tr>
                      <th className="p-2 w-16 text-center">Status</th>
                      <th className="p-2 whitespace-nowrap min-w-[120px]">Fonte</th>
                      <th className="p-2 whitespace-nowrap min-w-[90px]">Data</th>
                      <th className="p-2 min-w-[340px]">Descrição Coletada</th>
                      <th className="p-2 text-right whitespace-nowrap">Preço Unit.</th>
                      <th className="p-2 text-center">Unidade</th>
                      <th className="p-2 min-w-[280px]">Fornecedor / Órgão</th>
                      <th className="p-2 text-center w-32">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {referencias.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="p-8 text-center text-gray-500 text-xs space-y-2">
                          <Search className="h-8 w-8 mx-auto text-gray-400" />
                          <p className="font-semibold text-gray-700">
                            Nenhum preço coletado ainda para este item.
                          </p>
                          <p className="text-gray-500">
                            Clique em <strong>[Consultar Fontes Públicas]</strong> acima para
                            consultar bases oficiais (PNCP, Compras.gov.br, BPS, CMED) com
                            rastreabilidade integral.
                          </p>
                        </td>
                      </tr>
                    ) : referenciasFiltradas.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="p-6 text-center text-gray-500 text-xs">
                          Nenhuma amostra atende aos critérios do filtro REFINAR aplicado.
                        </td>
                      </tr>
                    ) : (
                      referenciasFiltradas.map((ref) => {
                        const isRegulatorio =
                          ref.fonte === 'cmed' || ref.natureza_preco === 'regulatorio_tabela'
                        const isAceito = ref.status_revisao === 'aceito'
                        const isExcluido = ref.status_revisao === 'excluido'

                        // Extração de metadados enriquecidos (NCM/NBS, critério, datas de vigência)
                        const detalhes: Record<string, any> =
                          typeof ref.detalhes_tecnicos === 'object' &&
                          ref.detalhes_tecnicos !== null
                            ? ref.detalhes_tecnicos
                            : {}
                        const ncm =
                          detalhes.ncm ||
                          detalhes.codigo_ncm ||
                          detalhes.nbs ||
                          (ref.codigo_catalogo?.toUpperCase().includes('NCM')
                            ? ref.codigo_catalogo
                            : null)
                        const criterioJulgamento =
                          detalhes.criterio_julgamento ||
                          detalhes.criterio ||
                          detalhes.tipo_julgamento ||
                          null

                        // Vigência da contratação ou da ata
                        const dataVigenciaFim =
                          detalhes.data_vigencia_fim ||
                          detalhes.dataVigenciaFim ||
                          detalhes.vigencia_fim ||
                          detalhes.data_fim_vigencia ||
                          null
                        const vigenciaInfo = dataVigenciaFim
                          ? calcularDiasVencimento(dataVigenciaFim)
                          : null

                        const precoValor = ref.valor_normalizado || ref.valor_original || 0

                        return (
                          <tr
                            key={ref.id}
                            className={`hover:bg-blue-50/40 transition-colors ${
                              isAceito ? 'bg-emerald-50/25' : ''
                            } ${isExcluido ? 'opacity-60 bg-red-50/20' : ''} ${
                              isRegulatorio ? 'bg-amber-50/30' : ''
                            }`}
                          >
                            {/* Status */}
                            <td className="p-2 text-center">
                              {isAceito ? (
                                <Badge className="bg-emerald-100 text-emerald-800 text-[9.5px] rounded-none font-bold">
                                  Na Cesta
                                </Badge>
                              ) : isExcluido ? (
                                <Badge className="bg-rose-100 text-rose-800 text-[9.5px] rounded-none font-bold">
                                  Descartado
                                </Badge>
                              ) : (
                                <Badge className="bg-amber-100 text-amber-800 text-[9.5px] rounded-none font-bold">
                                  Pendente
                                </Badge>
                              )}
                            </td>

                            {/* Fonte */}
                            <td className="p-2 font-bold text-gray-900 align-top">
                              <Badge
                                variant="outline"
                                className={`rounded-none text-[9.5px] font-bold ${
                                  ref.fonte === 'pncp'
                                    ? 'bg-blue-50 text-blue-800 border-blue-300'
                                    : ref.fonte === 'compras_gov'
                                      ? 'bg-indigo-50 text-indigo-800 border-indigo-300'
                                      : ref.fonte === 'bps'
                                        ? 'bg-rose-50 text-rose-800 border-rose-300'
                                        : ref.fonte === 'cmed'
                                          ? 'bg-purple-50 text-purple-800 border-purple-300'
                                          : ref.fonte === 'bec_sp'
                                            ? 'bg-gray-100 text-gray-800 border-gray-300'
                                            : 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                }`}
                              >
                                {ref.fonte.toUpperCase()}
                              </Badge>
                              {isRegulatorio && (
                                <span className="block text-[8.5px] font-bold text-amber-800 uppercase mt-0.5">
                                  Teto Regulatório
                                </span>
                              )}
                            </td>

                            {/* Data */}
                            <td className="p-2 text-gray-600 whitespace-nowrap font-mono text-[11px] align-top">
                              {formatarData(ref.data_contratacao)}
                            </td>

                            {/* Descrição Coletada com Highlight do Termo + Metadados NCM/critério/vigência */}
                            <td
                              className="p-2 text-gray-900 min-w-[340px] max-w-[560px] whitespace-normal break-words align-top"
                              title={ref.item_externo || undefined}
                            >
                              <div className="font-semibold text-gray-950 leading-snug whitespace-normal break-words text-[11.5px]">
                                <TermoDestacado
                                  texto={ref.item_externo || 'ITEM SEM DESCRIÇÃO'}
                                  termoBusca={filtroTexto || termoPesquisado}
                                  className="text-xs font-semibold"
                                />
                              </div>

                              {/* Metadados por amostra: NCM/NBS, Critério de Julgamento, Datas de Vigência */}
                              <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
                                {ncm ? (
                                  <span className="font-mono bg-gray-100 text-gray-700 px-1 py-0.2 border border-gray-300 rounded-none">
                                    NCM: {ncm}
                                  </span>
                                ) : (
                                  <span className="font-mono text-gray-400 text-[9px]">
                                    NCM: NÃO INFORMADO
                                  </span>
                                )}

                                {criterioJulgamento && (
                                  <span className="bg-blue-50 text-blue-900 px-1 py-0.2 border border-blue-200 rounded-none uppercase text-[9px] font-bold">
                                    Critério: {criterioJulgamento}
                                  </span>
                                )}

                                {ref.codigo_catalogo && !ncm && (
                                  <span className="font-mono text-gray-500 text-[9.5px]">
                                    Catálogo: {ref.codigo_catalogo}
                                  </span>
                                )}

                                {ref.id_externo && (
                                  <span className="font-mono text-gray-400 text-[9px]">
                                    ID: {ref.id_externo}
                                  </span>
                                )}

                                {ref.possivel_duplicata && (
                                  <span className="text-amber-700 font-bold text-[9px] bg-amber-50 px-1 border border-amber-200">
                                    • Possível duplicata trans-fontes
                                  </span>
                                )}
                              </div>

                              {/* Aviso de Vigência estilo Cesta de Preços */}
                              {vigenciaInfo && (
                                <div className="mt-1">
                                  <span
                                    className={`inline-block px-1.5 py-0.2 text-[9.5px] font-bold uppercase rounded-none border ${
                                      vigenciaInfo.vencido
                                        ? 'bg-rose-100 text-rose-900 border-rose-300'
                                        : 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                    }`}
                                  >
                                    {vigenciaInfo.texto}
                                  </span>
                                </div>
                              )}
                            </td>

                            {/* Preço Unitário */}
                            <td className="p-2 text-right font-mono font-bold text-gray-900 whitespace-nowrap text-sm align-top">
                              {formatarMoeda(precoValor)}
                            </td>

                            {/* Unidade */}
                            <td className="p-2 text-center font-mono text-gray-700 uppercase align-top">
                              {ref.unidade || 'UN'}
                            </td>

                            {/* Fornecedor / Órgão */}
                            <td
                              className="p-2 text-gray-800 min-w-[280px] max-w-[440px] whitespace-normal break-words align-top"
                              title={`Fornecedor: ${ref.fornecedor || 'NÃO INFORMADO'} | Órgão: ${ref.orgao_comprador || 'NÃO INFORMADO'}`}
                            >
                              <div className="font-semibold text-gray-900 leading-snug whitespace-normal break-words text-[11.5px]">
                                <TermoDestacado
                                  texto={ref.fornecedor || 'FORNECEDOR NÃO INFORMADO'}
                                  termoBusca={filtroTexto}
                                />
                              </div>
                              <p className="text-[10px] text-gray-500 font-mono">
                                CNPJ: {ref.cnpj_fornecedor || 'NÃO INFORMADO'}
                              </p>
                              <div className="text-[11px] text-gray-800 leading-snug whitespace-normal break-words mt-1 border-t border-gray-100 pt-1">
                                <span className="text-[9.5px] font-bold uppercase text-gray-500 block">
                                  Órgão Licitante:
                                </span>
                                <TermoDestacado
                                  texto={ref.orgao_comprador || 'NÃO INFORMADO'}
                                  termoBusca={filtroTexto}
                                  className="font-medium text-gray-900"
                                />
                              </div>
                              {ref.municipio_uf && (
                                <p className="text-[9.5px] text-gray-500 uppercase mt-0.5 font-medium">
                                  {ref.municipio_uf}
                                </p>
                              )}
                            </td>

                            {/* Ações */}
                            <td className="p-2 text-center">
                              <div className="flex items-center justify-center gap-1">
                                {ref.status_revisao !== 'aceito' ? (
                                  <Button
                                    size="sm"
                                    type="button"
                                    onClick={() => handleDecidirPreco(ref, 'aceito')}
                                    className="h-6 px-2 text-[10.5px] bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-none"
                                  >
                                    + Cesta
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    type="button"
                                    onClick={() =>
                                      setModalJustificarExclusao({
                                        aberto: true,
                                        refId: ref.id,
                                        motivo: '',
                                      })
                                    }
                                    className="h-6 px-2 text-[10.5px] text-rose-700 hover:bg-rose-50 border-rose-300 rounded-none font-medium"
                                  >
                                    Descartar
                                  </Button>
                                )}

                                {ref.url && (
                                  <a
                                    href={ref.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="p-1 text-gray-400 hover:text-[#124268]"
                                    title="Ver fonte oficial externa"
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </a>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ABA: MINHA CESTA (Preços válidos que compõem a amostra estatística) */}
        <TabsContent value="cesta" className="space-y-4 pt-3">
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center justify-between text-xs text-emerald-900">
            <div>
              <p className="font-bold flex items-center gap-1.5">
                <ShoppingCart className="h-4 w-4 text-emerald-700" />
                Cesta de Preços Selecionada — {totalSelecionados} Amostras Ativas
              </p>
              <p className="text-[11px] text-emerald-800">
                Amostra válida utilizada pelo servidor para cálculo do preço de referência. Nenhum
                preço é descartado sem decisão humana registrada.
              </p>
            </div>
            <Button
              onClick={() => setMemoriaAberta(!memoriaAberta)}
              variant="outline"
              size="sm"
              className="text-xs bg-white text-emerald-800 border-emerald-300"
            >
              {memoriaAberta ? 'Ocultar Memória de Cálculo' : 'Ver Memória de Cálculo'}
            </Button>
          </div>

          {/* Painel da Memória de Cálculo Estruturada */}
          {memoriaAberta && resultadoMotor && (
            <Card className="border border-blue-200 bg-blue-50/30">
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-xs font-bold text-[#1B4B8A] uppercase">
                  Memória de Cálculo Automática e Reprodutível
                </CardTitle>
                <CardDescription className="text-[11px]">
                  {resultadoMotor.memoria.resumo_rastreabilidade}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <pre className="text-xs font-mono bg-white p-3 rounded border border-gray-200 text-gray-800 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                  {resultadoMotor.memoria_texto}
                </pre>
              </CardContent>
            </Card>
          )}

          {/* Lista de itens da Cesta */}
          <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold">
                <tr>
                  <th className="p-2.5 min-w-[100px]">Fonte</th>
                  <th className="p-2.5 min-w-[320px]">Descrição</th>
                  <th className="p-2.5 min-w-[240px]">Fornecedor</th>
                  <th className="p-2.5 min-w-[260px]">Órgão Comprador</th>
                  <th className="p-2.5 text-right whitespace-nowrap">Preço Unitário</th>
                  <th className="p-2.5 text-center">Classificação Outlier</th>
                  <th className="p-2.5 text-center">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {referencias
                  .filter((r) => r.status_revisao === 'aceito')
                  .map((ref) => {
                    const outlierInfo = resultadoMotor?.outliers.find(
                      (o) => o.referencia_id === ref.id,
                    )
                    return (
                      <tr key={ref.id} className="hover:bg-gray-50">
                        <td className="p-2.5 font-bold uppercase text-[#1B4B8A] align-top">
                          {ref.fonte}
                        </td>
                        <td className="p-2.5 min-w-[320px] max-w-[500px] whitespace-normal break-words align-top">
                          <div className="font-semibold text-gray-900 leading-snug whitespace-normal break-words">
                            <TermoDestacado
                              texto={ref.item_externo}
                              termoBusca={
                                filtroTexto || pesquisa?.expand?.demanda_item_id?.descricao
                              }
                            />
                          </div>
                          <div className="text-[10px] text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                            {((ref.detalhes_tecnicos as any)?.ncm || (ref as any).ncm) && (
                              <span className="bg-blue-50 text-blue-700 px-1 py-0.2 rounded border border-blue-200">
                                NCM: {(ref.detalhes_tecnicos as any)?.ncm || (ref as any).ncm}
                              </span>
                            )}
                            {((ref.detalhes_tecnicos as any)?.criterio_julgamento ||
                              (ref as any).criterio_julgamento) && (
                              <span className="bg-purple-50 text-purple-700 px-1 py-0.2 rounded border border-purple-200">
                                {(ref.detalhes_tecnicos as any)?.criterio_julgamento ||
                                  (ref as any).criterio_julgamento}
                              </span>
                            )}
                            {(() => {
                              const dtFim =
                                (ref.detalhes_tecnicos as any)?.data_vigencia_fim ||
                                (ref as any).data_vigencia_fim
                              const infoVenc = calcularDiasVencimento(dtFim)
                              if (!infoVenc) return null
                              return (
                                <Badge
                                  variant="outline"
                                  className={`text-[9px] py-0 px-1 font-semibold ${
                                    infoVenc.vencido
                                      ? 'border-rose-300 bg-rose-50 text-rose-700'
                                      : 'border-emerald-300 bg-emerald-50 text-emerald-700'
                                  }`}
                                >
                                  {infoVenc.texto}
                                </Badge>
                              )
                            })()}
                          </div>
                        </td>
                        <td className="p-2.5 text-gray-800 min-w-[240px] max-w-[360px] whitespace-normal break-words align-top font-medium">
                          {ref.fornecedor || 'NÃO INFORMADO'}
                        </td>
                        <td className="p-2.5 text-gray-800 min-w-[260px] max-w-[400px] whitespace-normal break-words align-top">
                          <span className="font-semibold text-gray-900 block">
                            {ref.orgao_comprador || 'NÃO INFORMADO'}
                          </span>
                          {ref.municipio_uf && (
                            <span className="text-[10px] text-gray-500 uppercase">
                              {ref.municipio_uf}
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-right font-mono font-bold text-gray-900">
                          {formatarMoeda(ref.valor_normalizado || ref.valor_original)}
                        </td>
                        <td className="p-2.5 text-center">
                          {outlierInfo?.classificacao === 'NORMAL' ? (
                            <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">
                              Normal
                            </Badge>
                          ) : outlierInfo?.classificacao === 'ATENCAO' ? (
                            <Badge className="bg-amber-100 text-amber-800 text-[10px]">
                              Atenção ({outlierInfo.percentual_distancia_mediana > 0 ? '+' : ''}
                              {outlierInfo.percentual_distancia_mediana}%)
                            </Badge>
                          ) : (
                            <Badge className="bg-rose-100 text-rose-800 text-[10px]">
                              {outlierInfo?.classificacao}
                            </Badge>
                          )}
                        </td>
                        <td className="p-2.5 text-center">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setModalJustificarExclusao({
                                aberto: true,
                                refId: ref.id,
                                motivo: '',
                              })
                            }
                            className="h-6 text-rose-600 hover:bg-rose-50 text-[11px]"
                          >
                            Excluir c/ Justificativa
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ABA: ESTATÍSTICA (Quartis, Mediana, Média, CV e Recomendação) */}
        <TabsContent value="estatistica" className="space-y-4 pt-3">
          {resultadoMotor && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Painel Estatístico */}
              <Card className="border border-gray-200">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-xs font-bold text-gray-800 uppercase">
                    Parâmetros Estatísticos Centrais
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-2 space-y-2 text-xs">
                  <div className="flex justify-between py-1 border-b border-gray-100">
                    <span className="text-gray-500">Média Aritmética:</span>
                    <span className="font-mono font-semibold">
                      {formatarMoeda(resultadoMotor.estatisticas.media_aritmetica)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-100">
                    <span className="text-gray-500">Mediana (50º Percentil):</span>
                    <span className="font-mono font-bold text-[#1B4B8A]">
                      {formatarMoeda(resultadoMotor.estatisticas.mediana)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-100">
                    <span className="text-gray-500">Menor Preço:</span>
                    <span className="font-mono">
                      {formatarMoeda(resultadoMotor.estatisticas.menor_preco)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-100">
                    <span className="text-gray-500">Maior Preço:</span>
                    <span className="font-mono">
                      {formatarMoeda(resultadoMotor.estatisticas.maior_preco)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-100">
                    <span className="text-gray-500">Desvio-Padrão Amostral (s):</span>
                    <span className="font-mono">
                      {resultadoMotor.estatisticas.desvio_padrao.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-100">
                    <span className="text-gray-500">Coeficiente de Variação (CV):</span>
                    <span
                      className={`font-mono font-bold ${
                        resultadoMotor.estatisticas.coeficiente_variacao > 25
                          ? 'text-amber-600'
                          : 'text-emerald-600'
                      }`}
                    >
                      {resultadoMotor.estatisticas.coeficiente_variacao.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-gray-500">Intervalo Interquartil (IQR):</span>
                    <span className="font-mono">
                      {resultadoMotor.estatisticas.quartis.iqr.toFixed(2)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Recomendação do Motor & Decisão do Servidor */}
              <Card className="border border-blue-200 bg-blue-50/20">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-xs font-bold text-[#1B4B8A] uppercase">
                    Recomendação do Motor & Decisão do Servidor
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-2 space-y-3 text-xs">
                  <div className="p-2.5 bg-white rounded border border-blue-200">
                    <span className="text-[11px] font-bold text-gray-500 uppercase block mb-1">
                      Indicação Algorítmica:
                    </span>
                    <p className="font-semibold text-blue-900">
                      {resultadoMotor.estatisticas.motivo_recomendacao}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-bold text-gray-700">
                      Método Escolhido pelo Servidor:
                    </label>
                    <select
                      value={metodoSelecionado}
                      onChange={(e) => setMetodoSelecionado(e.target.value as any)}
                      className="w-full text-xs border border-gray-300 rounded p-2 bg-white"
                    >
                      <option value="mediana">Mediana (Recomendada em dispersão)</option>
                      <option value="media">Média Aritmética</option>
                      <option value="menor">Menor Preço</option>
                      <option value="media_saneada">Média Saneada (10% extremos)</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-gray-700">
                      Justificativa Técnica / Motivação:
                    </label>
                    <textarea
                      value={justificativaMetodo}
                      onChange={(e) => setJustificativaMetodo(e.target.value)}
                      rows={3}
                      placeholder="Ex: Adoção da mediana em conformidade com o Decreto Municipal e IN 65/2021..."
                      className="w-full text-xs p-2 border border-gray-300 rounded"
                    />
                  </div>

                  <Button
                    onClick={handleSalvarCalculo}
                    size="sm"
                    className="w-full bg-[#1B4B8A] hover:bg-[#15406F] text-white font-semibold text-xs"
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    Homologar e Salvar Preço Estimado
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ABA: MAPA COMPARATIVO (Quadro Geral para Licitação) */}
        <TabsContent value="mapa" className="space-y-4 pt-3">
          <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white p-4 space-y-4">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-sm font-bold text-gray-900">
                Mapa Comparativo de Preços e Propostas
              </h3>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleExportarRelatorio('xlsx')}
                  size="sm"
                  variant="outline"
                  className="text-xs"
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  Exportar XLSX
                </Button>
                <Button
                  onClick={() => handleExportarRelatorio('csv')}
                  size="sm"
                  variant="outline"
                  className="text-xs"
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  Exportar CSV
                </Button>
              </div>
            </div>

            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-gray-100 text-gray-700 font-semibold border-b">
                  <th className="p-2 border">#</th>
                  <th className="p-2 border min-w-[90px]">Fonte</th>
                  <th className="p-2 border min-w-[220px]">Fornecedor</th>
                  <th className="p-2 border min-w-[130px]">CNPJ</th>
                  <th className="p-2 border min-w-[260px]">Órgão / Ente</th>
                  <th className="p-2 border">Data</th>
                  <th className="p-2 border text-right">Qtd</th>
                  <th className="p-2 border text-right">Unitário (R$)</th>
                  <th className="p-2 border text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {referencias.map((ref, idx) => (
                  <tr key={ref.id} className="border-b hover:bg-gray-50">
                    <td className="p-2 border text-center text-gray-400 align-top">{idx + 1}</td>
                    <td className="p-2 border font-bold uppercase align-top">{ref.fonte}</td>
                    <td className="p-2 border font-semibold text-gray-900 min-w-[220px] max-w-[340px] whitespace-normal break-words align-top">
                      {ref.fornecedor || 'NÃO INFORMADO'}
                    </td>
                    <td className="p-2 border text-gray-600 font-mono text-[11px] align-top whitespace-nowrap">
                      {ref.cnpj_fornecedor || 'NÃO INFORMADO'}
                    </td>
                    <td className="p-2 border text-gray-800 min-w-[260px] max-w-[400px] whitespace-normal break-words align-top">
                      <span className="font-semibold text-gray-900 block">
                        {ref.orgao_comprador || 'NÃO INFORMADO'}
                      </span>
                      {ref.municipio_uf && (
                        <span className="text-[10px] text-gray-500 uppercase">
                          {ref.municipio_uf}
                        </span>
                      )}
                    </td>
                    <td className="p-2 border">{formatarData(ref.data_contratacao)}</td>
                    <td className="p-2 border text-right font-mono">{ref.quantidade || 1}</td>
                    <td className="p-2 border text-right font-mono font-bold">
                      {formatarMoeda(ref.valor_normalizado || ref.valor_original)}
                    </td>
                    <td className="p-2 border text-center">
                      <Badge
                        variant="outline"
                        className={
                          ref.status_revisao === 'aceito'
                            ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                            : 'text-rose-700 bg-rose-50 border-rose-200'
                        }
                      >
                        {ref.status_revisao.toUpperCase()}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ABA: CURVA ABC */}
        <TabsContent value="curva_abc" className="space-y-4 pt-3">
          <Card className="border border-gray-200">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-xs font-bold text-gray-800 uppercase flex items-center justify-between">
                <span>Classificação da Curva ABC dos Itens da Demanda</span>
                <Badge className="bg-purple-100 text-purple-800 text-[10px]">
                  Classe A (80%) • B (15%) • C (5%)
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2 space-y-4">
              <p className="text-xs text-gray-600">
                A Curva ABC prioriza os itens de maior impacto financeiro na contratação,
                direcionando maior rigor amostral e análise de mercado para itens de Classe A.
              </p>

              <div className="border border-gray-200 rounded-lg overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-50 border-b font-semibold text-gray-600">
                    <tr>
                      <th className="p-2">Classe</th>
                      <th className="p-2">Item</th>
                      <th className="p-2 text-right">Qtd</th>
                      <th className="p-2 text-right">Preço Unit.</th>
                      <th className="p-2 text-right">Valor Total</th>
                      <th className="p-2 text-right">% Acumulado</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="hover:bg-gray-50">
                      <td className="p-2">
                        <Badge className="bg-rose-100 text-rose-800 font-bold">Classe A</Badge>
                      </td>
                      <td className="p-2 font-medium">
                        {itemAtual?.descricao || 'Dipirona Sódica 500mg comprimido'}
                      </td>
                      <td className="p-2 text-right font-mono">{itemAtual?.quantidade || 1000}</td>
                      <td className="p-2 text-right font-mono font-bold">
                        {formatarMoeda(resultadoMotor?.preco_referencia)}
                      </td>
                      <td className="p-2 text-right font-mono font-bold text-[#1B4B8A]">
                        {formatarMoeda(resultadoMotor?.total_item)}
                      </td>
                      <td className="p-2 text-right font-mono font-bold text-emerald-700">
                        100.0%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ABA: RELATÓRIO (Prévia e Emissão do Relatório 16 Seções) */}
        <TabsContent value="relatorio" className="space-y-4 pt-3">
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-gray-900 uppercase">
                Relatório Técnico de Pesquisa de Preços (16 Seções)
              </h3>
              <p className="text-[11px] text-gray-500">
                Emissão completa conforme Art. 23 da Lei 14.133/2021 com todas as 16 seções formais.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => handleExportarRelatorio('pdf')}
                size="sm"
                className="bg-[#1B4B8A] hover:bg-[#15406F] text-white text-xs font-semibold"
              >
                <Printer className="h-3.5 w-3.5 mr-1" />
                Gerar PDF
              </Button>
              <Button
                onClick={() => handleExportarRelatorio('docx')}
                size="sm"
                variant="outline"
                className="text-xs"
              >
                <Download className="h-3.5 w-3.5 mr-1" />
                Baixar DOCX
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* ABA: EVIDÊNCIAS & HASH */}
        <TabsContent value="evidencias" className="space-y-4 pt-3">
          <Card className="border border-gray-200">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-xs font-bold text-gray-800 uppercase flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
                Repositório de Evidências Criptografadas e Rastreabilidade
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2 space-y-3 text-xs">
              <p className="text-gray-600">
                Cada cotação possui identificador único externo, hash criptográfico de validação e
                carimbo de data/hora de captura nos termos da Lei 14.133/2021.
              </p>

              <div className="space-y-2">
                {referencias.map((ref) => (
                  <div
                    key={ref.id}
                    className="p-2.5 bg-gray-50 border border-gray-200 rounded flex items-center justify-between"
                  >
                    <div className="space-y-0.5">
                      <p className="font-semibold text-gray-900">
                        {ref.fonte.toUpperCase()} • {ref.id_externo || 'Sem ID'}
                      </p>
                      <p className="text-[10px] text-gray-500 font-mono">
                        Hash SHA-256: {ref.hash || 'hash_gerado_no_momento_da_coleta'}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        Capturado em:{' '}
                        {ref.source_capture_date ? formatarData(ref.source_capture_date) : 'N/A'}
                      </p>
                    </div>
                    {ref.url && (
                      <a
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline flex items-center gap-1 font-semibold"
                      >
                        Abrir Documento <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ABA: HISTÓRICO E AUDITORIA */}
        <TabsContent value="historico" className="space-y-4 pt-3">
          <Card className="border border-gray-200">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-xs font-bold text-gray-800 uppercase flex items-center gap-2">
                <History className="h-4 w-4 text-amber-600" />
                Trilha de Auditoria e Versões da Pesquisa
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2 space-y-2 text-xs">
              <p className="text-gray-600">
                Todas as ações (coletas, exclusões, alterações de método e justificativas) ficam
                registradas com carimbo de tempo, agente e estado anterior/posterior.
              </p>
              <div className="p-3 bg-amber-50/50 border border-amber-200 rounded text-xs text-amber-900">
                <strong>Pesquisa Versão Atual:</strong> v{pesquisa.versao || 1} • Aberta em{' '}
                {formatarData(pesquisa.created)}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ABA: ITENS DEMANDA */}
        <TabsContent value="itens" className="space-y-4 pt-3">
          <div className="flex justify-between items-center">
            <span className="text-xs font-semibold text-gray-700">Itens da Demanda Vinculada:</span>
            <Button
              onClick={() => setModalImportacaoAberto(true)}
              size="sm"
              variant="outline"
              className="text-xs"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Importar Itens da Planilha (Excel/CSV)
            </Button>
          </div>

          <div className="p-4 bg-white border border-gray-200 rounded-lg space-y-2 text-xs">
            <p className="font-bold text-gray-900">{itemAtual?.descricao}</p>
            <p className="text-gray-600">
              Quantidade: {itemAtual?.quantidade} {itemAtual?.unidade}
            </p>
            {itemAtual?.codigo_catmat && (
              <Badge className="bg-[#1B4B8A] text-white text-[10px]">
                {itemAtual.codigo_catmat}
              </Badge>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Modal de Identificação de Item */}
      <ModalIdentificacaoItem
        aberto={modalIdentificacaoAberto}
        onClose={() => setModalIdentificacaoAberto(false)}
        termoInicial={itemAtual?.descricao || ''}
        onSelecionarItem={(it) => {
          alert(`Item selecionado do catálogo oficial: ${it.descricao} (${it.codigoCatalogo})`)
        }}
      />

      {/* Modal de Importação de Itens */}
      <ModalImportacaoItens
        aberto={modalImportacaoAberto}
        onClose={() => setModalImportacaoAberto(false)}
        onImportar={(itens) => {
          alert(`${itens.length} itens importados com sucesso!`)
        }}
      />

      {/* Modal de Justificativa Obrigatória para Exclusão de Preço */}
      {modalJustificarExclusao.aberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3 border">
            <h3 className="text-sm font-bold text-rose-900 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-rose-600" />
              Justificativa Obrigatória para Exclusão
            </h3>
            <p className="text-xs text-gray-600">
              Regra do Motor: <strong>NUNCA excluir um preço silenciosamente</strong>. Informe o
              motivo técnico da exclusão desta amostra (ex: especificação incompatível, valor fora
              da faixa mercadológica com comprovação nos autos):
            </p>
            <textarea
              value={modalJustificarExclusao.motivo}
              onChange={(e) =>
                setModalJustificarExclusao({ ...modalJustificarExclusao, motivo: e.target.value })
              }
              rows={3}
              placeholder="Digite a fundamentação da desconsideração..."
              className="w-full text-xs p-2.5 border rounded focus:ring-1 focus:ring-rose-500"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setModalJustificarExclusao({ aberto: false, refId: '', motivo: '' })}
                className="text-xs"
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                disabled={modalJustificarExclusao.motivo.trim().length < 5}
                onClick={async () => {
                  const refAlvo = referencias.find((r) => r.id === modalJustificarExclusao.refId)
                  if (refAlvo) {
                    await handleDecidirPreco(refAlvo, 'excluido', modalJustificarExclusao.motivo)
                  }
                  setModalJustificarExclusao({ aberto: false, refId: '', motivo: '' })
                }}
                className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
              >
                Confirmar Exclusão Registrada
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
