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
  fora_limites_cesta?: boolean
  decisao_requerida: boolean
}

export interface EstatisticasJuizoCritico {
  n_coletadas: number
  desvio_padrao: number
  mediana: number
  limite_inferior: number // 70% da mediana
  limite_superior: number // 130% da mediana (30% acima da mediana)
  criticas_count: number // contador em vermelho quando > 0 (amostras fora de [limite_inferior, limite_superior])
  expurgadas_count: number
}

export interface EstatisticasSaneadas {
  n_validas: number
  desvio_padrao: number
  coeficiente_variacao: number // percentual, ex: 1.70 para 1.70%
  menor_preco: number
  media: number
  mediana: number
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
  // Estatísticas avançadas no padrão Cesta de Preços
  juizo_critico: EstatisticasJuizoCritico
  estatisticas_saneadas: EstatisticasSaneadas
  pendencia_insuficiencia: boolean
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
      versao_motor: 'Motor Determinístico v2.0.0-CESTA-LEI14133',
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
      juizo_critico: {
        n_coletadas: 0,
        desvio_padrao: 0,
        mediana: 0,
        limite_inferior: 0,
        limite_superior: 0,
        criticas_count: 0,
        expurgadas_count: 0,
      },
      estatisticas_saneadas: {
        n_validas: 0,
        desvio_padrao: 0,
        coeficiente_variacao: 0,
        menor_preco: 0,
        media: 0,
        mediana: 0,
      },
      pendencia_insuficiencia: true,
    }
  }

  // Cálculo de Mediana
  const valoresOrdenados = [...valores].sort((a, b) => a - b)
  const meio = Math.floor(valoresOrdenados.length / 2)
  const mediana =
    valoresOrdenados.length % 2 === 0
      ? (valoresOrdenados[meio - 1] + valoresOrdenados[meio]) / 2
      : valoresOrdenados[meio]

  // Média Aritmética
  const soma = valores.reduce((acc, curr) => acc + curr, 0)
  const media = soma / valores.length

  // Desvio Padrão Amostral (s) ou Populacional (se n=1 => 0)
  let desvioPadrao = 0
  if (valores.length > 1) {
    const somaQuadrados = valores.reduce((acc, curr) => acc + Math.pow(curr - media, 2), 0)
    desvioPadrao = Math.sqrt(somaQuadrados / (valores.length - 1))
  }

  // Coeficiente de Variação (CV% = (DP / Média) * 100)
  const coeficienteVariacao = media > 0 ? (desvioPadrao / media) * 100 : 0

  // Limites do Juízo Crítico (modelo Cesta de Preços: Limite Inferior = 70% da mediana, Limite Superior = 130% da mediana / 30% acima)
  const limiteInferior = roundToTwoDecimals(mediana * 0.7)
  const limiteSuperior = roundToTwoDecimals(mediana * 1.3)

  // Amostras fora dos limites (críticas/suspeitas)
  let criticasCount = 0
  valores.forEach((v) => {
    if (v < limiteInferior || v > limiteSuperior) {
      criticasCount++
    }
  })

  // Cálculo do MAD (Median Absolute Deviation)
  // MAD = mediana(|xi - mediana|)
  const desviosAbsolutos = valores.map((v) => Math.abs(v - mediana)).sort((a, b) => a - b)
  const meioMad = Math.floor(desviosAbsolutos.length / 2)
  const mad_valor =
    desviosAbsolutos.length % 2 === 0
      ? (desviosAbsolutos[meioMad - 1] + desviosAbsolutos[meioMad]) / 2
      : desviosAbsolutos[meioMad]
  const mad_zero = mad_valor === 0 && valores.length > 1

  // Detecção de Outliers: sem exclusão automática, sinalização para decisão humana
  const outliers: AnaliseOutlier[] = entradas.map((e, idx) => {
    const val = e.valor_normalizado
    const desvio = Math.abs(val - mediana)
    // Se MAD=0 ou amostra pequena (n < 4), MAD puro não divide por zero
    const escore_mad = mad_valor > 0 ? desvio / (1.4826 * mad_valor) : 0
    const is_outlier = mad_valor > 0 ? escore_mad > 2.5 : false
    const fora_limites_cesta = val < limiteInferior || val > limiteSuperior

    return {
      valor: val,
      indice: idx + 1,
      referencia_id: e.referencia_id,
      fornecedor: e.fornecedor,
      desvio_mediana: roundToTwoDecimals(desvio),
      escore_mad: roundToTwoDecimals(escore_mad),
      is_outlier,
      fora_limites_cesta,
      decisao_requerida: is_outlier || fora_limites_cesta,
    }
  })

  // Se n < 3 e não houver justificativa preenchida (ou for menos de 3 amostras), pendência é sinalizada
  const pendencia_insuficiencia =
    n_precos < 3 && (!justificativaMetodo || justificativaMetodo.trim().length < 5)

  // Aplicação do método escolhido
  let precoBruto: number
  if (metodo === 'mediana') {
    precoBruto = mediana
  } else if (metodo === 'menor') {
    precoBruto = Math.min(...valores)
  } else if (metodo === 'maior') {
    precoBruto = Math.max(...valores)
  } else {
    precoBruto = media
  }

  // Regra Inegociável: Enquanto a justificativa de menos de 3 amostras não existir,
  // o item fica com pendência explícita e o preço de referência permanece AUSENTE (null, nunca zero).
  const preco_referencia = pendencia_insuficiencia ? null : roundToTwoDecimals(precoBruto)
  // REGRA CRÍTICA: Total = quantidade demandada × preço de referência (NÃO somar quantidades das contratações pesquisadas)
  const total_item =
    preco_referencia !== null ? roundToTwoDecimals(quantidadeDemandada * preco_referencia) : null
  const total_demanda = total_item

  const menor_preco = Math.min(...valores)

  const juizo_critico: EstatisticasJuizoCritico = {
    n_coletadas: n_precos,
    desvio_padrao: roundToTwoDecimals(desvioPadrao),
    mediana: roundToTwoDecimals(mediana),
    limite_inferior: limiteInferior,
    limite_superior: limiteSuperior,
    criticas_count: criticasCount,
    expurgadas_count: 0, // calculado pelo chamador com base em refs excluídas
  }

  const estatisticas_saneadas: EstatisticasSaneadas = {
    n_validas: n_precos,
    desvio_padrao: roundToTwoDecimals(desvioPadrao),
    coeficiente_variacao: roundToTwoDecimals(coeficienteVariacao),
    menor_preco: roundToTwoDecimals(menor_preco),
    media: roundToTwoDecimals(media),
    mediana: roundToTwoDecimals(mediana),
  }

  const memoria_texto = `
1. Parâmetros da Demanda:
   - Quantidade demandada do item: ${quantidadeDemandada} ${entradas[0]?.unidade || 'un'}
2. Análise Crítica das Amostras (Modelo Cesta de Preços & Lei 14.133/2021):
   - Amostras coletadas válidas: ${n_precos}
   - Transações distintas: ${n_transacoes}
   - Plataformas consultadas: ${n_plataformas} (${Object.entries(plataformasMap)
     .map(([p, count]) => `${p}: ${count}`)
     .join(', ')})
   - Juízo Crítico:
     * Mediana: R$ ${mediana.toFixed(2)}
     * Limite Inferior (70% da mediana): R$ ${limiteInferior.toFixed(2)}
     * Limite Superior (30% da mediana / 130%): R$ ${limiteSuperior.toFixed(2)}
     * Amostras fora dos limites (críticas): ${criticasCount} (exclusão sempre sob decisão humana)
3. Método Estatístico Aplicado às Amostras Saneadas:
   - Média Aritmética: R$ ${media.toFixed(2)}
   - Mediana: R$ ${mediana.toFixed(2)}
   - Menor Preço: R$ ${menor_preco.toFixed(2)}
   - Desvio-Padrão: R$ ${desvioPadrao.toFixed(2)}
   - Coeficiente de Variação: ${coeficienteVariacao.toFixed(2)}%
   - Desvio Absoluto da Mediana (MAD): R$ ${mad_valor.toFixed(2)}${mad_zero ? ' (Amostra com valores idênticos - tratamento explícito sem divisão por zero)' : ''}
4. Medida de Tendência Central Escolhida:
   - Método Selecionado: ${metodo.toUpperCase()} (Padrão normativo: MEDIANA)
   - Justificativa do Agente: ${justificativaMetodo || (n_precos < 3 ? 'PENDENTE DE JUSTIFICATIVA FORMAL' : 'Conformidade com a Lei nº 14.133/2021')}
5. Consolidação Determinística:
   - Preço de Referência Unitário: ${preco_referencia !== null ? `R$ ${preco_referencia.toFixed(2)}` : 'AUSENTE (justificativa de amostra insuficiente pendente)'}
   - Total do Item: ${total_item !== null ? `${quantidadeDemandada} × R$ ${preco_referencia!.toFixed(2)} = R$ ${total_item.toFixed(2)}` : 'AUSENTE'}
   - Nota Técnica: Arredondamento bancário conforme ABNT NBR 5891:2014. Quantidades amostrais externas descartadas do cômputo total.
  `.trim()

  return {
    metodo,
    versao_motor: 'Motor Determinístico v2.0.0-CESTA-LEI14133',
    arredondamento: 'ABNT NBR 5891:2014 (2 casas decimais)',
    amostra_valida: !pendencia_insuficiencia,
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
    juizo_critico,
    estatisticas_saneadas,
    pendencia_insuficiencia,
  }
}
