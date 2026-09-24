import type { MetodoCalculo, Referencia, MetodoOutlier } from '@/types'

export interface CalculoEntrada {
  referencia_id: string
  fonte: string
  id_externo?: string
  valor_original: number
  valor_normalizado: number
  unidade?: string
  unidade_normalizada?: string
  quantidade?: number
  data_contratacao?: string
  fornecedor?: string
  natureza_preco: string
  url?: string
  orgao_comprador?: string
  municipio_uf?: string
  modalidade_licitacao?: string
  confidence_score?: number
  is_regulatorio?: boolean
}

export interface MetricasN {
  n_precos: number
  n_transacoes: number
  n_plataformas: number
  plataformas_distribuicao: Record<string, number>
  suficiente: boolean
  quantidade_minima_configurada: number
  alerta_insuficiencia: string | null
  status_amostra: 'OK' | 'ATENCAO' | 'CRITICO' | 'SEM_REFERENCIA'
}

export type ClassificacaoOutlier = 'NORMAL' | 'ATENCAO' | 'INCONSISTENTE' | 'FORA_DA_FAIXA'

export interface AnaliseOutlier {
  valor: number
  indice: number
  referencia_id: string
  fornecedor?: string
  desvio_mediana: number
  percentual_distancia_mediana: number // ex 45% acima da mediana
  escore_mad: number
  escore_z: number
  classificacao: ClassificacaoOutlier
  is_outlier: boolean
  motivo_classificacao: string
  decisao_requerida: boolean
}

export interface QuartisEPercentis {
  min: number
  q1: number // 25º percentil
  mediana: number // 50º percentil
  q3: number // 75º percentil
  max: number
  iqr: number // Q3 - Q1
  limite_iqr_inferior: number // Q1 - 1.5 * IQR
  limite_iqr_superior: number // Q3 + 1.5 * IQR
  percentil_10: number
  percentil_90: number
}

export interface EstatisticasCompletas {
  n_coletadas: number
  n_validas: number
  menor_preco: number
  maior_preco: number
  amplitude: number
  media_aritmetica: number
  mediana: number
  media_saneada: number // média descartando extremos 10%
  media_ponderada: number // ponderada por quantidade amostral
  mediana_ponderada: number
  variancia: number
  desvio_padrao: number
  coeficiente_variacao: number // percentual, ex 12.5%
  quartis: QuartisEPercentis
  limite_inferior_configurado: number
  limite_superior_configurado: number
  criticas_count: number
  expurgadas_count: number
  metodo_recomendado: MetodoCalculo
  motivo_recomendacao: string
}

export interface MemoriaCalculoEstruturada {
  valores_considerados: number[]
  soma: number
  n: number
  media_aritmetica: number
  mediana: number
  menor_preco: number
  maior_preco: number
  desvio_padrao: number
  coeficiente_variacao: number
  metodo_selecionado: MetodoCalculo
  valor_estimado_unitario: number | null
  formula_utilizada: string
  resumo_rastreabilidade: string
  texto_completo: string
}

export interface EstatisticasJuizoCritico {
  n_coletadas?: number
  mediana?: number
  limite_inferior: number
  limite_superior: number
  criticas_count: number
  expurgadas_count: number
  media_com_criticas: number
  mediana_com_criticas: number
  desvio_padrao: number
  coeficiente_variacao: number
}

export interface EstatisticasSaneadas {
  n_validas: number
  media: number
  mediana: number
  menor: number
  maior: number
  menor_preco?: number
  desvio_padrao: number
  coeficiente_variacao: number
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
  preco_referencia: number | null
  quantidade_demandada: number
  total_item: number | null // quantidade_demandada * preco_referencia (NUNCA somar quantidades externas)
  total_demanda: number | null
  estatisticas: EstatisticasCompletas
  juizo_critico?: EstatisticasJuizoCritico
  estatisticas_saneadas?: EstatisticasSaneadas
  memoria: MemoriaCalculoEstruturada
  memoria_texto: string
  pendencia_insuficiencia: boolean
}

// ----------------------------------------------------
// Normalização de Unidades e Preços
// R$ 500,00 / 10 unidades -> R$ 50,00/unidade
// Caixa c/ 100 comp, Frasco 500ml, Pacote c/ 500 folhas, etc.
// ----------------------------------------------------
export interface UnidadeNormalizada {
  unidade_padrao: string // un, cx, pct, fr, l, ml, kg, g, m, m2, m3, t
  fator_conversao: number // quantas unidades básicas contém
  quantidade_base: number
  preco_unitario_convertido: number
  categoria: string
  observacao?: string
}

