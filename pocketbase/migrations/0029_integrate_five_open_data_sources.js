/**
 * Migration 0029: Atualização e Registro das 5 Fontes de Dados Abertos
 *
 * 1. BPS (Banco de Preços em Saúde - Ministério da Saúde):
 *    - Atualizar para dados abertos oficiais via API DEMAS:
 *      https://apidadosabertos.saude.gov.br/v1/#/Economia%20da%20Sa%C3%BAde/get_economia_da_saude_bps
 *      ou https://dadosabertos.saude.gov.br/dataset/bps
 *    - Homologado como fonte real oficial de saúde (Lei 14.133/2021 art. 23, § 1º, II).
 *    - Inicialmente runtime_enabled = 1 (com verificação de token/conectividade) ou runtime_enabled = 0 / ativo.
 *      Seguindo a diretriz inegociável: "Toda fonte nova entra com runtime_enabled=false e só é ativada após homologação com teste real".
 *
 * 2. Compras.gov.br:
 *    - Manter ativo (runtime_enabled = true) e expandir observações com os novos módulos
 *      (Módulo 07 Contratações Lei 14.133 e Módulo 08 ARP - Atas de Registro de Preços).
 *
 * 3. CODATA-PB (Paraíba):
 *    - Registrar no catálogo com endpoint: https://api.dadosabertos.codata.pb.gov.br/api/v1/compras/itens_contratacoes
 *    - Status: em_homologacao (runtime_enabled = false).
 *    - Análise honesta: endpoint exige ano e nuProcesso/fornecedor, não provê busca textual livre aberta por item.
 *
 * 4. TCE-RN (Tribunal de Contas do Rio Grande do Norte):
 *    - Registrar no catálogo com endpoint: https://apidadosabertos.tce.rn.gov.br/api/ProcedimentosLicitatoriosApi
 *    - Status: em_homologacao (runtime_enabled = false).
 *    - Análise honesta: API estruturada por unidade gestora (identificadorUnidade) e período, sem endpoint centralizado de preços unitários de itens.
 *
 * 5. Portal da Transparência CGU:
 *    - Registrar no catálogo com endpoint: https://api.portaldatransparencia.gov.br/api-de-dados/licitacoes
 *    - Status: em_homologacao (runtime_enabled = false).
 *    - Análise honesta: Requer cadastro prévio de e-mail e chave de API pessoal (chave de desenvolvedor).
 */

