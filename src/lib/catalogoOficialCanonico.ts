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
 * Verifica se uma amostra deve ser descartada pelos critérios de natureza inadequada:
 * - Unidades de serviço/hora/diária para termos de produto (picolé, etc.)
 * - Acessórios de picolé (palito de picolé, forma de picolé, saquinho para picolé)
 * - Derivados (pirulito tipo picolé)
 * - Apresentações de serviço (palhaço picolé, show circense)
 */
export function amostraEhNaturezaIncompativel(
  termo: string,
  descricao: string,
  unidade?: string,
): boolean {
  const tNorm = normalizarTextoCanonico(termo)
  const dNorm = normalizarTextoCanonico(descricao)
  const uNorm = normalizarTextoCanonico(unidade || '')

  // Se termo tem "PICOLE"
  if (tNorm.includes('PICOLE')) {
    // 1. Excluir unidades de serviço
    if (UNIDADES_SERVICO_EXCLUIR.has(uNorm) || uNorm.startsWith('SERVIC') || uNorm.startsWith('SERVIÇ')) {
      return true
    }

    // 2. Excluir espetáculos circenses / artista / palhaço
    if (dNorm.includes('PALHACO') || dNorm.includes('CIRCENSE') || dNorm.includes('ESPETACULO')) {
      return true
    }

    // 3. Excluir acessórios/insumos de fabricação e derivados
    // "PALITO DE PICOLE", "PALITO P PICOLE", "PALITO PARA PICOLE", "PALITO DE MADEIRA"
    if (
      dNorm.includes('PALITO DE PICOLE') ||
      dNorm.includes('PALITO P PICOLE') ||
      dNorm.includes('PALITO PARA PICOLE') ||
      dNorm.includes('PALITO DE MADEIRA') ||
      dNorm.includes('PALITOS DE PICOLE')
    ) {
      return true
    }

    // "FORMA DE PICOLE", "FORMA PARA PICOLE", "FORMA P PICOLE"
    if (
      dNorm.includes('FORMA DE PICOLE') ||
      dNorm.includes('FORMA PARA PICOLE') ||
      dNorm.includes('FORMA P PICOLE') ||
      dNorm.includes('FORMAS DE PICOLE') ||
      dNorm.includes('FORMAS PARA PICOLE')
    ) {
      return true
    }

    // "SAQUINHO PARA PICOLE", "SAQUINHO DE PICOLE", "SACO PARA PICOLE"
    if (
      dNorm.includes('SAQUINHO PARA PICOLE') ||
      dNorm.includes('SAQUINHO DE PICOLE') ||
      dNorm.includes('SACO PARA PICOLE') ||
      dNorm.includes('SAQUINHOS PARA PICOLE')
    ) {
      return true
    }

    // "PIRULITO TIPO PICOLE"
    if (dNorm.includes('PIRULITO')) {
      return true
    }
  }

  return false
}
