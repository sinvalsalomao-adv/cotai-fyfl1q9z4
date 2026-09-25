migrate(
  (app) => {
    // 1. Ativar Compras.gov.br como segunda fonte real homologada
    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 1, status = 'ativo', observacoes = 'HOMOLOGADO REAL (v2.1): Dados Abertos e Módulo de Preços Praticados com CATMAT/CATSER.', updated = DATETIME('now') WHERE codigo = 'compras_gov'",
      )
      .execute()

    // 2. Garantir que PNCP permaneça ativo e homologado
    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 1, status = 'ativo', observacoes = 'HOMOLOGADO REAL (v2.1): Portal Nacional de Contratações Públicas (Lei 14.133/2021).', updated = DATETIME('now') WHERE codigo = 'pncp'",
      )
      .execute()

    // 3. Atualizar status e anotações das fontes públicas para ingestão (BPS, CMED, SINAPI, SICRO, CONAB)
    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 0, status = 'em_homologacao', observacoes = 'AGUARDA CREDENCIAMENTO: Ministério da Saúde exige credenciamento de órgão contratante.', updated = DATETIME('now') WHERE codigo = 'bps'",
      )
      .execute()

    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 0, status = 'em_homologacao', observacoes = 'TABELA REGULATÓRIA PÚBLICA (ANVISA): Teto de Preço Fábrica (PF) e PMC. Preços máximos, não contratados.', updated = DATETIME('now') WHERE codigo = 'cmed'",
      )
      .execute()

    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 0, status = 'em_homologacao', observacoes = 'TABELA OFICIAL PÚBLICA (CAIXA/IBGE): Insumos e composições da construção civil (Lei 14.133 art. 23 §2º).', updated = DATETIME('now') WHERE codigo = 'sinapi'",
      )
      .execute()

    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 0, status = 'em_homologacao', observacoes = 'TABELA OFICIAL PÚBLICA (DNIT): Custos unitários rodoviários e obras de infraestrutura.', updated = DATETIME('now') WHERE codigo = 'sicro'",
      )
      .execute()

    app
      .db()
      .newQuery(
        "UPDATE fontes_catalogo SET runtime_enabled = 0, status = 'em_homologacao', observacoes = 'BOLETIM PÚBLICO (CONAB/CEASA): Preços médios atacado de alimentos e agricultura.', updated = DATETIME('now') WHERE codigo = 'conab'",
      )
      .execute()

    // 4. Inserir fontes estaduais, privadas comerciais, notas fiscais e rede de municípios
    const novasFontes = [
      {
        codigo: 'seinfra_ce',
        nome: 'SEINFRA — Tabela de Custos de Obras e Serviços (Ceará)',
        tipo: 'regional',
        categoria: 'obras',
        formato: 'xlsx',
        frequencia: 'mensal',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.seinfra.ce.gov.br/tabela-de-custos',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'CE',
        orgao_regional: 'Governo do Estado do Ceará',
        tipo_preco: 'tabela',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Referencial estadual de obras civis e infraestrutura.',
      },
      {
        codigo: 'setop_mg',
        nome: 'SETOP / SEINFRA — Planilha de Custos (Minas Gerais)',
        tipo: 'regional',
        categoria: 'obras',
        formato: 'xlsx',
        frequencia: 'mensal',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.infraestrutura.mg.gov.br/obras/custos',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'MG',
        orgao_regional: 'Governo de Minas Gerais',
        tipo_preco: 'tabela',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Tabela de preços de obras e serviços de engenharia MG.',
      },
      {
        codigo: 'compras_mg',
        nome: 'Portal de Compras MG (Compras Minas Gerais)',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.compras.mg.gov.br',
        autenticacao_tipo: 'Pública Estadual / Requer Convênio',
        uf_regional: 'MG',
        orgao_regional: 'Governo do Estado de Minas Gerais',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA CREDENCIAMENTO: Cobertura de contratações estaduais mineiras.',
      },
      {
        codigo: 'compras_df',
        nome: 'Compras DF — Portal de Compras do Distrito Federal',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.compras.df.gov.br',
        autenticacao_tipo: 'Pública Distrital / Requer Convênio',
        uf_regional: 'DF',
        orgao_regional: 'Governo do Distrito Federal',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA CREDENCIAMENTO: Licitações e compras diretas do GDF.',
      },
      {
        codigo: 'compras_es',
        nome: 'SIGA / Compras ES — Estado do Espírito Santo',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://compras.es.gov.br',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'ES',
        orgao_regional: 'Governo do Espírito Santo',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Catálogo e histórico de compras públicas do ES.',
      },
      {
        codigo: 'compras_rs',
        nome: 'CELIC / Compras RS — Central de Licitações do Rio Grande do Sul',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://compras.rs.gov.br',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'RS',
        orgao_regional: 'Governo do Rio Grande do Sul',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Compras e atas de registro de preços do RS.',
      },
      {
        codigo: 'compras_rj',
        nome: 'SIGA / Compras RJ — Governo do Estado do Rio de Janeiro',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.compras.rj.gov.br',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'RJ',
        orgao_regional: 'Governo do Rio de Janeiro',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Pregões e atas do estado do RJ.',
      },
      {
        codigo: 'compras_go',
        nome: 'ComprasNet GO / Goiás — Portal de Compras',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://comprasnet.go.gov.br',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'GO',
        orgao_regional: 'Governo de Goiás',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Contratações públicas de Goiás.',
      },
      {
        codigo: 'compras_pb',
        nome: 'Central de Compras PB — Paraíba',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://compras.pb.gov.br',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'PB',
        orgao_regional: 'Governo da Paraíba',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Histórico de preços governamentais PB.',
      },
      {
        codigo: 'compras_mt',
        nome: 'SIAG / Compras MT — Mato Grosso',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://aquisicoes.seplag.mt.gov.br',
        autenticacao_tipo: 'Pública Estadual',
        uf_regional: 'MT',
        orgao_regional: 'Governo de Mato Grosso',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA HOMOLOGAÇÃO: Sistema de aquisições de MT.',
      },
      {
        codigo: 'licitacoes_e',
        nome: 'Licitações-e — Banco do Brasil',
        tipo: 'governamental',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.licitacoes-e.com.br',
        autenticacao_tipo: 'Requer Contrato / BB',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA CREDENCIAMENTO: Plataforma de pregões do Banco do Brasil.',
      },
      {
        codigo: 'portal_compras_publicas',
        nome: 'Portal de Compras Públicas (Privado Comercial)',
        tipo: 'comercial',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.portaldecompraspublicas.com.br',
        autenticacao_tipo: 'API Privada Comercial / Contrato',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes:
          'AGUARDA CREDENCIAMENTO: Portal privado com contratações de centenas de municípios.',
      },
      {
        codigo: 'bbmnet',
        nome: 'BBMNET Licitações (Bolsa Brasileira de Mercadorias)',
        tipo: 'comercial',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.novobbmnet.com.br',
        autenticacao_tipo: 'API Privada Comercial / Convênio',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA CREDENCIAMENTO: Pregões eletrônicos municipais e estaduais BBMNET.',
      },
      {
        codigo: 'licitanet',
        nome: 'LicitaNET — Licitações Online (Privado Comercial)',
        tipo: 'comercial',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://licitanet.com.br',
        autenticacao_tipo: 'API Privada Comercial / Contrato',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes: 'AGUARDA CREDENCIAMENTO: Sistema privado de pregões e cotações.',
      },
      {
        codigo: 'banrisul_compras',
        nome: 'Banrisul Compras Eletrônicas',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.pregaoonlinebanrisul.com.br',
        autenticacao_tipo: 'Requer Convênio Bancário',
        uf_regional: 'RS',
        orgao_regional: 'Banrisul',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes:
          'AGUARDA CREDENCIAMENTO: Plataforma de pregões do Banrisul para entes gaúchos.',
      },
      {
        codigo: 'nfe_estaduais_rede',
        nome: 'Rede de Notas Fiscais Eletrônicas (NF-e) — 20+ Estados (AC, AL, AM, AP, BA, DF, ES, MA, MT, PA, PE, PI, PR, RJ, RN, RO, RR, RS, SE, TO)',
        tipo: 'governamental',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'tempo_real',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://www.nfe.fazenda.gov.br',
        autenticacao_tipo: 'Convênio SEFAZ por Estado (Art. 23 Lei 14.133)',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes:
          'AGUARDA CONVÊNIO: Consulta a bases fiscais de NF-e requer termo de cooperação técnica individual com a SEFAZ de cada UF.',
      },
      {
        codigo: 'municipios_rede',
        nome: 'Rede Nacional de Municípios — Contratações Similares (687+ Portais Municipais)',
        tipo: 'regional',
        categoria: 'geral',
        formato: 'api_rest',
        frequencia: 'diaria',
        status: 'em_homologacao',
        runtime_enabled: false,
        endpoint_url: 'https://pncp.gov.br/app/editais',
        autenticacao_tipo: 'Ingestão Unificada via PNCP + Convênios Homologados',
        tipo_preco: 'contratado',
        is_regulatorio: false,
        versao_adaptador: 'v1.0.0',
        observacoes:
          'EXPANSÃO VIA PNCP: A cobertura dos 687+ municípios entra primariamente pela centralização obrigatória do PNCP (Lei 14.133/2021) e secundariamente por convênios individuais homologados sem web scraping.',
      },
    ]

    const col = app.findCollectionByNameOrId('fontes_catalogo')
    for (const f of novasFontes) {
      try {
        const existente = app.findFirstRecordByData('fontes_catalogo', 'codigo', f.codigo)
        if (existente) {
          existente.set('nome', f.nome)
          existente.set('tipo', f.tipo)
          existente.set('categoria', f.categoria)
          existente.set('formato', f.formato)
          existente.set('status', f.status)
          existente.set('runtime_enabled', f.runtime_enabled)
          existente.set('endpoint_url', f.endpoint_url)
          existente.set('autenticacao_tipo', f.autenticacao_tipo)
          existente.set('uf_regional', f.uf_regional || '')
          existente.set('orgao_regional', f.orgao_regional || '')
          existente.set('tipo_preco', f.tipo_preco)
          existente.set('versao_adaptador', f.versao_adaptador)
          existente.set('observacoes', f.observacoes)
          app.save(existente)
        } else {
          const record = new Record(col)
          record.set('codigo', f.codigo)
          record.set('nome', f.nome)
          record.set('tipo', f.tipo)
          record.set('categoria', f.categoria)
          record.set('formato', f.formato)
          record.set('frequencia', f.frequencia)
          record.set('status', f.status)
          record.set('runtime_enabled', f.runtime_enabled)
          record.set('endpoint_url', f.endpoint_url)
          record.set('autenticacao_tipo', f.autenticacao_tipo)
          record.set('uf_regional', f.uf_regional || '')
          record.set('orgao_regional', f.orgao_regional || '')
          record.set('tipo_preco', f.tipo_preco)
          record.set('is_regulatorio', f.is_regulatorio)
          record.set('versao_adaptador', f.versao_adaptador)
          record.set('observacoes', f.observacoes)
          app.save(record)
        }
      } catch (err) {
        console.log('[MIGRATION 0014] Erro ao salvar fonte: ' + f.codigo + ' => ' + err.message)
      }
    }
  },
  (app) => {
    app
      .db()
      .newQuery("UPDATE fontes_catalogo SET runtime_enabled = 0 WHERE codigo = 'compras_gov'")
      .execute()
  },
)
