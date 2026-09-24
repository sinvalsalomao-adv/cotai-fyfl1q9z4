import type { MetodoCalculo, Referencia } from '@/types'

export interface CalculoEntrada {
  referencia_id: string
  fonte: string
  id_externo?: string
  valor_original: number
  valor_normalizado: number
  unidade?: string
  quantidade?: number
  data_contratacao?: string
  fornecedor?: string
  natureza_preco: string
}

export interface MetricasN {
  n_precos: number
  n_transacoes: number
  n_plataformas: number
  plataformas_distribuicao: Record<string, number>
  suficiente: boolean
  alerta_insuficiencia: string | null
}

export interface AnaliseOutlier {
  valor: number
  indice: number
  referencia_id: string
  fornecedor?: string
  desvio_mediana: number
  escore_mad: number
  is_outlier: boolean
  decisao_requerida: boolean
}

export interface ResultadoCalculo {
  metodo: MetodoCalculo
  versao_motor: string
  arredondamento: string
  amostra_valida: boolean
  mensagem_amostra?: string
  entradas: CalculoEntrada[]
  metricas_n: MetricasN
  mad_valor: number
  mad_zero: boolean
  outliers: AnaliseOutlier[]
  preco_referencia: number | null // Preço de referência ausente (null), NUNCA zero quando amostra insuficiente
  quantidade_demandada: number
  total_item: number | null // quantidade_demandada * preco_referencia (nunca soma de transações)
  total_demanda: number | null
  memoria_texto: string
}

/**
 * Arredondamento conforme ABNT NBR 5891 / Bancário (2 casas)
 */
export function roundToTwoDecimals(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100
}

export function formatarMoeda(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) {
    return 'Preço ausente (amostra insuficiente)'
  }
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val)
}

export function formatarData(dataStr?: string | null): string {
  if (!dataStr) return '-'
  try {
    const d = new Date(dataStr)
    if (isNaN(d.getTime())) return dataStr
    return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  } catch {
    return dataStr
  }
}

/**
 * Motor Determinístico de Pesquisa de Preços (Seção 5 da especificação)
 * Regra: Total = quantidade demandada × preço de referência;
 * Sem amostra válida: Preço de referência AUSENTE (null), NUNCA zero.
 */