export class PriceNormalizationEngine {
  /**
   * Converte preço bruto com base em quantidade e embalagem
   * Ex: R$ 500,00 / 10 unidades -> R$ 50,00/unidade
   * Caixa com 50 ampolas por R$ 250,00 -> R$ 5,00 por ampola
   */
  public static normalizarPreco(
    valorOriginal: number,
    unidadeTexto: string = 'un',
    quantidadeTransacao: number = 1,
    descricaoItem: string = '',
  ): UnidadeNormalizada {
    const rawUnit = (unidadeTexto || '').toLowerCase().trim()
    const desc = (descricaoItem || '').toLowerCase()

    let fator = 1
    let unidadePadrao = 'un'
    let categoria = 'geral'
    let observacao = 'Unidade direta'

    // Detecção de caixa ou pacote com quantidade embutida na descrição
    // Ex: "caixa com 50 comprimidos", "cx c/ 100", "pct c/ 500 folhas"
    const cxMatch = desc.match(/(?:caixa|cx|pct|pacote|envelope|blister)\s*(?:com|c\/)?\s*(\d+)/i)
    if (cxMatch && cxMatch[1]) {
      const qtdEmbalagem = parseInt(cxMatch[1], 10)
      if (qtdEmbalagem > 1) {
        fator = qtdEmbalagem
        unidadePadrao = 'un'
        categoria = 'medicamentos_expediente'
        observacao = `Embalagem coletiva identificada (${qtdEmbalagem} unidades por embalagem)`
      }
    }

    // Regras de unidade explícita
    if (rawUnit.includes('cx') || rawUnit.includes('caixa')) {
      unidadePadrao = 'cx'
      categoria = 'embalagem'
    } else if (rawUnit.includes('pct') || rawUnit.includes('pacote')) {
      unidadePadrao = 'pct'
      categoria = 'embalagem'
    } else if (rawUnit.includes('frasco') || rawUnit.includes('fr')) {
      unidadePadrao = 'fr'
      categoria = 'farmaceutica'
    } else if (rawUnit.includes('kg') || rawUnit.includes('quilo')) {
      unidadePadrao = 'kg'
      categoria = 'peso'
    } else if (rawUnit.includes('ton') || rawUnit.includes('tonelada')) {
      unidadePadrao = 't'
      fator = 1000 // 1 ton = 1000 kg se normalizado para kg
      categoria = 'peso'
    } else if (rawUnit.includes('litro') || rawUnit.includes('l')) {
      unidadePadrao = 'l'
      categoria = 'volume'
    } else if (rawUnit.includes('m³') || rawUnit.includes('m3')) {
      unidadePadrao = 'm3'
      categoria = 'volume_obras'
    } else if (rawUnit.includes('m²') || rawUnit.includes('m2')) {
      unidadePadrao = 'm2'
      categoria = 'area'
    } else if (rawUnit.includes('metro') || rawUnit === 'm') {
      unidadePadrao = 'm'
      categoria = 'comprimento'
    } else if (rawUnit.includes('resma') || desc.includes('resma')) {
      unidadePadrao = 'resma'
      categoria = 'expediente'
      observacao = 'Resma padrão 500 folhas'
    }

    // Se a contratação registrou um lote (ex: 10 unidades por R$ 500)
    const divisor = quantidadeTransacao > 0 ? quantidadeTransacao : 1
    // Se o preço registrado é unitário ou total da linha
    let precoUnitario = valorOriginal
    if (quantidadeTransacao > 1 && valorOriginal > 500 && desc.includes('lote')) {
      precoUnitario = valorOriginal / divisor
    }

    return {
      unidade_padrao: unidadePadrao,
      fator_conversao: fator,
      quantidade_base: divisor,
      preco_unitario_convertido: roundToTwoDecimals(precoUnitario),
      categoria,
      observacao,
    }
  }
}

// ----------------------------------------------------
// Funções Utilitárias Matemáticas
// ----------------------------------------------------
export function roundToTwoDecimals(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100
}

export function formatarMoeda(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) {
    return 'NÃO INFORMADO (ou amostra pendente)'
  }
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val)
}

