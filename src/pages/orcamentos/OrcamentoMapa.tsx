import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  FileText,
  Printer,
  Download,
  ArrowLeft,
  SlidersHorizontal,
  Building2,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Scale,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type {
  Budget,
  BudgetItem,
  BudgetMethodology,
  BudgetPriceResult,
  BudgetExpurgatedPrice,
} from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'

export default function OrcamentoMapa() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [budget, setBudget] = useState<Budget | null>(null)
  const [methodology, setMethodology] = useState<BudgetMethodology | null>(null)
  const [itens, setItens] = useState<BudgetItem[]>([])
  const [cotacoesPorItem, setCotacoesPorItem] = useState<Record<string, BudgetPriceResult[]>>({})
  const [expurgadosPorItem, setExpurgadosPorItem] = useState<
    Record<string, BudgetExpurgatedPrice[]>
  >({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (id) {
      carregarMapa(id)
    }
  }, [id])

  const carregarMapa = async (budgetId: string) => {
    setLoading(true)
    try {
      const [b, meth, its] = await Promise.all([
        BudgetService.obterOrcamento(budgetId),
        BudgetService.obterMetodologia(budgetId),
        BudgetService.listarItens(budgetId),
      ])
      setBudget(b)
      setMethodology(meth)
      setItens(its)

      // Carregar cotações e expurgos de cada item
      const mapCot: Record<string, BudgetPriceResult[]> = {}
      for (const it of its) {
        const prices = await BudgetService.listarPrecosDoItem(it.id)
        mapCot[it.id] = prices
      }
      setCotacoesPorItem(mapCot)
    } catch (err) {
      console.error('Erro ao carregar mapa comparativo:', err)
    } finally {
      setLoading(false)
    }
  }

  const decimals = methodology?.decimal_places || 2
  const valorTotalGeral = itens.reduce((s, it) => s + (it.total_price || 0), 0)

  // Itens com Valor de Referência cadastrado para análise de vantajosidade
  const itensComVantajosidade = itens.filter(
    (i) => i.reference_price !== undefined && i.reference_price !== null && i.reference_price > 0,
  )
  const itensVantajososConfirmados = itensComVantajosidade.filter(
    (i) => (i.unit_price || 0) >= (i.reference_price || 0),
  )

  // Exportação CSV do Mapa Comparativo
  const handleExportarCsv = () => {
    const headers = [
      'ITEM',
      'DESCRICAO',
      'UNIDADE',
      'QUANTIDADE',
      'VALOR_REF_CONTRATO',
      'COTACAO 1',
      'COTACAO 2',
      'COTACAO 3',
      'MENOR PRECO',
      'MEDIA',
      'MEDIANA',
      'PRECO ESTIMADO',
      'VALOR TOTAL',
      'VANTAJOSIDADE_PRORROGACAO',
      'DIFERENCA_MEDIA_RS',
      'DIFERENCA_MEDIA_PCT',
      'CURVA ABC',
    ]

    const linhas = itens.map((it) => {
      const precos = cotacoesPorItem[it.id] || []
      const c1 = precos[0]?.unit_price ? precos[0].unit_price.toFixed(decimals) : '—'
      const c2 = precos[1]?.unit_price ? precos[1].unit_price.toFixed(decimals) : '—'
      const c3 = precos[2]?.unit_price ? precos[2].unit_price.toFixed(decimals) : '—'

      const precosVals = precos.map((p) => p.unit_price).filter((v) => v > 0)
      const menor = precosVals.length > 0 ? Math.min(...precosVals).toFixed(decimals) : '—'
      const media =
        precosVals.length > 0
          ? (precosVals.reduce((a, b) => a + b, 0) / precosVals.length).toFixed(decimals)
          : '—'
      const ordenada = [...precosVals].sort((a, b) => a - b)
      const meio = Math.floor(ordenada.length / 2)
      const mediana =
        ordenada.length > 0
          ? (ordenada.length % 2 === 0
              ? (ordenada[meio - 1] + ordenada[meio]) / 2
              : ordenada[meio]
            ).toFixed(decimals)
          : '—'

      const refVal = it.reference_price && it.reference_price > 0 ? it.reference_price : null
      const precoFinal = it.unit_price || 0
      let vantajosidadeTexto = 'NÃO APLICADO'
      let diffRs = '0,00'
      let diffPct = '0,0%'

      if (refVal !== null) {
        const dRs = precoFinal - refVal
        const dPct = (dRs / refVal) * 100
        diffRs = dRs.toFixed(decimals)
        diffPct = `${dPct >= 0 ? '+' : ''}${dPct.toFixed(2)}%`
        vantajosidadeTexto =
          precoFinal >= refVal ? 'VANTAJOSA (PREÇO MERCADO >= CONTRATO)' : 'PREÇO MERCADO MENOR'
      }

      return [
        String(it.sequence).padStart(2, '0'),
        `"${it.description}"`,
        it.unit,
        it.quantity,
        refVal ? refVal.toFixed(decimals) : '—',
        c1,
        c2,
        c3,
        menor,
        media,
        mediana,
        it.unit_price ? it.unit_price.toFixed(decimals) : '0,00',
        it.total_price ? it.total_price.toFixed(decimals) : '0,00',
        vantajosidadeTexto,
        diffRs,
        diffPct,
        it.abc_class || '—',
      ].join(';')
    })

    const csvContent = '\ufeff' + [headers.join(';'), ...linhas].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `mapa_comparativo_${budget?.internal_number || 'orcamento'}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleImprimir = () => {
    window.print()
  }

  if (loading) {
    return (
      <div className="p-12 text-center text-xs text-gray-500">
        Carregando mapa comparativo de preços...
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto print:m-0 print:p-0">
      {/* Topo do Módulo Cesta de Preços */}
      <div className="bg-white border border-[#b8c2cc] shadow-xs">
        {/* Barra Superior Azul-Escura #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex flex-wrap items-center justify-between gap-2 select-none print:bg-black print:text-white">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              MAPA COMPARATIVO E RELATÓRIO DO ORÇAMENTO — {budget?.internal_number}
            </span>
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate(`/app/orcamentos/${id}/itens`)}
              className="h-7 text-[11px] font-bold uppercase rounded-none border-white/30 bg-white/10 hover:bg-white/20 text-white"
            >
              <ArrowLeft className="h-3 w-3 mr-1" />
              Voltar aos Itens
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportarCsv}
              className="h-7 text-[11px] font-bold uppercase rounded-none border-white/30 bg-white/10 hover:bg-white/20 text-white"
            >
              <Download className="h-3 w-3 mr-1" />
              Exportar CSV / Planilha
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleImprimir}
              className="h-7 text-[11px] font-bold uppercase rounded-none bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-none"
            >
              <Printer className="h-3 w-3 mr-1" />
              Imprimir / PDF
            </Button>
          </div>
        </div>

        {/* Informações Institucionais do Orçamento */}
        <div className="p-4 bg-gray-50 border-b border-gray-300 space-y-3 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <span className="text-gray-500 font-bold uppercase text-[10px] block">
                Nome do Orçamento:
              </span>
              <strong className="text-gray-900 text-sm block">{budget?.name}</strong>
            </div>
            <div>
              <span className="text-gray-500 font-bold uppercase text-[10px] block">
                Referência Externa (Processo):
              </span>
              <strong className="text-[#124268] font-mono text-sm block">
                {budget?.external_reference}
              </strong>
            </div>
            <div>
              <span className="text-gray-500 font-bold uppercase text-[10px] block">
                Órgão Interessado:
              </span>
              <strong className="text-gray-900 block">
                {budget?.expand?.organization_id?.nome || 'Órgão Contratante'}
              </strong>
            </div>
          </div>

          <div>
            <span className="text-gray-500 font-bold uppercase text-[10px] block">
              Objeto da Contratação:
            </span>
            <p className="text-gray-800 bg-white p-2.5 border border-gray-200 text-xs">
              {budget?.object}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-6 pt-1 text-[11px] text-gray-600">
            <div>
              Metodologia de Cálculo:{' '}
              <strong className="text-gray-800 uppercase">
                {methodology?.estimated_price_method}
              </strong>
            </div>
            <div>
              Juízo Crítico:{' '}
              <strong className="text-gray-800 uppercase">
                {methodology?.critical_judgment_method} (±{methodology?.percentage_upper || 30}%)
              </strong>
            </div>
            <div>
              Casas Decimais: <strong className="text-gray-800">{decimals}</strong>
            </div>
            <div>
              Data de Emissão:{' '}
              <strong className="text-gray-800">{new Date().toLocaleDateString('pt-BR')}</strong>
            </div>
          </div>
        </div>

        {/* MAPA COMPARATIVO — TABELA RIGOROSA */}
        <div className="p-4 space-y-3">
          <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
            <span>MAPA COMPARATIVO DE PREÇOS</span>
            <span className="text-[11px] font-normal lowercase">
              {itens.length} item(ns) cotado(s)
            </span>
          </div>

          <div className="border border-gray-300 overflow-x-auto shadow-2xs">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300 select-none">
                <tr>
                  <th className="p-2 text-center w-12">ITEM</th>
                  <th className="p-2">DESCRIÇÃO</th>
                  <th className="p-2 text-center">UNIDADE</th>
                  <th className="p-2 text-right">QUANT.</th>
                  <th
                    className="p-2 text-right bg-blue-50/80 border-x border-blue-200"
                    title="Valor Vigente no Contrato"
                  >
                    REF. VIGENTE
                  </th>
                  <th className="p-2 text-right">COTAÇÃO 1</th>
                  <th className="p-2 text-right">COTAÇÃO 2</th>
                  <th className="p-2 text-right">COTAÇÃO 3</th>
                  <th className="p-2 text-right">MENOR</th>
                  <th className="p-2 text-right">MÉDIA</th>
                  <th className="p-2 text-right">MEDIANA</th>
                  <th className="p-2 text-right bg-blue-50/50">PREÇO ESTIMADO</th>
                  <th className="p-2 text-right bg-blue-50/50">VALOR TOTAL</th>
                  <th className="p-2 text-center bg-emerald-50/60 border-l border-emerald-200">
                    VANTAJOSIDADE
                  </th>
                  <th className="p-2 text-center">CURVA ABC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {itens.map((it) => {
                  const cotacoes = cotacoesPorItem[it.id] || []
                  const c1 = cotacoes[0]
                  const c2 = cotacoes[1]
                  const c3 = cotacoes[2]

                  const precosVals = cotacoes
                    .map((p) => p.unit_price)
                    .filter((v) => typeof v === 'number' && v > 0)
                  const menor = precosVals.length > 0 ? Math.min(...precosVals) : null
                  const media =
                    precosVals.length > 0
                      ? precosVals.reduce((a, b) => a + b, 0) / precosVals.length
                      : null
                  const ordenada = [...precosVals].sort((a, b) => a - b)
                  const meio = Math.floor(ordenada.length / 2)
                  const mediana =
                    ordenada.length > 0
                      ? ordenada.length % 2 === 0
                        ? (ordenada[meio - 1] + ordenada[meio]) / 2
                        : ordenada[meio]
                      : null

                  const temRef =
                    it.reference_price !== undefined &&
                    it.reference_price !== null &&
                    it.reference_price > 0
                  const diffRs = temRef && it.unit_price ? it.unit_price - it.reference_price! : 0
                  const diffPct =
                    temRef && it.reference_price! > 0 ? (diffRs / it.reference_price!) * 100 : 0
                  const isVantajoso =
                    temRef && it.unit_price && it.unit_price >= it.reference_price!

                  return (
                    <tr key={it.id} className="hover:bg-gray-50">
                      <td className="p-2 text-center font-mono font-bold bg-gray-50">
                        {String(it.sequence).padStart(2, '0')}
                      </td>
                      <td
                        className="p-2 font-medium text-gray-900 max-w-[200px] truncate"
                        title={it.description}
                      >
                        {it.description}
                      </td>
                      <td className="p-2 text-center font-mono">{it.unit}</td>
                      <td className="p-2 text-right font-mono">
                        {it.quantity.toLocaleString('pt-BR')}
                      </td>

                      {/* VALOR DE REFERÊNCIA VIGENTE */}
                      <td className="p-2 text-right font-mono whitespace-nowrap bg-blue-50/40 border-x border-blue-200">
                        {temRef ? (
                          <strong className="text-blue-950 font-mono">
                            R$ {it.reference_price!.toFixed(decimals)}
                          </strong>
                        ) : (
                          <span className="text-gray-400 italic">Não inf.</span>
                        )}
                      </td>

                      {/* COTAÇÃO 1 */}
                      <td className="p-2 text-right font-mono whitespace-nowrap">
                        {c1 ? `R$ ${c1.unit_price.toFixed(decimals)}` : '—'}
                      </td>
                      {/* COTAÇÃO 2 */}
                      <td className="p-2 text-right font-mono whitespace-nowrap">
                        {c2 ? `R$ ${c2.unit_price.toFixed(decimals)}` : '—'}
                      </td>
                      {/* COTAÇÃO 3 */}
                      <td className="p-2 text-right font-mono whitespace-nowrap">
                        {c3 ? `R$ ${c3.unit_price.toFixed(decimals)}` : '—'}
                      </td>

                      {/* MENOR */}
                      <td className="p-2 text-right font-mono font-bold whitespace-nowrap text-gray-700">
                        {menor !== null ? `R$ ${menor.toFixed(decimals)}` : '—'}
                      </td>

                      {/* MÉDIA */}
                      <td className="p-2 text-right font-mono whitespace-nowrap text-gray-700">
                        {media !== null ? `R$ ${media.toFixed(decimals)}` : '—'}
                      </td>

                      {/* MEDIANA */}
                      <td className="p-2 text-right font-mono whitespace-nowrap text-gray-700">
                        {mediana !== null ? `R$ ${mediana.toFixed(decimals)}` : '—'}
                      </td>

                      {/* PREÇO ESTIMADO OFICIAL */}
                      <td className="p-2 text-right font-mono font-bold whitespace-nowrap bg-blue-50/50 text-[#124268]">
                        {it.unit_price ? `R$ ${it.unit_price.toFixed(decimals)}` : 'R$ 0,00'}
                      </td>

                      {/* VALOR TOTAL */}
                      <td className="p-2 text-right font-mono font-bold whitespace-nowrap bg-blue-50/50 text-gray-900">
                        {it.total_price ? `R$ ${it.total_price.toFixed(decimals)}` : 'R$ 0,00'}
                      </td>

                      {/* STATUS DA VANTAJOSIDADE */}
                      <td className="p-2 text-center whitespace-nowrap bg-emerald-50/30 border-l border-emerald-200">
                        {temRef ? (
                          <div className="flex flex-col items-center">
                            <span
                              className={`px-1.5 py-0.5 text-[10px] font-bold ${
                                isVantajoso
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                  : 'bg-amber-100 text-amber-800 border border-amber-300'
                              }`}
                            >
                              {isVantajoso ? '✓ VANTAJOSO' : '⚠ ABAIXO'}
                            </span>
                            <span className="text-[9px] font-mono text-gray-600 mt-0.5">
                              {diffRs >= 0 ? '+' : ''}
                              {diffRs.toFixed(decimals)} ({diffPct >= 0 ? '+' : ''}
                              {diffPct.toFixed(1)}%)
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-400 font-mono text-[11px]">—</span>
                        )}
                      </td>

                      {/* CURVA ABC */}
                      <td className="p-2 text-center font-mono font-bold">
                        {it.abc_class && it.abc_class !== '—' ? (
                          <span
                            className={`px-1.5 py-0.5 text-[10px] ${
                              it.abc_class === 'A'
                                ? 'bg-red-100 text-red-800'
                                : it.abc_class === 'B'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-blue-100 text-blue-800'
                            }`}
                          >
                            {it.abc_class}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="bg-gray-100 font-bold border-t-2 border-gray-400">
                <tr>
                  <td colSpan={11} className="p-3 text-right uppercase font-bold text-gray-800">
                    VALOR ESTIMADO GLOBAL DO ORÇAMENTO:
                  </td>
                  <td className="p-3 text-right font-mono text-sm text-[#124268] whitespace-nowrap">
                    R${' '}
                    {valorTotalGeral.toLocaleString('pt-BR', {
                      minimumFractionDigits: decimals,
                      maximumFractionDigits: decimals,
                    })}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* QUADRO ESPECIAL: DEMONSTRATIVO DE VANTAJOSIDADE PARA PRORROGAÇÃO CONTRATUAL */}
        {itensComVantajosidade.length > 0 && (
          <div className="p-4 bg-emerald-50/60 border-t-2 border-emerald-500 space-y-3">
            <div className="bg-[#124268] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between">
              <span>
                DEMONSTRATIVO DE VANTAJOSIDADE — PRORROGAÇÃO CONTRATUAL (ART. 106 / 107 DA LEI
                14.133/2021)
              </span>
              <span className="bg-emerald-400 text-slate-950 font-bold px-2 py-0.5 text-[10px]">
                {itensVantajososConfirmados.length} DE {itensComVantajosidade.length} ITENS
                COMPROVADOS
              </span>
            </div>

            <div className="bg-white p-3 border border-emerald-300 space-y-3 text-xs">
              <p className="text-gray-700 leading-relaxed text-[11.5px]">
                A vantajosidade econômica para prorrogação de vigência contratual resta comprovada
                quando os preços praticados no mercado se mostram iguais ou superiores aos valores
                atualmente vigentes no contrato. Dos{' '}
                <strong>{itensComVantajosidade.length} item(ns)</strong> analisados com valor de
                referência contratual cadastrado,{' '}
                <strong>
                  {itensVantajososConfirmados.length} item(ns) (
                  {(
                    (itensVantajososConfirmados.length / itensComVantajosidade.length) *
                    100
                  ).toFixed(1)}
                  %)
                </strong>{' '}
                possuem preço de mercado superior ou igual ao contratado, demonstrando que a
                renovação/prorrogação contratual é a medida mais econômica e vantajosa para a
                Administração Pública frente à realização de novo certame licitatório.
              </p>

              <div className="overflow-x-auto border border-emerald-200">
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="bg-emerald-100 text-emerald-950 font-bold uppercase text-[10px]">
                    <tr>
                      <th className="p-2 text-center w-12">ITEM</th>
                      <th className="p-2">DESCRIÇÃO</th>
                      <th className="p-2 text-right">VALOR CONTRATADO</th>
                      <th className="p-2 text-right">PREÇO DE MERCADO</th>
                      <th className="p-2 text-right">DIFERENÇA (R$)</th>
                      <th className="p-2 text-right">DIFERENÇA (%)</th>
                      <th className="p-2 text-center">CONCLUSÃO TÉCNICA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-100 font-mono text-[11px]">
                    {itensComVantajosidade.map((it) => {
                      const refVal = it.reference_price || 0
                      const mktVal = it.unit_price || 0
                      const dRs = mktVal - refVal
                      const dPct = refVal > 0 ? (dRs / refVal) * 100 : 0
                      const isVant = mktVal >= refVal

                      return (
                        <tr key={it.id} className="hover:bg-emerald-50/50">
                          <td className="p-2 text-center font-bold">
                            {String(it.sequence).padStart(2, '0')}
                          </td>
                          <td className="p-2 font-sans font-medium text-gray-900">
                            {it.description}
                          </td>
                          <td className="p-2 text-right">R$ {refVal.toFixed(decimals)}</td>
                          <td className="p-2 text-right font-bold text-[#124268]">
                            R$ {mktVal.toFixed(decimals)}
                          </td>
                          <td
                            className={`p-2 text-right font-bold ${dRs >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}
                          >
                            {dRs >= 0 ? '+' : ''}R$ {dRs.toFixed(decimals)}
                          </td>
                          <td
                            className={`p-2 text-right font-bold ${dPct >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}
                          >
                            {dPct >= 0 ? '+' : ''}
                            {dPct.toFixed(2)}%
                          </td>
                          <td className="p-2 text-center font-sans">
                            {isVant ? (
                              <span className="text-emerald-800 font-bold bg-emerald-100 px-2 py-0.5 border border-emerald-300">
                                ✓ Prorrogação Vantajosa
                              </span>
                            ) : (
                              <span className="text-amber-800 font-bold bg-amber-100 px-2 py-0.5 border border-amber-300">
                                ⚠ Mercado Inferior
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Quadro de Auditoria e Assinatura */}
        <div className="p-4 bg-gray-50 border-t border-gray-300 text-xs text-gray-600 space-y-4">
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Conformidade com a Lei Federal nº 14.133/2021:</strong> O presente orçamento e
              pesquisa de preços foi elaborado com suporte de Inteligência Artificial para busca e
              normalização de cotações em fontes governamentais oficiais (PNCP, Compras.gov.br, BPS,
              BEC-SP), sendo as amostras revisadas e o cálculo executado por motor estatístico
              determinístico.
            </div>
          </div>

          <div className="pt-8 grid grid-cols-2 gap-8 text-center">
            <div className="border-t border-gray-400 pt-2">
              <p className="font-bold text-gray-800">Responsável pela Pesquisa de Preços</p>
              <p className="text-[11px] text-gray-500">
                Comissão de Contratação / Servidor Designado
              </p>
            </div>
            <div className="border-t border-gray-400 pt-2">
              <p className="font-bold text-gray-800">Autoridade Competente</p>
              <p className="text-[11px] text-gray-500">
                Ordenador de Despesas / Secretário Municipal
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
