import { describe, it, expect } from 'vitest'
import {
  amostraEhNaturezaIncompativel,
  avaliarAmostraParaJuizoCritico,
  normalizarTextoCanonico,
} from './catalogoOficialCanonico'

describe('Matching Genérico e Casos Críticos (v0.0.134)', () => {
  it('garante que amostraEhNaturezaIncompativel NUNCA descarta amostras silenciosamente', () => {
    // Casos que anteriormente eram descartados indevidamente
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'PALITO DE PICOLÉ', 'UN')).toBe(false)
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'FORMA DE PICOLÉ', 'UN')).toBe(false)
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'SAQUINHO DE PICOLÉ', 'UN')).toBe(false)
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'PICOLETEIRA', 'UN')).toBe(false)
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'SHOW PALHAÇO PICOLÉ', 'MÊS')).toBe(false)
    expect(amostraEhNaturezaIncompativel('PICOLÉ', 'SERVIÇO DE BUFFET PICOLÉ', 'HORA')).toBe(false)
    expect(amostraEhNaturezaIncompativel('CAFÉ', 'CAFETEIRA ELÉTRICA', 'UN')).toBe(false)
    expect(amostraEhNaturezaIncompativel('DIPIRONA', 'DIPIRONA 1G', 'AMP')).toBe(false)
  })

  it('termo casa em qualquer posição da descrição (começo, meio e fim) com acentos/caixa normalizados', () => {
    // Começo
    const resComeco = avaliarAmostraParaJuizoCritico('PICOLÉ', 'Picolé de morango artesanal')
    expect(resComeco.aderente).toBe(true)

    // Meio
    const resMeio = avaliarAmostraParaJuizoCritico(
      'PICOLÉ',
      'Sobremesa gelada tipo picolé sabor chocolate',
    )
    expect(resMeio.aderente).toBe(true)

    // Fim
    const resFim = avaliarAmostraParaJuizoCritico('PICOLÉ', 'Sorvete no palito picolé')
    expect(resFim.aderente).toBe(true)

    // Acentos e caixa mista
    const resAcento = avaliarAmostraParaJuizoCritico('picole', 'PICOLÉ CREMOSO SABOR UVA')
    expect(resAcento.aderente).toBe(true)
  })

  // Os 7 casos de matching especificados na tarefa:
  // 1. palito picolé
  // 2. forma picolé
  // 3. filtro café vs cafeteira
  // 4. serviço HORA
  // 5. PALHAÇO PICOLÉ / MES
  // 6. dose 1G vs 500mg
  // 7. normalização "500 MG" vs "500MG"
  it('caso 1: PALITO PICOLÉ não é descartado e é sinalizado para juízo humano', () => {
    const analise = avaliarAmostraParaJuizoCritico(
      'PICOLÉ',
      'PALITO DE PICOLÉ PONTA REDONDA',
      'MILHEIRO',
    )
    expect(analise.aderente).toBe(true)
    expect(analise.alertas.some((a) => a.includes('acessório') || a.includes('PALITO'))).toBe(true)
  })

  it('caso 2: FORMA PICOLÉ não é descartado e é sinalizado para juízo humano', () => {
    const analise = avaliarAmostraParaJuizoCritico(
      'PICOLÉ',
      'FORMA DE PICOLÉ EM INOX 28 CAVIDADES',
      'UN',
    )
    expect(analise.aderente).toBe(true)
    expect(analise.alertas.some((a) => a.includes('acessório') || a.includes('FORMA'))).toBe(true)
  })

  it('caso 3: CAFÉ vs CAFETEIRA não é descartado e sinaliza equipamento vs insumo', () => {
    const analise = avaliarAmostraParaJuizoCritico('CAFÉ', 'CAFETEIRA ELÉTRICA 30 XÍCARAS', 'UN')
    expect(analise.aderente).toBe(true)
    expect(analise.alertas.some((a) => a.includes('CAFETEIRA'))).toBe(true)
  })

  it('caso 4: serviço HORA não é descartado e sinaliza unidade de serviço para juízo humano', () => {
    const analise = avaliarAmostraParaJuizoCritico(
      'MANUTENÇÃO PREDIAL',
      'SERVIÇO DE MANUTENÇÃO PREDIAL PREVENTIVA',
      'HORA',
    )
    expect(analise.aderente).toBe(true)
    expect(analise.alertas.some((a) => a.includes('Unidade de serviço'))).toBe(true)
  })

  it('caso 5: PALHAÇO PICOLÉ / MÊS não é descartado e sinaliza homônimo e unidade de serviço', () => {
    const analise = avaliarAmostraParaJuizoCritico(
      'PICOLÉ',
      'APRESENTAÇÃO ARTÍSTICA PALHAÇO PICOLÉ SHOW',
      'MÊS',
    )
    expect(analise.aderente).toBe(true)
    expect(analise.alertas.some((a) => a.includes('PALHAÇO'))).toBe(true)
    expect(analise.alertas.some((a) => a.includes('Unidade de serviço'))).toBe(true)
  })

  it('caso 6: dose 1G vs 500mg não descarta, mas sinaliza divergência de qualificador/dosagem obrigatória', () => {
    const analise = avaliarAmostraParaJuizoCritico(
      'DIPIRONA 500MG',
      'DIPIRONA 1G INJETÁVEL AMPOLA 2ML',
      'AMPOLA',
    )
    expect(analise.aderente).toBe(true)
    expect(analise.diferencasQualificadores.length).toBeGreaterThan(0)
    expect(analise.alertas.some((a) => a.includes('Dosagem da amostra difere'))).toBe(true)
  })

  it('caso 7: normalização bidirecional 500MG <-> 500 MG reconhece equivalência exata sem divergência', () => {
    const analise = avaliarAmostraParaJuizoCritico(
      'DIPIRONA 500 MG',
      'DIPIRONA 500MG COMPRIMIDO',
      'COMPRIMIDO',
    )
    expect(analise.aderente).toBe(true)
    expect(analise.diferencasQualificadores.length).toBe(0)
    expect(analise.alertas.length).toBe(0)

    const analiseInversa = avaliarAmostraParaJuizoCritico(
      'DIPIRONA 500MG',
      'DIPIRONA 500 MG COMPRIMIDO',
      'COMPRIMIDO',
    )
    expect(analiseInversa.aderente).toBe(true)
    expect(analiseInversa.diferencasQualificadores.length).toBe(0)
    expect(analiseInversa.alertas.length).toBe(0)
  })
})
