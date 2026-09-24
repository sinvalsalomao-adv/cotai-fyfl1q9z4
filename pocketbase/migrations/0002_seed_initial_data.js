migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId('_pb_users_auth_')
    const orgCol = app.findCollectionByNameOrId('organizacoes')
    const perfisCol = app.findCollectionByNameOrId('perfis_normativos')
    const integracoesCol = app.findCollectionByNameOrId('integracoes')
    const demandasCol = app.findCollectionByNameOrId('demandas')
    const demandaItensCol = app.findCollectionByNameOrId('demanda_itens')
    const pesquisasCol = app.findCollectionByNameOrId('pesquisas')
    const referenciasCol = app.findCollectionByNameOrId('referencias')
    const evidenciasCol = app.findCollectionByNameOrId('evidencias')
    const calculosCol = app.findCollectionByNameOrId('calculos')
    const processosCol = app.findCollectionByNameOrId('processos')
    const documentosCol = app.findCollectionByNameOrId('documentos')
    const versoesCol = app.findCollectionByNameOrId('versoes_documento')

    // 1. Seed or update primary admin user
    let adminUser
    try {
      adminUser = app.findAuthRecordByEmail('_pb_users_auth_', 'matheusflotencio137482@gmail.com')
    } catch (_) {
      adminUser = new Record(usersCol)
      adminUser.setEmail('matheusflotencio137482@gmail.com')
      adminUser.setPassword('Skip@Pass')
      adminUser.setVerified(true)
    }
    adminUser.set('name', 'Matheus Flotencio')
    adminUser.set('papel', 'admin')
    app.save(adminUser)

    // Also seed a gestor user for role testing
    let gestorUser
    try {
      gestorUser = app.findAuthRecordByEmail('_pb_users_auth_', 'gestor@exemplo.gov.br')
    } catch (_) {
      gestorUser = new Record(usersCol)
      gestorUser.setEmail('gestor@exemplo.gov.br')
      gestorUser.setPassword('Skip@Pass')
      gestorUser.setVerified(true)
      gestorUser.set('name', 'Ana Silveira - Gestora')
      gestorUser.set('papel', 'gestor')
      app.save(gestorUser)
    }

    // 2. Seed Norm Profiles (Lei 14.133 e IN 65)
    let perfil14133
    try {
      perfil14133 = app.findFirstRecordByData('perfis_normativos', 'norma_id', 'lei_14133')
    } catch (_) {
      perfil14133 = new Record(perfisCol)
      perfil14133.set('nome', 'Lei 14.133/2021 — Bens e Serviços Comuns')
      perfil14133.set('norma_id', 'lei_14133')
      perfil14133.set('vigencia', '2026-12-31 23:59:59.000Z')
      perfil14133.set('metodo_permitido', 'media_ou_mediana')
      perfil14133.set('autoridade_competente', 'Secretário Municipal de Administração')
      perfil14133.set(
        'exigencias',
        JSON.stringify({
          artigo_23:
            'Parâmetros de pesquisa preferenciais: PNCP, compras públicas similares, cotação com fornecedores',
          criterios_descarte:
            'Valores manifestamente inexequíveis ou flagrantemente excessivos desconsiderados com justificativa',
          temporalidade: 'Pesquisas realizadas com antecedência máxima de 1 ano antes do edital',
          deduplicacao:
            'Obrigatória identificação e unificação de contratações idênticas em bases distintas',
        }),
      )
      perfil14133.set(
        'regras_especificas',
        JSON.stringify({
          obras_engenharia_bloqueada: true,
          servicos_dedicacao_exclusiva_bloqueada: true,
          motivo_bloqueio:
            'Obras/engenharia (SINAPI/SICRO) e mão de obra exclusiva exigem planilhas de composição analítica e convenções coletivas; fluxo genérico vedado na v1.',
        }),
      )
      app.save(perfil14133)
    }

    let perfilIn65
    try {
      perfilIn65 = app.findFirstRecordByData('perfis_normativos', 'norma_id', 'in_seges_me_65')
    } catch (_) {
      perfilIn65 = new Record(perfisCol)
      perfilIn65.set('nome', 'IN SEGES/ME nº 65/2021 — Transferências Voluntárias Federais')
      perfilIn65.set('norma_id', 'in_seges_me_65')
      perfilIn65.set('vigencia', '2026-12-31 23:59:59.000Z')
      perfilIn65.set('metodo_permitido', 'mediana')
      perfilIn65.set('autoridade_competente', 'Coordenador-Geral de Convênios')
      perfilIn65.set(
        'exigencias',
        JSON.stringify({
          artigo_6:
            'Mínimo de 3 preços válidos admitindo exceção formalmente justificada e aprovada pela autoridade competente',
          ambito:
            'Aplicável exclusivamente a recursos decorrentes de transferências voluntárias da União (Convênios/Contratos de Repasse)',
          metodologia:
            'Menor valor, média ou mediana com justificativa expressa na memória de cálculo',
        }),
      )
      perfilIn65.set(
        'regras_especificas',
        JSON.stringify({
          obras_engenharia_bloqueada: true,
          limite_minimo_amostra: 3,
          exige_aprovacao_especial_amostra_menor: true,
        }),
      )
      app.save(perfilIn65)
    }

    // 3. Seed Organizations (Duas para testar isolamento de dados)
    let org1
    try {
      org1 = app.findFirstRecordByData('organizacoes', 'cnpj', '11.222.333/0001-44')
    } catch (_) {
      org1 = new Record(orgCol)
      org1.set('nome', 'Prefeitura Municipal de Exemplo (SP)')
      org1.set('cnpj', '11.222.333/0001-44')
      org1.set('municipio_ibge', '3550308 - São Paulo (SP)')
      org1.set('endereco', 'Praça do Município, 100 - Centro, São Paulo - SP')
      org1.set('unidade', 'Secretaria Municipal de Administração e Compras')
      org1.set('responsavel_legal', 'Carlos Eduardo Silveira - Secretário')
      org1.set('responsavel_pesquisa', adminUser.id)
      org1.set('origem_recursos', 'recursos_proprios')
      org1.set('perfil_normativo_id', perfil14133.id)
      app.save(org1)
    }

    let org2
    try {
      org2 = app.findFirstRecordByData('organizacoes', 'cnpj', '44.555.666/0001-77')
    } catch (_) {
      org2 = new Record(orgCol)
      org2.set('nome', 'Consórcio Intermunicipal de Saúde Vale das Pedras (MG)')
      org2.set('cnpj', '44.555.666/0001-77')
      org2.set('municipio_ibge', '3106200 - Belo Horizonte (MG)')
      org2.set('endereco', 'Av. das Flores, 450 - Funcionários, Belo Horizonte - MG')
      org2.set('unidade', 'Setor de Contratos e Licitações')
      org2.set('responsavel_legal', 'Juliana Rezende - Diretora Executiva')
      org2.set('origem_recursos', 'transferencia_voluntaria_federal')
      org2.set('perfil_normativo_id', perfilIn65.id)
      app.save(org2)
    }

    // Bind admin user to Org 1
    adminUser.set('organizacao_id', org1.id)
    app.save(adminUser)

    // 4. Seed Integrations registry (Todas com runtime_enabled=false por spec)
    const integracoesList = [
      {
        nome: 'Compras.gov.br (Catálogo e Preços Praticados)',
        uso: 'Consulta pública de preços homologados e catálogo CATMAT/CATSER',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao:
          'Documentação pública confirmada (Swagger/Manual Dados Abertos). Conector prioritário.',
        secreto_ref: 'COMPRAS_GOV_API_KEY',
        ambiente: 'Homologação/Produção Aberta',
      },
      {
        nome: 'PNCP Consulta (Portal Nacional de Contratações Públicas)',
        uso: 'Descoberta de contratações públicas e atas vigentes em todo o Brasil',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao: 'API pública documentada no Swagger PNCP. Consulta aberta.',
        secreto_ref: 'PNCP_PUBLIC_URL',
        ambiente: 'Produção Pública',
      },
      {
        nome: 'PNCP Detalhes e Itens',
        uso: 'Recuperação detalhada de itens contratados, marcas e termos de adjudicação',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao: 'API pública documentada. Depende do ID da contratação.',
        secreto_ref: 'PNCP_ITEMS_URL',
        ambiente: 'Produção Pública',
      },
      {
        nome: 'PNCP Publicação de Editais e Atas',
        uso: 'Envio e homologação de documentos para publicação oficial',
        documentation_status: 'pendente',
        runtime_enabled: false,
        condicao:
          'Credenciamento e certificado digital ICP-Brasil requeridos pelo Governo Federal.',
        secreto_ref: 'PNCP_CREDENTIAL_CERT',
        ambiente: 'Aguardando credenciamento',
      },
      {
        nome: 'Portal de Compras Públicas (PCP)',
        uso: 'Pesquisa em pregões e cotações realizadas em municípios conveniados',
        documentation_status: 'pendente',
        runtime_enabled: false,
        condicao: 'PublicKey e credenciais institucionais pendentes de aprovação pelo portal.',
        secreto_ref: 'PCP_PARTNER_KEY',
        ambiente: 'Aguardando ativação',
      },
      {
        nome: 'Cesta de Preços',
        uso: 'Banco privado de preços de fornecedores',
        documentation_status: 'nao_confirmada',
        runtime_enabled: false,
        condicao: 'API pública ou de parceiro não confirmada documentalmente.',
        secreto_ref: 'CESTA_PRECOS_TOKEN',
        ambiente: 'Não homologado',
      },
      {
        nome: 'IBGE — Localidades e Municípios',
        uso: 'Padronização de códigos IBGE municipais e estaduais',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao: 'API pública REST sem necessidade de token (servicodados.ibge.gov.br).',
        secreto_ref: 'NENHUM',
        ambiente: 'Público',
      },
      {
        nome: 'OpenAI (Assistente Estruturador e Redator)',
        uso: 'Auxílio na redação de justificativas e minutas estruturadas',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao:
          'Chave própria OpenAI pendente de homologação na instituição. Desabilitado na v1.',
        secreto_ref: 'OPENAI_API_KEY',
        ambiente: 'Desabilitado nesta versão',
      },
      {
        nome: 'Assinatura Digital ICP-Brasil (PAdES/CAdES)',
        uso: 'Assinatura eletrônica com validade jurídica estrita',
        documentation_status: 'pendente',
        runtime_enabled: false,
        condicao: 'Provedor ICP-Brasil não configurado. Exportação de documentos apenas.',
        secreto_ref: 'ICP_CERT_PIN',
        ambiente: 'Pendente de contratação',
      },
    ]

    for (let i = 0; i < integracoesList.length; i++) {
      const item = integracoesList[i]
      try {
        app.findFirstRecordByData('integracoes', 'nome', item.nome)
      } catch (_) {
        const rec = new Record(integracoesCol)
        rec.set('nome', item.nome)
        rec.set('uso', item.uso)
        rec.set('documentation_status', item.documentation_status)
        rec.set('runtime_enabled', item.runtime_enabled)
        rec.set('condicao', item.condicao)
        rec.set('secreto_ref', item.secreto_ref)
        rec.set('ambiente', item.ambiente)
        app.save(rec)
      }
    }

    // 5. Seed Test Case: PP-PREF-001/2026 (Veículo hatch popular 1.0)
    // Demanda de um hatch popular 1.0 deve permanecer com UM único item.
    let demandaHatch
    try {
      demandaHatch = app.findFirstRecordByData('demandas', 'numero', 'PP-PREF-001/2026')
    } catch (_) {
      demandaHatch = new Record(demandasCol)
      demandaHatch.set('organizacao_id', org1.id)
      demandaHatch.set('numero', 'PP-PREF-001/2026')
      demandaHatch.set('versao', 1)
      demandaHatch.set('origem_recursos', 'recursos_proprios')
      demandaHatch.set(
        'objeto',
        'Aquisição de 1 (um) veículo automotor zero km, tipo hatch compacto popular motor 1.0 flex, para atendimento dos serviços administrativos da Secretaria de Administração.',
      )
      demandaHatch.set('status', 'confirmada')
      demandaHatch.set('responsavel_id', adminUser.id)
      demandaHatch.set(
        'questoes_faltantes',
        JSON.stringify([
          'Confirmar se a garantia mínima de 3 anos inclui assistência técnica no raio de 100km',
        ]),
      )
      app.save(demandaHatch)
    }

    // Item Único da Demanda
    let itemHatch
    try {
      itemHatch = app.findFirstRecordByData('demanda_itens', 'demanda_id', demandaHatch.id)
    } catch (_) {
      itemHatch = new Record(demandaItensCol)
      itemHatch.set('demanda_id', demandaHatch.id)
      itemHatch.set(
        'descricao',
        'Veículo automotor leve zero km, tipo hatch de passeio, motorização 1.0 flex, 4 portas, ar-condicionado, direção elétrica/hidráulica, freios ABS e airbags frontais obrigatórios.',
      )
      itemHatch.set('quantidade', 1)
      itemHatch.set('unidade', 'un')
      itemHatch.set(
        'caracteristicas_essenciais',
        'Hatch 5 lugares, motor 1.0 flex (mínimo 75cv), transmissão manual 5 velocidades, cor sólida branca, garantia de fábrica mínima de 12 meses.',
      )
      itemHatch.set(
        'prazo_entrega',
        '30 (trinta) dias corridos a contar da emissão da ordem de fornecimento',
      )
      itemHatch.set(
        'local_entrega',
        'Pátio Central da Prefeitura — Rua do Município, 100, São Paulo/SP',
      )
      itemHatch.set('catalogo', 'CATMAT 463721 — VEÍCULO AUTOMOTOR, TIPO HATCH 1.0')
      itemHatch.set('versao', 1)
      itemHatch.set('confirmado', true)
      app.save(itemHatch)
    }

    // Processo associado
    let processoHatch
    try {
      processoHatch = app.findFirstRecordByData('processos', 'numero', 'PROC-ADM-2026/042')
    } catch (_) {
      processoHatch = new Record(processosCol)
      processoHatch.set('organizacao_id', org1.id)
      processoHatch.set('demanda_id', demandaHatch.id)
      processoHatch.set('numero', 'PROC-ADM-2026/042')
      processoHatch.set('status', 'em_pesquisa')
      processoHatch.set('responsavel_id', adminUser.id)
      processoHatch.set('pendencia_atual', 'Revisão final dos candidatos da pesquisa de preços')
      processoHatch.set('prazo', '2026-04-15 18:00:00.000Z')
      processoHatch.set(
        'proxima_acao',
        'Concluir aprovação da memória de cálculo e emitir Relatório de Preços',
      )
      app.save(processoHatch)
    }

    // Pesquisa de Preços vinculada ao item do hatch
    let pesquisaHatch
    try {
      pesquisaHatch = app.findFirstRecordByData('pesquisas', 'demanda_item_id', itemHatch.id)
    } catch (_) {
      pesquisaHatch = new Record(pesquisasCol)
      pesquisaHatch.set('demanda_item_id', itemHatch.id)
      pesquisaHatch.set('numero', 'PESQ-2026-001/HATCH')
      pesquisaHatch.set('status', 'aguardando_revisao')
      pesquisaHatch.set(
        'conectores',
        JSON.stringify({
          compras_gov: { selecionado: true, status: 'cobertura_completa', paginas: 4 },
          pncp: { selecionado: true, status: 'cobertura_completa', paginas: 6 },
          manual: { selecionado: true, status: 'ativo', registros: 1 },
        }),
      )
      pesquisaHatch.set(
        'filtros',
        JSON.stringify({
          termo: 'veiculo hatch 1.0',
          periodo_meses: 12,
          uf: 'SP, MG, RJ, PR',
        }),
      )
      pesquisaHatch.set(
        'cobertura',
        JSON.stringify({
          compras_gov: { paginas: 4, registros_encontrados: 4, status: 'completa' },
          pncp: { paginas: 6, registros_encontrados: 5, status: 'completa' },
          manual: { paginas: 1, registros_encontrados: 1, status: 'completa' },
        }),
      )
      pesquisaHatch.set('falhas', JSON.stringify([]))
      pesquisaHatch.set('inicio', '2026-03-01 09:00:00.000Z')
      pesquisaHatch.set('fim', '2026-03-01 11:30:00.000Z')
      pesquisaHatch.set('responsavel_id', adminUser.id)
      app.save(pesquisaHatch)
    }

    // Candidatos de demonstração (Seed claramente rotulado)
    // CASO DE TESTE: Itens incompatíveis do PDF (picape, ambulância, retroescavadeira, trator, carroça)
    // NUNCA entram como itens da demanda — entram apenas como referências excluídas.
    const candidatosSeed = [
      // Compatíveis aceitos (para demonstrar cálculo determinístico com 3 preços de fontes reais)
      {
        fonte: 'pncp',
        id_externo: 'PNCP-CONTRATO-2025-98124',
        item_externo: 'Veículo tipo Hatch compacto 1.0 flex, 4 portas, ar condicionado (Item 1)',
        natureza_preco: 'contratado',
        valor_original: 78500.0,
        valor_normalizado: 78500.0,
        unidade: 'un',
        quantidade: 3,
        data_contratacao: '2025-11-14 10:00:00.000Z',
        fornecedor: 'Auto Sul Comercial de Veículos Ltda (CNPJ 05.892.311/0001-90)',
        url: 'https://pncp.gov.br/app/contratos/05892311000190/2025/98124',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        status_revisao: 'aceito',
        motivo_exclusao: '',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          compatibilidade: 'Compatível integralmente com motor 1.0, 4 portas e ar condicionado.',
        },
      },
      {
        fonte: 'compras_gov',
        id_externo: 'COMPRAS-PE-90042/2025-IT01',
        item_externo:
          'Automóvel Hatch 5p motor 1.0 flex, ar, direção elétrica (Adjudicado Pregão 42/2025)',
        natureza_preco: 'homologado',
        valor_original: 79900.0,
        valor_normalizado: 79900.0,
        unidade: 'un',
        quantidade: 5,
        data_contratacao: '2025-12-05 14:30:00.000Z',
        fornecedor: 'Nacional Veículos e Frotas S.A. (CNPJ 18.234.567/0001-12)',
        url: 'https://dadosabertos.compras.gov.br/pregao/90042-2025/item/1',
        hash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        status_revisao: 'aceito',
        motivo_exclusao: '',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          compatibilidade: 'Compatível com CATMAT 463721; homologado em pregão eletrônico.',
        },
      },
      {
        fonte: 'manual',
        id_externo: 'COT-DIR-2026-004',
        item_externo:
          'Cotação formalizada de concessionária local autorizada — Hatch 1.0 Flex Branco',
        natureza_preco: 'cotacao_comercial',
        valor_original: 81200.0,
        valor_normalizado: 81200.0,
        unidade: 'un',
        quantidade: 1,
        data_contratacao: '2026-01-20 09:00:00.000Z',
        fornecedor: 'Concessionária Metropolitana Ltda (CNPJ 55.444.333/0001-22)',
        url: 'https://prefeitura.sp.gov.br/cotacoes/2026/COT-DIR-004.pdf',
        hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
        status_revisao: 'aceito',
        motivo_exclusao: '',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          compatibilidade: 'Proposta formal com validade de 60 dias acompanhada de certidões.',
        },
      },
      // Compatível com valor estimado em edital (demonstrar distinção de natureza)
      {
        fonte: 'pncp',
        id_externo: 'PNCP-EDITAL-2026-1102',
        item_externo: 'Valor estimado de edital — Hatch compacto 1.0',
        natureza_preco: 'estimado',
        valor_original: 83500.0,
        valor_normalizado: 83500.0,
        unidade: 'un',
        quantidade: 2,
        data_contratacao: '2026-02-10 11:00:00.000Z',
        fornecedor: 'Município de Campinas / Edital PE 12/2026',
        url: 'https://pncp.gov.br/editais/2026/1102',
        hash: '7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d',
        status_revisao: 'pendente',
        motivo_exclusao: '',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          compatibilidade: 'Natureza estimada de edital — aguardando homologação do certame.',
        },
      },
      // DUPLICATA SINALIZADA (mesma contratação em bases diferentes)
      {
        fonte: 'compras_gov',
        id_externo: 'COMPRAS-CONV-2025-98124',
        item_externo: 'Automóvel Hatch 1.0 (mesma transação do PNCP-CONTRATO-2025-98124)',
        natureza_preco: 'contratado',
        valor_original: 78500.0,
        valor_normalizado: 78500.0,
        unidade: 'un',
        quantidade: 3,
        data_contratacao: '2025-11-14 10:00:00.000Z',
        fornecedor: 'Auto Sul Comercial de Veículos Ltda',
        url: 'https://comprasnet.gov.br/contrato/98124',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        status_revisao: 'excluido',
        motivo_exclusao:
          'Duplicata confirmada — mesmo contrato já contabilizado via PNCP (PNCP-CONTRATO-2025-98124)',
        possivel_duplicata: true,
        detalhes_tecnicos: { duplicata_de: 'PNCP-CONTRATO-2025-98124' },
      },
      // ITENS DO PDF PP-PREF-001/2026 QUE DEVEM SER MARCADOS COMO EXCLUÍDOS COM MOTIVO INCOMPATÍVEL
      {
        fonte: 'pncp',
        id_externo: 'PDF-PREF-ITEM-02',
        item_externo: 'Camionete tipo picape cabine dupla 4x4 diesel 2.8',
        natureza_preco: 'contratado',
        valor_original: 245000.0,
        valor_normalizado: 245000.0,
        unidade: 'un',
        quantidade: 2,
        data_contratacao: '2025-10-18 10:00:00.000Z',
        fornecedor: 'Concessionária Força Bruta 4x4 Ltda',
        url: 'https://pncp.gov.br/app/contratos/picape-4x4-2025',
        hash: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
        status_revisao: 'excluido',
        motivo_exclusao: 'Item incompatível com a demanda',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          incompatibilidade_essencial:
            'Picape 4x4 cabine dupla diesel não atende à demanda de hatch popular 1.0 flex de uso urbano.',
        },
      },
      {
        fonte: 'pncp',
        id_externo: 'PDF-PREF-ITEM-03',
        item_externo: 'Ambulância de Suporte Avançado tipo UTI móvel furgão diesel',
        natureza_preco: 'contratado',
        valor_original: 389000.0,
        valor_normalizado: 389000.0,
        unidade: 'un',
        quantidade: 1,
        data_contratacao: '2025-09-02 11:00:00.000Z',
        fornecedor: 'Transformadora de Veículos Especiais S.A.',
        url: 'https://pncp.gov.br/app/contratos/ambulancia-uti-2025',
        hash: 'c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3',
        status_revisao: 'excluido',
        motivo_exclusao: 'Item incompatível com a demanda',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          incompatibilidade_essencial:
            'Veículo de socorro médico de urgência (UTI móvel) descaracteriza totalmente o hatch popular solicitado.',
        },
      },
      {
        fonte: 'compras_gov',
        id_externo: 'PDF-PREF-ITEM-04',
        item_externo: 'Retroescavadeira sobre rodas 4x4 potência mínima 85 HP',
        natureza_preco: 'contratado',
        valor_original: 480000.0,
        valor_normalizado: 480000.0,
        unidade: 'un',
        quantidade: 1,
        data_contratacao: '2025-08-15 15:00:00.000Z',
        fornecedor: 'Máquinas e Implementos Rodoviários Ltda',
        url: 'https://comprasnet.gov.br/contrato/retro-2025',
        hash: 'd3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4',
        status_revisao: 'excluido',
        motivo_exclusao: 'Item incompatível com a demanda',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          incompatibilidade_essencial:
            'Máquina amarela pesada de construção civil; incompatibilidade categórica com hatch leve.',
        },
      },
      {
        fonte: 'pncp',
        id_externo: 'PDF-PREF-ITEM-05',
        item_externo: 'Trator agrícola cabinado 4x4 110 cv com tomada de força',
        natureza_preco: 'contratado',
        valor_original: 365000.0,
        valor_normalizado: 365000.0,
        unidade: 'un',
        quantidade: 2,
        data_contratacao: '2025-07-20 14:00:00.000Z',
        fornecedor: 'Agro Tratores Brasil Ltda',
        url: 'https://pncp.gov.br/app/contratos/trator-110cv',
        hash: 'e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5',
        status_revisao: 'excluido',
        motivo_exclusao: 'Item incompatível com a demanda',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          incompatibilidade_essencial:
            'Veículo/equipamento de uso agrícola rural; incompatível com demanda de transporte urbano.',
        },
      },
      {
        fonte: 'manual',
        id_externo: 'PDF-PREF-ITEM-06',
        item_externo: 'Carroça de tração animal com estrutura em madeira e rodas raiadas',
        natureza_preco: 'cotacao_comercial',
        valor_original: 8500.0,
        valor_normalizado: 8500.0,
        unidade: 'un',
        quantidade: 1,
        data_contratacao: '2025-06-10 16:00:00.000Z',
        fornecedor: 'Carpintaria Tradicional Rural ME',
        url: 'https://prefeitura.sp.gov.br/anexos/carroca-manual.pdf',
        hash: 'f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6',
        status_revisao: 'excluido',
        motivo_exclusao: 'Item incompatível com a demanda',
        possivel_duplicata: false,
        detalhes_tecnicos: {
          incompatibilidade_essencial:
            'Veículo de tração animal rudimentar; não atende requisitos mínimos de segurança e motorização.',
        },
      },
    ]

    for (let i = 0; i < candidatosSeed.length; i++) {
      const cand = candidatosSeed[i]
      let refRecord
      try {
        refRecord = app.findFirstRecordByData('referencias', 'id_externo', cand.id_externo)
      } catch (_) {
        refRecord = new Record(referenciasCol)
        refRecord.set('pesquisa_id', pesquisaHatch.id)
        refRecord.set('fonte', cand.fonte)
        refRecord.set('id_externo', cand.id_externo)
        refRecord.set('item_externo', cand.item_externo)
        refRecord.set('natureza_preco', cand.natureza_preco)
        refRecord.set('valor_original', cand.valor_original)
        refRecord.set('valor_normalizado', cand.valor_normalizado)
        refRecord.set('unidade', cand.unidade)
        refRecord.set('quantidade', cand.quantidade)
        refRecord.set('data_contratacao', cand.data_contratacao)
        refRecord.set('fornecedor', cand.fornecedor)
        refRecord.set('url', cand.url)
        refRecord.set('hash', cand.hash)
        refRecord.set('status_revisao', cand.status_revisao)
        refRecord.set('motivo_exclusao', cand.motivo_exclusao)
        refRecord.set('possivel_duplicata', cand.possivel_duplicata)
        refRecord.set('detalhes_tecnicos', JSON.stringify(cand.detalhes_tecnicos))
        app.save(refRecord)

        // Create evidence record
        const evid = new Record(evidenciasCol)
        evid.set('referencia_id', refRecord.id)
        evid.set('url', cand.url)
        evid.set('hash', cand.hash)
        evid.set('momento_coleta', '2026-03-01 10:15:00.000Z')
        evid.set('campo_origem', 'Extrato de Contrato / Diário Oficial / Comprovante eletrônico')
        evid.set('permissao', 'Acesso público via Lei de Acesso à Informação (LAI)')
        evid.set('retencao', 'Guarda permanente no dossiê de contratação')
        evid.set(
          'trecho_resposta',
          `Item: ${cand.item_externo} | Preço: R$ ${cand.valor_original} | Fornecedor: ${cand.fornecedor}`,
        )
        app.save(evid)
      }
    }

    // 6. Seed Memória de Cálculo Determinística para o Caso do Hatch
    // Preços aceitos: 78.500,00, 79.900,00, 81.200,00
    // Média = (78500 + 79900 + 81200) / 3 = 79.866,67
    // Mediana = 79.900,00
    // Total = 1 (quantidade demandada) × 79.900,00 (preço de referência) = R$ 79.900,00
    // NOTA ESPECIFICAÇÃO: NUNCA somar quantidades das contratações pesquisadas.
    // No PDF o erro gerou R$ 3.096.703,17 — o sistema produz 1 × R$ 79.900,00.
    let calculoHatch
    try {
      calculoHatch = app.findFirstRecordByData('calculos', 'pesquisa_id', pesquisaHatch.id)
    } catch (_) {
      calculoHatch = new Record(calculosCol)
      calculoHatch.set('pesquisa_id', pesquisaHatch.id)
      calculoHatch.set('metodo', 'mediana')
      calculoHatch.set(
        'valores_entrada',
        JSON.stringify([
          {
            fonte: 'pncp',
            id: 'PNCP-CONTRATO-2025-98124',
            valor: 78500.0,
            natureza: 'contratado',
            fornecedor: 'Auto Sul Comercial',
          },
          {
            fonte: 'compras_gov',
            id: 'COMPRAS-PE-90042/2025-IT01',
            valor: 79900.0,
            natureza: 'homologado',
            fornecedor: 'Nacional Veículos',
          },
          {
            fonte: 'manual',
            id: 'COT-DIR-2026-004',
            valor: 81200.0,
            natureza: 'cotacao_comercial',
            fornecedor: 'Concessionária Metropolitana',
          },
        ]),
      )
      calculoHatch.set(
        'arredondamento',
        'Arredondamento bancário conforme ABNT NBR 5891:2014 para 2 casas decimais.',
      )
      calculoHatch.set('resultado', 79900.0)
      calculoHatch.set('total_item', 79900.0)
      calculoHatch.set('total_demanda', 79900.0)
      calculoHatch.set('versao_motor', 'Motor Determinístico v1.0.0-LEI14133')
      calculoHatch.set(
        'justificativa_metodo',
        'Adotada a MEDIANA da amostra de 3 preços válidos aceitos (Lei 14.133/2021, art. 23, §1º), por conferir maior robustez contra dispersões e refletir com precisão a tendência central do mercado automobilístico.',
      )
      calculoHatch.set('status', 'aprovado')
      calculoHatch.set(
        'metricas_n',
        JSON.stringify({
          n_precos: 3,
          n_transacoes: 3,
          n_plataformas: 3,
          distribuicao_plataformas: { pncp: 1, compras_gov: 1, manual: 1 },
          suficiencia_amostral: 'Amostra suficiente (n=3 em 3 fontes distintas)',
        }),
      )
      calculoHatch.set(
        'analise_outliers',
        JSON.stringify({
          metodo_mad: 'Desvio Absoluto da Mediana (MAD = 1.350,00; limiar 2.5x)',
          outliers_detectados: 0,
          parecer: 'Nenhum valor discrepante identificado na amostra aceita.',
        }),
      )
      app.save(calculoHatch)
    }

    // 7. Seed Documento: Relatório de Pesquisa de Preços
    let docRelatorio
    try {
      docRelatorio = app.findFirstRecordByData('documentos', 'processo_id', processoHatch.id)
    } catch (_) {
      docRelatorio = new Record(documentosCol)
      docRelatorio.set('processo_id', processoHatch.id)
      docRelatorio.set('tipo', 'relatorio_precos')
      docRelatorio.set(
        'titulo',
        'Relatório Oficial de Pesquisa de Preços — Veículo Hatch 1.0 (PP-PREF-001/2026)',
      )
      docRelatorio.set('versao', 1)
      docRelatorio.set('status', 'aprovado')
      docRelatorio.set('hash', '3b18d361c4de4bb91ad05e05a5dc6f9f3792078693c0bc5f9c490a195e542ef8')
      docRelatorio.set(
        'conteudo',
        JSON.stringify({
          identificacao: {
            orgao: 'Prefeitura Municipal de Exemplo (SP)',
            cnpj: '11.222.333/0001-44',
            processo: 'PROC-ADM-2026/042',
            demanda: 'PP-PREF-001/2026',
            objeto: 'Aquisição de 1 (um) veículo hatch popular 1.0 flex',
          },
          demanda_estruturada: {
            itens: [
              {
                item: 1,
                descricao: 'Veículo hatch popular 1.0 flex zero km',
                quantidade_demandada: 1,
                unidade: 'un',
                preco_referencia: 79900.0,
                total_item: 79900.0,
              },
            ],
            total_estimado_geral: 79900.0,
          },
          criterios_fontes: {
            normativo: 'Lei nº 14.133/2021, Art. 23',
            bases_consultadas: ['Compras.gov.br', 'PNCP', 'Cotação Direta'],
            candidatos_analisados: 10,
            candidatos_aceitos: 3,
            candidatos_excluidos: 7,
          },
          memoria_calculo: {
            metodo: 'Mediana',
            formula: 'Mediana([78.500,00; 79.900,00; 81.200,00])',
            resultado_unitario: 79900.0,
            quantidade_demandada: 1,
            total_calculado: 79900.0,
            nota_auditoria:
              'Total = quantidade demandada (1) × preço unitário. Proibida soma de quantidades das amostras consultadas.',
          },
          exclusoes_registradas: [
            {
              item: 'PDF-PREF-ITEM-02',
              descricao: 'Camionete picape 4x4 cabine dupla diesel',
              motivo: 'Item incompatível com a demanda',
            },
            {
              item: 'PDF-PREF-ITEM-03',
              descricao: 'Ambulância UTI móvel diesel',
              motivo: 'Item incompatível com a demanda',
            },
            {
              item: 'PDF-PREF-ITEM-04',
              descricao: 'Retroescavadeira 4x4 85 HP',
              motivo: 'Item incompatível com a demanda',
            },
            {
              item: 'PDF-PREF-ITEM-05',
              descricao: 'Trator agrícola cabinado 110 cv',
              motivo: 'Item incompatível com a demanda',
            },
            {
              item: 'PDF-PREF-ITEM-06',
              descricao: 'Carroça de tração animal',
              motivo: 'Item incompatível com a demanda',
            },
          ],
        }),
      )
      app.save(docRelatorio)

      // Versão estruturada do documento
      const versaoDoc = new Record(versoesCol)
      versaoDoc.set('documento_id', docRelatorio.id)
      versaoDoc.set('numero_versao', 1)
      versaoDoc.set('conteudo', docRelatorio.get('conteudo'))
      versaoDoc.set('hash', '3b18d361c4de4bb91ad05e05a5dc6f9f3792078693c0bc5f9c490a195e542ef8')
      versaoDoc.set(
        'motivo_alteracao',
        'Versão inicial consolidada da pesquisa de preços com exclusão de itens incompatíveis.',
      )
      app.save(versaoDoc)
    }
  },
  (app) => {
    // Downgrade seed data if needed
  },
)
