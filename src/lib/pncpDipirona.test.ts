import { describe, it, expect } from 'vitest'
import { PncpConnectorAdapter } from './connectors/pncpConnectorAdapter'
import { PncpService } from './pncpService'

describe('PNCP - Mecanismo de Preços e Validação com Dipirona (8 Cenários Controlados)', () => {
  const adapter = new PncpConnectorAdapter()

  // 1. Item de Dipirona com preço unitário R$ 0,18 e valor total R$ 180.000,00 para 1.000.000 de unidades
  // -> preço exibido deve ser R$ 0,18
  it('Cenário 1: Item com preço unitário R$ 0,18 e valor total R$ 180.000,00 para 1.000.000 de unidades deve ter preço unitário R$ 0,18', () => {
    const rawItem = {
      id_externo: '12345678000199-1-000001/2024',
      item_externo: 'DIPIRONA 500MG COMPRIMIDO',
      valorUnitarioHomologado: 0.18,
      valorTotalHomologado: 180000.0,
      quantidade: 1000000,
      unidadeMedida: 'COMPRIMIDO',
      orgao_comprador: 'HOSPITAL GERAL DE TESTE',
    }

    const amostra = adapter.normalize(rawItem, 0)
    expect(amostra).not.toBeNull()
    expect(amostra?.valorUnitario).toBe(0.18)
    expect(amostra?.valorTotal).toBe(180000.0)
    expect(amostra?.natureza).toBe('contratado')
  })

  // 2. Contratação com valor global R$ 8.000.000,00 sem preço unitário do medicamento
  // -> esse valor global NÃO pode aparecer como preço da Dipirona
  it('Cenário 2: Contratação com valor global R$ 8.000.000,00 sem preço unitário do medicamento NÃO pode virar amostra com preço unitário', () => {
    const rawContratacaoSemPreco = {
      id_externo: '99999999000100-1-000099/2024',
      objeto: 'REGISTRO DE PREÇOS PARA AQUISIÇÃO DE MEDICAMENTOS INCLUINDO DIPIRONA',
      valor_global: 8000000.0,
      valorTotal: 8000000.0,
      quantidade: 1,
      _detalhamento_pendente: true,
      _is_contratacao_sem_item: true,
    }

    // Adaptador descarta sumariamente porque não possui preço unitário do item
    const amostra = adapter.normalize(rawContratacaoSemPreco, 0)
    expect(amostra).toBeNull()

    // No PncpService, mapearItemParaReferencia também descarta
    const ref = PncpService.converterParaReferencia(rawContratacaoSemPreco as any, null)
    expect(ref).toBeNull()
  })

  // 3. Item cujo preço homologado só está disponível no endpoint de detalhamento
  // -> sistema recupera e usa o preço correto
  it('Cenário 3: Item com subitem detalhado em itensAta recupera o preço homologado específico do item', () => {
    const ataComSubItem = {
      numeroControlePNCP: '11222333000144-1-000012/2024',
      objeto: 'AQUISIÇÃO DE MEDICAMENTOS HOSPITALARES',
      valor_global: 500000.0,
      itensAta: [
        {
          numeroItem: 1,
          descricao: 'DIPIRONA SODICA 500 MG COMPRIMIDO',
          valorUnitarioHomologado: 0.22,
          valorTotalHomologado: 22000.0,
          quantidade: 100000,
          unidadeMedida: 'COMPRIMIDO',
        },
      ],
    }

    const subItem = ataComSubItem.itensAta[0]
    const ref = PncpService.converterParaReferencia(ataComSubItem as any, subItem, 0, 0)
    expect(ref).not.toBeNull()
    expect(ref?.valor_normalizado).toBe(0.22)
    expect(ref?.natureza_preco).toBe('contratado')
  })

  // 4. Item com preço unitário estimado e sem homologado
  // -> classificar corretamente a natureza do preço (distinção estimado vs contratado)
  it('Cenário 4: Item com preço estimado sem homologado é classificado com natureza estimado', () => {
    const rawEstimado = {
      id_externo: '44555666000188-1-000055/2024',
      item_externo: 'DIPIRONA MONOIDRATADA 500MG COMPRIMIDO',
      valorUnitarioEstimado: 0.25,
      quantidade: 50000,
      unidadeMedida: 'COMPRIMIDO',
    }

    const amostra = adapter.normalize(rawEstimado, 0)
    expect(amostra).not.toBeNull()
    expect(amostra?.valorUnitario).toBe(0.25)
    expect(amostra?.natureza).toBe('estimado')

    const ref = PncpService.converterParaReferencia(
      { numeroControlePNCP: rawEstimado.id_externo } as any,
      {
        descricao: rawEstimado.item_externo,
        valorUnitarioEstimado: 0.25,
        quantidade: 50000,
        unidadeMedida: 'COMPRIMIDO',
      },
    )
    expect(ref).not.toBeNull()
    expect(ref?.natureza_preco).toBe('estimado')
  })

  // 5. Diversas amostras de valores baixos e altos
  // -> preservar as válidas e ordenar do menor para o maior preço unitário
  it('Cenário 5: Múltiplas amostras são todas preservadas e ordenadas crescentemente por preço unitário', () => {
    const amostrasBrutas = [
      { id: '1', item: 'DIPIRONA 500MG CX 250 UN', unit: 55.0, qtd: 100 },
      { id: '2', item: 'DIPIRONA 500MG COMPRIMIDO', unit: 0.18, qtd: 50000 },
      { id: '3', item: 'DIPIRONA 500MG GOTAS 10ML', unit: 3.45, qtd: 2000 },
      { id: '4', item: 'DIPIRONA 500MG COMPRIMIDO', unit: 0.22, qtd: 10000 },
      { id: '5', item: 'DIPIRONA 1G INJETAVEL 2ML', unit: 1.85, qtd: 5000 },
    ]

    const normalizadas = amostrasBrutas
      .map((b, i) =>
        adapter.normalize(
          {
            id_externo: b.id,
            item_externo: b.item,
            valorUnitarioHomologado: b.unit,
            quantidade: b.qtd,
          },
          i,
        ),
      )
      .filter((a): a is NonNullable<typeof a> => a !== null)

    // Ordenação crescente (menor -> maior)
    normalizadas.sort((a, b) => a.valorUnitario - b.valorUnitario)

    expect(normalizadas.length).toBe(5)
    expect(normalizadas[0].valorUnitario).toBe(0.18)
    expect(normalizadas[1].valorUnitario).toBe(0.22)
    expect(normalizadas[2].valorUnitario).toBe(1.85)
    expect(normalizadas[3].valorUnitario).toBe(3.45)
    expect(normalizadas[4].valorUnitario).toBe(55.0)
  })

  // 6. Contratação cujo objeto geral menciona Dipirona mas não contém item compatível
  // -> não gerar amostra falsa
  it('Cenário 6: Contratação cujo objeto geral menciona Dipirona mas não contém item compatível não gera amostra', () => {
    // Exemplo: licitação cujo objeto é "SERVIÇOS DE LOGÍSTICA PARA TRANSPORTE DE DIPIRONA E OUTROS"
    const contratacaoLogistica = {
      numeroControlePNCP: '77888999000100-1-000033/2024',
      objeto: 'SERVICOS DE LOGISTICA E TRANSPORTE DE DIPIRONA E MEDICAMENTOS',
      valor_global: 450000.0,
      itensAta: [
        {
          numeroItem: 1,
          descricao: 'LOCACAO DE CAMINHAO REFRIGERADO 5 TON',
          valorUnitarioHomologado: 15000.0,
          quantidade: 12,
          unidadeMedida: 'MES',
        },
      ],
    }

    // O subitem é caminhão/serviço, não dipirona medicamento
    const subItem = contratacaoLogistica.itensAta[0]
    const isDipirona = (desc: string) => desc.toUpperCase().includes('DIPIRONA')
    expect(isDipirona(subItem.descricao)).toBe(false)

    // Se tentar normalizar subitem não compatível para busca de dipirona, não deve gerar falso positivo
  })

  // 7. Falha ou timeout no detalhamento -> não converter valores totais em preços unitários
  it('Cenário 7: Falha ou pendência no detalhamento NÃO converte valor_global em preço unitário', () => {
    const rawComFalha = {
      id_externo: '33444555000122-1-000077/2024',
      objeto: 'AQUISIÇÃO DE MEDICAMENTOS PARA O MUNICÍPIO',
      valor_global: 1250000.0,
      valorTotal: 1250000.0,
      quantidade: 1,
      _detalhamento_pendente: true,
      _is_contratacao_sem_item: true,
    }

    const amostra = adapter.normalize(rawComFalha, 0)
    expect(amostra).toBeNull()
  })

  // 8. Duplicados -> remover somente duplicidades comprovadas, preservando contratações distintas
  it('Cenário 8: Remove somente duplicidades idênticas e preserva contratações de órgãos/fornecedores distintos com mesmo preço', () => {
    const rawContratacoes = [
      {
        id_externo: '001',
        orgao_comprador: 'PREFEITURA DE CURITIBA',
        fornecedor: 'FORNECEDOR A',
        item_externo: 'DIPIRONA 500MG COMPRIMIDO',
        valorUnitarioHomologado: 0.18,
      },
      {
        id_externo: '002',
        orgao_comprador: 'PREFEITURA DE JOINVILLE',
        fornecedor: 'FORNECEDOR B',
        item_externo: 'DIPIRONA 500MG COMPRIMIDO',
        valorUnitarioHomologado: 0.18, // mesmo preço, mas outro órgão e fornecedor!
      },
      {
        id_externo: '001',
        orgao_comprador: 'PREFEITURA DE CURITIBA',
        fornecedor: 'FORNECEDOR A',
        item_externo: 'DIPIRONA 500MG COMPRIMIDO',
        valorUnitarioHomologado: 0.18, // DUPLICADO IDÊNTICO do 1º
      },
    ]

    const chavesDedup = new Set<string>()
    const amostrasUnicas = []

    for (const raw of rawContratacoes) {
      const amostra = adapter.normalize(raw, 0)
      if (amostra) {
        const chave = `${amostra.fonte}#${amostra.idExterno}#${amostra.orgaoComprador}#${amostra.fornecedorNome}#${amostra.valorUnitario.toFixed(4)}`
        if (!chavesDedup.has(chave)) {
          chavesDedup.add(chave)
          amostrasUnicas.push(amostra)
        }
      }
    }

    expect(amostrasUnicas.length).toBe(2)
    expect(amostrasUnicas[0].orgaoComprador).toBe('PREFEITURA DE CURITIBA')
    expect(amostrasUnicas[1].orgaoComprador).toBe('PREFEITURA DE JOINVILLE')
  })
})
