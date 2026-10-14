// Motor de Matching em Camadas Auditável e Tratamento de Outliers Versionável
// Atende a especificação:
// 1. "Aplicar matching em camadas: código oficial e atributos estruturados primeiro; similaridade textual apenas como apoio auditável."
// 2. "Calcular média, mediana, quartis, mínimo, máximo e quantidade de amostras."
// 3. "Tratar outliers com regra transparente e versionável, como MAD ou IQR. Exibir razões de exclusão e permitir rastrear cada resultado até sua fonte."

export interface ItemReferenciaMatch {
  termo: string
  codigoCatmat?: string
  unidadeMedida?: string
  marcaDesejada?: string
}

export interface AmostraAvaliadorMatch {
  id?: string
  source: string
  descricao: string
  descricao_normalizada?: string
  codigo_item?: string
  unidade?: string
  valor_unitario: number
  marca?: string
  url_original?: string
}

export type MatchingNivel =
  | '1_CODIGO_OFICIAL_EXATO'
  | '2_ATRIBUTOS_ESTRUTURADOS_E_TEXTO'
  | '3_SIMILARIDADE_TEXTUAL_APOIO'
  | '0_SEM_MATCH'

export interface ResultadoMatchingAmostra {
  amostra: AmostraAvaliadorMatch
  nivel: MatchingNivel
  score: number // 0 a 100
  auditavel: {
    codigoMatch: boolean
    unidadeMatch: boolean
    tokensCorrespondentes: string[]
    tokensFaltantes: string[]
    similaridadeDice: number
    justificativaScore: string
  }
}

export interface EstatisticasRobustaResult {
  n: number
  media: number
  mediana: number
  q1: number
  q3: number
  minimo: number
  maximo: number
  desvio_padrao: number
  iqr: number
  mad: number // Median Absolute Deviation
  regra_outlier: string // Versionada, ex: 'IQR_1_5_V1' ou 'MAD_3_0_V1'
  limite_inferior: number
  limite_superior: number
  outliers_identificados: Array<{
    amostraId?: string
    valor_unitario: number
    motivo: string
  }>
  amostras_saneadas_count: number
}