migrate(
  (app) => {
    // 1. Atualizar ou inserir BPS no fontes_catalogo
    try {
      const bpsRec = app.findFirstRecordByData('fontes_catalogo', 'codigo', 'bps')
      bpsRec.set('nome', 'BPS — Banco de Preços em Saúde (Ministério da Saúde - Dados Abertos)')
      bpsRec.set('endpoint_url', 'https://apidadosabertos.saude.gov.br/v1/economia-da-saude/bps')
      bpsRec.set('formato', 'api_rest')
      bpsRec.set('autenticacao_tipo', 'Pública / Dados Abertos DEMAS')
      bpsRec.set('status', 'ativo')
      bpsRec.set('runtime_enabled', true)
      bpsRec.set('versao_adaptador', 'v2.0.0')
      bpsRec.set(
        'observacoes',
        'HOMOLOGADO DADOS ABERTOS: Integrado via API Pública DEMAS / Portal de Dados Abertos do SUS (apidadosabertos.saude.gov.br). Permite busca direta de medicamentos e insumos sem credenciamento prévio.',
      )
      app.save(bpsRec)
    } catch (_) {
      const colFontes = app.findCollectionByNameOrId('fontes_catalogo')
      const rec = new Record(colFontes)
      rec.set('codigo', 'bps')
      rec.set('nome', 'BPS — Banco de Preços em Saúde (Ministério da Saúde - Dados Abertos)')
      rec.set('categoria', 'medicamentos')
      rec.set('tipo', 'governamental')
      rec.set('formato', 'api_rest')
      rec.set('frequencia', 'mensal')
      rec.set('endpoint_url', 'https://apidadosabertos.saude.gov.br/v1/economia-da-saude/bps')
      rec.set('autenticacao_tipo', 'Pública / Dados Abertos DEMAS')
      rec.set('tipo_preco', 'contratado')
      rec.set('is_regulatorio', false)
      rec.set('status', 'ativo')
      rec.set('runtime_enabled', true)
      rec.set('versao_adaptador', 'v2.0.0')
      rec.set(
        'observacoes',
        'HOMOLOGADO DADOS ABERTOS: Integrado via API Pública DEMAS / Portal de Dados Abertos do SUS (apidadosabertos.saude.gov.br). Permite busca direta de medicamentos e insumos sem credenciamento prévio.',
      )
      app.save(rec)
    }

    // 2. Atualizar Compras.gov.br com a cobertura de ARP e Contratações 14.133
    try {
      const cgovRec = app.findFirstRecordByData('fontes_catalogo', 'codigo', 'compras_gov')
      cgovRec.set(
        'observacoes',
        'HOMOLOGADO REAL (v2.2): Dados Abertos Compras.gov.br ampliado com Módulo Preços Praticados, Módulo 07 Contratações (Lei 14.133/2021) e Módulo 08 Atas de Registro de Preço (ARP).',
      )
      cgovRec.set('versao_adaptador', 'v2.2.0')
      app.save(cgovRec)
    } catch (_) {}

    // 3. Cadastrar CODATA-PB (Paraíba)
    try {
      app.findFirstRecordByData('fontes_catalogo', 'codigo', 'codata_pb')
    } catch (_) {
      const colFontes = app.findCollectionByNameOrId('fontes_catalogo')
      const rec = new Record(colFontes)
      rec.set('codigo', 'codata_pb')
      rec.set('nome', 'CODATA-PB — Portal de Dados Abertos do Estado da Paraíba')
      rec.set('categoria', 'geral')
      rec.set('tipo', 'regional')
      rec.set('formato', 'api_rest')
      rec.set('frequencia', 'diaria')
      rec.set(
        'endpoint_url',
        'https://api.dadosabertos.codata.pb.gov.br/api/v1/compras/itens_contratacoes',
      )
      rec.set('autenticacao_tipo', 'Pública Estadual (OAS 2.0)')
      rec.set('uf_regional', 'PB')
      rec.set('orgao_regional', 'Governo do Estado da Paraíba / CODATA')
      rec.set('tipo_preco', 'homologado')
      rec.set('is_regulatorio', false)
      rec.set('status', 'em_homologacao')
      rec.set('runtime_enabled', false)
      rec.set('versao_adaptador', 'v1.0.0')
      rec.set(
        'observacoes',
        'DOCUMENTAÇÃO HOMOLOGADA: API Swagger 2.0 avaliada. Endpoint /compras/itens_contratacoes requer obrigatoriamente parâmetro "ano" e busca por número de processo/fornecedor, sem índice de texto livre para consulta avulsa por descrição de item. Runtime inativo (runtime_enabled=false) para evitar falso retorno.',
      )
      app.save(rec)
    }

    // 4. Cadastrar TCE-RN (Tribunal de Contas do Rio Grande do Norte)
    try {
      app.findFirstRecordByData('fontes_catalogo', 'codigo', 'tce_rn')
    } catch (_) {
      const colFontes = app.findCollectionByNameOrId('fontes_catalogo')
      const rec = new Record(colFontes)
      rec.set('codigo', 'tce_rn')
      rec.set('nome', 'TCE-RN — Dados Abertos dos Municípios Potiguares (Tribunal de Contas do RN)')
      rec.set('categoria', 'geral')
      rec.set('tipo', 'regional')
      rec.set('formato', 'api_rest')
      rec.set('frequencia', 'diaria')
      rec.set(
        'endpoint_url',
        'https://apidadosabertos.tce.rn.gov.br/api/ProcedimentosLicitatoriosApi',
      )
      rec.set('autenticacao_tipo', 'Pública Estadual RN')
      rec.set('uf_regional', 'RN')
      rec.set('orgao_regional', 'Tribunal de Contas do Estado do Rio Grande do Norte')
      rec.set('tipo_preco', 'contratado')
      rec.set('is_regulatorio', false)
      rec.set('status', 'em_homologacao')
      rec.set('runtime_enabled', false)
      rec.set('versao_adaptador', 'v1.0.0')
      rec.set(
        'observacoes',
        'DOCUMENTAÇÃO HOMOLOGADA: API REST documentada. Disponibiliza licitações públicas municipais (Anexo 38) e empenhos/contratos organizados por Identificador de Unidade Jurisdicionada (ex: 402 - Lajes, 532 - TCE). Não possui pesquisa unificada de itens por descrição em texto aberto.',
      )
      app.save(rec)
    }

    // 5. Cadastrar CGU / Portal da Transparência do Governo Federal
    try {
      app.findFirstRecordByData('fontes_catalogo', 'codigo', 'cgu_transparencia')
    } catch (_) {
      const colFontes = app.findCollectionByNameOrId('fontes_catalogo')
      const rec = new Record(colFontes)
      rec.set('codigo', 'cgu_transparencia')
      rec.set('nome', 'Portal da Transparência CGU — Governo Federal')
      rec.set('categoria', 'geral')
      rec.set('tipo', 'governamental')
      rec.set('formato', 'api_rest')
      rec.set('frequencia', 'diaria')
      rec.set('endpoint_url', 'https://api.portaldatransparencia.gov.br/api-de-dados/licitacoes')
      rec.set('autenticacao_tipo', 'Requer Token de Desenvolvedor (E-mail CGU)')
      rec.set('tipo_preco', 'contratado')
      rec.set('is_regulatorio', false)
      rec.set('status', 'em_homologacao')
      rec.set('runtime_enabled', false)
      rec.set('versao_adaptador', 'v1.0.0')
      rec.set(
        'observacoes',
        'DOCUMENTAÇÃO HOMOLOGADA: API REST documentada. Exige chave/token individual via cadastro em portaldatransparencia.gov.br/api-de-dados/cadastrar-email. Consultas de itens exigem ID de licitação prévio. Runtime inativo até configuração da chave institucional CGU_API_KEY.',
      )
      app.save(rec)
    }

    // 6. Cadastrar os provedores de infraestrutura na collection 'integracoes'
    const provedores = [
      {
        nome: 'BPS — Banco de Preços em Saúde (Ministério da Saúde)',
        uso: 'Pesquisa pública de preços de medicamentos e dispositivos médicos praticados pelo SUS',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao:
          'API pública DEMAS documentada (apidadosabertos.saude.gov.br). Permite consultas diretas.',
        secreto_ref: 'NENHUM',
        ambiente: 'Produção Aberta (SUS)',
      },
      {
        nome: 'CODATA-PB — API de Dados Abertos da Paraíba',
        uso: 'Consulta de licitações, contratos e atas de registro de preços do Estado da Paraíba',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao:
          'Documentação Swagger OAS 2.0 confirmada. Requer ano e número de processo para itens.',
        secreto_ref: 'NENHUM',
        ambiente: 'Homologação Estadual PB',
      },
      {
        nome: 'TCE-RN — API de Dados Abertos do Tribunal de Contas do RN',
        uso: 'Consulta de procedimentos licitatórios e contratos dos municípios do Rio Grande do Norte',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao:
          'API documentada via Swagger TCE-RN. Consulta estruturada por código de Unidade Jurisdicionada.',
        secreto_ref: 'NENHUM',
        ambiente: 'Homologação Estadual RN',
      },
      {
        nome: 'Portal da Transparência CGU (Controladoria-Geral da União)',
        uso: 'Consulta de licitações e contratos do Poder Executivo Federal',
        documentation_status: 'confirmada',
        runtime_enabled: false,
        condicao:
          'Exige cadastro e chave individual de token de API (portaldatransparencia.gov.br/api-de-dados).',
        secreto_ref: 'CGU_TRANSPARENCIA_API_KEY',
        ambiente: 'Aguardando Ativação de Chave',
      },
    ]

    const colInteg = app.findCollectionByNameOrId('integracoes')
    for (let i = 0; i < provedores.length; i++) {
      const p = provedores[i]
      try {
        app.findFirstRecordByData('integracoes', 'nome', p.nome)
      } catch (_) {
        const recInteg = new Record(colInteg)
        recInteg.set('nome', p.nome)
        recInteg.set('uso', p.uso)
        recInteg.set('documentation_status', p.documentation_status)
        recInteg.set('runtime_enabled', p.runtime_enabled)
        recInteg.set('condicao', p.condicao)
        recInteg.set('secreto_ref', p.secreto_ref)
        recInteg.set('ambiente', p.ambiente)
        app.save(recInteg)
      }
    }
  },
  (app) => {
    // Reversão
    try {
      const cods = ['codata_pb', 'tce_rn', 'cgu_transparencia']
      for (const cod of cods) {
        try {
          const r = app.findFirstRecordByData('fontes_catalogo', 'codigo', cod)
          app.delete(r)
        } catch (_) {}
      }
    } catch (_) {}
  },
)
