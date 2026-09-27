/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId('fontes_catalogo')

    // Verificar se o Portal de Compras Públicas já existe no catálogo
    let recordExistente = null
    try {
      recordExistente = app.findFirstRecordByFilter(
        'fontes_catalogo',
        "codigo = 'portal_compras_publicas' || codigo = 'pcp'",
      )
    } catch {
      recordExistente = null
    }

    const payload = {
      nome: 'Portal de Compras Públicas',
      codigo: 'portal_compras_publicas',
      tipo: 'comercial', // valores válidos: governamental | regulatoria | comercial | tabela_oficial | regional | propria
      categoria: 'geral', // valores válidos: geral | medicamentos | saude | obras | alimentacao | veiculos | tecnologia
      formato: 'api_rest',
      frequencia: 'diaria',
      status: 'em_homologacao', // valores válidos: ativo | inativo | em_homologacao | desatualizado | manutencao
      runtime_enabled: false,
      endpoint_url: 'https://apipcp.portaldecompraspublicas.com.br/comprador/apidoc/',
      autenticacao_tipo: 'Privada / Token de Comprador Credenciado',
      tipo_preco: 'homologado',
      is_regulatorio: false,
      versao_adaptador: 'v1.0.0',
      observacoes:
        'AGUARDA CREDENCIAMENTO: API do Portal de Compras Públicas (apipcp.portaldecompraspublicas.com.br) exige autenticação via Token de Comprador ou PublicKey institucional parceira. Conector e proxy COTAI implementados e integrados. Chave configurável via secret PORTAL_COMPRAS_PUBLICAS_API_KEY. Conforme Lei 14.133/2021, o sistema não substitui silenciosamente por dados sintéticos.',
    }

    if (recordExistente) {
      recordExistente.set('nome', payload.nome)
      recordExistente.set('tipo', payload.tipo)
      recordExistente.set('categoria', payload.categoria)
      recordExistente.set('formato', payload.formato)
      recordExistente.set('frequencia', payload.frequencia)
      recordExistente.set('status', payload.status)
      recordExistente.set('runtime_enabled', payload.runtime_enabled)
      recordExistente.set('endpoint_url', payload.endpoint_url)
      recordExistente.set('autenticacao_tipo', payload.autenticacao_tipo)
      recordExistente.set('tipo_preco', payload.tipo_preco)
      recordExistente.set('is_regulatorio', payload.is_regulatorio)
      recordExistente.set('versao_adaptador', payload.versao_adaptador)
      recordExistente.set('observacoes', payload.observacoes)
      app.save(recordExistente)
    } else {
      const novoRecord = new Record(collection, payload)
      app.save(novoRecord)
    }
  },
  (app) => {
    try {
      const record = app.findFirstRecordByFilter(
        'fontes_catalogo',
        "codigo = 'portal_compras_publicas'",
      )
      if (record) {
        app.delete(record)
      }
    } catch {
      // ignora
    }
  },
)