export function executarMotorCalculo(
  candidatosAceitos: Referencia[],
  quantidadeDemandada: number,
  metodo: MetodoCalculo,
  justificativaMetodo: string,
): ResultadoCalculo {
  const entradas: CalculoEntrada[] = candidatosAceitos.map((c) => ({
    referencia_id: c.id,
    fonte: c.fonte,
    id_externo: c.id_externo,
    valor_original: c.valor_original,
    valor_normalizado: c.valor_normalizado || c.valor_original,
    unidade: c.unidade || 'un',
    quantidade: c.quantidade || 1,
    data_contratacao: c.data_contratacao,
    fornecedor: c.fornecedor,
    natureza_preco: c.natureza_preco,
  }))

  const valores = entradas
    .map((e) => e.valor_normalizado)
    .filter((v) => typeof v === 'number' && !isNaN(v) && v > 0)

  // Métricas N independentes
  const plataformasMap: Record<string, number> = {}
  const transacoesSet = new Set<string>()

  entradas.forEach((e) => {
    plataformasMap[e.fonte] = (plataformasMap[e.fonte] || 0) + 1
    const transKey = e.id_externo || `${e.fornecedor}_${e.data_contratacao}_${e.valor_original}`
    transacoesSet.add(transKey)
  })

  const n_precos = valores.length
  const n_transacoes = transacoesSet.size
  const n_plataformas = Object.keys(plataformasMap).length

  const metricas_n: MetricasN = {
    n_precos,
    n_transacoes,
    n_plataformas,
    plataformas_distribuicao: plataformasMap,
    suficiente: n_precos >= 3,
    alerta_insuficiencia:
      n_precos === 0
        ? 'Amostra vazia: nenhum preço válido aceito para este item.'
        : n_precos < 3
          ? `Amostra reduzida (n = ${n_precos} preços, ${n_transacoes} transações). A Lei 14.133 e IN 65 recomendam no mínimo 3 fontes. Preço ausente de homologação direta sem justificativa formal.`
          : null,
  }

  // Se não houver amostra aceita, preço é AUSENTE (null), nunca zero
  if (n_precos === 0) {
    return {
      metodo,
      versao_motor: 'Motor Determinístico v1.0.0-LEI14133',
      arredondamento: 'ABNT NBR 5891:2014 (2 casas decimais)',
      amostra_valida: false,
      mensagem_amostra: 'Preço de referência ausente: nenhuma amostra aceita.',
      entradas,
      metricas_n,
      mad_valor: 0,
      mad_zero: false,
      outliers: [],
      preco_referencia: null,
      quantidade_demandada: quantidadeDemandada,
      total_item: null,
      total_demanda: null,
      memoria_texto:
        'Sem amostra válida. O motor não produz valor zero nem substitui silenciosamente por estimativa.',
    }
  }

  // Cálculo de Mediana
  const valoresOrdenados = [...valores].sort((a, b) => a - b)
  const meio = Math.floor(valoresOrdenados.length / 2)
  const mediana =
    valoresOrdenados.length % 2 === 0
      ? (valoresOrdenados[meio - 1] + valoresOrdenados[meio]) / 2
      : valoresOrdenados[meio]

  // Cálculo do MAD (Median Absolute Deviation)
  // MAD = mediana(|xi - mediana|)
  const desviosAbsolutos = valores.map((v) => Math.abs(v - mediana)).sort((a, b) => a - b)
  const meioMad = Math.floor(desviosAbsolutos.length / 2)
  const mad_valor =
    desviosAbsolutos.length % 2 === 0
      ? (desviosAbsolutos[meioMad - 1] + desviosAbsolutos[meioMad]) / 2
      : desviosAbsolutos[meioMad]
  const mad_zero = mad_valor === 0 && valores.length > 1

  // Detecção de Outliers: sem exclusão automática, sinalização para decisão
  const outliers: AnaliseOutlier[] = entradas.map((e, idx) => {
    const val = e.valor_normalizado
    const desvio = Math.abs(val - mediana)
    // Se MAD=0 ou amostra pequena (n < 4), MAD puro não divide por zero
    const escore_mad = mad_valor > 0 ? desvio / (1.4826 * mad_valor) : 0
    const is_outlier = mad_valor > 0 ? escore_mad > 2.5 : false

    return {
      valor: val,
      indice: idx + 1,
      referencia_id: e.referencia_id,
      fornecedor: e.fornecedor,
      desvio_mediana: roundToTwoDecimals(desvio),
      escore_mad: roundToTwoDecimals(escore_mad),
      is_outlier,
      decisao_requerida: is_outlier,
    }
  })

  // Aplicação do método escolhido
  let precoBruto: number
  if (metodo === 'mediana') {
    precoBruto = mediana
  } else if (metodo === 'menor') {
    precoBruto = Math.min(...valores)
  } else if (metodo === 'maior') {
    precoBruto = Math.max(...valores)
  } else {
    // média aritmética
    const soma = valores.reduce((acc, curr) => acc + curr, 0)
    precoBruto = soma / valores.length
  }

  const preco_referencia = roundToTwoDecimals(precoBruto)
  // REGRA CRÍTICA: Total = quantidade demandada × preço de referência (NÃO somar quantidades das contratações pesquisadas)
  const total_item = roundToTwoDecimals(quantidadeDemandada * preco_referencia)
  const total_demanda = total_item

  const memoria_texto = `
1. Parâmetros da Demanda:
   - Quantidade demandada do item: ${quantidadeDemandada} ${entradas[0]?.unidade || 'un'}
2. Amostra Analisada:
   - Total de preços aceitos: ${n_precos}
   - Transações distintas: ${n_transacoes}
   - Plataformas consultadas: ${n_plataformas} (${Object.entries(plataformasMap)
     .map(([p, count]) => `${p}: ${count}`)
     .join(', ')})
3. Análise de Dispersão e Outliers:
   - Mediana: R$ ${mediana.toFixed(2)}
   - Desvio Absoluto da Mediana (MAD): R$ ${mad_valor.toFixed(2)}${mad_zero ? ' (Amostra com valores idênticos - tratamento explícito sem divisão por zero)' : ''}
   - Outliers sinalizados para revisão: ${outliers.filter((o) => o.is_outlier).length}
4. Método Selecionado:
   - Método: ${metodo.toUpperCase()}
   - Justificativa do Agente: ${justificativaMetodo || 'Conformidade com a Lei nº 14.133/2021'}
5. Consolidação Determinística:
   - Preço de Referência Unitário: R$ ${preco_referencia.toFixed(2)}
   - Total do Item: ${quantidadeDemandada} × R$ ${preco_referencia.toFixed(2)} = R$ ${total_item.toFixed(2)}
   - Nota Técnica: Arredondamento bancário conforme ABNT NBR 5891:2014. Quantidades amostrais externas descartadas do cômputo total.
  `.trim()

  return {
    metodo,
    versao_motor: 'Motor Determinístico v1.0.0-LEI14133',
    arredondamento: 'ABNT NBR 5891:2014 (2 casas decimais)',
    amostra_valida: true,
    entradas,
    metricas_n,
    mad_valor: roundToTwoDecimals(mad_valor),
    mad_zero,
    outliers,
    preco_referencia,
    quantidade_demandada: quantidadeDemandada,
    total_item,
    total_demanda,
    memoria_texto,
  }
}
