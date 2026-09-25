import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  SlidersHorizontal,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Scale,
  Hash,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import type { Budget, BudgetMethodology } from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'

export default function OrcamentoMetodologia() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [budget, setBudget] = useState<Budget | null>(null)
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)

  // Juízo Crítico
  const [criticalJudgmentMethod, setCriticalJudgmentMethod] = useState<
    'nao_aplicar' | 'desvio_padrao' | 'percentual'
  >('percentual')
  const [percentageUpper, setPercentageUpper] = useState<number>(30)
  const [percentageLower, setPercentageLower] = useState<number>(30)
  const [standardDeviationParameter, setStandardDeviationParameter] = useState<number>(2.0)

  // Método de obtenção do preço estimado
  const [estimatedPriceMethod, setEstimatedPriceMethod] = useState<
    'media' | 'mediana' | 'menor' | 'media_ponderada' | 'automatico_cv'
  >('mediana')
  const [cvThreshold, setCvThreshold] = useState<number>(25)

  // Casas decimais
  const [decimalPlaces, setDecimalPlaces] = useState<2 | 4>(2)

  useEffect(() => {
    if (id) {
      carregarOrcamento(id)
    }
  }, [id])

  const carregarOrcamento = async (budgetId: string) => {
    setLoading(true)
    try {
      const b = await BudgetService.obterOrcamento(budgetId)
      setBudget(b)

      const meth = await BudgetService.obterMetodologia(budgetId)
      if (meth) {
        setCriticalJudgmentMethod(meth.critical_judgment_method)
        setPercentageUpper(meth.percentage_upper !== undefined ? meth.percentage_upper : 30)
        setPercentageLower(meth.percentage_lower !== undefined ? meth.percentage_lower : 30)
        setStandardDeviationParameter(meth.standard_deviation_parameter || 2.0)
        setEstimatedPriceMethod(meth.estimated_price_method)
        setCvThreshold(meth.cv_threshold !== undefined ? meth.cv_threshold : 25)
        setDecimalPlaces(meth.decimal_places || 2)
      }
    } catch (err) {
      console.error('Erro ao carregar metodologia:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleContinuar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return

    setSalvando(true)
    try {
      await BudgetService.salvarMetodologia({
        budget_id: id,
        critical_judgment_method: criticalJudgmentMethod,
        percentage_upper: percentageUpper,
        percentage_lower: percentageLower,
        standard_deviation_parameter: standardDeviationParameter,
        estimated_price_method: estimatedPriceMethod,
        cv_threshold: cvThreshold,
        decimal_places: decimalPlaces,
      })

      // Navegar para a Etapa 3: Tela dos Itens do Orçamento
      navigate(`/app/orcamentos/${id}/itens`)
    } catch (err: any) {
      console.error('Erro ao salvar metodologia:', err)
      alert('Erro ao salvar metodologia: ' + (err.message || 'Verifique as configurações.'))
    } finally {
      setSalvando(false)
    }
  }

  if (loading) {
    return (
      <div className="p-12 text-center text-xs text-gray-500">
        Carregando configurações de metodologia...
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-white border border-[#b8c2cc] shadow-xs">
        {/* Barra Superior Azul-Escura #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex items-center justify-between select-none">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-amber-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              METODOLOGIAS E PADRÕES DE PREÇO — {budget?.internal_number}
            </span>
          </div>
          <span className="text-[11px] font-mono bg-white/10 px-2 py-0.5 text-amber-300">
            ETAPA 2 DE 3
          </span>
        </div>

        {/* Resumo do Orçamento no Topo */}
        <div className="bg-gray-100 p-3 px-4 border-b border-gray-300 text-xs flex flex-wrap justify-between items-center gap-2">
          <div>
            <span className="text-gray-500 font-bold uppercase text-[10px]">Orçamento:</span>{' '}
            <strong className="text-gray-900">{budget?.name}</strong>
          </div>
          <div>
            <span className="text-gray-500 uppercase text-[10px] block">Referência Externa:</span>
            <strong className="text-[#124268] font-mono">
              {budget?.external_reference?.trim() || '—'}
            </strong>
          </div>{' '}
        </div>

        {/* Banner Orientativo Amarelo */}
        <div className="bg-[#fffbeb] border-l-4 border-amber-500 p-3.5 m-4 text-xs text-amber-950 flex items-start gap-2.5">
          <HelpCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <strong className="block text-amber-900 uppercase font-bold text-[11px]">
              Tratamento Metodológico Transparente:
            </strong>
            <p>
              O sistema <strong>JAMAIS apaga um preço expurgado</strong>. Toda amostra saneada pelo
              juízo crítico permanece registrada com o status{' '}
              <span className="font-mono bg-amber-100 px-1 py-0.5">
                EXPURGADO PELO JUÍZO CRÍTICO
              </span>
              , guardando o preço original, motivo legal, método, fórmula, data e usuário
              responsável para fins de auditoria dos órgãos de controle.
            </p>
          </div>
        </div>

        <form onSubmit={handleContinuar} className="p-4 sm:p-6 space-y-6">
          {/* BLOCO 1: JUÍZO CRÍTICO */}
          <div className="space-y-3">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider select-none">
              BLOCO 1 — JUÍZO CRÍTICO E SANEAMENTO DE AMOSTRAS
            </div>

            <p className="text-xs text-gray-600 bg-gray-50 p-2.5 border border-gray-200">
              Método utilizado para realizar o saneamento das amostras coletadas, permitindo a
              identificação e o tratamento de valores excessivamente altos ou baixos conforme as
              regras metodológicas configuradas pelo órgão.
            </p>

            <div className="space-y-3 pl-1">
              {/* Opção 1: Não aplicar */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="criticalJudgment"
                  checked={criticalJudgmentMethod === 'nao_aplicar'}
                  onChange={() => setCriticalJudgmentMethod('nao_aplicar')}
                  className="mt-0.5 text-[#124268] focus:ring-[#124268]"
                />
                <div className="text-xs">
                  <span className="font-bold text-gray-900 block">Não aplicar juízo crítico</span>
                  <span className="text-gray-500">
                    Todas as cotações selecionadas pelo usuário entrarão diretamente no cálculo.
                  </span>
                </div>
              </label>

              {/* Opção 2: Desvio Padrão */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="criticalJudgment"
                  checked={criticalJudgmentMethod === 'desvio_padrao'}
                  onChange={() => setCriticalJudgmentMethod('desvio_padrao')}
                  className="mt-0.5 text-[#124268] focus:ring-[#124268]"
                />
                <div className="text-xs flex-1">
                  <span className="font-bold text-gray-900 block">
                    Expurgo de sobrepreço e preço inexequível por desvio padrão
                  </span>
                  <span className="text-gray-500 block">
                    Calcula a média e o desvio padrão das amostras. Valores com escore Z elevado são
                    sinalizados e expurgados mantendo o registro integral para auditoria.
                  </span>
                  {criticalJudgmentMethod === 'desvio_padrao' && (
                    <div className="mt-2.5 p-3 bg-blue-50/60 border border-blue-200 flex items-center gap-3">
                      <label className="text-[11px] font-bold text-gray-700 uppercase">
                        Múltiplo de Desvio Padrão (Escore |Z|):
                      </label>
                      <Input
                        type="number"
                        step="0.1"
                        min="1.0"
                        max="4.0"
                        value={standardDeviationParameter}
                        onChange={(e) =>
                          setStandardDeviationParameter(parseFloat(e.target.value) || 2.0)
                        }
                        className="h-8 w-24 text-xs font-bold rounded-none border-gray-400 bg-white"
                      />
                      <span className="text-[11px] text-gray-500">
                        (Padrão: 2.0 desvios acima/abaixo da média)
                      </span>
                    </div>
                  )}
                </div>
              </label>

              {/* Opção 3: Percentual */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="criticalJudgment"
                  checked={criticalJudgmentMethod === 'percentual'}
                  onChange={() => setCriticalJudgmentMethod('percentual')}
                  className="mt-0.5 text-[#124268] focus:ring-[#124268]"
                />
                <div className="text-xs flex-1">
                  <span className="font-bold text-gray-900 block">
                    Expurgo de sobrepreço e preço inexequível por percentual
                  </span>
                  <span className="text-gray-500 block">
                    Define limites percentuais acima e abaixo do preço de referência (mediana
                    preliminar). A faixa é configurável pelo órgão e não fixa em 30%.
                  </span>
                  {criticalJudgmentMethod === 'percentual' && (
                    <div className="mt-2.5 p-3 bg-blue-50/60 border border-blue-200 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-gray-700 uppercase mb-1">
                          Percentual máximo acima da referência (%):
                        </label>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min="5"
                            max="200"
                            value={percentageUpper}
                            onChange={(e) => setPercentageUpper(parseFloat(e.target.value) || 30)}
                            className="h-8 w-24 text-xs font-bold rounded-none border-gray-400 bg-white"
                          />
                          <span className="text-xs text-gray-600 font-bold">%</span>
                        </div>
                        <span className="text-[10px] text-gray-500">
                          Ex: +30% (limite superior para sobrepreço)
                        </span>
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-gray-700 uppercase mb-1">
                          Percentual máximo abaixo da referência (%):
                        </label>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min="5"
                            max="90"
                            value={percentageLower}
                            onChange={(e) => setPercentageLower(parseFloat(e.target.value) || 30)}
                            className="h-8 w-24 text-xs font-bold rounded-none border-gray-400 bg-white"
                          />
                          <span className="text-xs text-gray-600 font-bold">%</span>
                        </div>
                        <span className="text-[10px] text-gray-500">
                          Ex: -30% (limite inferior para inexequibilidade)
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </label>
            </div>
          </div>

          {/* BLOCO 2: MÉTODO DE OBTENÇÃO DO PREÇO ESTIMADO */}
          <div className="space-y-3 pt-2">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider select-none">
              BLOCO 2 — MÉTODO DE OBTENÇÃO DO PREÇO ESTIMADO
            </div>

            <div className="space-y-2.5 pl-1">
              {[
                {
                  id: 'media',
                  label: 'Média aritmética',
                  desc: 'Soma de todos os preços válidos dividida pela quantidade de amostras.',
                },
                {
                  id: 'mediana',
                  label: 'Mediana aritmética (Recomendada pela Lei 14.133)',
                  desc: 'Valor central que separa a metade superior da inferior. Imune a distorções de valores extremos.',
                },
                {
                  id: 'menor',
                  label: 'Menor preço',
                  desc: 'Menor valor encontrado entre as amostras saneadas.',
                },
                {
                  id: 'media_ponderada',
                  label: 'Média ponderada',
                  desc: 'Média ponderada pelas quantidades das contratações consultadas.',
                },
                {
                  id: 'automatico_cv',
                  label: 'Método automático baseado no Coeficiente de Variação (CV)',
                  desc: 'Aplica Média quando o CV estiver abaixo do limite configurado; caso contrário, aplica Mediana.',
                },
              ].map((opt) => (
                <label key={opt.id} className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="radio"
                    name="estimatedMethod"
                    checked={estimatedPriceMethod === opt.id}
                    onChange={() => setEstimatedPriceMethod(opt.id as any)}
                    className="mt-0.5 text-[#124268] focus:ring-[#124268]"
                  />
                  <div className="text-xs flex-1">
                    <span className="font-bold text-gray-900 block">{opt.label}</span>
                    <span className="text-gray-500 block">{opt.desc}</span>

                    {opt.id === 'automatico_cv' && estimatedPriceMethod === 'automatico_cv' && (
                      <div className="mt-2.5 p-3 bg-blue-50/60 border border-blue-200 flex items-center gap-3">
                        <label className="text-[11px] font-bold text-gray-700 uppercase">
                          Limite de corte do Coeficiente de Variação (CV):
                        </label>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min="5"
                            max="50"
                            value={cvThreshold}
                            onChange={(e) => setCvThreshold(parseFloat(e.target.value) || 25)}
                            className="h-8 w-20 text-xs font-bold rounded-none border-gray-400 bg-white"
                          />
                          <span className="text-xs font-bold text-gray-600">%</span>
                        </div>
                        <span className="text-[11px] text-gray-600">
                          (CV ≤ {cvThreshold}% → MÉDIA | CV &gt; {cvThreshold}% → MEDIANA)
                        </span>
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* BLOCO 3: CASAS DECIMAIS */}
          <div className="space-y-3 pt-2">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider select-none">
              BLOCO 3 — CASAS DECIMAIS
            </div>

            <p className="text-xs text-gray-600">
              A regra vale de forma consistente para preços unitários, médias, medianas, preços
              estimados e valores totais:
            </p>

            <div className="flex items-center gap-6 pl-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="decimalPlaces"
                  checked={decimalPlaces === 2}
                  onChange={() => setDecimalPlaces(2)}
                  className="text-[#124268]"
                />
                <span className="text-xs font-bold text-gray-900">
                  2 Casas Decimais (ex: R$ 15,37)
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="decimalPlaces"
                  checked={decimalPlaces === 4}
                  onChange={() => setDecimalPlaces(4)}
                  className="text-[#124268]"
                />
                <span className="text-xs font-bold text-gray-900">
                  4 Casas Decimais (ex: R$ 15,3750) — Ideal para combustíveis e medicamentos
                  fracionados
                </span>
              </label>
            </div>
          </div>

          {/* Botões do Rodapé: CANCELAR e CONTINUAR */}
          <div className="pt-4 border-t border-gray-300 flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(`/app/orcamentos`)}
              className="h-10 px-5 text-xs font-bold uppercase rounded-none border-gray-400 text-gray-700 bg-white hover:bg-gray-100"
            >
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              VOLTAR
            </Button>
            <Button
              type="submit"
              disabled={salvando}
              className="h-10 px-6 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex items-center gap-2"
            >
              <span>{salvando ? 'SALVANDO...' : 'CONTINUAR'}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
