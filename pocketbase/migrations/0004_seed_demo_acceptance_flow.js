migrate(
  (app) => {
    try {
      const org1 = app.findFirstRecordByData('organizacoes', 'cnpj', '11.222.333/0001-44')
      const adminUser = app.findFirstRecordByData('users', 'email', 'admin@nucleodeprecos.gov.br')

      // 1. Demanda para Dipirona 500 mg
      const demandasCol = app.findCollectionByNameOrId('demandas')
      const itensCol = app.findCollectionByNameOrId('demanda_itens')
      const pesquisasCol = app.findCollectionByNameOrId('pesquisas')
      const referenciasCol = app.findCollectionByNameOrId('referencias')

      let demandaDip
      try {
        demandaDip = app.findFirstRecordByData('demandas', 'numero', 'DEM-2026-DIP500')
      } catch (_) {
        demandaDip = new Record(demandasCol)
        demandaDip.set('organizacao_id', org1.id)
        demandaDip.set('numero', 'DEM-2026-DIP500')
        demandaDip.set('versao', 1)
        demandaDip.set('origem_recursos', 'recursos_proprios')
        demandaDip.set(
          'objeto',
          'Aquisição de Dipirona Sódica 500 mg comprimido para a Rede de Atenção Básica de Saúde',
        )
        demandaDip.set('status', 'em_pesquisa')
        demandaDip.set('responsavel_id', adminUser.id)
        app.save(demandaDip)
      }

      let itemDip
      try {
        itemDip = app.findFirstRecordByData(
          'demanda_itens',
          'descricao',
          'Dipirona Sódica 500 mg comprimido simples',
        )
      } catch (_) {
        itemDip = new Record(itensCol)
        itemDip.set('demanda_id', demandaDip.id)
        itemDip.set('descricao', 'Dipirona Sódica 500 mg comprimido simples')
        itemDip.set('quantidade', 50000)
        itemDip.set('unidade', 'comprimido')
        itemDip.set('versao', 1)
        itemDip.set('confirmado', true)
        itemDip.set('principio_ativo', 'Dipirona Sódica')
        itemDip.set('concentracao', '500 mg')
        itemDip.set('forma_farmaceutica', 'Comprimido')
        itemDip.set('apresentacao', '500 mg comprimido simples')
        itemDip.set('codigo_catmat', 'CATMAT 269412')
        itemDip.set('codigo_bps', 'BPS-9901421')
        app.save(itemDip)
      }

      let pesqDip
      try {
        pesqDip = app.findFirstRecordByData('pesquisas', 'numero', 'PESQ-DIP-2026/01')
      } catch (_) {
        pesqDip = new Record(pesquisasCol)
        pesqDip.set('demanda_item_id', itemDip.id)
        pesqDip.set('numero', 'PESQ-DIP-2026/01')
        pesqDip.set('status', 'aguardando_revisao')
        pesqDip.set('versao', 1)
        pesqDip.set('responsavel_id', adminUser.id)
        app.save(pesqDip)
      }

      // 2. Preços Seed com Rastreabilidade para Dipirona (BPS, PNCP, Compras.gov, BEC-SP, Fornecedor e CMED)
      const refsParaInserir = [
        {
          pesquisa_id: pesqDip.id,
          fonte: 'bps',
          id_externo: 'BPS-COMPRA-2025-449102',
          item_externo: 'Dipirona Sódica 500 mg comprimido simples (Caixa c/ 500 unidades)',
          natureza_preco: 'contratado',
          valor_original: 0.38,
          valor_normalizado: 0.38,
          unidade: 'comprimido',
          quantidade: 50000,
          data_contratacao: '2025-11-20 10:00:00.000Z',
          fornecedor: 'Prati-Donaduzzi & Cia Ltda',
          cnpj_fornecedor: '73.856.507/0001-25',
          orgao_comprador: 'Secretaria Municipal de Saúde de Campinas',
          municipio_uf: 'Campinas - SP',
          modalidade_licitacao: 'Pregão Eletrônico (SRP)',
          processo_origem: 'PE 112/2025-SMS',
          marca_modelo: 'Prati Donaduzzi / Genérico',
          codigo_catalogo: 'CATMAT 269412',
          url: 'https://bps.saude.gov.br/consultas/contrato/449102',
          hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
          status_revisao: 'aceito',
          source_identifier: 'BPS-REG-2025-449102',
          confidence_score: 98,
          similarity_score: 96,
        },
        {
          pesquisa_id: pesqDip.id,
          fonte: 'pncp',
          id_externo: 'PNCP-CONTRATO-2025-882194',
          item_externo: 'DIPIRONA SODICA 500MG COMPRIMIDO',
          natureza_preco: 'contratado',
          valor_original: 0.4,
          valor_normalizado: 0.4,
          unidade: 'comprimido',
          quantidade: 20000,
          data_contratacao: '2025-12-10 14:30:00.000Z',
          fornecedor: 'Medquímica Indústria Farmacêutica S.A.',
          cnpj_fornecedor: '17.870.172/0001-04',
          orgao_comprador: 'Prefeitura Municipal de Ribeirão Preto',
          municipio_uf: 'Ribeirão Preto - SP',
          modalidade_licitacao: 'Pregão Eletrônico',
          processo_origem: 'PROC-2025/0987',
          marca_modelo: 'Medquímica Genérico',
          codigo_catalogo: 'CATMAT 269412',
          url: 'https://pncp.gov.br/app/contratos/17870172000104/2025/882194',
          hash: 'b2c3d4e5f6a17890123456789abcdef0123456789abcdef0123456789abcdef1',
          status_revisao: 'aceito',
          source_identifier: 'PNCP-ATA-2025-882194',
          confidence_score: 95,
          similarity_score: 95,
        },
        {
          pesquisa_id: pesqDip.id,
          fonte: 'compras_gov',
          id_externo: 'COMPRAS-PE-90145/2025-IT04',
          item_externo: 'Medicamento Dipirona 500 mg, apresentação comprimido',
          natureza_preco: 'homologado',
          valor_original: 0.41,
          valor_normalizado: 0.41,
          unidade: 'un',
          quantidade: 35000,
          data_contratacao: '2025-10-15 09:00:00.000Z',
          fornecedor: 'União Química Farmacêutica Nacional S.A.',
          cnpj_fornecedor: '60.665.981/0001-18',
          orgao_comprador: 'Hospital das Forças Armadas - Ministério da Defesa',
          municipio_uf: 'Brasília - DF',
          modalidade_licitacao: 'Pregão Eletrônico',
          processo_origem: 'PE 90145/2025-HFA',
          marca_modelo: 'União Química',
          codigo_catalogo: 'CATMAT 269412',
          url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90145-2025-4',
          hash: 'c3d4e5f6a1b27890123456789abcdef0123456789abcdef0123456789abcdef2',
          status_revisao: 'aceito',
          source_identifier: 'COMPRAS-90145-4',
          confidence_score: 94,
          similarity_score: 93,
        },
        {
          pesquisa_id: pesqDip.id,
          fonte: 'bec_sp',
          id_externo: 'BEC-OC-2025-11094',
          item_externo: 'Dipirona 500 mg comp (dispensa eletrônica estadual)',
          natureza_preco: 'contratado',
          valor_original: 0.42,
          valor_normalizado: 0.42,
          unidade: 'comprimido',
          quantidade: 15000,
          data_contratacao: '2026-01-18 16:00:00.000Z',
          fornecedor: 'Distribuidora Medicar Paulista Ltda',
          cnpj_fornecedor: '04.221.998/0001-44',
          orgao_comprador: 'Secretaria de Estado da Saúde de São Paulo',
          municipio_uf: 'São Paulo - SP',
          modalidade_licitacao: 'Dispensa Eletrônica',
          processo_origem: 'DISP-SES-2026/012',
          marca_modelo: 'EMS Genérico',
          codigo_catalogo: 'CATMAT 269412',
          url: 'https://www.bec.sp.gov.br/bec_pregao_ui/contrato/11094',
          hash: 'd4e5f6a1b2c37890123456789abcdef0123456789abcdef0123456789abcdef3',
          status_revisao: 'aceito',
          source_identifier: 'BEC-OC-11094',
          confidence_score: 92,
          similarity_score: 91,
        },
        {
          pesquisa_id: pesqDip.id,
          fonte: 'cmed',
          id_externo: 'CMED-REG-2026-DIP500',
          item_externo:
            'CMED TABELA REGULATÓRIA — DIPIRONA SÓDICA 500MG COMPRIMIDO (TETO DE PREÇO)',
          natureza_preco: 'regulatorio_tabela',
          valor_original: 0.58,
          valor_normalizado: 0.42,
          unidade: 'comprimido',
          quantidade: 1,
          data_contratacao: '2026-02-01 00:00:00.000Z',
          fornecedor: 'ANVISA / Câmara de Regulação do Mercado de Medicamentos',
          cnpj_fornecedor: '00.394.544/0001-85',
          orgao_comprador: 'Órgão Regulador Federal (ANVISA/CMED)',
          municipio_uf: 'Brasília - DF',
          modalidade_licitacao: 'Tabela Regulamentar Oficial',
          processo_origem: 'Resolução CMED 2026/01',
          marca_modelo: 'Referência Teto Regulatório PF/PMC',
          codigo_catalogo: 'CATMAT 269412',
          url: 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/lista-conformidade-2026.pdf',
          hash: 'f6a1b2c3d4e57890123456789abcdef0123456789abcdef0123456789abcdef5',
          status_revisao: 'pendente',
          source_identifier: 'CMED-REG-2026',
          confidence_score: 100,
          similarity_score: 100,
        },
      ]

      for (let i = 0; i < refsParaInserir.length; i++) {
        const r = refsParaInserir[i]
        try {
          app.findFirstRecordByData('referencias', 'id_externo', r.id_externo)
        } catch (_) {
          const refRec = new Record(referenciasCol)
          Object.keys(r).forEach((k) => refRec.set(k, r[k]))
          app.save(refRec)
        }
      }
    } catch (e) {
      console.warn('Erro ao popular dados de demonstração da Dipirona:', e)
    }
  },
  (app) => {},
)
