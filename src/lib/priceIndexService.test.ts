import { describe, it, expect, vi } from 'vitest'
import { PriceIndexService } from './priceIndexService'
import { PncpConnectorAdapter } from './connectors/pncpConnectorAdapter'

describe('Motor de Pesquisa Indexada - Testes de Aceitação', () => {
  // Teste A: Normalização e identificação correta de Amostras (inclusive abaixo de R$1,00)
  it('Teste A (Dipirona / Amostras reais < R$1,00): preserva valores em centavos e descarta itens sem preço', () => {
    const adapter = new PncpConnectorAdapter()

    // Amostra legítima de Dipirona com valor unitário homologado R$ 0,12
    const rawDipirona = {
      numeroControlePNCP: '00394544000185-1-000001/2026',
      descricao: 'DIPIRONA SODICA 500MG COMPRIMIDO',
      valorUnitarioHomologado: 0.12,
      quantidade: 50000,
      unidadeMedida: 'COMPRIMIDO',
      fornecedor: {
        niFornecedor: '12345678000199',
        nomeRazaoSocialFornecedor: 'DISTRIBUIDORA MED LTDA',
      },
    }

    const amostraNorm = adapter.normalize(rawDipirona, 0)
    expect(amostraNorm).not.toBeNull()
    expect(amostraNorm?.valorUnitario).toBe(0.12)
    expect(amostraNorm?.valorUnitario).toBeLessThan(1.0)
    expect(amostraNorm?.natureza).toBe('contratado')
    expect(amostraNorm?.fornecedorNome).toBe('DISTRIBUIDORA MED LTDA')
  })

  // Teste B: Regra Crítica de Valores Globais
  it('Teste B (Valores Globais): contratação com valor global R$8.000.000,00 e sem item detalhado NÃO pode gerar amostra unitária R$8.000.000,00', () => {
    const adapter = new PncpConnectorAdapter()

    // Cabeçalho de contratação com valor global sem preço unitário no item
    const rawCabecalhoSemItem = {
      numeroControlePNCP: '99999999000199-1-000123/2026',
      objeto: 'AQUISIÇÃO DE MEDICAMENTOS PARA O HOSPITAL MUNICIPAL',
      valor_global: 8000000.0,
      valorTotal: 8000000.0,
      quantidade: 1,
      _detalhamento_pendente: true,
      _is_contratacao_sem_item: true,
    }

    const amostra = adapter.normalize(rawCabecalhoSemItem, 0)
    // Sem preço unitário de item apurado, a amostra DEVE ser rejeitada/descartada
    expect(amostra).toBeNull()
  })

  // Teste C: Deduplicação e chaves estáveis
  it('Teste C: Chave estável de amostra indexada é determinística e idempotente', () => {
    const key1 = PriceIndexService.gerarSampleKey({
      fonte: 'PNCP',
      idExterno: 'CONTRATO-123',
      orgaoCnpj: '00394544000185',
      fornecedorCnpjOuCpf: '12345678000199',
      numeroItem: 1,
      valorUnitario: 0.12,
    })

    const key2 = PriceIndexService.gerarSampleKey({
      fonte: 'PNCP',
      idExterno: 'CONTRATO-123',
      orgaoCnpj: '00394544000185',
      fornecedorCnpjOuCpf: '12345678000199',
      numeroItem: 1,
      valorUnitario: 0.12,
    })

    expect(key1).toBe(key2)
    expect(key1).toContain('PNCP')
    expect(key1).toContain('CONTRATO-123')
    expect(key1).toContain('0_1200')
  })

  // Teste D: Normalização de termos e queries
  it('Teste D: Normalização canônica unifica termos com acentos e caixas diferentes', () => {
    const norm1 = PriceIndexService.canonicalNormalize('Dipirona Sódica 500mg')
    const norm2 = PriceIndexService.canonicalNormalize('DIPIRONA SODICA 500MG')
    expect(norm1).toBe('DIPIRONA SODICA 500MG')
    expect(norm1).toBe(norm2)
  })

  // Teste E: Conversão de Hit indexado para AmostraPreco canônica
  it('Teste E: Conversão de hit para AmostraPreco preserva integridade e natureza', () => {
    const hitSource = {
      sample_key: 'PNCP#123#1#000#0_5000',
      descricao: 'DIPIRONA 500MG',
      fonte: 'PNCP',
      orgao: 'PREFEITURA MUNICIPAL',
      for_nome: 'FARMA LTDA',
      unidade: 'COMP',
      quantidade: 1000,
      valor_unitario: 0.5,
      valor_total: 500,
      natureza_preco: 'homologado',
      data: '2026-03-01',
      uf: 'SP',
    }

    const amostra = PriceIndexService.hitToAmostraPreco(hitSource as any)
    expect(amostra.valorUnitario).toBe(0.5)
    expect(amostra.natureza).toBe('contratado')
    expect(amostra.unidade).toBe('COMP')
    expect(amostra.fornecedorNome).toBe('FARMA LTDA')
    expect(amostra.orgaoComprador).toBe('PREFEITURA MUNICIPAL')
  })
})
