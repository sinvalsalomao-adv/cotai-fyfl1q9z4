/**
 * Mapeamento Canônico de Termos e Códigos Oficiais CATMAT / CATSER
 * Centralizado e compartilhado entre módulos de busca, conectores e grade.
 */

export interface TermoCatalogoOficial {
  termoNormalizado: string
  codigosCatmat: string[]
  palavrasExcluir?: string[]
}

/**
 * Normaliza uma string para comparação fonética/textual canônica (sem acentos, maiúscula, sem pontuação)
 */
export function normalizarTextoCanonico(str: string): string {
  if (!str) return ''
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Mapeamento canônico oficial para os termos frequentes de compras públicas
 */
export const MAPEAMENTO_CANONICO_CATMAT: Record<string, string[]> = {
  PICOLE: ['462776', '462772'],
  SORVETE: ['462772', '462776'],
  DIPIRONA: ['267203', '268252', '267205', '267206', '267204'],
  METAMIZOL: ['267203', '268252', '267205', '267206', '267204'],
  PARACETAMOL: ['271501'],
  ALCOOL: ['318920'],
  GASOLINA: ['390145'],
  DIESEL: ['390146'],
}

/**
 * Padrões de unidades de serviço ou tempo que NÃO devem entrar em contratações de fornecimento de material/consumo
 */
export const UNIDADES_SERVICO_EXCLUIR = new Set([
  'SERVICO',
  'SERVIÇO',
  'SERVICOS',
  'SERVIÇOS',
  'SV',
  'SRV',
  'HORA',
  'H',
  'HR',
  'HRS',
  'DIARIA',
  'DIÁRIA',
  'MES',
  'MÊS',
  'POSTO',
])

/**
 * Retorna lista de códigos CATMAT canônicos associados ao termo de busca
 */
export function obterCodigosCatmatDoTermo(termo: string): string[] {
  const norm = normalizarTextoCanonico(termo)
  if (!norm) return []

  // Se o próprio termo for um código numérico de 4 a 8 dígitos
  if (/^\d{4,8}$/.test(norm)) {
    return [norm]
  }

  const codigos = new Set<string>()
  for (const [chave, lista] of Object.entries(MAPEAMENTO_CANONICO_CATMAT)) {
    if (norm.includes(chave)) {
      lista.forEach((c) => codigos.add(c))
    }
  }

  return Array.from(codigos)
}

/**
 * Verifica se um código de item (ex.: 'CATMAT 462776', '462776', 'CATMAT:462776')
 * corresponde aos códigos CATMAT canônicos associados ao termo de pesquisa.
 */
export function codigoCorrespondeAoTermo(termo: string, codigoItem?: string): boolean {
  if (!codigoItem) return false
  const codigosTermo = obterCodigosCatmatDoTermo(termo)
  if (codigosTermo.length === 0) return false

  // Extrai apenas os dígitos ou normaliza o código
  const numerosAmostra = String(codigoItem).replace(/\D/g, '')
  if (numerosAmostra && codigosTermo.includes(numerosAmostra)) {
    return true
  }

  const cUpper = String(codigoItem).toUpperCase()
  for (const c of codigosTermo) {
    if (cUpper.includes(c)) return true
  }

  return false
}

/**
 * Verifica se uma amostra deve ser descartada pelos critérios de natureza inadequada:
 * - Unidades de serviço/hora/diária para termos de produto (picolé, etc.)
 * - Acessórios de picolé (palito de picolé, forma de picolé, saquinho para picolé, etc.)
 * - Derivados (pirulito tipo picolé)
 * - Apresentações de serviço (palhaço picolé, show circense)
 */
export function amostraEhNaturezaIncompativel(
  _termo: string,
  _descricao: string,
  _unidade?: string,
): boolean {
  // CLARIFICAÇÃO DEFINITIVA DO USUÁRIO (v0.0.134):
  // Matching genérico sem allowlist ou exclusão automática por acessórios, artistas ou unidades.
  // Toda descrição que contém o termo no começo, meio ou fim deve aparecer na grade.
  // Diferenças conceituais devem ser sinalizadas para juízo humano e nunca descartadas silenciosamente.
  return false
}

export interface AnaliseJuizoCriticoAmostra {
  aderente: boolean
  alertas: string[]
  diferencasQualificadores: string[]
}

/**
 * Avalia a amostra para juízo crítico humano sem descartá-la:
 * - Termo casa em qualquer posição (início, meio ou fim), normalizando acentos e maiúsculas
 * - Sem descartes por unidade (HORA, H, MÊS, DIÁRIA, POSTO)
 * - Sem descartes por acessório (palito, forma, saquinho, picoleteira) ou homônimo (palhaço)
 * - Sinaliza diferenças de dosagens/qualificadores explícitos (ex.: DIPIRONA 1G vs 500mg, café vs cafeteira)
 */
export function avaliarAmostraParaJuizoCritico(
  termo: string,
  descricaoAmostra: string,
  unidadeAmostra?: string,
): AnaliseJuizoCriticoAmostra {
  const alertas: string[] = []
  const diferencasQualificadores: string[] = []

  const termoNorm = normalizarTextoCanonico(termo || '')
  const descNorm = normalizarTextoCanonico(descricaoAmostra || '')
  const unNorm = normalizarTextoCanonico(unidadeAmostra || '')

  if (!termoNorm) {
    return { aderente: true, alertas, diferencasQualificadores }
  }

  // 1. Termo casa em qualquer posição da descrição (começo/meio/fim)
  const tokensTermo = termoNorm.split(/\s+/).filter(Boolean)
  const tokensNaoEncontrados = tokensTermo.filter((tok) => !descNorm.includes(tok))
  const contemTermoCompleto = descNorm.includes(termoNorm)
  const aderente = contemTermoCompleto || tokensNaoEncontrados.length === 0

  if (!aderente) {
    alertas.push('A descrição não contém todos os termos buscados')
  }

  // 2. Sinalização de unidades de serviço para juízo humano (NUNCA descartar)
  const unidadesServico = ['HORA', 'H', 'HR', 'MES', 'MESES', 'DIARIA', 'POSTO', 'SV', 'SERVICO']
  if (unidadesServico.some((u) => unNorm === u || unNorm.startsWith(u + ' '))) {
    alertas.push(
      `Unidade de serviço identificada (${unidadeAmostra}): verificar se cotação é de serviço ou bem`,
    )
  }

  // 3. Sinalização de acessórios ou homônimos para juízo humano (NUNCA descartar)
  const acessorios = ['PALITO', 'FORMA', 'SAQUINHO', 'PICOLETEIRA', 'EMBALAGEM', 'POTE']
  for (const ac of acessorios) {
    if (descNorm.includes(ac) && !termoNorm.includes(ac)) {
      alertas.push(`Possível acessório identificado na descrição: ${ac}`)
      break
    }
  }

  if (descNorm.includes('PALHACO') && !termoNorm.includes('PALHACO')) {
    alertas.push('Possível homônimo/apresentação artística identificado: PALHAÇO')
  }

  if (descNorm.includes('CAFETEIRA') && termoNorm === 'CAFE') {
    alertas.push('Equipamento identificado para termo de insumo: CAFETEIRA vs CAFÉ')
  }

  // 4. Qualificadores explícitos e dosagens farmacêuticas ("500MG" <-> "500 MG", "1G" != "500MG")
  const regexDosagem = /\b(\d+(?:[.,]\d+)?)\s*(MG|G|MCG|ML|UI|KG)\b/g
  const converterParaMg = (valStr: string, unStr: string): number | null => {
    const num = parseFloat(valStr.replace(',', '.'))
    if (isNaN(num)) return null
    if (unStr === 'MG') return num
    if (unStr === 'G') return num * 1000
    if (unStr === 'KG') return num * 1000000
    if (unStr === 'MCG') return num / 1000
    return null
  }

  const dosagensTermo = new Set<string>()
  const dosagensTermoEmMg: number[] = []
  let mDose: RegExpExecArray | null
  while ((mDose = regexDosagem.exec(termoNorm)) !== null) {
    dosagensTermo.add(`${mDose[1]}${mDose[2]}`)
    const emMg = converterParaMg(mDose[1], mDose[2])
    if (emMg !== null) dosagensTermoEmMg.push(emMg)
  }

  if (dosagensTermo.size > 0) {
    const regexDoseAmostra = /\b(\d+(?:[.,]\d+)?)\s*(MG|G|MCG|ML|UI|KG)\b/g
    const dosagensAmostra = new Set<string>()
    const dosagensAmostraEmMg: number[] = []
    let mAmostra: RegExpExecArray | null
    while ((mAmostra = regexDoseAmostra.exec(descNorm)) !== null) {
      dosagensAmostra.add(`${mAmostra[1]}${mAmostra[2]}`)
      const emMgA = converterParaMg(mAmostra[1], mAmostra[2])
      if (emMgA !== null) dosagensAmostraEmMg.push(emMgA)
    }

    if (dosagensAmostra.size > 0) {
      let casou = false
      for (const d of dosagensTermo) {
        if (dosagensAmostra.has(d)) {
          casou = true
          break
        }
      }
      if (!casou && dosagensTermoEmMg.length > 0 && dosagensAmostraEmMg.length > 0) {
        for (const mgT of dosagensTermoEmMg) {
          for (const mgA of dosagensAmostraEmMg) {
            if (Math.abs(mgT - mgA) < 0.001) {
              casou = true
              break
            }
          }
          if (casou) break
        }
      }
      if (!casou) {
        const msg = 'Dosagem da amostra difere da solicitada no termo'
        alertas.push(msg)
        diferencasQualificadores.push(msg)
      }
    }
  }

  return {
    aderente,
    alertas,
    diferencasQualificadores,
  }
}
