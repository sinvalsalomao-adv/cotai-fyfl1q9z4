migrate(
  (app) => {
    // 1. Extend users with papel and organizacao_id
    const users = app.findCollectionByNameOrId('_pb_users_auth_')
    if (!users.fields.getByName('papel')) {
      users.fields.add(
        new SelectField({
          name: 'papel',
          values: ['admin', 'gestor', 'responsavel_pesquisa', 'aprovador', 'integracoes'],
          maxSelect: 1,
        }),
      )
    }
    if (!users.fields.getByName('organizacao_id')) {
      users.fields.add(
        new TextField({
          name: 'organizacao_id',
        }),
      )
    }
    app.save(users)

    // 2. perfis_normativos
    const perfisNormativos = new Collection({
      name: 'perfis_normativos',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        { name: 'nome', type: 'text', required: true },
        {
          name: 'norma_id',
          type: 'select',
          required: true,
          values: ['lei_14133', 'in_seges_me_65'],
          maxSelect: 1,
        },
        { name: 'vigencia', type: 'date' },
        { name: 'exigencias', type: 'json' },
        { name: 'regras_especificas', type: 'json' },
        {
          name: 'metodo_permitido',
          type: 'select',
          values: ['media_ou_mediana', 'mediana', 'menor', 'media'],
          maxSelect: 1,
        },
        { name: 'autoridade_competente', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_perfis_norma_id ON perfis_normativos (norma_id)'],
    })
    app.save(perfisNormativos)

    // 3. organizacoes
    const organizacoes = new Collection({
      name: 'organizacoes',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        { name: 'nome', type: 'text', required: true },
        { name: 'cnpj', type: 'text', required: true },
        { name: 'municipio_ibge', type: 'text', required: true },
        { name: 'endereco', type: 'text' },
        { name: 'unidade', type: 'text' },
        { name: 'responsavel_legal', type: 'text' },
        {
          name: 'responsavel_pesquisa',
          type: 'relation',
          collectionId: '_pb_users_auth_',
          maxSelect: 1,
        },
        {
          name: 'origem_recursos',
          type: 'select',
          values: [
            'recursos_proprios',
            'transferencia_voluntaria_federal',
            'emenda_parlamentar',
            'outro',
          ],
          maxSelect: 1,
        },
        { name: 'regulamento_local', type: 'file', maxSelect: 1, maxSize: 10485760 },
        {
          name: 'perfil_normativo_id',
          type: 'relation',
          collectionId: perfisNormativos.id,
          maxSelect: 1,
        },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: [
        'CREATE UNIQUE INDEX idx_organizacoes_cnpj ON organizacoes (cnpj)',
        'CREATE INDEX idx_organizacoes_municipio ON organizacoes (municipio_ibge)',
      ],
    })
    app.save(organizacoes)

    // 4. demandas
    const demandas = new Collection({
      name: 'demandas',
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
          collectionId: organizacoes.id,
          maxSelect: 1,
        },
        { name: 'numero', type: 'text', required: true },
        { name: 'versao', type: 'number', required: true },
        {
          name: 'origem_recursos',
          type: 'select',
          required: true,
          values: [
            'recursos_proprios',
            'transferencia_voluntaria_federal',
            'emenda_parlamentar',
            'outro',
          ],
          maxSelect: 1,
        },
        { name: 'objeto', type: 'text', required: true },
        {
          name: 'status',
          type: 'select',
          required: true,
          values: [
            'rascunho',
            'confirmada',
            'em_pesquisa',
            'em_documentacao',
            'concluida',
            'cancelada',
          ],
          maxSelect: 1,
        },
        { name: 'responsavel_id', type: 'relation', collectionId: '_pb_users_auth_', maxSelect: 1 },
        { name: 'questoes_faltantes', type: 'json' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: [
        'CREATE INDEX idx_demandas_org_status ON demandas (organizacao_id, status)',
        'CREATE INDEX idx_demandas_numero ON demandas (numero)',
      ],
    })
    app.save(demandas)

    // 5. demanda_itens
    const demandaItens = new Collection({
      name: 'demanda_itens',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'demanda_id',
          type: 'relation',
          required: true,
          collectionId: demandas.id,
          maxSelect: 1,
        },
        { name: 'descricao', type: 'text', required: true },
        { name: 'quantidade', type: 'number', required: true },
        { name: 'unidade', type: 'text', required: true },
        { name: 'caracteristicas_essenciais', type: 'text' },
        { name: 'prazo_entrega', type: 'text' },
        { name: 'local_entrega', type: 'text' },
        { name: 'catalogo', type: 'text' },
        { name: 'anexos', type: 'file', maxSelect: 10, maxSize: 10485760 },
        { name: 'versao', type: 'number', required: true },
        { name: 'confirmado', type: 'bool' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_demanda_itens_demanda ON demanda_itens (demanda_id)'],
    })
    app.save(demandaItens)

    // 6. pesquisas
    const pesquisas = new Collection({
      name: 'pesquisas',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'demanda_item_id',
          type: 'relation',
          required: true,
          collectionId: demandaItens.id,
          maxSelect: 1,
        },
        { name: 'numero', type: 'text', required: true },
        {
          name: 'status',
          type: 'select',
          required: true,
          values: ['em_andamento', 'aguardando_revisao', 'parcial', 'concluida', 'falha'],
          maxSelect: 1,
        },
        { name: 'conectores', type: 'json' },
        { name: 'filtros', type: 'json' },
        { name: 'cobertura', type: 'json' },
        { name: 'falhas', type: 'json' },
        { name: 'inicio', type: 'date' },
        { name: 'fim', type: 'date' },
        { name: 'responsavel_id', type: 'relation', collectionId: '_pb_users_auth_', maxSelect: 1 },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_pesquisas_item_status ON pesquisas (demanda_item_id, status)'],
    })
    app.save(pesquisas)

    // 7. referencias (sem auto-referência inicial para permitir app.save)
    const referencias = new Collection({
      name: 'referencias',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'pesquisa_id',
          type: 'relation',
          required: true,
          collectionId: pesquisas.id,
          maxSelect: 1,
        },
        {
          name: 'fonte',
          type: 'select',
          required: true,
          values: ['compras_gov', 'pncp', 'manual'],
          maxSelect: 1,
        },
        { name: 'id_externo', type: 'text' },
        { name: 'item_externo', type: 'text' },
        {
          name: 'natureza_preco',
          type: 'select',
          required: true,
          values: ['estimado', 'homologado', 'contratado', 'cotacao_comercial', 'desconhecido'],
          maxSelect: 1,
        },
        { name: 'valor_original', type: 'number', required: true },
        { name: 'valor_normalizado', type: 'number' },
        { name: 'unidade', type: 'text' },
        { name: 'quantidade', type: 'number' },
        { name: 'data_contratacao', type: 'date' },
        { name: 'fornecedor', type: 'text' },
        { name: 'url', type: 'text' },
        { name: 'hash', type: 'text' },
        {
          name: 'status_revisao',
          type: 'select',
          required: true,
          values: ['pendente', 'aceito', 'excluido', 'necessita_esclarecimento'],
          maxSelect: 1,
        },
        { name: 'motivo_exclusao', type: 'text' },
        { name: 'possivel_duplicata', type: 'bool' },
        { name: 'detalhes_tecnicos', type: 'json' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: [
        'CREATE INDEX idx_referencias_pesquisa ON referencias (pesquisa_id)',
        'CREATE INDEX idx_referencias_status ON referencias (status_revisao)',
        'CREATE INDEX idx_referencias_fonte ON referencias (fonte)',
      ],
    })
    app.save(referencias)

    // Agora adicionamos o campo de auto-relação canonico_id
    referencias.fields.add(
      new RelationField({
        name: 'canonico_id',
        collectionId: referencias.id,
        maxSelect: 1,
      }),
    )
    app.save(referencias)

    // 8. evidencias
    const evidencias = new Collection({
      name: 'evidencias',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'referencia_id',
          type: 'relation',
          required: true,
          collectionId: referencias.id,
          maxSelect: 1,
        },
        { name: 'url', type: 'text' },
        { name: 'arquivo', type: 'file', maxSelect: 1, maxSize: 10485760 },
        { name: 'hash', type: 'text', required: true },
        { name: 'momento_coleta', type: 'date', required: true },
        { name: 'campo_origem', type: 'text' },
        { name: 'permissao', type: 'text' },
        { name: 'retencao', type: 'text' },
        { name: 'trecho_resposta', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_evidencias_referencia ON evidencias (referencia_id)'],
    })
    app.save(evidencias)

    // 9. decisoes_amostra
    const decisoesAmostra = new Collection({
      name: 'decisoes_amostra',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'referencia_id',
          type: 'relation',
          required: true,
          collectionId: referencias.id,
          maxSelect: 1,
        },
        {
          name: 'status',
          type: 'select',
          values: ['pendente', 'aceito', 'excluido', 'necessita_esclarecimento'],
          maxSelect: 1,
        },
        { name: 'autor_id', type: 'relation', collectionId: '_pb_users_auth_', maxSelect: 1 },
        { name: 'motivo', type: 'text' },
        { name: 'versao', type: 'number' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_decisoes_referencia ON decisoes_amostra (referencia_id)'],
    })
    app.save(decisoesAmostra)

    // 10. calculos
    const calculos = new Collection({
      name: 'calculos',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'pesquisa_id',
          type: 'relation',
          required: true,
          collectionId: pesquisas.id,
          maxSelect: 1,
        },
        {
          name: 'metodo',
          type: 'select',
          required: true,
          values: ['media', 'mediana', 'menor', 'maior'],
          maxSelect: 1,
        },
        { name: 'valores_entrada', type: 'json' },
        { name: 'arredondamento', type: 'text' },
        { name: 'resultado', type: 'number' },
        { name: 'total_item', type: 'number' },
        { name: 'total_demanda', type: 'number' },
        { name: 'versao_motor', type: 'text', required: true },
        { name: 'justificativa_metodo', type: 'text' },
        {
          name: 'status',
          type: 'select',
          values: ['rascunho', 'aprovado', 'invalidado'],
          maxSelect: 1,
        },
        { name: 'metricas_n', type: 'json' },
        { name: 'analise_outliers', type: 'json' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_calculos_pesquisa ON calculos (pesquisa_id)'],
    })
    app.save(calculos)

    // 11. processos
    const processos = new Collection({
      name: 'processos',
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
          collectionId: organizacoes.id,
          maxSelect: 1,
        },
        {
          name: 'demanda_id',
          type: 'relation',
          required: true,
          collectionId: demandas.id,
          maxSelect: 1,
        },
        { name: 'numero', type: 'text', required: true },
        {
          name: 'status',
          type: 'select',
          values: [
            'planejamento',
            'em_pesquisa',
            'em_revisao',
            'aprovado',
            'concluido',
            'arquivado',
          ],
          maxSelect: 1,
        },
        { name: 'responsavel_id', type: 'relation', collectionId: '_pb_users_auth_', maxSelect: 1 },
        { name: 'pendencia_atual', type: 'text' },
        { name: 'prazo', type: 'date' },
        { name: 'proxima_acao', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_processos_organizacao ON processos (organizacao_id)'],
    })
    app.save(processos)

    // 12. documentos
    const documentos = new Collection({
      name: 'documentos',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'processo_id',
          type: 'relation',
          required: true,
          collectionId: processos.id,
          maxSelect: 1,
        },
        {
          name: 'tipo',
          type: 'select',
          required: true,
          values: ['dfd', 'etp', 'tr', 'relatorio_precos', 'mapa_riscos', 'matriz_riscos'],
          maxSelect: 1,
        },
        { name: 'titulo', type: 'text', required: true },
        { name: 'versao', type: 'number' },
        { name: 'conteudo', type: 'json' },
        { name: 'evidencias_ids', type: 'json' },
        { name: 'modelo_id', type: 'text' },
        { name: 'modelo_versao', type: 'text' },
        { name: 'prompt_versao', type: 'text' },
        { name: 'modelo_ia', type: 'text' },
        { name: 'custo_execucao', type: 'number' },
        {
          name: 'status',
          type: 'select',
          values: ['rascunho', 'em_revisao', 'aprovado', 'assinado', 'publicado'],
          maxSelect: 1,
        },
        { name: 'hash', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: [
        'CREATE INDEX idx_documentos_proc_status_tipo ON documentos (processo_id, status, tipo)',
      ],
    })
    app.save(documentos)

    // 13. versoes_documento
    const versoesDocumento = new Collection({
      name: 'versoes_documento',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'documento_id',
          type: 'relation',
          required: true,
          collectionId: documentos.id,
          maxSelect: 1,
        },
        { name: 'numero_versao', type: 'number' },
        { name: 'conteudo', type: 'json' },
        { name: 'hash', type: 'text' },
        { name: 'motivo_alteracao', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_versoes_documento ON versoes_documento (documento_id)'],
    })
    app.save(versoesDocumento)

    // 14. aprovacoes
    const aprovacoes = new Collection({
      name: 'aprovacoes',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        {
          name: 'versao_documento_id',
          type: 'relation',
          required: true,
          collectionId: versoesDocumento.id,
          maxSelect: 1,
        },
        { name: 'agente_id', type: 'relation', collectionId: '_pb_users_auth_', maxSelect: 1 },
        { name: 'papel', type: 'text' },
        { name: 'decisao', type: 'select', values: ['aprovado', 'rejeitado'], maxSelect: 1 },
        { name: 'justificativa', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_aprovacoes_versao ON aprovacoes (versao_documento_id)'],
    })
    app.save(aprovacoes)

    // 15. integracoes
    const integracoes = new Collection({
      name: 'integracoes',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        { name: 'nome', type: 'text', required: true },
        { name: 'uso', type: 'text' },
        {
          name: 'documentation_status',
          type: 'select',
          values: ['confirmada', 'pendente', 'nao_confirmada'],
          maxSelect: 1,
        },
        { name: 'runtime_enabled', type: 'bool' },
        { name: 'condicao', type: 'text' },
        { name: 'secreto_ref', type: 'text' },
        { name: 'ambiente', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
    })
    app.save(integracoes)

    // 16. contratos
    const contratos = new Collection({
      name: 'contratos',
      type: 'base',
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != ""',
      deleteRule: '@request.auth.id != ""',
      fields: [
        { name: 'organizacao_id', type: 'relation', collectionId: organizacoes.id, maxSelect: 1 },
        { name: 'processo_id', type: 'relation', collectionId: processos.id, maxSelect: 1 },
        { name: 'numero', type: 'text' },
        {
          name: 'status',
          type: 'select',
          values: ['vigente', 'encerrado', 'rescindido'],
          maxSelect: 1,
        },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
    })
    app.save(contratos)

    // 17. auditoria
    const auditoria = new Collection({
      name: 'auditoria',
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
          collectionId: organizacoes.id,
          maxSelect: 1,
        },
        {
          name: 'agente_id',
          type: 'relation',
          required: true,
          collectionId: '_pb_users_auth_',
          maxSelect: 1,
        },
        { name: 'evento', type: 'text', required: true },
        { name: 'objeto_tipo', type: 'text' },
        { name: 'objeto_id', type: 'text' },
        { name: 'antes_depois', type: 'json' },
        { name: 'correlacao', type: 'text' },
        { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
        { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
      ],
      indexes: ['CREATE INDEX idx_auditoria_org_evento ON auditoria (organizacao_id, evento)'],
    })
    app.save(auditoria)
  },
  (app) => {
    const toDelete = [
      'auditoria',
      'contratos',
      'integracoes',
      'aprovacoes',
      'versoes_documento',
      'documentos',
      'processos',
      'calculos',
      'decisoes_amostra',
      'evidencias',
      'referencias',
      'pesquisas',
      'demanda_itens',
      'demandas',
      'organizacoes',
      'perfis_normativos',
    ]
    for (let i = 0; i < toDelete.length; i++) {
      try {
        const col = app.findCollectionByNameOrId(toDelete[i])
        app.delete(col)
      } catch (_) {}
    }
  },
)
