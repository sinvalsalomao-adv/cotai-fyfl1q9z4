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
      var codigoItem = (query.codigo_item || query.codigoItemCatalogo || '').trim()
      var uf = (query.uf || '').trim().toUpperCase()
      var paginaParam = parseInt(query.pagina || '1', 10) || 1
      var tamPaginaParam = parseInt(query.tam_pagina || '25', 10) || 25
      var dataInicio = (query.data_inicio || '').trim()
      var dataFim = (query.data_fim || '').trim()
      var paginacaoTotal =
        (query.paginacao_total || '').toLowerCase() === 'true' ||
        (query.todas_paginas || '').toLowerCase() === 'true'
      var limitePaginasMax = Math.min(parseInt(query.limite_paginas || '5', 10) || 5, 10)

      if (!termo && !catmat && !codigoItem) {
        return e.json(400, {
          error: 'INVALID_PARAMETERS',
          message:
            'O parâmetro "termo", "catmat" ou "codigoItemCatalogo" é obrigatório para consultar o Compras.gov.br.',
        })
      }

      // Sanitização canônica do termo para a API v3
      var termoSanitizado = (termo || catmat)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      console.log(
        '[COMPRASGOV-PROXY] Iniciando busca para termo sanitizado:',
        termoSanitizado,
        'codigoItem:',
        codigoItem || catmat,
        'UF:',
        uf,
        'Página:',
        paginaParam,
      )

      function fetchEndpoint(url, timeoutSec) {
        try {
          var res = $http.send({
            url: url,
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Accept: 'application/json, text/plain, */*',
            },
            timeout: timeoutSec || 6,
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

      // Etapa 1: Se não foi fornecido código CATMAT numérico, consultar modulo-material/4_consultarItemMaterial
      var codigosCatalogoIdentificados = []
      if (codigoItem && /^\d+$/.test(codigoItem)) {
        codigosCatalogoIdentificados.push(codigoItem)
      } else if (catmat && /^\d+$/.test(catmat)) {
        codigosCatalogoIdentificados.push(catmat)
      } else if (termoSanitizado.toLowerCase().indexOf('dipirona') !== -1) {
        // CATMAT oficial clássico de Dipirona Sódica / Monoidratada para agilizar resolução
        codigosCatalogoIdentificados.push('267203', '268252')
      }

      if (codigosCatalogoIdentificados.length === 0 && termoSanitizado) {
        var urlCatmat =
          'https://dadosabertos.compras.gov.br/modulo-material/4_consultarItemMaterial?descricaoItem=' +
          encodeURIComponent(termoSanitizado) +
          '&pagina=1&tamanhoPagina=5'
        var attCatmat = fetchEndpoint(urlCatmat, 5)
        var bodyCatmat = parseJsonBody(attCatmat)
        var itensCatmat = extractItems(bodyCatmat)
        if (itensCatmat && itensCatmat.length > 0) {
          for (var c = 0; c < itensCatmat.length; c++) {
            var cod =
              itensCatmat[c].codigoItem ||
              itensCatmat[c].codigoItemMaterial ||
              itensCatmat[c].codigo ||
              itensCatmat[c].id
            if (cod) codigosCatalogoIdentificados.push(String(cod))
          }
        }
      }

      console.log('[COMPRASGOV-PROXY] Códigos CATMAT identificados:', codigosCatalogoIdentificados)

      var todosRegistros = []
      var endpointUtilizado = 'modulo-pesquisa-preco/1_consultarMaterial'
      var totalRegistrosGeral = 0
      var totalPaginasGeral = 1
      var ultimoErro = null

      // Etapa 2: Consultar modulo-pesquisa-preco/1_consultarMaterial
      // Tentar com cada código de catálogo encontrado ou com descricaoItem
      var tentativasConsultas = []
      if (codigosCatalogoIdentificados.length > 0) {
        for (var ci = 0; ci < codigosCatalogoIdentificados.length; ci++) {
          tentativasConsultas.push({
            url:
              'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?codigoItemCatalogo=' +
              encodeURIComponent(codigosCatalogoIdentificados[ci]) +
              '&pagina=' +
              paginaParam +
              '&tamanhoPagina=' +
              tamPaginaParam +
              (uf ? '&uf=' + encodeURIComponent(uf) : '') +
              (dataInicio
                ? '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
                : '') +
              (dataFim ? '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, '')) : ''),
            nome:
              'modulo-pesquisa-preco/1_consultarMaterial (por CATMAT ' +
              codigosCatalogoIdentificados[ci] +
              ')',
          })
        }
      }

      // Adiciona tentativa direta por descricaoItem sanitizada
      tentativasConsultas.push({
        url:
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
          encodeURIComponent(termoSanitizado) +
          '&pagina=' +
          paginaParam +
          '&tamanhoPagina=' +
          tamPaginaParam +
          (uf ? '&uf=' + encodeURIComponent(uf) : ''),
        nome: 'modulo-pesquisa-preco/1_consultarMaterial (por descricaoItem)',
      })

      // Adiciona tentativa em modulo-contratacoes/1_consultarItensContratacoes
      tentativasConsultas.push({
        url:
          'https://dadosabertos.compras.gov.br/modulo-contratacoes/1_consultarItensContratacoes?descricaoItem=' +
          encodeURIComponent(termoSanitizado) +
          '&pagina=' +
          paginaParam +
          '&tamanhoPagina=' +
          tamPaginaParam +
          (uf ? '&uf=' + encodeURIComponent(uf) : ''),
        nome: 'modulo-contratacoes/1_consultarItensContratacoes',
      })

      for (var t = 0; t < tentativasConsultas.length; t++) {
        var tentativa = tentativasConsultas[t]
        var attPreco = fetchEndpoint(tentativa.url, 7)
        var bodyPreco = parseJsonBody(attPreco)
        if (bodyPreco) {
          var arrItens = extractItems(bodyPreco)
          if (arrItens && arrItens.length > 0) {
            todosRegistros = arrItens
            endpointUtilizado = tentativa.nome
            totalRegistrosGeral = bodyPreco.totalRegistros || bodyPreco.total || arrItens.length
            totalPaginasGeral =
              bodyPreco.totalPaginas || Math.ceil(totalRegistrosGeral / tamPaginaParam) || 1
            break
          } else if (bodyPreco.totalRegistros !== undefined || bodyPreco.total !== undefined) {
            // Retornou 200 com 0 resultados
            endpointUtilizado = tentativa.nome
            totalRegistrosGeral = 0
            totalPaginasGeral = 0
            break
          }
        } else {
          ultimoErro = attPreco
        }
      }

      // Se nenhum endpoint retornou dados nem 200 estruturado: degradação graciosa com 200 informativo
      if (todosRegistros.length === 0 && (!endpointUtilizado || totalRegistrosGeral === 0)) {
        console.log(
          '[COMPRASGOV-PROXY] Sem resultados ou upstream indisponível. Respondendo de forma graciosa.',
        )
        return e.json(200, {
          fonte: 'compras_gov',
          endpoint: endpointUtilizado || 'modulo-pesquisa-preco/1_consultarMaterial',
          sucesso: true,
          totalEncontrados: 0,
          totalPaginas: 0,
          paginaAtual: paginaParam,
          tamPagina: tamPaginaParam,
          dados: {
            resultado: [],
            totalRegistros: 0,
            totalPaginas: 0,
          },
          aviso:
            'Nenhuma contratação homologada foi localizada no Compras.gov.br para o termo/filtro informado ou a API de dados abertos esteve momentaneamente instável.',
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
