// Endpoint de proxy seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts e formatação unificada.
// GET /backend/v1/pncp/search?q=termo&pagina=1&tam_pagina=15&uf=RN

routerAdd(
  'GET',
  '/backend/v1/pncp/search',
  (e) => {
    try {
      const q = (e.requestInfo().query.q || '').trim()
      const pagina = (e.requestInfo().query.pagina || '1').trim()
      const tamPagina = (e.requestInfo().query.tam_pagina || '25').trim()
      const uf = (e.requestInfo().query.uf || '').trim().toUpperCase()

      if (!q) {
        return e.json(400, {
          error: 'INVALID_PARAMETER',
          message: 'O parâmetro "q" de busca é obrigatório.',
        })
      }

      console.log('[PNCP-PROXY] Iniciando busca para termo:', q, 'UF:', uf, 'Página:', pagina)

      const userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      const headers = {
        Accept: 'application/json',
        'User-Agent': userAgent,
      }

      // Função interna de requisição HTTP com try/catch rigoroso (Goja throws em timeout/DNS/egress)
      const fetchEndpoint = (targetUrl, timeoutSec) => {
        try {
          const resp = $http.send({
            url: targetUrl,
            method: 'GET',
            headers: headers,
            timeout: timeoutSec || 8,
          })
          return { ok: true, resp: resp }
        } catch (err) {
          console.log('[PNCP-PROXY] Exceção $http.send:', err.message, 'URL:', targetUrl)
          return { ok: false, error: err.message || 'Falha de rede/timeout' }
        }
      }

      // 1. Tentar busca textual de atas no endpoint real vigente do PNCP: /api/search/?tipos_documento=ata
      let urlAtas =
        'https://pncp.gov.br/api/search/?q=' +
        encodeURIComponent(q) +
        '&tipos_documento=ata&pagina=' +
        encodeURIComponent(pagina) +
        '&tam_pagina=' +
        encodeURIComponent(tamPagina)
      if (uf) {
        urlAtas += '&ufs=' + encodeURIComponent(uf)
      }

      let attempt1 = fetchEndpoint(urlAtas, 8)
      if (!attempt1.ok) {
        // Retry simples de 1x com timeout levemente maior
        attempt1 = fetchEndpoint(urlAtas, 8)
      }

      if (
        attempt1.ok &&
        attempt1.resp &&
        attempt1.resp.statusCode >= 200 &&
        attempt1.resp.statusCode < 300
      ) {
        let jsonBody = null
        try {
          jsonBody = attempt1.resp.json || JSON.parse(attempt1.resp.raw)
        } catch (jsonErr) {
          console.log('[PNCP-PROXY] Resposta não-JSON em atas:', jsonErr.message)
        }
        if (
          jsonBody &&
          (jsonBody.items || jsonBody.total !== undefined || Array.isArray(jsonBody))
        ) {
          return e.json(200, jsonBody)
        }
      }

      // 2. Tentar busca textual de editais: /api/search/?tipos_documento=edital
      let urlEditais =
        'https://pncp.gov.br/api/search/?q=' +
        encodeURIComponent(q) +
        '&tipos_documento=edital&pagina=' +
        encodeURIComponent(pagina) +
        '&tam_pagina=' +
        encodeURIComponent(tamPagina)
      if (uf) {
        urlEditais += '&ufs=' + encodeURIComponent(uf)
      }

      let attempt2 = fetchEndpoint(urlEditais, 8)
      if (
        attempt2.ok &&
        attempt2.resp &&
        attempt2.resp.statusCode >= 200 &&
        attempt2.resp.statusCode < 300
      ) {
        let jsonBody = null
        try {
          jsonBody = attempt2.resp.json || JSON.parse(attempt2.resp.raw)
        } catch (jsonErr) {
          console.log('[PNCP-PROXY] Resposta não-JSON em editais:', jsonErr.message)
        }
        if (
          jsonBody &&
          (jsonBody.items || jsonBody.total !== undefined || Array.isArray(jsonBody))
        ) {
          return e.json(200, jsonBody)
        }
      }

      // 3. Fallback: endpoint de consulta direta de atas por vigência (api/consulta/v1/atas)
      const dataHoje = new Date()
      const anoHoje = dataHoje.getFullYear().toString()
      const urlConsultaAtas =
        'https://pncp.gov.br/api/consulta/v1/atas?dataInicial=' +
        anoHoje +
        '0101&dataFinal=' +
        anoHoje +
        '1231&pagina=' +
        encodeURIComponent(pagina) +
        '&tamanhoPagina=' +
        encodeURIComponent(tamPagina)

      let attempt3 = fetchEndpoint(urlConsultaAtas, 8)
      if (
        attempt3.ok &&
        attempt3.resp &&
        attempt3.resp.statusCode >= 200 &&
        attempt3.resp.statusCode < 300
      ) {
        let jsonBody = null
        try {
          jsonBody = attempt3.resp.json || JSON.parse(attempt3.resp.raw)
        } catch (jsonErr) {
          console.log('[PNCP-PROXY] Resposta não-JSON em consulta atas:', jsonErr.message)
        }
        if (jsonBody) {
          return e.json(200, jsonBody)
        }
      }

      // Se nenhum endpoint retornou sucesso, responder 502 estruturado (NUNCA 400 nem 500 desestruturado)
      const statusFinal =
        (attempt1.resp && attempt1.resp.statusCode) ||
        (attempt2.resp && attempt2.resp.statusCode) ||
        (attempt3.resp && attempt3.resp.statusCode) ||
        502

      const detailMsg =
        attempt1.error ||
        attempt2.error ||
        attempt3.error ||
        'O PNCP retornou status HTTP ' +
          statusFinal +
          ' e nenhuma amostra válida pôde ser recuperada.'

      return e.json(502, {
        error: 'PNCP_UPSTREAM_UNAVAILABLE',
        message:
          'A API pública do PNCP está temporariamente inacessível ou não respondeu no tempo limite.',
        detail: detailMsg,
        upstreamStatus: statusFinal,
      })
    } catch (globalErr) {
      console.log('[PNCP-PROXY] Exceção não capturada no hook:', globalErr.message)
      return e.json(502, {
        error: 'PNCP_UPSTREAM_UNAVAILABLE',
        message:
          'A API pública do PNCP está temporariamente inacessível ou ocorreu falha de comunicação.',
        detail: globalErr.message || 'Erro inesperado no proxy',
      })
    }
  },
  $apis.requireAuth(),
)
