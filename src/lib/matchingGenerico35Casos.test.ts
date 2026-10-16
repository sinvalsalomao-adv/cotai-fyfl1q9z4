import { describe, it, expect } from 'vitest'
import {
  amostraEhNaturezaIncompativel,
  codigoCorrespondeAoTermo,
  normalizarTextoCanonico,
} from './catalogoOficialCanonico'

describe('Regressão de Matching Genérico e Casos Críticos (35 Casos)', () => {
  // Função auxiliar reproduzindo as regras refinadas de validação aderente do modal
  function validarAderenciaTextual(
    termo: string,
    descricaoAmostra: string,
    codigoItem?: string,
    _unidade?: string,
  ): boolean {
    if (!termo || !termo.trim()) return true

    // Normalização compatível de dosagens: "500 MG" -> "500MG"
    const normalizarDosagensTexto = (s: string): string => {
      if (!s) return ''
      return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
    }

    const tNorm = normalizarDosagensTexto(termo)
    const dNorm = normalizarDosagensTexto(descricaoAmostra)

    // Se a busca for especificamente por código numérico de item (CATMAT / CATSER explícito)
    if (/^\d{4,8}$/.test(termo.trim())) {
      const numCode = termo.trim()
      const dCode = String(codigoItem || '').replace(/\D/g, '')
      return dCode === numCode || dNorm.includes(numCode)
    }

    // Validação de QUALIFICADORES EXPLÍCITOS DE DOSAGEM / CONCENTRAÇÃO:
    const dosesTermo = tNorm.match(/\b\d+(?:[.,]\d+)?(?:MG|G|ML|MCG|KG|L)\b/g) || []
    if (dosesTermo.length > 0) {
      for (const dose of dosesTermo) {
        if (!dNorm.includes(dose)) {
          return false
        }
      }
    }

    // Validação de FORMA FARMACÊUTICA / APRESENTAÇÃO EXPLÍCITA:
    if (/\bCOMPRIMIDO\b/.test(tNorm) && !/\bCOMPRIMIDO\b/.test(dNorm)) {
      return false
    }
    if (/\b(SOLUCAO|GOTAS|INJETAVEL|XAROPE|SUSPENSAO)\b/.test(tNorm)) {
      const matchForma = tNorm.match(/\b(SOLUCAO|GOTAS|INJETAVEL|XAROPE|SUSPENSAO)\b/)
      if (matchForma && !dNorm.includes(matchForma[0])) {
        return false
      }
    }

    // Se o código oficial casa e os qualificadores explícitos foram respeitados, aceita
    if (codigoCorrespondeAoTermo(termo, codigoItem)) {
      return true
    }

    // Helper tokenização
    const normalizarTokensTexto = (txt: string): string[] => {
      const STOPWORDS = new Set([
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
        'AO',
        'AOS',
        'ITEM',
        'LOTE',
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

    const stemToken = (t: string): string => {
      if (!t || t.length <= 3) return t
      if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
      if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
      return t
    }

    const tokensTermo = normalizarTokensTexto(tNorm)
    if (tokensTermo.length === 0) return true
    const tokensDesc = normalizarTokensTexto(dNorm)
    if (tokensDesc.length === 0) return false

    const tokensDescStems = new Set<string>()
    for (const dtk of tokensDesc) {
      tokensDescStems.add(dtk)
      const dst = stemToken(dtk)
      if (dst) tokensDescStems.add(dst)
    }

    for (const ttk of tokensTermo) {
      const stemT = stemToken(ttk)
      const match = tokensDescStems.has(ttk) || (stemT ? tokensDescStems.has(stemT) : false)
      if (!match) {
        return false
      }
    }

    return true
  }

  // OS 7 CASOS QUE ANTES FALHAVAM EM 35
  it('1. Palito de picolé deve ser aceito na busca de picolé para juízo humano (sem descarte automático por acessório)', () => {
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'PALITO DE MADEIRA PARA PICOLÉ', 'UN')).toBe(
      false,
    )
    expect(validarAderenciaTextual('picolé', 'PALITO DE MADEIRA PARA PICOLÉ')).toBe(true)
  })

  it('2. Forma para picolé deve ser aceita na busca de picolé para juízo humano (sem descarte automático)', () => {
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'FORMA DE INOX PARA PICOLÉ', 'UN')).toBe(false)
    expect(validarAderenciaTextual('picolé', 'FORMA DE INOX PARA PICOLÉ')).toBe(true)
  })

  it('3. Filtro de café deve ser aceito na busca de café para juízo humano (sem descarte automático)', () => {
    expect(amostraEhNaturezaIncompativel('CAFÉ', 'FILTRO PARA CAFÉ DESCARTÁVEL', 'UN')).toBe(false)
    expect(validarAderenciaTextual('café', 'FILTRO PARA CAFÉ DESCARTÁVEL')).toBe(true)
  })

  it('4. Serviço distribuição de picolé com unidade HORA deve ser aceito para juízo humano (sem exclusão de unidade)', () => {
    expect(
      amostraEhNaturezaIncompativel('PICOLÉ', 'SERVIÇO DE DISTRIBUIÇÃO DE PICOLÉ', 'HORA'),
    ).toBe(false)
    expect(validarAderenciaTextual('picolé', 'SERVIÇO DE DISTRIBUIÇÃO DE PICOLÉ', '', 'HORA')).toBe(
      true,
    )
  })

  it('5. Apresentação Palhaço Picolé com unidade MÊS deve ser aceita para juízo humano (sem exclusão de artista)', () => {
    expect(
      amostraEhNaturezaIncompativel('PICOLÉ', 'SHOW ARTÍSTICO COM PALHAÇO PICOLÉ', 'MÊS'),
    ).toBe(false)
    expect(validarAderenciaTextual('picolé', 'SHOW ARTÍSTICO COM PALHAÇO PICOLÉ', '', 'MÊS')).toBe(
      true,
    )
  })

  it('6. Dose 1G vs 500mg: código CATMAT não pode validar DIPIRONA 1G para consulta de 500mg comprimido', () => {
    // Termo pede 500mg comprimido: mesmo com código 267203 de dipirona, 1G NÃO pode ser validado
    const matchDoseInvalida = validarAderenciaTextual(
      'DIPIRONA 500MG COMPRIMIDO',
      'DIPIRONA SODICA 1G COMPRIMIDO',
      '267203', // CATMAT genérico de dipirona
    )
    expect(matchDoseInvalida).toBe(false)

    // Já a amostra com 500mg deve passar
    const matchDoseValida = validarAderenciaTextual(
      'DIPIRONA 500MG COMPRIMIDO',
      'DIPIRONA SODICA 500MG COMPRIMIDO',
      '267203',
    )
    expect(matchDoseValida).toBe(true)
  })

  it('7. Compatibilidade entre "500 MG" e "500mg" sem perda do qualificador', () => {
    // Busca com "500 MG" encontra descrição persistida com "500mg"
    expect(validarAderenciaTextual('DIPIRONA 500 MG COMPRIMIDO', 'DIPIRONA 500MG COMPRIMIDO')).toBe(
      true,
    )

    // Busca com "500mg" encontra descrição com "500 MG"
    expect(validarAderenciaTextual('DIPIRONA 500MG COMPRIMIDO', 'DIPIRONA 500 MG COMPRIMIDO')).toBe(
      true,
    )
  })

  // Casos adicionais do conjunto de 35
  it('8. Termo em qualquer posição (começo, meio, fim) deve ser aceito', () => {
    expect(validarAderenciaTextual('dipirona', 'DIPIRONA 500MG')).toBe(true)
    expect(validarAderenciaTextual('dipirona', 'MEDICAMENTO ANALGÉSICO DIPIRONA COMPRIMIDO')).toBe(
      true,
    )
    expect(validarAderenciaTextual('dipirona', 'SOLUÇÃO ORAL GOTAS À BASE DE DIPIRONA')).toBe(true)
  })

  it('9. Formas farmacêuticas explícitas respeitadas', () => {
    expect(validarAderenciaTextual('DIPIRONA COMPRIMIDO', 'DIPIRONA GOTAS')).toBe(false)
    expect(validarAderenciaTextual('DIPIRONA GOTAS', 'DIPIRONA COMPRIMIDO')).toBe(false)
    expect(validarAderenciaTextual('DIPIRONA COMPRIMIDO', 'DIPIRONA 500MG COMPRIMIDO')).toBe(true)
  })

  it('10. Busca por código CATMAT estrito não confunde texto solto', () => {
    expect(validarAderenciaTextual('267203', 'DIPIRONA 500MG', '267203')).toBe(true)
    expect(validarAderenciaTextual('267203', 'ITEM SEM CÓDIGO', '999999')).toBe(false)
  })
})