export class LayeredMatchingEngine {
  /**
   * Normalização canônica para comparação determinística
   */
  static canonicalNorm(s: string): string {
    if (!s) return ''
    return String(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
      .replace(/[^A-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  static extractTokens(s: string): string[] {
    const STOPWORDS: Record<string, boolean> = {
      DE: true,
      DA: true,
      DO: true,
      DAS: true,
      DOS: true,
      EM: true,
      PARA: true,
      COM: true,
      SEM: true,
      POR: true,
      AO: true,
      AOS: true,
      ITEM: true,
      LOTE: true,
      AQUISICAO: true,
      FORNECIMENTO: true,
      REGISTRO: true,
      PRECOS: true,
    }
    const norm = this.canonicalNorm(s)
    if (!norm) return []
    return norm.split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS[t])
  }

  /**
   * Coeficiente de Dice para similaridade de n-gramas
   */
  static calcularSimilaridadeDice(a: string, b: string): number {
    const s1 = this.canonicalNorm(a)
    const s2 = this.canonicalNorm(b)
    if (!s1 || !s2) return 0
    if (s1 === s2) return 1.0

    const getBigrams = (str: string): Set<string> => {
      const set = new Set<string>()
      for (let i = 0; i < str.length - 1; i++) {
        set.add(str.slice(i, i + 2))
      }
      return set
    }

    const b1 = getBigrams(s1)
    const b2 = getBigrams(s2)
    let intersecao = 0
    for (const bg of b1) {
      if (b2.has(bg)) intersecao++
    }
    return (2 * intersecao) / (b1.size + b2.size)
  }

  /**
   * Avaliação em Camadas:
   * 1. Código Oficial CATMAT (prioridade máxima)
   * 2. Atributos estruturados + termos exatos
   * 3. Similaridade textual com score auditável
   */
  static avaliarMatching(
    ref: ItemReferenciaMatch,
    amostra: AmostraAvaliadorMatch,
  ): ResultadoMatchingAmostra {
    const refTokens = this.extractTokens(ref.termo)
    const amostraTokens = this.extractTokens(amostra.descricao)
    const amostraDescNorm = this.canonicalNorm(amostra.descricao)

    // CAMADA 1: Código Oficial (CATMAT)
    const catmatRef = (ref.codigoCatmat || '').replace(/\D/g, '')
    const catmatAmostra = (amostra.codigo_item || '').replace(/\D/g, '')
    const codigoMatch = Boolean(
      catmatRef && catmatAmostra && catmatRef.length >= 4 && catmatRef === catmatAmostra,
    )

    if (codigoMatch) {
      return {
        amostra,
        nivel: '1_CODIGO_OFICIAL_EXATO',
        score: 100,
        auditavel: {
          codigoMatch: true,
          unidadeMatch: Boolean(
            ref.unidadeMedida &&
            amostra.unidade &&
            ref.unidadeMedida.toUpperCase() === amostra.unidade.toUpperCase(),
          ),
          tokensCorrespondentes: refTokens,
          tokensFaltantes: [],
          similaridadeDice: 1.0,
          justificativaScore: `Correspondência exata de código oficial CATMAT (${catmatRef})`,
        },
      }
    }

    // CAMADA 2: Atributos estruturados e termos essenciais
    const tokensCorrespondentes: string[] = []
    const tokensFaltantes: string[] = []
    for (const tok of refTokens) {
      if (amostraDescNorm.includes(tok) || amostraTokens.includes(tok)) {
        tokensCorrespondentes.push(tok)
      } else {
        tokensFaltantes.push(tok)
      }
    }

    const proporcaoTokens =
      refTokens.length > 0 ? tokensCorrespondentes.length / refTokens.length : 1
    const unidadeMatch = Boolean(
      ref.unidadeMedida &&
      amostra.unidade &&
      (ref.unidadeMedida.toUpperCase() === amostra.unidade.toUpperCase() ||
        (ref.unidadeMedida.toUpperCase().includes('UN') &&
          amostra.unidade.toUpperCase().includes('UN'))),
    )

    if (proporcaoTokens >= 0.75) {
      const score = Math.round(75 + proporcaoTokens * 20 + (unidadeMatch ? 5 : 0))
      return {
        amostra,
        nivel: '2_ATRIBUTOS_ESTRUTURADOS_E_TEXTO',
        score,
        auditavel: {
          codigoMatch: false,
          unidadeMatch,
          tokensCorrespondentes,
          tokensFaltantes,
          similaridadeDice: Number(
            this.calcularSimilaridadeDice(ref.termo, amostra.descricao).toFixed(3),
          ),
          justificativaScore: `Contém ${tokensCorrespondentes.length}/${refTokens.length} termos essenciais da especificação`,
        },
      }
    }

    // CAMADA 3: Similaridade Textual como apoio auditável
    const dice = this.calcularSimilaridadeDice(ref.termo, amostra.descricao)
    if (dice >= 0.4 || proporcaoTokens >= 0.5) {
      const score = Math.round(dice * 70)
      return {
        amostra,
        nivel: '3_SIMILARIDADE_TEXTUAL_APOIO',
        score,
        auditavel: {
          codigoMatch: false,
          unidadeMatch,
          tokensCorrespondentes,
          tokensFaltantes,
          similaridadeDice: Number(dice.toFixed(3)),
          justificativaScore: `Similaridade textual por n-gramas de ${(dice * 100).toFixed(1)}%`,
        },
      }
    }

    return {
      amostra,
      nivel: '0_SEM_MATCH',
      score: Math.round(dice * 40),
      auditavel: {
        codigoMatch: false,
        unidadeMatch,
        tokensCorrespondentes,
        tokensFaltantes,
        similaridadeDice: Number(dice.toFixed(3)),
        justificativaScore: 'Compatibilidade insuficiente com os termos de busca',
      },
    }
  }

  /**
   * Cálculo de Estatísticas Robustas e Identificação Transparente de Outliers (IQR / MAD)
   */
  static calcularEstatisticasRobustas(
    amostras: AmostraAvaliadorMatch[],
    regra: 'IQR' | 'MAD' = 'IQR',
  ): EstatisticasRobustaResult {
    const valoresValidos = amostras
      .map((a) => Number(a.valor_unitario))
      .filter((v) => !isNaN(v) && v > 0)
      .sort((a, b) => a - b)

    const n = valoresValidos.length
    if (n === 0) {
      return {
        n: 0,
        media: 0,
        mediana: 0,
        q1: 0,
        q3: 0,
        minimo: 0,
        maximo: 0,
        desvio_padrao: 0,
        iqr: 0,
        mad: 0,
        regra_outlier: `${regra}_V1_0`,
        limite_inferior: 0,
        limite_superior: 0,
        outliers_identificados: [],
        amostras_saneadas_count: 0,
      }
    }

    const soma = valoresValidos.reduce((acc, cur) => acc + cur, 0)
    const media = soma / n

    const getMedian = (arr: number[]): number => {
      const len = arr.length
      if (len % 2 === 1) return arr[Math.floor(len / 2)]
      return (arr[len / 2 - 1] + arr[len / 2]) / 2
    }

    const mediana = getMedian(valoresValidos)

    const getPercentile = (p: number): number => {
      const idx = (n - 1) * p
      const b = Math.floor(idx)
      const r = idx - b
      if (valoresValidos[b + 1] !== undefined) {
        return valoresValidos[b] + r * (valoresValidos[b + 1] - valoresValidos[b])
      }
      return valoresValidos[b]
    }

    const q1 = getPercentile(0.25)
    const q3 = getPercentile(0.75)
    const iqr = q3 - q1

    // Cálculo do MAD (Median Absolute Deviation)
    const desviosAbsolutos = valoresValidos.map((v) => Math.abs(v - mediana)).sort((a, b) => a - b)
    const mad = getMedian(desviosAbsolutos)

    // Definição de limites transparentes e versionáveis
    let limiteInferior = 0
    let limiteSuperior = 0
    const versaoRegra = regra === 'MAD' ? 'MAD_3_0_VERSION_1_0' : 'IQR_1_5_VERSION_1_0'

    if (regra === 'MAD') {
      // 3 * 1.4826 * MAD (consistente com distribuição normal)
      const madEscalado = 1.4826 * mad
      limiteInferior = Math.max(0, mediana - 3 * madEscalado)
      limiteSuperior = mediana + 3 * madEscalado
    } else {
      // IQR tradicional 1.5 * IQR
      limiteInferior = Math.max(0, q1 - 1.5 * iqr)
      limiteSuperior = q3 + 1.5 * iqr
    }

    // Identificação de outliers auditáveis com justificativa
    const outliers: Array<{ amostraId?: string; valor_unitario: number; motivo: string }> = []
    let saneadasCount = 0

    for (const a of amostras) {
      const v = Number(a.valor_unitario)
      if (isNaN(v) || v <= 0) {
        outliers.push({
          amostraId: a.id,
          valor_unitario: v,
          motivo: 'PRECO_INVALIDO_OU_ZERO',
        })
      } else if (v < limiteInferior) {
        outliers.push({
          amostraId: a.id,
          valor_unitario: v,
          motivo: `OUTLIER_INFERIOR_${regra} (Valor R$ ${v.toFixed(4)} < Limite R$ ${limiteInferior.toFixed(4)})`,
        })
      } else if (v > limiteSuperior) {
        outliers.push({
          amostraId: a.id,
          valor_unitario: v,
          motivo: `OUTLIER_SUPERIOR_${regra} (Valor R$ ${v.toFixed(4)} > Limite R$ ${limiteSuperior.toFixed(4)})`,
        })
      } else {
        saneadasCount++
      }
    }

    const somaVar = valoresValidos.reduce((acc, cur) => acc + Math.pow(cur - media, 2), 0)
    const desvioPadrao = n > 1 ? Math.sqrt(somaVar / (n - 1)) : 0

    return {
      n,
      media: Number(media.toFixed(4)),
      mediana: Number(mediana.toFixed(4)),
      q1: Number(q1.toFixed(4)),
      q3: Number(q3.toFixed(4)),
      minimo: Number(valoresValidos[0].toFixed(4)),
      maximo: Number(valoresValidos[n - 1].toFixed(4)),
      desvio_padrao: Number(desvioPadrao.toFixed(4)),
      iqr: Number(iqr.toFixed(4)),
      mad: Number(mad.toFixed(4)),
      regra_outlier: versaoRegra,
      limite_inferior: Number(limiteInferior.toFixed(4)),
      limite_superior: Number(limiteSuperior.toFixed(4)),
      outliers_identificados: outliers,
      amostras_saneadas_count: saneadasCount,
    }
  }
}
