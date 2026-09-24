migrate(
  (app) => {
    // 1. Atualizar SelectField papel na coleção users para incluir papéis RBAC SaaS adicionais
    const users = app.findCollectionByNameOrId('_pb_users_auth_')
    const papelField = users.fields.getByName('papel')
    if (papelField) {
      papelField.values = [
        'super_admin',
        'admin',
        'gestor',
        'compras',
        'licitacao',
        'consultor',
        'visualizacao',
        'auditor',
        'responsavel_pesquisa',
        'aprovador',
        'integracoes',
      ]
      papelField.maxSelect = 1
    }
    app.save(users)

    // 2. Coleção de Planos SaaS (Básico, Profissional, Premium, Enterprise)
    let planosCol
    try {
      planosCol = app.findCollectionByNameOrId('planos_saas')
    } catch (_) {
      planosCol = new Collection({
        name: 'planos_saas',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          { name: 'nome', type: 'text', required: true },
          { name: 'codigo', type: 'text', required: true },
          { name: 'descricao', type: 'text' },
          { name: 'limite_usuarios', type: 'number', required: true },
          { name: 'limite_pesquisas_mes', type: 'number', required: true },
          { name: 'limite_armazenamento_mb', type: 'number', required: true },
          { name: 'acesso_api', type: 'bool' },
          { name: 'automacoes_lote', type: 'bool' },
          { name: 'fontes_premium', type: 'bool' },
          { name: 'relatorios_avancados', type: 'bool' },
          { name: 'ativo', type: 'bool' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE UNIQUE INDEX idx_planos_saas_codigo ON planos_saas (codigo)'],
      })
      app.save(planosCol)
    }

    // 3. Coleção de Configurações e Licenças por Órgão (orgao_configuracoes)
    const orgaosCol = app.findCollectionByNameOrId('organizacoes')
    let orgaoConfigCol
    try {
      orgaoConfigCol = app.findCollectionByNameOrId('orgao_configuracoes')
    } catch (_) {
      orgaoConfigCol = new Collection({
        name: 'orgao_configuracoes',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'organizacao_id',
            type: 'relation',
            required: true,
            collectionId: orgaosCol.id,
            maxSelect: 1,
          },
          {
            name: 'plano_id',
            type: 'relation',
            collectionId: planosCol.id,
            maxSelect: 1,
          },
          {
            name: 'status_licenca',
            type: 'select',
            required: true,
            values: ['ativa', 'bloqueada', 'degustacao', 'vencida', 'suspensa'],
            maxSelect: 1,
          },
          { name: 'vencimento_licenca', type: 'date' },
          { name: 'quantidade_minima_precos', type: 'number' },
          {
            name: 'metodo_outlier_padrao',
            type: 'select',
            values: ['distancia_mediana', 'iqr', 'desvio_padrao', 'percentual_fixo', 'nenhum'],
            maxSelect: 1,
          },
          { name: 'limite_outlier_superior', type: 'number' }, // ex 130 (130% da mediana)
          { name: 'limite_outlier_inferior', type: 'number' }, // ex 70 (70% da mediana)
          {
            name: 'metodo_calculo_padrao',
            type: 'select',
            values: ['mediana', 'media', 'menor', 'media_saneada'],
            maxSelect: 1,
          },
          { name: 'exigir_justificativa_insuficiente', type: 'bool' },
          { name: 'priorizar_fontes_governamentais', type: 'bool' },
          { name: 'permitir_cotacao_fornecedor', type: 'bool' },
          { name: 'periodo_maximo_meses', type: 'number' },
          { name: 'fontes_prioritarias', type: 'json' },
          { name: 'fontes_bloqueadas', type: 'json' },
          { name: 'regras_pesquisa', type: 'json' },
          { name: 'cabecalho_relatorio', type: 'text' },
          { name: 'rodape_relatorio', type: 'text' },
          { name: 'responsavel_assinatura_nome', type: 'text' },
          { name: 'responsavel_assinatura_cargo', type: 'text' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_orgao_config_org ON orgao_configuracoes (organizacao_id)',
        ],
      })
      app.save(orgaoConfigCol)
    }

    // 4. Coleção de Fontes de Dados e Conectores do Sistema (fontes_catalogo)
    let fontesCol
    try {
      fontesCol = app.findCollectionByNameOrId('fontes_catalogo')
    } catch (_) {
      fontesCol = new Collection({
        name: 'fontes_catalogo',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          { name: 'nome', type: 'text', required: true },
          { name: 'codigo', type: 'text', required: true },
          {
            name: 'tipo',
            type: 'select',
            required: true,
            values: [
              'governamental',
              'regulatoria',
              'comercial',
              'tabela_oficial',
              'regional',
              'propria',
            ],
            maxSelect: 1,
          },
          {
            name: 'categoria',
            type: 'select',
            required: true,
            values: [
              'geral',
              'medicamentos',
              'saude',
              'obras',
              'alimentacao',
              'veiculos',
              'tecnologia',
            ],
            maxSelect: 1,
          },
          {
            name: 'formato',
            type: 'select',
            required: true,
            values: ['api_rest', 'json', 'xml', 'csv', 'xlsx', 'arquivo_periodico', 'manual'],
            maxSelect: 1,
          },
          {
            name: 'frequencia',
            type: 'select',
            values: ['tempo_real', 'diaria', 'semanal', 'mensal', 'anual', 'sob_demanda'],
            maxSelect: 1,
          },
          {
            name: 'status',
            type: 'select',
            required: true,
            values: ['ativo', 'inativo', 'em_homologacao', 'desatualizado', 'manutencao'],
            maxSelect: 1,
          },
          { name: 'runtime_enabled', type: 'bool' },
          { name: 'endpoint_url', type: 'text' },
          { name: 'autenticacao_tipo', type: 'text' },
          { name: 'ultima_sincronizacao', type: 'date' },
          { name: 'proxima_sincronizacao', type: 'date' },
          { name: 'uf_regional', type: 'text' },
          { name: 'orgao_regional', type: 'text' },
          { name: 'metodologia', type: 'text' },
          {
            name: 'tipo_preco',
            type: 'select',
            values: [
              'contratado',
              'homologado',
              'regulatorio',
              'cotacao_mercado',
              'estimado_edital',
              'tabela',
            ],
            maxSelect: 1,
          },
          { name: 'is_regulatorio', type: 'bool' }, // ex. CMED
          { name: 'versao_adaptador', type: 'text' },
          { name: 'observacoes', type: 'text' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE UNIQUE INDEX idx_fontes_catalogo_codigo ON fontes_catalogo (codigo)'],
      })
      app.save(fontesCol)
    }

    // 5. Coleção de Logs de ETL / Sincronização de Fontes (sync_logs)
    let syncLogsCol
    try {
      syncLogsCol = app.findCollectionByNameOrId('sync_logs')
    } catch (_) {
      syncLogsCol = new Collection({
        name: 'sync_logs',
        type: 'base',
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        createRule: '@request.auth.id != ""',
        updateRule: '@request.auth.id != ""',
        deleteRule: '@request.auth.id != ""',
        fields: [
          {
            name: 'fonte_id',
            type: 'relation',
            required: true,
            collectionId: fontesCol.id,
            maxSelect: 1,
          },
          {
            name: 'status',
            type: 'select',
            required: true,
            values: ['sucesso', 'parcial', 'falha', 'em_execucao'],
            maxSelect: 1,
          },
          { name: 'quantidade_coletada', type: 'number' },
          { name: 'novos_registros', type: 'number' },
          { name: 'registros_atualizados', type: 'number' },
          { name: 'duplicados_identificados', type: 'number' },
          { name: 'erros_count', type: 'number' },
          { name: 'tempo_processamento_ms', type: 'number' },
          { name: 'detalhes', type: 'text' },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
        ],
        indexes: ['CREATE INDEX idx_sync_logs_fonte ON sync_logs (fonte_id, created DESC)'],
      })
      app.save(syncLogsCol)
    }

    // 6. Atualizar referências para permitir novos tipos de fonte (bps, cmed, sinapi, etc.)
    const referenciasCol = app.findCollectionByNameOrId('referencias')
    const fonteField = referenciasCol.fields.getByName('fonte')
    if (fonteField) {
      fonteField.values = [
        'compras_gov',
        'pncp',
        'bps',
        'cmed',
        'sinapi',
        'sicro',
        'ceasa',
        'conab',
        'bec_sp',
        'regional_estadual',
        'manual',
      ]
      fonteField.maxSelect = 1
    }
    const natField = referenciasCol.fields.getByName('natureza_preco')
    if (natField) {
      natField.values = [
        'estimado',
        'homologado',
        'contratado',
        'cotacao_comercial',
        'regulatorio_tabela',
        'desconhecido',
      ]
      natField.maxSelect = 1
    }
    // Adicionar campos de governança caso não existam
    if (!referenciasCol.fields.getByName('source_capture_date')) {
      referenciasCol.fields.add(new DateField({ name: 'source_capture_date' }))
    }
    if (!referenciasCol.fields.getByName('source_update_date')) {
      referenciasCol.fields.add(new DateField({ name: 'source_update_date' }))
    }
    if (!referenciasCol.fields.getByName('source_identifier')) {
      referenciasCol.fields.add(new TextField({ name: 'source_identifier' }))
    }
    if (!referenciasCol.fields.getByName('confidence_score')) {
      referenciasCol.fields.add(new NumberField({ name: 'confidence_score' }))
    }
    if (!referenciasCol.fields.getByName('similarity_score')) {
      referenciasCol.fields.add(new NumberField({ name: 'similarity_score' }))
    }
    if (!referenciasCol.fields.getByName('cnpj_fornecedor')) {
      referenciasCol.fields.add(new TextField({ name: 'cnpj_fornecedor' }))
    }
    if (!referenciasCol.fields.getByName('orgao_comprador')) {
      referenciasCol.fields.add(new TextField({ name: 'orgao_comprador' }))
    }
    if (!referenciasCol.fields.getByName('municipio_uf')) {
      referenciasCol.fields.add(new TextField({ name: 'municipio_uf' }))
    }
    if (!referenciasCol.fields.getByName('modalidade_licitacao')) {
      referenciasCol.fields.add(new TextField({ name: 'modalidade_licitacao' }))
    }
    if (!referenciasCol.fields.getByName('processo_origem')) {
      referenciasCol.fields.add(new TextField({ name: 'processo_origem' }))
    }
    if (!referenciasCol.fields.getByName('marca_modelo')) {
      referenciasCol.fields.add(new TextField({ name: 'marca_modelo' }))
    }
    if (!referenciasCol.fields.getByName('codigo_catalogo')) {
      referenciasCol.fields.add(new TextField({ name: 'codigo_catalogo' }))
    }
    app.save(referenciasCol)

    // 7. Seed dos 4 Planos SaaS iniciais
    const planosIniciais = [
      {
        codigo: 'basico',
        nome: 'Plano Básico',
        descricao: 'Para pequenos municípios e câmaras com até 3 pesquisadores',
        limite_usuarios: 3,
        limite_pesquisas_mes: 30,
        limite_armazenamento_mb: 2048,
        acesso_api: false,
        automacoes_lote: false,
        fontes_premium: false,
        relatorios_avancados: false,
        ativo: true,
      },
      {
        codigo: 'profissional',
        nome: 'Plano Profissional',
        descricao: 'Para secretarias municipais e autarquias de médio porte',
        limite_usuarios: 10,
        limite_pesquisas_mes: 150,
        limite_armazenamento_mb: 10240,
        acesso_api: true,
        automacoes_lote: true,
        fontes_premium: false,
        relatorios_avancados: true,
        ativo: true,
      },
      {
        codigo: 'premium',
        nome: 'Plano Premium',
        descricao: 'Para capitais, consórcios intermunicipais e secretarias estaduais',
        limite_usuarios: 30,
        limite_pesquisas_mes: 500,
        limite_armazenamento_mb: 51200,
        acesso_api: true,
        automacoes_lote: true,
        fontes_premium: true,
        relatorios_avancados: true,
        ativo: true,
      },
      {
        codigo: 'enterprise',
        nome: 'Plano Enterprise Governamental',
        descricao: 'Ilimitado, instâncias dedicadas e suporte prioritário 24/7',
        limite_usuarios: 999,
        limite_pesquisas_mes: 99999,
        limite_armazenamento_mb: 512000,
        acesso_api: true,
        automacoes_lote: true,
        fontes_premium: true,
        relatorios_avancados: true,
        ativo: true,
      },
    ]

    for (let i = 0; i < planosIniciais.length; i++) {
      const p = planosIniciais[i]
      try {
        app.findFirstRecordByData('planos_saas', 'codigo', p.codigo)
      } catch (_) {
        const rec = new Record(planosCol)
        rec.set('codigo', p.codigo)
        rec.set('nome', p.nome)
        rec.set('descricao', p.descricao)
        rec.set('limite_usuarios', p.limite_usuarios)
        rec.set('limite_pesquisas_mes', p.limite_pesquisas_mes)
        rec.set('limite_armazenamento_mb', p.limite_armazenamento_mb)
        rec.set('acesso_api', p.acesso_api)
        rec.set('automacoes_lote', p.automacoes_lote)
        rec.set('fontes_premium', p.fontes_premium)
        rec.set('relatorios_avancados', p.relatorios_avancados)
        rec.set('ativo', p.ativo)
        app.save(rec)
      }
    }

    // 8. Seed das Fontes de Dados Oficiais
    const fontesSeed = [
      {
        nome: 'PNCP — Portal Nacional de Contratações Públicas',
        codigo: 'pncp',
        tipo: 'governamental',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url: 'https://pncp.gov.br/api/consulta/v1',
        autenticacao_tipo: 'Pública (Open Data)',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v2.1.0',
        observacoes:
          'Base central de contratações públicas conforme Lei 14.133/2021. Runtime controlado.',
      },
      {
        nome: 'Compras.gov.br — Módulo Preços Praticados',
        codigo: 'compras_gov',
        tipo: 'governamental',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarPreco',
        autenticacao_tipo: 'Pública (Dados Abertos)',
        tipo_preco: 'homologado',
        is_regulatorio: false,
        versao_adaptador: 'v2.0.4',
        observacoes: 'Preços de pregões e dispensas do Governo Federal por CATMAT/CATSER.',
      },
      {
        nome: 'BPS — Banco de Preços em Saúde (Ministério da Saúde)',
        codigo: 'bps',
        tipo: 'governamental',
        categoria: 'medicamentos',
        formato: 'csv',
        frequencia: 'mensal',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url: 'https://bps.saude.gov.br/relatorios/extracao-mensal',
        autenticacao_tipo: 'Pública / Ingestão Periódica',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.4.0',
        observacoes: 'Registro de compras públicas de medicamentos e insumos hospitalares.',
      },
      {
        nome: 'CMED — Câmara de Regulação do Mercado de Medicamentos (ANVISA)',
        codigo: 'cmed',
        tipo: 'regulatoria',
        categoria: 'medicamentos',
        formato: 'xlsx',
        frequencia: 'mensal',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url: 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos',
        autenticacao_tipo: 'Tabela Oficial ANVISA',
        tipo_preco: 'regulatorio',
        is_regulatorio: true,
        versao_adaptador: 'v3.0.0',
        observacoes:
          'REFERÊNCIA REGULATÓRIA: Teto de Preço Fábrica (PF) e Preço Máximo ao Consumidor (PMC). Não se confunde com preço contratado.',
      },
      {
        nome: 'SINAPI — Sistema Nacional de Pesquisa de Custos e Índices da Construção Civil',
        codigo: 'sinapi',
        tipo: 'tabela_oficial',
        categoria: 'obras',
        formato: 'xlsx',
        frequencia: 'mensal',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url: 'https://www.caixa.gov.br/poder-publico/modernizacao-gestao/sinapi',
        autenticacao_tipo: 'Tabela Pública CAIXA/IBGE',
        tipo_preco: 'tabela',
        is_regulatorio: false,
        versao_adaptador: 'v1.1.0',
        observacoes: 'Preços de insumos e composições da construção civil.',
      },
      {
        nome: 'SICRO — Sistema de Custos Rodoviários (DNIT)',
        codigo: 'sicro',
        tipo: 'tabela_oficial',
        categoria: 'obras',
        formato: 'xlsx',
        frequencia: 'mensal',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url:
          'https://www.gov.br/dnit/pt-br/assuntos/planejamento-e-pesquisa/custos-e-pagamentos/sicro',
        autenticacao_tipo: 'Tabela Pública DNIT',
        tipo_preco: 'tabela',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.2',
        observacoes: 'Custos unitários para infraestrutura de transportes e rodovias.',
      },
      {
        nome: 'CEASA / CONAB — Companhia Nacional de Abastecimento',
        codigo: 'conab',
        tipo: 'governamental',
        categoria: 'alimentacao',
        formato: 'csv',
        frequencia: 'semanal',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url: 'https://portaldeinformacoes.conab.gov.br/precos-agropecuarios',
        autenticacao_tipo: 'Pública',
        tipo_preco: 'cotacao_mercado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'Preços médios atacado de gêneros alimentícios e merenda escolar.',
      },
      {
        nome: 'BEC-SP — Bolsa Eletrônica de Compras do Estado de São Paulo',
        codigo: 'bec_sp',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'ativo',
        runtime_enabled: false,
        endpoint_url: 'https://www.bec.sp.gov.br/bec_pregao_ui/api',
        autenticacao_tipo: 'Pública Regional SP',
        uf_regional: 'SP',
        orgao_regional: 'Governo do Estado de São Paulo',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.2.0',
        observacoes: 'Catálogo de materiais e serviços e histórico de preços praticados em SP.',
      },
    ]

    for (let i = 0; i < fontesSeed.length; i++) {
      const f = fontesSeed[i]
      try {
        app.findFirstRecordByData('fontes_catalogo', 'codigo', f.codigo)
      } catch (_) {
        const rec = new Record(fontesCol)
        rec.set('nome', f.nome)
        rec.set('codigo', f.codigo)
        rec.set('tipo', f.tipo)
        rec.set('categoria', f.categoria)
        rec.set('formato', f.formato)
        rec.set('frequencia', f.frequencia)
        rec.set('status', f.status)
        rec.set('runtime_enabled', f.runtime_enabled)
        rec.set('endpoint_url', f.endpoint_url)
        rec.set('autenticacao_tipo', f.autenticacao_tipo)
        rec.set('tipo_preco', f.tipo_preco)
        rec.set('is_regulatorio', f.is_regulatorio)
        rec.set('versao_adaptador', f.versao_adaptador)
        rec.set('observacoes', f.observacoes)
        if (f.uf_regional) rec.set('uf_regional', f.uf_regional)
        if (f.orgao_regional) rec.set('orgao_regional', f.orgao_regional)
        app.save(rec)
      }
    }

    // 9. Vincular orgao_configuracoes para Org 1 e Org 2
    try {
      const org1 = app.findFirstRecordByData('organizacoes', 'cnpj', '11.222.333/0001-44')
      const planoProf = app.findFirstRecordByData('planos_saas', 'codigo', 'profissional')
      try {
        app.findFirstRecordByData('orgao_configuracoes', 'organizacao_id', org1.id)
      } catch (_) {
        const cfg1 = new Record(orgaoConfigCol)
        cfg1.set('organizacao_id', org1.id)
        cfg1.set('plano_id', planoProf.id)
        cfg1.set('status_licenca', 'ativa')
        cfg1.set('vencimento_licenca', '2027-12-31 23:59:59.000Z')
        cfg1.set('quantidade_minima_precos', 3)
        cfg1.set('metodo_outlier_padrao', 'distancia_mediana')
        cfg1.set('limite_outlier_inferior', 70)
        cfg1.set('limite_outlier_superior', 130)
        cfg1.set('metodo_calculo_padrao', 'mediana')
        cfg1.set('exigir_justificativa_insuficiente', true)
        cfg1.set('priorizar_fontes_governamentais', true)
        cfg1.set('permitir_cotacao_fornecedor', true)
        cfg1.set('periodo_maximo_meses', 12)
        cfg1.set('responsavel_assinatura_nome', 'Carlos Eduardo Silveira')
        cfg1.set('responsavel_assinatura_cargo', 'Secretário Municipal de Administração')
        cfg1.set('cabecalho_relatorio', 'ESTADO DE SÃO PAULO — PREFEITURA MUNICIPAL DE EXEMPLO')
        cfg1.set(
          'rodape_relatorio',
          'Documento gerado eletronicamente em conformidade com a Lei nº 14.133/2021.',
        )
        app.save(cfg1)
      }
    } catch (_) {}
  },
  (app) => {
    // Reversão segura
  },
)
