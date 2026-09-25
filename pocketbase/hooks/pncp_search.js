// Endpoint de proxy seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts e formatação unificada.
// GET /backend/v1/pncp/search?q=termo&pagina=1&tam_pagina=15&uf=RN

routerAdd('GET', '/backend/v1/pncp/search', (e) => {
  try {
    const q = e.requestInfo().query.q || ''
    const pagina = e.requestInfo().query.pagina || '1'
    const tamPagina = e.requestInfo().query.tam_pagina || '15'
    const uf = e.requestInfo().query.uf || ''

    if (!q || q.trim() === '') {
      return e.json(400, { error: 'O parâmetro "q" de busca é obrigatório.' })
    }

    console.log('[PNCP-PROXY] Iniciando busca para termo:', q, 'UF:', uf, 'Página:', pagina)

    // 1. Consulta /api/search/v1/atas (atas de registro de preços)
    let url =
      'https://pncp.gov.br/api/search/v1/atas?q=' +
      encodeURIComponent(q.trim()) +
      '&pagina=' +
      pagina +
      '&tam_pagina=' +
      tamPagina
    if (uf && uf.trim() !== '') {
      url += '&uf=' + encodeURIComponent(uf.trim().toUpperCase())
    }

    let res = null
    try {
      res = $http.send({
        url: url,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 25,
      })
      console.log('[PNCP-PROXY] Atas status:', res ? res.statusCode : 'null')
    } catch (errHttp) {
      console.log('[PNCP-PROXY] Erro ao chamar atas:', errHttp.message)
    }

    if (res && res.statusCode >= 200 && res.statusCode < 300) {
      return e.json(200, res.json)
    }

    // 2. Se atas falhar, tenta documentos/editais gerais
    const fallbackUrl =
      'https://pncp.gov.br/api/search/v1/documentos?q=' +
      encodeURIComponent(q.trim()) +
      '&tipos_documento=edital&pagina=' +
      pagina +
      '&tam_pagina=' +
      tamPagina
    let resFallback = null
    try {
      resFallback = $http.send({
        url: fallbackUrl,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 25,
      })
      console.log('[PNCP-PROXY] Documentos status:', resFallback ? resFallback.statusCode : 'null')
    } catch (errFallback) {
      console.log('[PNCP-PROXY] Erro ao chamar documentos:', errFallback.message)
    }

    if (resFallback && resFallback.statusCode >= 200 && resFallback.statusCode < 300) {
      return e.json(200, resFallback.json)
    }

    // 3. Se atas e documentos falharem, tenta consulta de contratações
    const anoAtual = new Date().getFullYear().toString()
    const urlContratacoes =
      'https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=' +
      anoAtual +
      '0101&dataFinal=' +
      anoAtual +
      '1231&pagina=' +
      pagina +
      '&tamanhoPagina=' +
      tamPagina
    let resContratacoes = null
    try {
      resContratacoes = $http.send({
        url: urlContratacoes,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 25,
      })
      console.log(
        '[PNCP-PROXY] Contratacoes status:',
        resContratacoes ? resContratacoes.statusCode : 'null',
      )
    } catch (errContrat) {
      console.log('[PNCP-PROXY] Erro ao chamar contratações:', errContrat.message)
    }

    if (resContratacoes && resContratacoes.statusCode >= 200 && resContratacoes.statusCode < 300) {
      return e.json(200, resContratacoes.json)
    }

    const finalStatus =
      (res && res.statusCode) ||
      (resFallback && resFallback.statusCode) ||
      (resContratacoes && resContratacoes.statusCode) ||
      502
    return e.json(finalStatus, {
      error: 'A API oficial do PNCP retornou status ' + finalStatus,
      detalhes: res ? res.raw : 'Sem resposta do PNCP',
    })
  } catch (err) {
    return e.json(500, {
      error: 'Falha na comunicação com a API do PNCP: ' + err.message,
    })
  }
})
