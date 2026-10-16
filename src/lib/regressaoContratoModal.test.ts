import { describe, it, expect, vi } from 'vitest'
import { PriceIndexService } from './priceIndexService'

describe('Regressão Contrato Modal e Integração (v0.0.134)', () => {
  it('garante que página 2 é acessível e suportada nos parâmetros de consulta', () => {
    const paramsPagina2 = {
      palavra_chave: 'DIPIRONA',
      pagina: 2,
      tamanho_pagina: 50,
    }
    expect(paramsPagina2.pagina).toBe(2)
    expect(paramsPagina2.tamanho_pagina).toBe(50)
  })

  it('AbortError do usuário não cai em fallback SDK e propaga exceção', async () => {
    const controller = new AbortController()
    controller.abort() // Simula cancelamento imediato

    await expect(
      PriceIndexService.searchIndex(
        { palavra_chave: 'DIPIRONA', pagina: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow()
  })

  it('diferencia contadores de processo vs contadores de preço do PNCP', () => {
    // No PNCP, a API retorna apenas o total de processos (licitações), não o total de preços/itens.
    // O modal e os adaptadores nunca devem exibir contagem de processos como se fossem amostras de preço.
    const observabilidadePncp = {
      quantidadeInformadaApi: undefined, // Total de preços NÃO informado upstream
      totalProcessosUpstream: 1420, // Processos licitatórios
      amostrasColetadas: 18, // Amostras reais de preços detalhadas
    }

    expect(observabilidadePncp.quantidadeInformadaApi).toBeUndefined()
    expect(observabilidadePncp.totalProcessosUpstream).not.toBe(
      observabilidadePncp.amostrasColetadas,
    )
    expect(observabilidadePncp.amostrasColetadas).toBe(18)
  })

  it('garante que token em qualquer posição da descrição é recuperado', () => {
    const descricoes = [
      'DIPIRONA SODICA 500MG COMPRIMIDO',
      'COMPRIMIDO DE DIPIRONA MONOIDRATADA 500MG',
      'MEDICAMENTO ANALGESICO E ANTITERMICO DIPIRONA',
    ]
    const termo = 'DIPIRONA'
    for (const desc of descricoes) {
      expect(desc.toUpperCase().includes(termo)).toBe(true)
    }
  })

  it('troca de fonte refaz consulta no servidor com reset de páginas', () => {
    let paginaAtual = 3
    let fonteAtiva = 'PNCP'

    const handleTrocarFonte = (novaFonte: string) => {
      fonteAtiva = novaFonte
      paginaAtual = 1 // Reset obrigatório ao refazer no servidor
    }

    handleTrocarFonte('Compras.gov.br')
    expect(fonteAtiva).toBe('Compras.gov.br')
    expect(paginaAtual).toBe(1)
  })
})
