import { codigoCorrespondeAoTermo } from './catalogoOficialCanonico'

// Helpers de anti-contaminação e tokenização
const normalizarTokensTexto = (txt: string): string[] => {
  if (!txt) return []
  const STOPWORDS = new Set([
    'AS',
    'OS',
    'DE',
    'DA',
    'DO',
    'DAS',
    'DOS',
    'EM',
    'PARA',
    'COM',
    'SEM',
    'POR',
    'ITEM',
    'LOTE',
    'AQUISICAO',
    'FORNECIMENTO',
    'REGISTRO',
    'PRECOS',
  ])
  const norm = txt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .trim()
  if (!norm) return []
  return norm.split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

// Mesmas alternativas por palavra de prices_search.js; OR somente dentro da palavra.
const variantesToken = (token: string): string[] => {
  const variants = [token]
  if (token.length >= 4) {
    if (token.length > 4 && token.endsWith('S')) variants.push(token.slice(0, -1))
    else variants.push(token + 'S')
    if (token.endsWith('M')) variants.push(token.slice(0, -1) + 'NS')
    if (token.endsWith('R') || token.endsWith('Z')) variants.push(token + 'ES')
  }
  return variants
}

const tokenCorresponde = (token: string, descricaoTokens: Set<string>): boolean =>
  variantesToken(token).some((variant) => descricaoTokens.has(variant))

// Normalização de dosagens para comparação canônica: "500 MG" -> "500MG"
const normalizarDosagensTexto = (s: string): string => {
  if (!s) return ''
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
}

// Verifica se a descrição de uma amostra possui aderência com o termo pesquisado.
// CLARIFICAÇÃO DEFINITIVA DO USUÁRIO (v0.0.134):
// (1) MATCHING GENÉRICO para QUALQUER produto ou serviço — SEM allowlist e SEM descarte por unidade/acessório/artista.
// (2) Termo presente em qualquer posição (começo, meio, fim) deve ser aceito.
// (3) Qualificadores EXPLÍCITOS (dose 500mg vs 1g, comprimido, etc.) continuam obrigatórios e não podem
//     ser burlados por código CATMAT genérico da substância.
// (4) Normalização compatível entre "500 MG" e "500mg".
export const validarAderenciaTextual = (
  termo: string,
  descricaoAmostra: string,
  codigoItem?: string,
  _unidade?: string,
): boolean => {
  if (!termo || !termo.trim()) return true

  const tNorm = normalizarDosagensTexto(termo)
  const dNorm = normalizarDosagensTexto(descricaoAmostra)

  // Se a busca for especificamente por código numérico de item (CATMAT / CATSER explícito)
  if (/^\d{4,8}$/.test(termo.trim())) {
    const numCode = termo.trim()
    const dCode = String(codigoItem || '').replace(/\D/g, '')
    return dCode === numCode || dNorm.includes(numCode)
  }

  // Validação de QUALIFICADORES EXPLÍCITOS DE DOSAGEM / CONCENTRAÇÃO:
  // Extrai todas as doses explícitas do termo (ex: "500MG", "1G", "10MG/ML")
  const dosesTermo = tNorm.match(/\b\d+(?:[.,]\d+)?(?:MG|G|ML|MCG|KG|L)\b/g) || []
  if (dosesTermo.length > 0) {
    const dosesDescricao = new Set(dNorm.match(/\b\d+(?:[.,]\d+)?(?:MG|G|ML|MCG|KG|L)\b/g) || [])
    for (const dose of dosesTermo) {
      // Se o termo pede 500MG, a descrição da amostra DEVE conter 500MG (ou 500 MG)
      // e NÃO pode ser aceita apenas por ter o mesmo CATMAT básico
      if (!dosesDescricao.has(dose)) {
        return false
      }
    }
  }

  const tokensTermo = normalizarTokensTexto(tNorm)
  const tokensDesc = new Set(normalizarTokensTexto(dNorm))

  // Mantém as famílias de apresentação antes do atalho por código canônico.
  // Plurais irregulares qualificam a forma; não ampliam as alternativas da busca genérica.
  const familiasFormasExplicitas = [
    variantesToken('COMPRIMIDO'),
    [...variantesToken('SOLUCAO'), 'SOLUCOES'],
    variantesToken('GOTAS'),
    [...variantesToken('INJETAVEL'), 'INJETAVEIS'],
    variantesToken('XAROPE'),
    [...variantesToken('SUSPENSAO'), 'SUSPENSOES'],
  ]
  for (const familia of familiasFormasExplicitas) {
    const formas = new Set(familia)
    if (
      tokensTermo.some((token) => formas.has(token)) &&
      !Array.from(tokensDesc).some((token) => formas.has(token))
    ) {
      return false
    }
  }

  // Se o código oficial casa e os qualificadores explícitos foram respeitados, aceita
  if (codigoCorrespondeAoTermo(termo, codigoItem)) {
    return true
  }

  if (tokensTermo.length === 0) return true
  if (tokensDesc.size === 0) return false

  // Todas as palavras significativas do termo devem estar presentes na descrição da amostra (em qualquer posição/ordem)
  for (const ttk of tokensTermo) {
    if (!tokenCorresponde(ttk, tokensDesc)) {
      return false
    }
  }

  return true
}
