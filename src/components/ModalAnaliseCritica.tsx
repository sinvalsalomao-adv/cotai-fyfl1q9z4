import React, { useState, useEffect } from 'react'
import {
  X,
  FileText,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Plus,
  ShieldCheck,
  Scale,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type {
  BudgetItem,
  BudgetPriceResult,
  BudgetStatistics,
  BudgetMethodology,
} from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'

interface ModalAnaliseCriticaProps {
  item: BudgetItem
  budgetId: string
  isOpen: boolean
  onClose: () => void
  onAtualizar?: () => void
}

export const ModalAnaliseCritica: React.FC<ModalAnaliseCriticaProps> = ({
  item,
  budgetId,
  isOpen,
  onClose,
  onAtualizar,
}) => {
  const [loading, setLoading] = useState(true)
  const [methodology, setMethodology] = useState<BudgetMethodology | null>(null)
  const [precos, setPrecos] = useState<BudgetPriceResult[]>([])
  const [estatisticas, setEstatisticas] = useState<BudgetStatistics | null>(null)
  const [justificativa, setJustificativa] = useState('')
  const [mostrandoCampoJustificativa, setMostrandoCampoJustificativa] = useState(false)
  const [salvandoJustificativa, setSalvandoJustificativa] = useState(false)

  useEffect(() => {
    if (isOpen) {
      carregarDados()
    }
  }, [isOpen, item.id])

  const carregarDados = async () => {
    setLoading(true)
    try {
      const [meth, pList] = await Promise.all([
        BudgetService.obterMetodologia(budgetId),
        BudgetService.listarPrecosDoItem(item.id),
      ])
      setMethodology(meth)
      setPrecos(pList)

      // Carregar estatísticas existentes do item
      const statsEx = await fetchStatistics(item.id)
      setEstatisticas(statsEx)

      // Se houver justificativas salvas em details_json
      if (statsEx?.details_json?.justificativa_analise) {
        setJustificativa(statsEx.details_json.justificativa_analise)
      } else {
        setJustificativa('')
      }
    } catch (e) {
      console.error('Erro ao carregar dados da análise crítica:', e)
    } finally {
      setLoading(false)
    }
  }

  const fetchStatistics = async (itemId: string): Promise<BudgetStatistics | null> => {
    try {
      // Como o pocketbase pode ter estatísticas na collection budget_statistics
      // ou calculamos na hora com os preços já cotados
      const precosValidos = precos.filter(
        (p) => p.status === 'selecionado' || p.status === 'encontrado',
      )
      return null
    } catch {
      return null
    }
  }

  const handleSalvarJustificativa = async () => {
    if (!justificativa.trim()) {
      alert('Por favor, informe a justificativa ou observação técnica.')
      return
    }

    setSalvandoJustificativa(true)
    try {
      await BudgetService.registrarLog({
        budget_id: budgetId,
        action: 'JUSTIFICATIVA_ANALISE_CRITICA',
        entity_type: 'budget_items',
        entity_id: item.id,
        description: `Justificativa registrada na Análise Crítica do Item ${String(item.sequence).padStart(2, '0')}: "${justificativa.trim()}".`,
        metadata: {
          item_id: item.id,
          justificativa: justificativa.trim(),
          data: new Date().toISOString(),
        },
      })
      alert('Justificativa/Observação registrada com sucesso na auditoria do orçamento!')
      setMostrandoCampoJustificativa(false)
      if (onAtualizar) onAtualizar()
    } catch (e: any) {
      alert('Erro ao registrar justificativa: ' + (e.message || 'Falha'))
    } finally {
      setSalvandoJustificativa(false)
    }
  }

  if (!isOpen) return null

  // Cálculos determinísticos para exibir na janela da Etapa 08
  const decimais = methodology?.decimal_places || 2
  const amostrasValidas = precos.filter(
    (p) => p.status !== 'expurgado' && p.status !== 'nao_selecionado',
  )
  const amostrasExpurgadas = precos.filter((p) => p.status === 'expurgado')
  const totalColetadas = precos.length

  const valores = amostrasValidas.map((p) => p.unit_price).sort((a, b) => a - b)
  const n = valores.length
  const media = n > 0 ? valores.reduce((a, b) => a + b, 0) / n : 0
  const menor = n > 0 ? valores[0] : 0
  const maior = n > 0 ? valores[n - 1] : 0

  const meio = Math.floor(n / 2)
  const mediana =
    n > 0 ? (n % 2 === 0 ? (valores[meio - 1] + valores[meio]) / 2 : valores[meio]) : 0

  let desvioPadrao = 0
  if (n > 1) {
    const somaQuad = valores.reduce((acc, v) => acc + Math.pow(v - media, 2), 0)
    desvioPadrao = Math.sqrt(somaQuad / (n - 1))
  }
  const cv = media > 0 ? (desvioPadrao / media) * 100 : 0

  // Limites do Juízo Crítico
  let limiteInferior = 0
  let limiteSuperior = 0
  let labelInferior = '(DP - média)'
  let labelSuperior = '(DP + média)'

  if (methodology?.critical_judgment_method === 'percentual') {
    const sup = methodology.percentage_upper || 30
    const inf = methodology.percentage_lower || 30
    limiteInferior = Math.max(0, mediana * (1 - inf / 100))
    limiteSuperior = mediana * (1 + sup / 100)
    labelInferior = `(-${inf}% da mediana)`
    labelSuperior = `(+${sup}% da mediana)`
  } else if (methodology?.critical_judgment_method === 'desvio_padrao') {
    const fator = methodology.standard_deviation_parameter || 2.0
    limiteInferior = Math.max(0, media - fator * desvioPadrao)
    limiteSuperior = media + fator * desvioPadrao
    labelInferior = `(-${fator} DP)`
    labelSuperior = `(+${fator} DP)`
  }

  // Críticas: amostras menores que 3 ou CV alto
  const criticasCount =
    (n < 3 ? 1 : 0) + (cv > 25 ? 1 : 0) + (amostrasExpurgadas.length > 0 ? 1 : 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-5xl my-6 rounded-none overflow-hidden flex flex-col max-h-[92vh]">
        {/* Barra Superior Azul-Escura Cesta de Preços: #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex items-center justify-between select-none flex-shrink-0">
          <span className="font-bold text-xs uppercase tracking-wider">
            ANÁLISE CRÍTICA DOS DADOS COLETADOS
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-white/80 hover:text-white p-1"
            title="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* ITEM PESQUISADO */}
          <div className="bg-gray-100 p-3 border border-gray-300">
            <span className="text-[10px] font-bold text-gray-500 uppercase block">
              ITEM PESQUISADO
            </span>
            <div className="font-bold text-[#124268] text-sm mt-0.5">
              {String(item.sequence).padStart(2, '0')}. {item.description}
            </div>
            <div className="text-[11px] text-gray-600 mt-1 flex flex-wrap gap-4">
              <span>
                Quantidade: <strong>{item.quantity.toLocaleString('pt-BR')}</strong>
              </span>
              <span>
                Medida: <strong>{item.unit}</strong>
              </span>
              <span>
                Tipo: <strong>{item.type}</strong>
              </span>
              {item.brand && (
                <span>
                  Marca: <strong>{item.brand}</strong>
                </span>
              )}
            </div>
          </div>

          {/* TABELA 1: JUÍZO CRÍTICO (ESTILO CESTA DE PREÇOS) */}
          <div className="space-y-1">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider select-none">
              JUÍZO CRÍTICO
            </div>
            <div className="border border-gray-300 overflow-x-auto shadow-2xs">
              <table className="w-full text-xs text-center border-collapse">
                <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300">
                  <tr>
                    <th className="p-2 border-r border-gray-200">Nº DE AMOSTRAS COLETADAS</th>
                    <th className="p-2 border-r border-gray-200">MÉDIA</th>
                    <th className="p-2 border-r border-gray-200">DESVIO-PADRÃO</th>
                    <th className="p-2 border-r border-gray-200">LIMITE INFERIOR</th>
                    <th className="p-2 border-r border-gray-200">LIMITE SUPERIOR</th>
                    <th className="p-2 border-r border-gray-200">CRÍTICAS</th>
                    <th className="p-2">AMOSTRAS EXPURGADAS</th>
                  </tr>
                </thead>
                <tbody className="bg-white font-mono font-medium">
                  <tr>
                    <td className="p-2 border-r border-gray-200 font-bold">{totalColetadas}</td>
                    <td className="p-2 border-r border-gray-200">R$ {media.toFixed(decimais)}</td>
                    <td className="p-2 border-r border-gray-200">
                      {desvioPadrao.toFixed(decimais)}
                    </td>
                    <td className="p-2 border-r border-gray-200 text-gray-700">
                      <div>R$ {limiteInferior.toFixed(decimais)}</div>
                      <div className="text-[9px] text-gray-500 font-sans">{labelInferior}</div>
                    </td>
                    <td className="p-2 border-r border-gray-200 text-gray-700">
                      <div>R$ {limiteSuperior.toFixed(decimais)}</div>
                      <div className="text-[9px] text-gray-500 font-sans">{labelSuperior}</div>
                    </td>
                    <td className="p-2 border-r border-gray-200 font-sans">
                      <span
                        className={`inline-block px-2 py-0.5 text-[10px] font-bold text-white rounded-none ${
                          criticasCount > 0 ? 'bg-red-600' : 'bg-emerald-600'
                        }`}
                      >
                        {criticasCount}
                      </span>
                    </td>
                    <td className="p-2 font-sans">
                      <span
                        className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded-none ${
                          amostrasExpurgadas.length > 0
                            ? 'bg-amber-100 text-amber-900 border border-amber-300'
                            : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {amostrasExpurgadas.length}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* TABELA 2: MÉTODO ESTATÍSTICO APLICADO ÀS AMOSTRAS SANEADAS */}
          <div className="space-y-1">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider select-none">
              MÉTODO ESTATÍSTICO APLICADO ÀS AMOSTRAS SANEADAS
            </div>
            <div className="border border-gray-300 overflow-x-auto shadow-2xs">
              <table className="w-full text-xs text-center border-collapse">
                <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300">
                  <tr>
                    <th className="p-2 border-r border-gray-200">Nº DE AMOSTRAS VÁLIDAS</th>
                    <th className="p-2 border-r border-gray-200">DESVIO-PADRÃO</th>
                    <th className="p-2 border-r border-gray-200">COEFICIENTE DE VARIAÇÃO</th>
                    <th className="p-2 border-r border-gray-200">MENOR PREÇO</th>
                    <th className="p-2 border-r border-gray-200">MÉDIA</th>
                    <th className="p-2">MEDIANA</th>
                  </tr>
                </thead>
                <tbody className="bg-white font-mono font-medium">
                  <tr>
                    <td className="p-2 border-r border-gray-200 font-bold">{n}</td>
                    <td className="p-2 border-r border-gray-200">
                      {desvioPadrao.toFixed(decimais)}
                    </td>
                    <td className="p-2 border-r border-gray-200">{cv.toFixed(2)}%</td>
                    <td className="p-2 border-r border-gray-200">R$ {menor.toFixed(decimais)}</td>
                    <td className="p-2 border-r border-gray-200">R$ {media.toFixed(decimais)}</td>
                    <td className="p-2 font-bold text-[#124268]">R$ {mediana.toFixed(decimais)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* TABELA 3: SÉRIE DE PREÇOS COLETADOS */}
          <div className="space-y-1">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider select-none flex items-center justify-between">
              <span>SÉRIE DE PREÇOS COLETADOS</span>
              <span className="text-[10px] font-normal lowercase">{precos.length} amostra(s)</span>
            </div>
            {precos.length === 0 ? (
              <div className="p-8 text-center border border-gray-300 bg-gray-50 text-gray-500">
                VOCÊ NÃO POSSUI AMOSTRAS DE PREÇOS PARA ESTE ITEM
              </div>
            ) : (
              <div className="border border-gray-300 overflow-x-auto shadow-2xs">
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300">
                    <tr>
                      <th className="p-2 text-center w-14">AMOSTRA</th>
                      <th className="p-2 text-center">SITUAÇÃO</th>
                      <th className="p-2">FONTE</th>
                      <th className="p-2">ÓRGÃO / FORNECEDOR</th>
                      <th className="p-2">MARCA</th>
                      <th className="p-2 text-center">DATA</th>
                      <th className="p-2 text-center">MEDIDA</th>
                      <th className="p-2 text-right">QNT ORIGINAL</th>
                      <th className="p-2 text-right">VALOR UNITÁRIO</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {precos.map((p, idx) => {
                      const isExp = p.status === 'expurgado'
                      return (
                        <tr
                          key={p.id}
                          className={`hover:bg-blue-50/30 ${isExp ? 'bg-red-50/40 text-gray-500' : ''}`}
                        >
                          <td className="p-2 text-center font-bold font-mono">
                            {String(idx + 1).padStart(2, '0')}
                          </td>
                          <td className="p-2 text-center whitespace-nowrap">
                            {isExp ? (
                              <span className="inline-block px-1.5 py-0.5 text-[9px] font-bold bg-red-100 text-red-800 border border-red-300">
                                EXPURGADO PELO JUÍZO CRÍTICO
                              </span>
                            ) : p.status === 'selecionado' ? (
                              <span className="inline-block px-1.5 py-0.5 text-[9px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                                SANEADA / VÁLIDA
                              </span>
                            ) : (
                              <span className="inline-block px-1.5 py-0.5 text-[9px] font-bold bg-gray-100 text-gray-700 border border-gray-300">
                                COLETADA
                              </span>
                            )}
                          </td>
                          <td className="p-2 font-bold whitespace-nowrap">{p.source}</td>
                          <td
                            className="p-2 max-w-[200px] truncate"
                            title={`${p.government_entity} - ${p.supplier}`}
                          >
                            <div className="font-medium text-gray-900 truncate">
                              {p.government_entity || 'NÃO INFORMADO'}
                            </div>
                            <div className="text-[10px] text-gray-500 truncate">
                              {p.supplier || 'NÃO INFORMADO'}
                            </div>
                          </td>
                          <td className="p-2 text-gray-700">
                            {p.raw_data?.marca || 'NÃO INFORMADO'}
                          </td>
                          <td className="p-2 text-center font-mono text-[11px]">
                            {p.source_date
                              ? new Date(p.source_date).toLocaleDateString('pt-BR')
                              : '—'}
                          </td>
                          <td className="p-2 text-center font-mono">{p.unit}</td>
                          <td className="p-2 text-right font-mono">
                            {p.quantity.toLocaleString('pt-BR')}
                          </td>
                          <td className="p-2 text-right font-mono font-bold whitespace-nowrap">
                            R$ {p.unit_price.toFixed(decimais)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* TABELA 4: MEDIDAS DE TENDÊNCIA CENTRAL */}
          <div className="border border-gray-300 p-3 bg-gray-50 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-gray-700 font-bold uppercase text-[11px]">
              MEDIDA DE TENDÊNCIA CENTRAL CONFIGURADA:{' '}
              <span className="text-[#124268]">
                {methodology?.estimated_price_method?.toUpperCase() || 'MEDIANA'}
              </span>
            </div>
            <div className="flex items-center gap-6 font-mono text-xs">
              <div>
                <span className="text-gray-500 block text-[10px]">MEDIANA:</span>
                <strong className="text-gray-900">R$ {mediana.toFixed(decimais)}</strong>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">MÉDIA:</span>
                <strong className="text-gray-900">R$ {media.toFixed(decimais)}</strong>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">MENOR PREÇO:</span>
                <strong className="text-gray-900">R$ {menor.toFixed(decimais)}</strong>
              </div>
            </div>
          </div>

          {/* SEÇÃO DE CRÍTICA DOS DADOS E JUSTIFICATIVA/OBSERVAÇÃO (ETAPA 08) */}
          <div className="space-y-2 border-t border-gray-200 pt-3">
            <div className="bg-[#828892] text-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider select-none flex items-center justify-between">
              <span>CRÍTICA DOS DADOS</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setMostrandoCampoJustificativa(!mostrandoCampoJustificativa)}
                className="h-6 text-[10px] font-bold uppercase bg-white text-[#124268] hover:bg-gray-100 rounded-none border-none"
              >
                <Plus className="h-3 w-3 mr-1" />
                ADICIONAR JUSTIFICATIVA OU OBSERVAÇÃO
              </Button>
            </div>

            {/* Alertas e Críticas */}
            <div className="space-y-1.5">
              {n < 3 && (
                <div className="p-2.5 bg-amber-50 border-l-4 border-amber-500 text-amber-950 text-xs flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>
                      1. FORAM COLETADAS MENOS DE TRÊS AMOSTRAS VÁLIDAS. É PRECISO JUSTIFICAR ESTE
                      ITEM DO ORÇAMENTO.
                    </strong>
                    <p className="text-[11px] text-amber-800">
                      Conforme preconizado no art. 23 da Lei 14.133/2021 e jurisprudência do TCU, a
                      pesquisa deve contar preferencialmente com no mínimo 3 cotações de
                      fornecedores ou contratações similares. Justifique a restrição de fornecedores
                      ou selecione mais amostras.
                    </p>
                  </div>
                </div>
              )}

              {cv > 25 && (
                <div className="p-2.5 bg-blue-50 border-l-4 border-blue-500 text-blue-950 text-xs flex items-start gap-2">
                  <HelpCircle className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>2. ALTA DISPERSÃO AMOSTRAL (CV = {cv.toFixed(2)}% &gt; 25%).</strong>
                    <p className="text-[11px] text-blue-800">
                      A adoção da Mediana como preço de referência mitiga distorções ocasionadas por
                      valores extremos da amostra saneada.
                    </p>
                  </div>
                </div>
              )}

              {amostrasExpurgadas.length > 0 && (
                <div className="p-2.5 bg-red-50 border-l-4 border-red-500 text-red-950 text-xs flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong>
                      3. FORAM IDENTIFICADAS {amostrasExpurgadas.length} AMOSTRA(S) EXPURGADA(S)
                      PELO JUÍZO CRÍTICO.
                    </strong>
                    <p className="text-[11px] text-red-800">
                      Os valores foram classificados como sobrepreço ou inexequíveis e expurgados do
                      cálculo estatístico, mantendo-se integral rastreabilidade nos registros de
                      auditoria.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Campo para Adicionar Justificativa ou Observação */}
            {mostrandoCampoJustificativa && (
              <div className="p-3 bg-gray-50 border border-gray-300 space-y-2 mt-2">
                <label className="block text-gray-800 font-bold uppercase text-[11px]">
                  Registrar Justificativa Técnica / Observação da Análise Crítica:
                </label>
                <Textarea
                  rows={3}
                  value={justificativa}
                  onChange={(e) => setJustificativa(e.target.value)}
                  placeholder="Ex: Em razão da especificidade do princípio ativo e da restrição do mercado produtor homologado pela Anvisa, foram localizadas apenas 2 contratações públicas no período de 12 meses..."
                  className="text-xs rounded-none border-gray-400 bg-white"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setMostrandoCampoJustificativa(false)}
                    className="h-8 text-xs font-bold uppercase rounded-none border-gray-400"
                  >
                    CANCELAR
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={salvandoJustificativa}
                    onClick={handleSalvarJustificativa}
                    className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
                  >
                    {salvandoJustificativa ? 'SALVANDO...' : 'REGISTRAR JUSTIFICATIVA'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Rodapé com botão Fechar */}
        <div className="bg-gray-100 p-3 sm:p-4 border-t border-gray-300 flex justify-end flex-shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="h-8 px-6 text-xs font-bold uppercase rounded-none border-gray-400 bg-white text-gray-800 hover:bg-gray-50"
          >
            ✕ FECHAR
          </Button>
        </div>
      </div>
    </div>
  )
}
