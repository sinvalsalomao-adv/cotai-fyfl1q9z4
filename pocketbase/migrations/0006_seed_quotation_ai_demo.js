migrate(
  (app) => {
    try {
      const org1 = app.findFirstRecordByData('organizacoes', 'cnpj', '11.222.333/0001-44')
      const adminUser = app.findFirstRecordByData(
        'users',
        'email',
        'matheusflotencio137482@gmail.com',
      )
      const quotationsCol = app.findCollectionByNameOrId('quotations')
      const quotationItemsCol = app.findCollectionByNameOrId('quotation_items')
      const quotationPricesCol = app.findCollectionByNameOrId('quotation_price_records')
      const quotationVersionsCol = app.findCollectionByNameOrId('quotation_versions')

      // Verificar se cotação demo já existe
      try {
        app.findFirstRecordByData('quotations', 'numero', 'COT-IA-2026/001')
        return // Já seeded
      } catch (_) {}

      // 1. Cria Cotação Demo Multitens: Medicamentos e Suprimentos
      const quotation = new Record(quotationsCol)
      quotation.set('tenant_id', org1.id)
      quotation.set('numero', 'COT-IA-2026/001')
      quotation.set(
        'titulo',
        'Cotação com IA — Aquisição de Medicamentos e Insumos da Atenção Básica',
      )
      quotation.set('status', 'concluida')
      quotation.set('responsavel_id', adminUser.id)
      quotation.set('versao_atual', 1)
      quotation.set('total_itens', 3)
      quotation.set('itens_concluidos', 3)
      quotation.set('itens_revisao', 0)
      quotation.set('itens_sem_resultados', 0)
      quotation.set('valor_total_estimado', 38220.0)
      quotation.set('configuracao_execucao', {
        modo: 'automatico',
        periodo_meses: 12,
        quantidade_minima: 3,
        metodo_padrao: 'mediana',
        fontes: ['bps', 'pncp', 'compras_gov', 'cmed', 'bec_sp'],
        deduplicacao: true,
        normalizacao: true,
      })
      quotation.set('metrica_estagios', {
        encontrados: 15,
        compativeis: 13,
        normalizados: 11,
        validos: 11,
        selecionados: 9,
      })
      app.save(quotation)

      // 2. Item 1: Dipirona Sódica 500 mg comprimido
      const item1 = new Record(quotationItemsCol)
      item1.set('tenant_id', org1.id)
      item1.set('quotation_id', quotation.id)
      item1.set('numero_item', 1)
      item1.set('codigo_interno', 'MED-DIP-500')
      item1.set('descricao_original', 'Dipirona 500 mg comprimido')
      item1.set('descricao_normalizada', 'DIPIRONA SÓDICA 500 MG, COMPRIMIDO SIMPLES')
      item1.set('quantidade', 50000)
      item1.set('unidade', 'comprimido')
      item1.set('unidade_normalizada', 'un')
      item1.set('principio_ativo', 'Dipirona Sódica')
      item1.set('concentracao', '500 mg')
      item1.set('forma_farmaceutica', 'Comprimido')
      item1.set('apresentacao', '500 mg comprimido simples')
      item1.set('codigo_catalogo', 'CATMAT 269412')
      item1.set('tipo_catalogo', 'CATMAT')
      item1.set('confidence_score', 98)
      item1.set('status', 'concluido')
      item1.set('mensagem_status', 'Pesquisa e consolidação concluídas com alta correspondência.')
      item1.set('qtd_encontrados', 5)
      item1.set('qtd_compativeis', 5)
      item1.set('qtd_normalizados', 5)
      item1.set('qtd_validos', 4)
      item1.set('qtd_selecionados', 4)
      item1.set('qtd_outliers', 0)
      item1.set('preco_minimo', 0.38)
      item1.set('preco_media', 0.4025)
      item1.set('preco_mediana', 0.405)
      item1.set('preco_media_ponderada', 0.398)
      item1.set('preco_referencia', 0.405)
      item1.set('valor_total_item', 20250.0)
      item1.set('metodo_sugerido', 'mediana')
      item1.set(
        'motivo_sugestao_metodo',
        'Mediana recomendada devido a pequenas assimetrias entre cotações federais e municipais.',
      )
      item1.set('metodo_adotado', 'mediana')
      item1.set('analise_inteligente', {
        item_identificado: 'DIPIRONA SÓDICA 500 MG, COMPRIMIDO SIMPLES',
        correspondencia_pct: 98,
        codigo_encontrado: 'CATMAT 269412',
        fontes_consultadas: ['bps', 'pncp', 'compras_gov', 'bec_sp', 'cmed'],
        explicacao:
          'Considerado altamente compatível pois apresenta idêntico princípio ativo, dosagem e forma farmacêutica.',
        referencia_regulatoria: {
          fonte: 'cmed',
          pmc_teto: 0.58,
          pf_teto: 0.42,
          aviso:
            'Preço regulatório CMED exibido como teto referencial e não integrado à contratação.',
        },
      })
      app.save(item1)

      // Preços do Item 1 (Dipirona)
      const precosDip = [
        {
          fonte: 'bps',
          source_identifier: 'BPS-COMPRA-2025-449102',
          source_record_id: '449102',
          source_url: 'https://bps.saude.gov.br/consultas/contrato/449102',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'Dipirona Sódica 500 mg comprimido simples (Caixa c/ 500 unidades)',
          normalized_description: 'DIPIRONA SÓDICA 500 MG, COMPRIMIDO SIMPLES',
          catalog_code: 'CATMAT 269412',
          unit: 'comprimido',
          normalized_unit: 'un',
          quantity: 50000,
          unit_price: 0.38,
          normalized_unit_price: 0.38,
          total_price: 19000.0,
          supplier: 'Prati-Donaduzzi & Cia Ltda',
          supplier_cnpj: '73.856.507/0001-25',
          orgao_comprador: 'Secretaria Municipal de Saúde de Campinas',
          municipio: 'Campinas',
          uf: 'SP',
          modalidade: 'Pregão Eletrônico (SRP)',
          numero_processo: 'PE 112/2025-SMS',
          purchase_date: '2025-11-20 10:00:00.000Z',
          natureza_preco: 'contratado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 98,
          similarity_score: 96,
          faixa_similaridade: 'ALTA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
        {
          fonte: 'pncp',
          source_identifier: 'PNCP-CONTRATO-2025-882194',
          source_record_id: '882194',
          source_url: 'https://pncp.gov.br/app/contratos/17870172000104/2025/882194',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'DIPIRONA SODICA 500MG COMPRIMIDO',
          normalized_description: 'DIPIRONA SÓDICA 500 MG, COMPRIMIDO SIMPLES',
          catalog_code: 'CATMAT 269412',
          unit: 'comprimido',
          normalized_unit: 'un',
          quantity: 20000,
          unit_price: 0.4,
          normalized_unit_price: 0.4,
          total_price: 8000.0,
          supplier: 'Medquímica Indústria Farmacêutica S.A.',
          supplier_cnpj: '17.870.172/0001-04',
          orgao_comprador: 'Prefeitura Municipal de Ribeirão Preto',
          municipio: 'Ribeirão Preto',
          uf: 'SP',
          modalidade: 'Pregão Eletrônico',
          numero_processo: 'PROC-2025/0987',
          purchase_date: '2025-12-10 14:30:00.000Z',
          natureza_preco: 'contratado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 95,
          similarity_score: 95,
          faixa_similaridade: 'ALTA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
        {
          fonte: 'compras_gov',
          source_identifier: 'COMPRAS-PE-90145/2025-IT04',
          source_record_id: '90145-2025-4',
          source_url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90145-2025-4',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'Medicamento Dipirona 500 mg, apresentação comprimido',
          normalized_description: 'DIPIRONA SÓDICA 500 MG, COMPRIMIDO SIMPLES',
          catalog_code: 'CATMAT 269412',
          unit: 'un',
          normalized_unit: 'un',
          quantity: 35000,
          unit_price: 0.41,
          normalized_unit_price: 0.41,
          total_price: 14350.0,
          supplier: 'União Química Farmacêutica Nacional S.A.',
          supplier_cnpj: '60.665.981/0001-18',
          orgao_comprador: 'Hospital das Forças Armadas - Ministério da Defesa',
          municipio: 'Brasília',
          uf: 'DF',
          modalidade: 'Pregão Eletrônico',
          numero_processo: 'PE 90145/2025-HFA',
          purchase_date: '2025-10-15 09:00:00.000Z',
          natureza_preco: 'homologado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 94,
          similarity_score: 93,
          faixa_similaridade: 'BOA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
        {
          fonte: 'bec_sp',
          source_identifier: 'BEC-OC-2025-11094',
          source_record_id: '11094',
          source_url: 'https://www.bec.sp.gov.br/bec_pregao_ui/contrato/11094',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'Dipirona 500 mg comp (dispensa eletrônica estadual)',
          normalized_description: 'DIPIRONA SÓDICA 500 MG, COMPRIMIDO SIMPLES',
          catalog_code: 'CATMAT 269412',
          unit: 'comprimido',
          normalized_unit: 'un',
          quantity: 15000,
          unit_price: 0.42,
          normalized_unit_price: 0.42,
          total_price: 6300.0,
          supplier: 'Distribuidora Medicar Paulista Ltda',
          supplier_cnpj: '04.221.998/0001-44',
          orgao_comprador: 'Secretaria de Estado da Saúde de São Paulo',
          municipio: 'São Paulo',
          uf: 'SP',
          modalidade: 'Dispensa Eletrônica',
          numero_processo: 'DISP-SES-2026/012',
          purchase_date: '2026-01-18 16:00:00.000Z',
          natureza_preco: 'contratado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 92,
          similarity_score: 91,
          faixa_similaridade: 'BOA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
        {
          fonte: 'cmed',
          source_identifier: 'CMED-REG-2026-DIP500',
          source_record_id: 'CMED-DIP-500',
          source_url:
            'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/lista-conformidade-2026.pdf',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description:
            'CMED TABELA REGULATÓRIA — DIPIRONA SÓDICA 500MG COMPRIMIDO (TETO DE PREÇO)',
          normalized_description: 'DIPIRONA SÓDICA 500 MG, COMPRIMIDO SIMPLES',
          catalog_code: 'CATMAT 269412',
          unit: 'comprimido',
          normalized_unit: 'un',
          quantity: 1,
          unit_price: 0.58,
          normalized_unit_price: 0.42,
          total_price: 0.42,
          supplier: 'ANVISA / Câmara de Regulação do Mercado de Medicamentos',
          supplier_cnpj: '00.394.544/0001-85',
          orgao_comprador: 'Órgão Regulador Federal (ANVISA/CMED)',
          municipio: 'Brasília',
          uf: 'DF',
          modalidade: 'Tabela Regulamentar Oficial',
          numero_processo: 'Resolução CMED 2026/01',
          purchase_date: '2026-02-01 00:00:00.000Z',
          natureza_preco: 'regulatorio_tabela',
          is_regulatorio: true,
          estagio: 'compativel',
          confidence_score: 100,
          similarity_score: 100,
          faixa_similaridade: 'ALTA',
          is_outlier: false,
          decisao_humana: 'pendente',
        },
      ]

      for (const p of precosDip) {
        const prec = new Record(quotationPricesCol)
        prec.set('tenant_id', org1.id)
        prec.set('quotation_id', quotation.id)
        prec.set('quotation_item_id', item1.id)
        Object.keys(p).forEach((k) => prec.set(k, p[k]))
        app.save(prec)
      }

      // 3. Item 2: Paracetamol 750 mg
      const item2 = new Record(quotationItemsCol)
      item2.set('tenant_id', org1.id)
      item2.set('quotation_id', quotation.id)
      item2.set('numero_item', 2)
      item2.set('codigo_interno', 'MED-PAR-750')
      item2.set('descricao_original', 'Paracetamol 750 mg')
      item2.set('descricao_normalizada', 'PARACETAMOL 750 MG, COMPRIMIDO')
      item2.set('quantidade', 30000)
      item2.set('unidade', 'comprimido')
      item2.set('unidade_normalizada', 'un')
      item2.set('principio_ativo', 'Paracetamol')
      item2.set('concentracao', '750 mg')
      item2.set('forma_farmaceutica', 'Comprimido')
      item2.set('apresentacao', '750 mg comprimido')
      item2.set('codigo_catalogo', 'CATMAT 271501')
      item2.set('tipo_catalogo', 'CATMAT')
      item2.set('confidence_score', 96)
      item2.set('status', 'concluido')
      item2.set('mensagem_status', 'Pesquisa e consolidação concluídas.')
      item2.set('qtd_encontrados', 3)
      item2.set('qtd_compativeis', 3)
      item2.set('qtd_normalizados', 3)
      item2.set('qtd_validos', 3)
      item2.set('qtd_selecionados', 3)
      item2.set('qtd_outliers', 0)
      item2.set('preco_minimo', 0.35)
      item2.set('preco_media', 0.36)
      item2.set('preco_mediana', 0.36)
      item2.set('preco_media_ponderada', 0.359)
      item2.set('preco_referencia', 0.36)
      item2.set('valor_total_item', 10800.0)
      item2.set('metodo_sugerido', 'media')
      item2.set('motivo_sugestao_metodo', 'Dispersão extremamente baixa (CV = 2.8%).')
      item2.set('metodo_adotado', 'mediana')
      app.save(item2)

      const precosPar = [
        {
          fonte: 'bps',
          source_identifier: 'BPS-COMPRA-2025-331200',
          source_record_id: '331200',
          source_url: 'https://bps.saude.gov.br/consultas/contrato/331200',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'Paracetamol 750 mg comprimido',
          normalized_description: 'PARACETAMOL 750 MG, COMPRIMIDO',
          catalog_code: 'CATMAT 271501',
          unit: 'comprimido',
          normalized_unit: 'un',
          quantity: 30000,
          unit_price: 0.35,
          normalized_unit_price: 0.35,
          total_price: 10500.0,
          supplier: 'EMS S.A.',
          supplier_cnpj: '57.507.378/0003-65',
          orgao_comprador: 'Prefeitura Municipal de Santos',
          municipio: 'Santos',
          uf: 'SP',
          modalidade: 'Pregão Eletrônico',
          numero_processo: 'PE 45/2025',
          purchase_date: '2025-11-05 10:00:00.000Z',
          natureza_preco: 'contratado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 96,
          similarity_score: 95,
          faixa_similaridade: 'ALTA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
        {
          fonte: 'pncp',
          source_identifier: 'PNCP-CONTRATO-2025-776100',
          source_record_id: '776100',
          source_url: 'https://pncp.gov.br/app/contratos/cimed-paracetamol-750',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'PARACETAMOL 750MG COMPRIMIDO BLISTER',
          normalized_description: 'PARACETAMOL 750 MG, COMPRIMIDO',
          catalog_code: 'CATMAT 271501',
          unit: 'comprimido',
          normalized_unit: 'un',
          quantity: 40000,
          unit_price: 0.36,
          normalized_unit_price: 0.36,
          total_price: 14400.0,
          supplier: 'Cimed Indústria de Medicamentos Ltda',
          supplier_cnpj: '02.814.497/0007-00',
          orgao_comprador: 'Prefeitura de Belo Horizonte',
          municipio: 'Belo Horizonte',
          uf: 'MG',
          modalidade: 'Pregão Eletrônico',
          numero_processo: 'PE 88/2025-SMS',
          purchase_date: '2025-12-01 15:00:00.000Z',
          natureza_preco: 'contratado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 95,
          similarity_score: 94,
          faixa_similaridade: 'ALTA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
        {
          fonte: 'compras_gov',
          source_identifier: 'COMPRAS-PE-90210/2025-IT01',
          source_record_id: '90210-2025-1',
          source_url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90210-2025-1',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'Paracetamol 750mg comprimido',
          normalized_description: 'PARACETAMOL 750 MG, COMPRIMIDO',
          catalog_code: 'CATMAT 271501',
          unit: 'un',
          normalized_unit: 'un',
          quantity: 25000,
          unit_price: 0.37,
          normalized_unit_price: 0.37,
          total_price: 9250.0,
          supplier: 'Geolab Indústria Farmacêutica S.A.',
          supplier_cnpj: '03.485.572/0001-04',
          orgao_comprador: 'Comando do Exército - 2ª Região Militar',
          municipio: 'São Paulo',
          uf: 'SP',
          modalidade: 'Pregão Eletrônico',
          numero_processo: 'PE 90210/2025',
          purchase_date: '2025-10-22 09:30:00.000Z',
          natureza_preco: 'homologado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 93,
          similarity_score: 93,
          faixa_similaridade: 'BOA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
      ]

      for (const p of precosPar) {
        const prec = new Record(quotationPricesCol)
        prec.set('tenant_id', org1.id)
        prec.set('quotation_id', quotation.id)
        prec.set('quotation_item_id', item2.id)
        Object.keys(p).forEach((k) => prec.set(k, p[k]))
        app.save(prec)
      }

      // 4. Item 3: Álcool 70% 1 Litro
      const item3 = new Record(quotationItemsCol)
      item3.set('tenant_id', org1.id)
      item3.set('quotation_id', quotation.id)
      item3.set('numero_item', 3)
      item3.set('codigo_interno', 'SAU-ALC-70')
      item3.set('descricao_original', 'Álcool Etílico 70% 1 Litro')
      item3.set(
        'descricao_normalizada',
        'ÁLCOOL ETÍLICO 70% (P/P OU 77° GL), EM GEL OU LÍQUIDO, FRASCO 1000 ML (1 LITRO)',
      )
      item3.set('quantidade', 1000)
      item3.set('unidade', 'litro')
      item3.set('unidade_normalizada', 'l')
      item3.set('codigo_catalogo', 'CATMAT 318920')
      item3.set('tipo_catalogo', 'CATMAT')
      item3.set('confidence_score', 95)
      item3.set('status', 'concluido')
      item3.set('mensagem_status', 'Pesquisa e consolidação concluídas.')
      item3.set('qtd_encontrados', 3)
      item3.set('qtd_compativeis', 3)
      item3.set('qtd_normalizados', 3)
      item3.set('qtd_validos', 3)
      item3.set('qtd_selecionados', 2)
      item3.set('qtd_outliers', 0)
      item3.set('preco_minimo', 6.8)
      item3.set('preco_media', 6.98)
      item3.set('preco_mediana', 6.95)
      item3.set('preco_media_ponderada', 6.93)
      item3.set('preco_referencia', 7.17)
      item3.set('valor_total_item', 7170.0)
      item3.set('metodo_sugerido', 'media')
      item3.set('motivo_sugestao_metodo', 'Dispersão baixa.')
      item3.set('metodo_adotado', 'mediana')
      app.save(item3)

      const precosAlc = [
        {
          fonte: 'pncp',
          source_identifier: 'PNCP-CONTRATO-2025-992100',
          source_record_id: '992100',
          source_url: 'https://pncp.gov.br/app/contratos/alcool-70-ype',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'Álcool Etílico 70% líquido frasco 1000ml',
          normalized_description: 'ÁLCOOL ETÍLICO 70%, FRASCO 1000 ML',
          catalog_code: 'CATMAT 318920',
          unit: 'litro',
          normalized_unit: 'l',
          quantity: 1200,
          unit_price: 6.8,
          normalized_unit_price: 6.8,
          total_price: 8160.0,
          supplier: 'Química Amparo Ltda (Ypê)',
          supplier_cnpj: '43.465.126/0001-02',
          orgao_comprador: 'Prefeitura Municipal de Curitiba',
          municipio: 'Curitiba',
          uf: 'PR',
          modalidade: 'Pregão Eletrônico',
          numero_processo: 'PE 312/2025',
          purchase_date: '2025-11-18 10:00:00.000Z',
          natureza_preco: 'contratado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 95,
          similarity_score: 94,
          faixa_similaridade: 'ALTA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
        {
          fonte: 'compras_gov',
          source_identifier: 'COMPRAS-PE-90412/2025-IT02',
          source_record_id: '90412-2025-2',
          source_url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90412-2025-2',
          source_capture_date: '2026-03-01 08:00:00.000Z',
          original_description: 'Álcool Etílico 70° GL frasco com 1L',
          normalized_description: 'ÁLCOOL ETÍLICO 70%, FRASCO 1000 ML',
          catalog_code: 'CATMAT 318920',
          unit: 'litro',
          normalized_unit: 'l',
          quantity: 2500,
          unit_price: 6.95,
          normalized_unit_price: 6.95,
          total_price: 17375.0,
          supplier: 'Vic Pharma Indústria e Comércio Ltda',
          supplier_cnpj: '38.804.818/0001-37',
          orgao_comprador: 'Universidade Federal de São Paulo (UNIFESP)',
          municipio: 'São Paulo',
          uf: 'SP',
          modalidade: 'Pregão Eletrônico',
          numero_processo: 'PE 90412/2025',
          purchase_date: '2025-12-05 14:00:00.000Z',
          natureza_preco: 'homologado',
          is_regulatorio: false,
          estagio: 'selecionado',
          confidence_score: 94,
          similarity_score: 93,
          faixa_similaridade: 'BOA',
          is_outlier: false,
          decisao_humana: 'manter',
        },
      ]

      for (const p of precosAlc) {
        const prec = new Record(quotationPricesCol)
        prec.set('tenant_id', org1.id)
        prec.set('quotation_id', quotation.id)
        prec.set('quotation_item_id', item3.id)
        Object.keys(p).forEach((k) => prec.set(k, p[k]))
        app.save(prec)
      }

      // 5. Versão 1 Snapshot
      const versao1 = new Record(quotationVersionsCol)
      versao1.set('tenant_id', org1.id)
      versao1.set('quotation_id', quotation.id)
      versao1.set('numero_versao', 1)
      versao1.set('titulo_versao', 'Cotação IA — Versão 1 (Inicial)')
      versao1.set(
        'motivo_versao',
        'Pesquisa executada automaticamente com conectores governamentais e normalização com IA.',
      )
      versao1.set('total_estimado', 38220.0)
      versao1.set('snapshot_dados', {
        itens_count: 3,
        total_estimado: 38220.0,
        metodo: 'mediana',
        data_execucao: '2026-03-01T08:00:00Z',
      })
      versao1.set('criado_por', adminUser.id)
      app.save(versao1)
    } catch (e) {
      console.warn('Erro ao popular dados de cotação inteligente:', e)
    }
  },
  (app) => {},
)
