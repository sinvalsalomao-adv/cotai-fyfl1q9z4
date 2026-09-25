// Endpoint de proxy seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts, paginação e enriquecimento de itens reais.
// GET /backend/v1/pncp/search?q=termo&pagina=1&tam_pagina=25&uf=RN

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

      // Função auxiliar para enriquecer compras/atas com os itens oficiais
      // GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}/itens
      const enrichItems = (rawJson) => {
        if (!rawJson) return rawJson
        const items = Array.isArray(rawJson)
          ? rawJson
          : Array.isArray(rawJson.items)
            ? rawJson.items
            : Array.isArray(rawJson.data)
              ? rawJson.data
              : []

        if (!items || items.length === 0) return rawJson

        // Limite de compras enriquecidas por requisição (ex: primeiras 8 compras) para evitar estourar tempo de resposta
        const limitToEnrich = Math.min(items.length, 8)
        const qUpper = q.toUpperCase()

        for (let i = 0; i < limitToEnrich; i++) {
          const entry = items[i]
          // Se já possui itensAta com valorUnitario, pula
          if (Array.isArray(entry.itensAta) && entry.itensAta.length > 0) {
            const hasValidPrice = entry.itensAta.some(function (it) {
              return (
                (Number(it.valorUnitarioHomologado) ||
                  Number(it.valorUnitarioEstimado) ||
                  Number(it.valorUnitario)) > 0
              )
            })
            if (hasValidPrice) continue
          }

          // Extrair CNPJ, ano e sequencial da compra
          const orgaoCnpj = (
            (entry.orgaoEntidade && entry.orgaoEntidade.cnpj) ||
            (entry.orgaoSubRogado && entry.orgaoSubRogado.cnpj) ||
            entry.orgao_cnpj ||
            entry.cnpj ||
            ''
          ).replace(/\D/g, '')

          let ano = entry.anoCompra || entry.ano || entry.anoAta || 0
          let sequencial =
            entry.sequencialCompra ||
            entry.numeroSequencialCompra ||
            entry.numeroSequencialAta ||
            entry.numero_sequencial ||
            0

          // Se tiver numeroControlePNCP (ex: 08241747000143-1-000005/2024), extrai dele
          const numControle =
            entry.numeroControlePNCP ||
            entry.numero_controle_pncp ||
            entry.numeroControlePncpCompra ||
            ''
          if ((!ano || !sequencial) && numControle && numControle.indexOf('/') !== -1) {
            const parts = numControle.split('/')
            ano = parseInt(parts[1], 10) || ano
            const leftParts = parts[0].split('-')
            if (leftParts.length >= 3) {
              sequencial = parseInt(leftParts[2], 10) || sequencial
            }
          }

          if (!orgaoCnpj || !ano || !sequencial) continue

          const itensUrl =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            orgaoCnpj +
            '/compras/' +
            ano +
            '/' +
            sequencial +
            '/itens?pagina=1&tamanhoPagina=20'

          const itensAttempt = fetchEndpoint(itensUrl, 4)
          if (
            itensAttempt.ok &&
            itensAttempt.resp &&
            itensAttempt.resp.statusCode >= 200 &&
            itensAttempt.resp.statusCode < 300
          ) {
            try {
              const itensBody = itensAttempt.resp.json || JSON.parse(itensAttempt.resp.raw)
              const itensArray = Array.isArray(itensBody)
                ? itensBody
                : Array.isArray(itensBody.items)
                  ? itensBody.items
                  : Array.isArray(itensBody.data)
                    ? itensBody.data
                    : []

              if (itensArray && itensArray.length > 0) {
                // Filtrar os itens que correspondem ao termo buscado ou pegar todos se poucos
                let matchedItens = itensArray.filter(function (it) {
                  const desc = (it.descricao || it.materialOuServicoNome || '').toUpperCase()
                  return desc.indexOf(qUpper) !== -1
                })

                if (matchedItens.length === 0) {
                  // Se nenhum item deu match direto pelo termo exato, pegar os primeiros 3 itens com preço
                  matchedItens = itensArray.slice(0, 3)
                }

                entry.itensAta = matchedItens.map(function (it) {
                  return {
                    numeroItem: it.numeroItem || 1,
                    descricao: it.descricao || it.materialOuServicoNome || entry.objeto,
                    materialOuServico: it.materialOuServico || 'CATMAT',
                    materialOuServicoNome: it.materialOuServicoNome || '',
                    valorUnitarioHomologado:
                      Number(it.valorUnitarioHomologado) ||
                      Number(it.valorUnitarioEstimado) ||
                      Number(it.valorUnitario) ||
                      0,
                    valorUnitarioEstimado: Number(it.valorUnitarioEstimado) || 0,
                    quantidade: Number(it.quantidade) || 1,
                    unidadeMedida: it.unidadeMedida || 'UN',
                    marcaNome: it.marcaNome || 'NÃO INFORMADO',
                    modeloNome: it.modeloNome || '',
                  }
                })
              }
            } catch (errItens) {
              console.log(
                '[PNCP-PROXY] Erro ao processar itens de compra:',
                orgaoCnpj,
                ano,
                sequencial,
                errItens.message,
              )
            }
          }
        }

        return rawJson
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
          jsonBody = enrichItems(jsonBody)
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
          jsonBody = enrichItems(jsonBody)
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
          jsonBody = enrichItems(jsonBody)
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
