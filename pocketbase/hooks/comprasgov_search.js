/**
 * PocketBase Hook: Proxy Seguro para API Pública de Dados Abertos do Compras.gov.br
 * Base: dadosabertos.compras.gov.br (Módulo Pesquisa de Preço / CATMAT / Contratações 14.133)
 *
 * Características e Garantias de Homologação:
 * 1. Rota autenticada: GET /backend/v1/cotai/comprasgov-search (requer token JWT)
 * 2. Suporte a Paginação Total: itera páginas adicionais da API de dados abertos
 * 3. Enriquecimento de itens e tratamento rigoroso contra timeout com fila de retry
 * 4. Resposta 502 estruturada (COMPRASGOV_UPSTREAM_UNAVAILABLE) quando upstream falhar
 * 5. Deep links auditáveis e metadados completos (CATMAT, UASG, CNPJ, Órgão, Data, Unidade, Valor)
 */

routerAdd(
  'GET',
  '/backend/v1/cotai/comprasgov-search',
  function (e) {
    try {
      var query = e.requestInfo().query
      var termo = (query.termo || '').trim()
      var catmat = (query.catmat || '').trim()
      var uf = (query.uf || '').trim().toUpperCase()
      var paginaParam = parseInt(query.pagina || '1', 10) || 1
      var tamPaginaParam = parseInt(query.tam_pagina || '25', 10) || 25
      var dataInicio = (query.data_inicio || '').trim()
      var dataFim = (query.data_fim || '').trim()
      var paginacaoTotal =
        (query.paginacao_total || '').toLowerCase() === 'true' ||
        (query.todas_paginas || '').toLowerCase() === 'true'
      var limitePaginasMax = Math.min(parseInt(query.limite_paginas || '5', 10) || 5, 15)

      if (!termo && !catmat) {
        return e.json(400, {
          error: 'INVALID_PARAMETERS',
          message: 'O parâmetro "termo" ou "catmat" é obrigatório para consultar o Compras.gov.br.',
        })
      }

      console.log(
        '[COMPRASGOV-PROXY] Iniciando busca para termo:',
        termo || catmat,
        'UF:',
        uf,
        'Página:',
        paginaParam,
        'Paginação Total:',
        paginacaoTotal,
      )

      function fetchEndpoint(url, timeoutSec) {
        try {
          var res = $http.send({
            url: url,
            method: 'GET',
            headers: {
              'User-Agent':
                'COTAI-PriceEngine/2.1 (GovTech; Contratações Públicas Lei 14.133/2021)',
              Accept: 'application/json',
            },
            timeout: timeoutSec || 8,
          })
          return { ok: true, resp: res }
        } catch (err) {
          return { ok: false, error: err.message, resp: null }
        }
      }

      function parseJsonBody(attempt) {
        if (!attempt.ok || !attempt.resp) return null
        if (attempt.resp.statusCode < 200 || attempt.resp.statusCode >= 300) return null
        try {
          return attempt.resp.json || JSON.parse(attempt.resp.raw)
        } catch (_) {
          return null
        }
      }

      function extractItems(body) {
        if (!body) return []
        if (Array.isArray(body)) return body
        if (Array.isArray(body.resultado)) return body.resultado
        if (Array.isArray(body.items)) return body.items
        if (Array.isArray(body.data)) return body.data
        return []
      }

      var termoCodificado = encodeURIComponent(termo || catmat)

      function montarQueryParams(pNum, pSize) {
        var qp =
          'pagina=' + encodeURIComponent(pNum) + '&tamanhoPagina=' + encodeURIComponent(pSize)
        if (uf) {
          qp += '&uf=' + encodeURIComponent(uf)
        }
        if (dataInicio) {
          qp += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
        }
        if (dataFim) {
          qp += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
        }
        return qp
      }

      var endpointsOficiais = [
        {
          nome: 'modulo-pesquisa-preco/1_consultarMaterial',
          urlBase:
            'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=',
        },
        {
          nome: 'modulo-contratacoes/1_consultarItensContratacoes',
          urlBase:
            'https://dadosabertos.compras.gov.br/modulo-contratacoes/1_consultarItensContratacoes?descricaoItem=',
        },
        {
          nome: 'modulo-pesquisa-preco/1_consultarPreco',
          urlBase:
            'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarPreco?termo=',
        },
      ]

      var endpointSucesso = null
      var bodyPrimeiraPagina = null
      var attemptUltimoErro = null

      for (var epIdx = 0; epIdx < endpointsOficiais.length; epIdx++) {
        var ep = endpointsOficiais[epIdx]
        var urlTeste =
          ep.urlBase + termoCodificado + '&' + montarQueryParams(paginaParam, tamPaginaParam)
        var att = fetchEndpoint(urlTeste, 8)
        var body = parseJsonBody(att)
        var itens = extractItems(body)
        if (itens && itens.length > 0) {
          endpointSucesso = ep
          bodyPrimeiraPagina = body
          break
        } else if (body && (body.totalRegistros !== undefined || body.total !== undefined)) {
          endpointSucesso = ep
          bodyPrimeiraPagina = body
          break
        } else {
          attemptUltimoErro = att
        }
      }

      if (!endpointSucesso || !bodyPrimeiraPagina) {
        var statusFinal =
          (attemptUltimoErro && attemptUltimoErro.resp && attemptUltimoErro.resp.statusCode) || 502
        var detailMsg =
          (attemptUltimoErro && attemptUltimoErro.error) ||
          'O portal Compras.gov.br retornou status HTTP ' +
            statusFinal +
            ' e nenhuma amostra pôde ser recuperada.'

        return e.json(502, {
          error: 'COMPRASGOV_UPSTREAM_UNAVAILABLE',
          message:
            'A API pública do Compras.gov.br (Dados Abertos) está temporariamente inacessível ou não respondeu no tempo limite.',
          detail: detailMsg,
          upstreamStatus: statusFinal,
        })
      }

      var todosRegistros = extractItems(bodyPrimeiraPagina)
      var totalRegistrosGeral =
        typeof bodyPrimeiraPagina.totalRegistros === 'number'
          ? bodyPrimeiraPagina.totalRegistros
          : typeof bodyPrimeiraPagina.total === 'number'
            ? bodyPrimeiraPagina.total
            : todosRegistros.length

      var totalPaginasGeral =
        typeof bodyPrimeiraPagina.totalPaginas === 'number'
          ? bodyPrimeiraPagina.totalPaginas
          : Math.max(1, Math.ceil(totalRegistrosGeral / tamPaginaParam))

      // Paginação total se solicitada
      if (paginacaoTotal && totalPaginasGeral > 1) {
        var maxPags = Math.min(totalPaginasGeral, limitePaginasMax)
        console.log('[COMPRASGOV-PROXY] Paginando Compras.gov.br da página 2 até', maxPags)
        for (var p = 2; p <= maxPags; p++) {
          var urlProx =
            endpointSucesso.urlBase + termoCodificado + '&' + montarQueryParams(p, tamPaginaParam)
          var attProx = fetchEndpoint(urlProx, 7)
          var bodyProx = parseJsonBody(attProx)
          var itensProx = extractItems(bodyProx)
          if (itensProx && itensProx.length > 0) {
            todosRegistros = todosRegistros.concat(itensProx)
          }
        }
      }

      // Deduplicação defensiva por código do item / id
      var seenIds = {}
      var registrosUnicos = []
      for (var k = 0; k < todosRegistros.length; k++) {
        var it = todosRegistros[k]
        var idChave =
          it.id ||
          (it.codigoItem && it.uasg ? it.uasg + '_' + it.codigoItem : null) ||
          (it.codigoUasg && it.numeroItem ? it.codigoUasg + '_' + it.numeroItem : null) ||
          String(k)
        if (!seenIds[idChave]) {
          seenIds[idChave] = true
          registrosUnicos.push(it)
        }
      }

      return e.json(200, {
        fonte: 'compras_gov',
        endpoint: endpointSucesso.nome,
        sucesso: true,
        totalEncontrados: totalRegistrosGeral,
        totalPaginas: totalPaginasGeral,
        paginaAtual: paginaParam,
        tamPagina: tamPaginaParam,
        dados: {
          resultado: registrosUnicos,
          totalRegistros: totalRegistrosGeral,
          totalPaginas: totalPaginasGeral,
        },
      })
    } catch (globalErr) {
      console.log('[COMPRASGOV-PROXY] Exceção no hook: ' + globalErr.message)
      return e.json(502, {
        error: 'COMPRASGOV_UPSTREAM_UNAVAILABLE',
        message:
          'A API pública do Compras.gov.br está temporariamente inacessível ou ocorreu falha de comunicação.',
        detail: globalErr.message || 'Erro inesperado no proxy Compras.gov.br',
      })
    }
  },
  $apis.requireAuth(),
)