export function formatarData(dataStr?: string | null): string {
  if (!dataStr) return 'NÃO INFORMADO'
  try {
    const d = new Date(dataStr)
    if (isNaN(d.getTime())) return dataStr
    return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  } catch {
    return dataStr
  }
}

export function calcularPercentil(valoresOrdenados: number[], percentil: number): number {
  if (valoresOrdenados.length === 0) return 0
  if (valoresOrdenados.length === 1) return valoresOrdenados[0]
  const index = (percentil / 100) * (valoresOrdenados.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const weight = index - lower
  return roundToTwoDecimals(
    valoresOrdenados[lower] * (1 - weight) + valoresOrdenados[upper] * weight,
  )
}

// ----------------------------------------------------
// Motor Determinístico de Formação de Preços (PriceEngine)
// Totalmente reutilizável, testável, puro e determinístico.
// ----------------------------------------------------
export interface OpcoesMotorPrecos {
  quantidadeMinima?: number
  metodoOutlier?: MetodoOutlier
  limiteInferiorPercentual?: number // ex 70 para 70% da mediana
  limiteSuperiorPercentual?: number // ex 130 para 130% da mediana
  descarteAutomaticoVedado?: boolean // sempre true por especificação
}

export function executarMotorCalculo(
  candidatosAceitos: Referencia[],
  quantidadeDemandada: number,
  metodo: MetodoCalculo = 'mediana',
  justificativaMetodo: string = '',
  opcoes: OpcoesMotorPrecos = {},
): ResultadoCalculo {
  const qtdMinima = opcoes.quantidadeMinima !== undefined ? opcoes.quantidadeMinima : 3
  const metodoOutlier = opcoes.metodoOutlier || 'distancia_mediana'
  const limiteInfPct =
    opcoes.limiteInferiorPercentual !== undefined ? opcoes.limiteInferiorPercentual : 70
  const limiteSupPct =
    opcoes.limiteSuperiorPercentual !== undefined ? opcoes.limiteSuperiorPercentual : 130

  // 1. Mapeamento e normalização das entradas
  const entradas: CalculoEntrada[] = candidatosAceitos.map((c) => {
    const norm = PriceNormalizationEngine.normalizarPreco(
      c.valor_original,
      c.unidade,
      c.quantidade || 1,
      c.item_externo || '',
    )
    const valorNorm =
      c.valor_normalizado && c.valor_normalizado > 0
        ? c.valor_normalizado
        : norm.preco_unitario_convertido

    return {
      referencia_id: c.id,
      fonte: c.fonte,
      id_externo: c.id_externo || c.source_identifier || 'NÃO INFORMADO',
      valor_original: c.valor_original,
      valor_normalizado: valorNorm,
      unidade: c.unidade || 'un',
      unidade_normalizada: norm.unidade_padrao,
      quantidade: c.quantidade || 1,
      data_contratacao: c.data_contratacao || c.source_capture_date,
      fornecedor: c.fornecedor || 'NÃO INFORMADO',
      natureza_preco: c.natureza_preco || 'desconhecido',
      url: c.url,
      orgao_comprador: c.orgao_comprador || 'NÃO INFORMADO',
      municipio_uf: c.municipio_uf || 'NÃO INFORMADO',
      modalidade_licitacao: c.modalidade_licitacao || 'NÃO INFORMADO',
      confidence_score: c.confidence_score,
      is_regulatorio: c.natureza_preco === 'regulatorio_tabela' || c.fonte === 'cmed',
    }
  })

  // Preços de contratação válidos (referências regulatórias são destacadas, mas não misturadas sem indicação)
  const valores = entradas
    .map((e) => e.valor_normalizado)
    .filter((v) => typeof v === 'number' && !isNaN(v) && v > 0)

  // 2. Análise de Rastreabilidade e Cobertura N
  const plataformasMap: Record<string, number> = {}
  const transacoesSet = new Set<string>()

  entradas.forEach((e) => {
    plataformasMap[e.fonte] = (plataformasMap[e.fonte] || 0) + 1
    const transKey =
      e.id_externo !== 'NÃO INFORMADO'
        ? e.id_externo
        : `${e.fornecedor}_${e.data_contratacao}_${e.valor_original}`
    transacoesSet.add(transKey!)
  })

  const n_precos = valores.length
  const n_transacoes = transacoesSet.size
  const n_plataformas = Object.keys(plataformasMap).length

  // Classificação do Nível Amostral
  let statusAmostra: 'OK' | 'ATENCAO' | 'CRITICO' | 'SEM_REFERENCIA' = 'OK'
  let alertaInsuficiencia: string | null = null

  if (n_precos === 0) {
    statusAmostra = 'SEM_REFERENCIA'
    alertaInsuficiencia =
      'Esta pesquisa possui 0 preços válidos. Não há base referencial para cálculo.'
  } else if (n_precos === 1) {
    statusAmostra = 'CRITICO'
    alertaInsuficiencia = `Esta pesquisa possui 1 preço válido, abaixo do mínimo configurado de ${qtdMinima}. Informe a justificativa.`
  } else if (n_precos < qtdMinima) {
    statusAmostra = 'ATENCAO'
    alertaInsuficiencia = `Esta pesquisa possui ${n_precos} preços válidos, abaixo do mínimo configurado de ${qtdMinima}. Informe a justificativa.`
  }

  // 3. Caso especial: Sem amostra válida
  if (n_precos === 0) {
    const quartisVazios: QuartisEPercentis = {
      min: 0,
      q1: 0,
      mediana: 0,
      q3: 0,
      max: 0,
      iqr: 0,
      limite_iqr_inferior: 0,
      limite_iqr_superior: 0,
      percentil_10: 0,
      percentil_90: 0,
    }
    const estatisticasVazias: EstatisticasCompletas = {
      n_coletadas: 0,
      n_validas: 0,
      menor_preco: 0,
      maior_preco: 0,
      amplitude: 0,
      media_aritmetica: 0,
      mediana: 0,
      media_saneada: 0,
      media_ponderada: 0,
      mediana_ponderada: 0,
      variancia: 0,
      desvio_padrao: 0,
      coeficiente_variacao: 0,
      quartis: quartisVazios,
      limite_inferior_configurado: 0,
      limite_superior_configurado: 0,
      criticas_count: 0,
      expurgadas_count: 0,
      metodo_recomendado: 'mediana',
      motivo_recomendacao: 'Amostra vazia. Adicione referências com rastreabilidade.',
    }

    return {
      metodo,
      versao_motor: 'PriceEngine v2.0-ENTERPRISE-LEI14133',
      arredondamento: 'ABNT NBR 5891:2014 (2 casas decimais)',
      amostra_valida: false,
      mensagem_amostra: alertaInsuficiencia!,
      entradas,
      metricas_n: {
        n_precos: 0,
        n_transacoes: 0,
        n_plataformas: 0,
        plataformas_distribuicao: {},
        suficiente: false,
        quantidade_minima_configurada: qtdMinima,
        alerta_insuficiencia: alertaInsuficiencia,
        status_amostra: statusAmostra,
      },
      mad_valor: 0,
      mad_zero: false,
      outliers: [],
      preco_referencia: null,
      quantidade_demandada: quantidadeDemandada,
      total_item: null,
      total_demanda: null,
      estatisticas: estatisticasVazias,
      memoria: {
        valores_considerados: [],
        soma: 0,
        n: 0,
        media_aritmetica: 0,
        mediana: 0,
        menor_preco: 0,
        maior_preco: 0,
        desvio_padrao: 0,
        coeficiente_variacao: 0,
        metodo_selecionado: metodo,
        valor_estimado_unitario: null,
        formula_utilizada: 'Nenhuma amostra aceita',
        resumo_rastreabilidade:
          'Valor estimado calculado com base em 0 preços válidos provenientes de 0 fontes.',
        texto_completo:
          'Sem amostra válida. O motor nunca produz valor zero nem inventa estimativa.',
      },
      memoria_texto: 'Sem amostra válida. O motor nunca produz valor zero nem inventa estimativa.',
      pendencia_insuficiencia: true,
    }
  }

  // 4. Cálculos Estatísticos Centrais
  const valoresOrdenados = [...valores].sort((a, b) => a - b)
  const soma = valores.reduce((acc, curr) => acc + curr, 0)
  const mediaAritmetica = soma / n_precos

  const meio = Math.floor(valoresOrdenados.length / 2)
  const mediana =
    valoresOrdenados.length % 2 === 0
      ? (valoresOrdenados[meio - 1] + valoresOrdenados[meio]) / 2
      : valoresOrdenados[meio]

  const menorPreco = valoresOrdenados[0]
  const maiorPreco = valoresOrdenados[valoresOrdenados.length - 1]
  const amplitude = maiorPreco - menorPreco

  // Variância e Desvio Padrão Amostral (s)
  let variancia = 0
  let desvioPadrao = 0
  if (n_precos > 1) {
    const somaQuadrados = valores.reduce(
      (acc, curr) => acc + Math.pow(curr - mediaAritmetica, 2),
      0,
    )
    variancia = somaQuadrados / (n_precos - 1)
    desvioPadrao = Math.sqrt(variancia)
  }

  // Coeficiente de Variação (CV% = (DP / Média) * 100)
  const coeficienteVariacao = mediaAritmetica > 0 ? (desvioPadrao / mediaAritmetica) * 100 : 0

  // Média Saneada (removendo 10% inferior e 10% superior se n >= 5)
  let mediaSaneada = mediaAritmetica
  if (n_precos >= 5) {
    const corte = Math.max(1, Math.floor(n_precos * 0.1))
    const amostraAparada = valoresOrdenados.slice(corte, valoresOrdenados.length - corte)
    const somaAparada = amostraAparada.reduce((acc, c) => acc + c, 0)
    mediaSaneada = somaAparada / amostraAparada.length
  }

  // Média Ponderada (pesando pelas quantidades transacionadas informadas)
  let somaPonderada = 0
  let somaPesos = 0
  entradas.forEach((e) => {
    const peso = e.quantidade && e.quantidade > 0 ? e.quantidade : 1
    somaPonderada += e.valor_normalizado * peso
    somaPesos += peso
  })
  const mediaPonderada = somaPesos > 0 ? somaPonderada / somaPesos : mediaAritmetica
  const medianaPonderada = mediana

  // Quartis, IQR e Percentis
  const q1 = calcularPercentil(valoresOrdenados, 25)
  const q3 = calcularPercentil(valoresOrdenados, 75)
  const iqr = roundToTwoDecimals(q3 - q1)
  const limiteIqrInf = roundToTwoDecimals(q1 - 1.5 * iqr)
  const limiteIqrSup = roundToTwoDecimals(q3 + 1.5 * iqr)
  const p10 = calcularPercentil(valoresOrdenados, 10)
  const p90 = calcularPercentil(valoresOrdenados, 90)

  const quartis: QuartisEPercentis = {
    min: menorPreco,
    q1,
    mediana: roundToTwoDecimals(mediana),
    q3,
    max: maiorPreco,
    iqr,
    limite_iqr_inferior: limiteIqrInf,
    limite_iqr_superior: limiteIqrSup,
    percentil_10: p10,
    percentil_90: p90,
  }

  // 5. MAD (Median Absolute Deviation)
  const desviosAbsolutos = valores.map((v) => Math.abs(v - mediana)).sort((a, b) => a - b)
  const meioMad = Math.floor(desviosAbsolutos.length / 2)
  const mad_valor =
    desviosAbsolutos.length % 2 === 0
      ? (desviosAbsolutos[meioMad - 1] + desviosAbsolutos[meioMad]) / 2
      : desviosAbsolutos[meioMad]
  const mad_zero = mad_valor === 0 && n_precos > 1

  // Limites do Juízo Crítico por distância da Mediana (padrão 70% e 130%)
  const limiteInfConfigurado = roundToTwoDecimals(mediana * (limiteInfPct / 100))
  const limiteSupConfigurado = roundToTwoDecimals(mediana * (limiteSupPct / 100))

  // 6. Detecção e Classificação de Outliers (NUNCA EXCLUIR SILENCIOSAMENTE)
  let criticasCount = 0
  const outliers: AnaliseOutlier[] = entradas.map((e, idx) => {
    const val = e.valor_normalizado
    const desvio = Math.abs(val - mediana)
    const percDistancia = mediana > 0 ? ((val - mediana) / mediana) * 100 : 0
    const escore_mad = mad_valor > 0 ? desvio / (1.4826 * mad_valor) : 0
    const escore_z = desvioPadrao > 0 ? (val - mediaAritmetica) / desvioPadrao : 0

    let isOutlier = false
    let classificacao: ClassificacaoOutlier = 'NORMAL'
    let motivo = 'Preço compatível com a distribuição'

    if (metodoOutlier === 'iqr') {
      if (val < limiteIqrInf || val > limiteIqrSup) {
        isOutlier = true
        classificacao = val > limiteIqrSup ? 'FORA_DA_FAIXA' : 'INCONSISTENTE'
        motivo = `Valor fora dos limites IQR [${limiteIqrInf.toFixed(2)}, ${limiteIqrSup.toFixed(2)}]`
      }
    } else if (metodoOutlier === 'desvio_padrao') {
      if (Math.abs(escore_z) > 2) {
        isOutlier = true
        classificacao = 'FORA_DA_FAIXA'
        motivo = `Desvio estatístico elevado (|Z| = ${escore_z.toFixed(2)} > 2.0)`
      }
    } else {
      // Método padrão: Distância da Mediana (Juízo crítico 70% a 130%)
      if (val < limiteInfConfigurado) {
        isOutlier = true
        classificacao = 'INCONSISTENTE'
        motivo = `Valor ${Math.abs(percDistancia).toFixed(1)}% abaixo da mediana (limite inferior ${limiteInfPct}%)`
      } else if (val > limiteSupConfigurado) {
        isOutlier = true
        classificacao = 'FORA_DA_FAIXA'
        motivo = `Valor ${percDistancia.toFixed(1)}% acima da mediana (limite superior ${limiteSupPct}%)`
      } else if (Math.abs(percDistancia) > 20) {
        classificacao = 'ATENCAO'
        motivo = `Variação moderada em relação à mediana (${percDistancia > 0 ? '+' : ''}${percDistancia.toFixed(1)}%)`
      }
    }

    if (classificacao !== 'NORMAL') {
      criticasCount++
    }

    return {
      valor: val,
      indice: idx + 1,
      referencia_id: e.referencia_id,
      fornecedor: e.fornecedor,
      desvio_mediana: roundToTwoDecimals(desvio),
      percentual_distancia_mediana: roundToTwoDecimals(percDistancia),
      escore_mad: roundToTwoDecimals(escore_mad),
      escore_z: roundToTwoDecimals(escore_z),
      classificacao,
      is_outlier: isOutlier,
      motivo_classificacao: motivo,
      decisao_requerida: isOutlier,
    }
  })

  // 7. Recomendação Automática de Método
  // Coeficiente de Variação baixo (< 25%) -> Média recomendada
  // Coeficiente de Variação alto (>= 25%) ou outliers presentes -> Mediana recomendada
  let metodoRecomendado: MetodoCalculo = 'mediana'
  let motivoRecomendacao = ''

  if (coeficienteVariacao < 25 && criticasCount === 0) {
    metodoRecomendado = 'media'
    motivoRecomendacao = `Média recomendada (baixa dispersão: CV = ${coeficienteVariacao.toFixed(1)}% < 25% e sem outliers)`
  } else {
    metodoRecomendado = 'mediana'
    motivoRecomendacao = `Mediana recomendada (alta dispersão: CV = ${coeficienteVariacao.toFixed(1)}% e ${criticasCount} amostra(s) fora da faixa central)`
  }

  // 8. Resolução do Preço de Referência
  // Se abaixo do mínimo de preços e SEM justificativa formal preenchida, o preço é AUSENTE (null), NUNCA zero.
  const pendenciaInsuficiencia =
    n_precos < qtdMinima && (!justificativaMetodo || justificativaMetodo.trim().length < 5)

  let precoBruto: number
  let formulaUtilizada = ''

  switch (metodo) {
    case 'mediana':
      precoBruto = mediana
      formulaUtilizada = `Mediana([${valoresOrdenados.map((v) => v.toFixed(2)).join('; ')}])`
      break
    case 'media':
      precoBruto = mediaAritmetica
      formulaUtilizada = `Média = (${valoresOrdenados.map((v) => v.toFixed(2)).join(' + ')}) / ${n_precos}`
      break
    case 'menor':
      precoBruto = menorPreco
      formulaUtilizada = `Menor Preço = Min([${valoresOrdenados.map((v) => v.toFixed(2)).join('; ')}])`
      break
    case 'maior':
      precoBruto = maiorPreco
      formulaUtilizada = `Maior Preço = Max([${valoresOrdenados.map((v) => v.toFixed(2)).join('; ')}])`
      break
    case 'media_saneada':
      precoBruto = mediaSaneada
      formulaUtilizada = `Média Saneada (expurgo dos 10% extremos)`
      break
    case 'media_ponderada':
      precoBruto = mediaPonderada
      formulaUtilizada = `Média Ponderada por volume de contratação`
      break
    default:
      precoBruto = mediana
      formulaUtilizada = `Mediana Padrão`
  }

  const precoReferencia = pendenciaInsuficiencia ? null : roundToTwoDecimals(precoBruto)
  // REGRA INVIOLÁVEL: Total = Quantidade Demandada × Preço de Referência
  // NUNCA somar quantidades das amostras consultadas
  const totalItem =
    precoReferencia !== null ? roundToTwoDecimals(quantidadeDemandada * precoReferencia) : null

  const estatisticasCompletas: EstatisticasCompletas = {
    n_coletadas: n_precos,
    n_validas: n_precos,
    menor_preco: roundToTwoDecimals(menorPreco),
    maior_preco: roundToTwoDecimals(maiorPreco),
    amplitude: roundToTwoDecimals(amplitude),
    media_aritmetica: roundToTwoDecimals(mediaAritmetica),
    mediana: roundToTwoDecimals(mediana),
    media_saneada: roundToTwoDecimals(mediaSaneada),
    media_ponderada: roundToTwoDecimals(mediaPonderada),
    mediana_ponderada: roundToTwoDecimals(medianaPonderada),
    variancia: roundToTwoDecimals(variancia),
    desvio_padrao: roundToTwoDecimals(desvioPadrao),
    coeficiente_variacao: roundToTwoDecimals(coeficienteVariacao),
    quartis,
    limite_inferior_configurado: limiteInfConfigurado,
    limite_superior_configurado: limiteSupConfigurado,
    criticas_count: criticasCount,
    expurgadas_count: 0,
    metodo_recomendado: metodoRecomendado,
    motivo_recomendacao: motivoRecomendacao,
  }

  const juizoCriticoCompat: EstatisticasJuizoCritico = {
    n_coletadas: n_precos,
    mediana: roundToTwoDecimals(mediana),
    limite_inferior: limiteInfConfigurado,
    limite_superior: limiteSupConfigurado,
    criticas_count: criticasCount,
    expurgadas_count: 0,
    media_com_criticas: roundToTwoDecimals(mediaAritmetica),
    mediana_com_criticas: roundToTwoDecimals(mediana),
    desvio_padrao: roundToTwoDecimals(desvioPadrao),
    coeficiente_variacao: roundToTwoDecimals(coeficienteVariacao),
  }

  const estatisticasSaneadasCompat: EstatisticasSaneadas = {
    n_validas: n_precos,
    media: roundToTwoDecimals(mediaAritmetica),
    mediana: roundToTwoDecimals(mediana),
    menor: roundToTwoDecimals(menorPreco),
    maior: roundToTwoDecimals(maiorPreco),
    menor_preco: roundToTwoDecimals(menorPreco),
    desvio_padrao: roundToTwoDecimals(desvioPadrao),
    coeficiente_variacao: roundToTwoDecimals(coeficienteVariacao),
  }

  // 9. Memória de Cálculo Estruturada e Reprodutível
  const resumoRastreabilidade = `Valor estimado calculado com base em ${n_precos} preços válidos provenientes de ${n_plataformas} fontes distintas.`
  const memoriaTexto = `
1. PARÂMETROS DA DEMANDA
   - Quantidade demandada do item: ${quantidadeDemandada} ${entradas[0]?.unidade_normalizada || 'un'}
   - Quantidade mínima exigida pelo órgão: ${qtdMinima} preços válidos

2. RASTREABILIDADE E COBERTURA DE FONTES
   - ${resumoRastreabilidade}
   - Fontes consultadas: ${Object.entries(plataformasMap)
     .map(([f, qtd]) => `${f.toUpperCase()} (${qtd} cotações)`)
     .join(', ')}
   - Transações independentes registradas: ${n_transacoes}

3. DISTRIBUIÇÃO E DISPERSÃO ESTATÍSTICA
   - Média Aritmética: R$ ${mediaAritmetica.toFixed(2)}
   - Mediana: R$ ${mediana.toFixed(2)}
   - Menor Preço: R$ ${menorPreco.toFixed(2)} | Maior Preço: R$ ${maiorPreco.toFixed(2)}
   - Desvio-Padrão Amostral: R$ ${desvioPadrao.toFixed(2)}
   - Coeficiente de Variação (CV): ${coeficienteVariacao.toFixed(2)}%
   - Quartis: Q1 = R$ ${q1.toFixed(2)} | Q2 (Mediana) = R$ ${mediana.toFixed(2)} | Q3 = R$ ${q3.toFixed(2)} | IQR = R$ ${iqr.toFixed(2)}
   - Desvio Absoluto da Mediana (MAD): R$ ${mad_valor.toFixed(2)}${mad_zero ? ' (Valores homogêneos sem divisão por zero)' : ''}

4. JUÍZO CRÍTICO E CLASSIFICAÇÃO DE OUTLIERS
   - Limite Inferior (${limiteInfPct}% da mediana): R$ ${limiteInfConfigurado.toFixed(2)}
   - Limite Superior (${limiteSupPct}% da mediana): R$ ${limiteSupConfigurado.toFixed(2)}
   - Amostras fora da faixa central: ${criticasCount} (decisão de exclusão sempre humana e motivada)
   - Recomendação do Motor: ${motivoRecomendacao}

5. MÉTODO SELECIONADO E CONSOLIDAÇÃO DETERMINÍSTICA
   - Método Selecionado: ${metodo.toUpperCase()}
   - Fórmula Utilizada: ${formulaUtilizada}
   - Justificativa do Servidor: ${justificativaMetodo || (pendenciaInsuficiencia ? 'PENDENTE DE JUSTIFICATIVA FORMAL' : 'Em conformidade com a regulamentação do órgão')}
   - Preço de Referência Unitário: ${precoReferencia !== null ? `R$ ${precoReferencia.toFixed(2)}` : 'AUSENTE (justificativa pendente)'}
   - Valor Total Estimado para a Demanda: ${totalItem !== null ? `${quantidadeDemandada} × R$ ${precoReferencia!.toFixed(2)} = R$ ${totalItem.toFixed(2)}` : 'AUSENTE'}
   - Regra de Auditoria: Arredondamento bancário ABNT NBR 5891:2014. Quantidades amostrais externas não somadas ao quantitativo do órgão.
  `.trim()

  const memoria: MemoriaCalculoEstruturada = {
    valores_considerados: valoresOrdenados,
    soma: roundToTwoDecimals(soma),
    n: n_precos,
    media_aritmetica: roundToTwoDecimals(mediaAritmetica),
    mediana: roundToTwoDecimals(mediana),
    menor_preco: roundToTwoDecimals(menorPreco),
    maior_preco: roundToTwoDecimals(maiorPreco),
    desvio_padrao: roundToTwoDecimals(desvioPadrao),
    coeficiente_variacao: roundToTwoDecimals(coeficienteVariacao),
    metodo_selecionado: metodo,
    valor_estimado_unitario: precoReferencia,
    formula_utilizada: formulaUtilizada,
    resumo_rastreabilidade: resumoRastreabilidade,
    texto_completo: memoriaTexto,
  }

  return {
    metodo,
    versao_motor: 'PriceEngine v2.0-ENTERPRISE-LEI14133',
    arredondamento: 'ABNT NBR 5891:2014 (2 casas decimais)',
    amostra_valida: !pendenciaInsuficiencia,
    mensagem_amostra: alertaInsuficiencia || undefined,
    entradas,
    metricas_n: {
      n_precos,
      n_transacoes,
      n_plataformas,
      plataformas_distribuicao: plataformasMap,
      suficiente: n_precos >= qtdMinima,
      quantidade_minima_configurada: qtdMinima,
      alerta_insuficiencia: alertaInsuficiencia,
      status_amostra: statusAmostra,
    },
    mad_valor: roundToTwoDecimals(mad_valor),
    mad_zero,
    outliers,
    preco_referencia: precoReferencia,
    quantidade_demandada: quantidadeDemandada,
    total_item: totalItem,
    total_demanda: totalItem,
    estatisticas: estatisticasCompletas,
    juizo_critico: juizoCriticoCompat,
    estatisticas_saneadas: estatisticasSaneadasCompat,
    memoria,
    memoria_texto: memoriaTexto,
    pendencia_insuficiencia: pendenciaInsuficiencia,
  }
}
