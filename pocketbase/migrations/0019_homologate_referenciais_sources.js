migrate(
  (app) => {
    // Homologação e ativação das 6 fontes referenciais públicas atendidas pelo pipeline do backend:
    // CMED (ANVISA), SINAPI (CAIXA/IBGE), SICRO (DNIT), CONAB (Abastecimento), SEINFRA (Ceará) e SETOP (Minas Gerais)
    const codigos = ['cmed', 'sinapi', 'sicro', 'conab', 'seinfra_ce', 'setop_mg']

    for (let i = 0; i < codigos.length; i++) {
      const cod = codigos[i]
      try {
        const record = app.findFirstRecordByData('fontes_catalogo', 'codigo', cod)
        record.set('runtime_enabled', true)
        record.set('status', 'ativo')
        if (cod === 'cmed') {
          record.set(
            'observacoes',
            'HOMOLOGADO REAL (v3.0): Teto Regulatório PF / PMC ANVISA (Preço Fábrica e Consumidor). ATENÇÃO: CMED é parâmetro regulatório teto, não contratação similar.',
          )
        } else if (cod === 'sinapi') {
          record.set(
            'observacoes',
            'HOMOLOGADO REAL (v1.2): Tabela Oficial de Custos da Construção Civil CAIXA/IBGE (Lei 14.133/2021, art. 23 §2º). Insumos e composições com e sem desoneração.',
          )
        } else if (cod === 'sicro') {
          record.set(
            'observacoes',
            'HOMOLOGADO REAL (v1.1): Sistema de Custos Rodoviários DNIT. Composições, equipamentos e insumos de infraestrutura de transportes.',
          )
        } else if (cod === 'conab') {
          record.set(
            'observacoes',
            'HOMOLOGADO REAL (v1.1): Boletim de Preços Agropecuários e Hortifrúti CONAB / CEASA. Preços médios, mínimos e máximos praticados no atacado.',
          )
        } else if (cod === 'seinfra_ce') {
          record.set(
            'observacoes',
            'HOMOLOGADO REAL (v1.1): Tabela Oficial de Custos de Obras e Serviços de Engenharia do Estado do Ceará (SEINFRA/CE).',
          )
        } else if (cod === 'setop_mg') {
          record.set(
            'observacoes',
            'HOMOLOGADO REAL (v1.1): Planilha Oficial de Custos de Obras Públicas de Minas Gerais (SETOP / SEINFRA-MG).',
          )
        }
        app.save(record)
      } catch (_) {
        // Ignora caso registro não exista
      }
    }
  },
  (app) => {
    const codigos = ['cmed', 'sinapi', 'sicro', 'conab', 'seinfra_ce', 'setop_mg']
    for (let i = 0; i < codigos.length; i++) {
      const cod = codigos[i]
      try {
        const record = app.findFirstRecordByData('fontes_catalogo', 'codigo', cod)
        record.set('runtime_enabled', false)
        record.set('status', 'em_homologacao')
        app.save(record)
      } catch (_) {}
    }
  },
)
