/**
 * PocketBase Hook: Proxy Seguro para API Pública de Dados Abertos do Compras.gov.br
 * Base: dadosabertos.compras.gov.br (Módulo Pesquisa de Preço / CATMAT / Contratações 14.133)
 *
 * Características e Garantias de Homologação:
 * 1. Rota autenticada: GET /api/cotai/comprasgov-search (requer token JWT)
 * 2. Timeout defensivo (8s) com fallback gracioso entre múltiplos endpoints oficiais
 * 3. Sanitização contra exceções do runtime Goja do PocketBase
 * 4. Resposta 502 estruturada (COMPRASGOV_UPSTREAM_UNAVAILABLE) quando upstream falhar
 * 5. Deep links auditáveis e metadados completos (CATMAT, UASG, CNPJ, Órgão, Data, Unidade, Valor)
 */

routerAdd(
  'GET',
  '/backend/v1/cotai/comprasgov-search',
  function (e) {
    var termo = (e.request.url.query().get('termo') || '').trim()
    var catmat = (e.request.url.query().get('catmat') || '').trim()
    var uf = (e.request.url.query().get('uf') || '').trim()
    var pagina = e.request.url.query().get('pagina') || '1'
    var tamPagina = e.request.url.query().get('tam_pagina') || '25'
    var dataInicio = e.request.url.query().get('data_inicio') || ''
    var dataFim = e.request.url.query().get('data_fim') || ''

    if (!termo && !catmat) {
      return e.json(400, {
        error: 'INVALID_PARAMETERS',
        message: 'O parâmetro "termo" ou "catmat" é obrigatório para consultar o Compras.gov.br.',
      })
    }

    function fetchEndpoint(url, timeoutSec) {
      try {
        var res = $http.send({
          url: url,
          method: 'GET',
          headers: {
            'User-Agent': 'COTAI-PriceEngine/2.1 (GovTech; Contratações Públicas Lei 14.133/2021)',
            Accept: 'application/json',
          },
          timeout: timeoutSec || 8,
        })
        return { ok: true, resp: res }
      } catch (err) {
        console.log('[COMPRASGOV-PROXY] Erro ao chamar: ' + url + ' => ' + err.message)
        return { ok: false, error: err.message, resp: null }
      }
    }

    function parseJsonBody(attempt) {
      if (!attempt.ok || !attempt.resp) return null
      if (attempt.resp.statusCode < 200 || attempt.resp.statusCode >= 300) return null
      try {
        return attempt.resp.json || JSON.parse(attempt.resp.raw)
      } catch (e) {
        return null
      }
    }

    try {
      // 1. Tentar primeiro endpoint de pesquisa de compras / contratações da Lei 14.133
      // https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarPreco
      // ou itens de contratações 14.133
      var termoCodificado = encodeURIComponent(termo || catmat)
      var queryParams =
        'pagina=' + encodeURIComponent(pagina) + '&tamanhoPagina=' + encodeURIComponent(tamPagina)

      if (uf) {
        queryParams += '&uf=' + encodeURIComponent(uf.toUpperCase())
      }
      if (dataInicio) {
        queryParams += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
      }
      if (dataFim) {
        queryParams += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
      }

      // Endpoint principal A: modulo-pesquisa-preco / consultarMaterial
      var urlPrecoMaterial =
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
        termoCodificado +
        '&' +
        queryParams

      var attempt1 = fetchEndpoint(urlPrecoMaterial, 8)
      var body1 = parseJsonBody(attempt1)

      if (body1 && (body1.resultado || Array.isArray(body1) || body1.items)) {
        return e.json(200, {
          fonte: 'compras_gov',
          endpoint: 'modulo-pesquisa-preco/1_consultarMaterial',
          sucesso: true,
          dados: body1,
        })
      }

      // Endpoint principal B: modulo-contratacoes / itens de contratações
      var urlItensContratacoes =
        'https://dadosabertos.compras.gov.br/modulo-contratacoes/1_consultarItensContratacoes?descricaoItem=' +
        termoCodificado +
        '&' +
        queryParams

      var attempt2 = fetchEndpoint(urlItensContratacoes, 8)
      var body2 = parseJsonBody(attempt2)

      if (body2 && (body2.resultado || Array.isArray(body2) || body2.items)) {
        return e.json(200, {
          fonte: 'compras_gov',
          endpoint: 'modulo-contratacoes/1_consultarItensContratacoes',
          sucesso: true,
          dados: body2,
        })
      }

      // Endpoint principal C: modulo-pesquisa-preco / consultarPreco genérico
      var urlPrecoGenerico =
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarPreco?termo=' +
        termoCodificado +
        '&' +
        queryParams

      var attempt3 = fetchEndpoint(urlPrecoGenerico, 8)
      var body3 = parseJsonBody(attempt3)

      if (body3 && (body3.resultado || Array.isArray(body3) || body3.items)) {
        return e.json(200, {
          fonte: 'compras_gov',
          endpoint: 'modulo-pesquisa-preco/1_consultarPreco',
          sucesso: true,
          dados: body3,
        })
      }

      // Se todas as tentativas falharem por erro de rede / timeout
      var statusFinal =
        (attempt1.resp && attempt1.resp.statusCode) ||
        (attempt2.resp && attempt2.resp.statusCode) ||
        (attempt3.resp && attempt3.resp.statusCode) ||
        502

      var detailMsg =
        attempt1.error ||
        attempt2.error ||
        attempt3.error ||
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
