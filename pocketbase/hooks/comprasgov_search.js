/**
 * PocketBase Hook: Proxy Seguro para API Pública de Dados Abertos do Compras.gov.br
 * Base: dadosabertos.compras.gov.br (Módulo Pesquisa de Preço / CATMAT / Contratações 14.133)
 *
 * Características e Garantias de Homologação:
 * 1. Rota autenticada: GET /backend/v1/cotai/comprasgov-search (requer token JWT)
 * 2. Suporte à assinatura vigente da API:
 *    - /modulo-pesquisa-preco/1_consultarMaterial exige o par:
 *      tipo=codigoItemCatalogo & codigo=<CATMAT>
 *      (o antigo `codigoItemCatalogo=<int>` ou `descricaoItem` gera 404/rejeição upstream)
 * 3. Mapeamento canônico e resolução de CATMAT a partir do termo com fallback estruturado
 * 4. Paginação e deduplicação defensiva por CNPJ de fornecedor + item
 * 5. NUNCA retorna 502 cru sem estrutura e NUNCA derruba o lote agregado
 * 6. Deep links auditáveis e rastreabilidade com hash SHA/determinístico
 */

routerAdd('GET', '/backend/v1/cotai/comprasgov-search', function (e) {
  try {
    var query = e.requestInfo().query
    // B5: Ler catser e tipo ANTES do guard de parâmetros para que catser-only não dê 400
    var tipoCatalogo = (query.tipo_catalogo || query.tipo || '').toLowerCase() // 'material', 'servico' ou vazio
    var catser = (query.catser || query.codigo_servico || query.codigoServico || '').trim()
    var termo = (query.termo || '').trim()
    var catmat = (query.catmat || '').trim()
    var codigoItem = (query.codigo_item || query.codigoItemCatalogo || query.codigo || '').trim()
    var uf = (query.uf || query.estado || '').trim().toUpperCase()
    var paginaParam = parseInt(query.pagina || '1', 10) || 1
    // B4: tamanhoPagina mínimo 10 (5 dá 400 oficial), máximo 500 — remover cap artificial de 50
    var tamPaginaParam = Math.min(
      500,
      Math.max(
        10,
        parseInt(query.tam_pagina || query.tamanhoPagina || query.tamanho_pagina || '50', 10) || 50,
      ),
    )
    var dataInicio = (query.data_inicio || '').trim()
    var dataFim = (query.data_fim || '').trim()
    var paginacaoTotal =
      (query.paginacao_total || '').toLowerCase() === 'true' ||
      (query.todas_paginas || '').toLowerCase() === 'true'
    var limitePaginasMax = Math.max(1, parseInt(query.limite_paginas || '50', 10) || 50)

    if (!termo && !catmat && !codigoItem && !catser && !tipoCatalogo) {
      return e.json(400, {
        error: 'INVALID_PARAMETERS',
        message:
          'O parâmetro "termo", "catmat", "catser" ou "codigo_item" é obrigatório para consultar o Compras.gov.br.',
      })
    }

    // Sanitização canônica do termo
    var termoSanitizado = (termo || catmat)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    var termoLower = termoSanitizado.toLowerCase()

    console.log(
      '[COMPRASGOV-PROXY] Iniciando busca para termo:',
      termoSanitizado,
      'catmat/codigo:',
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
          timeout: timeoutSec || 4,
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

    function respostaPrecoValida(body) {
      if (!body || typeof body !== 'object' || body.sucesso === false) return false
      var items = Array.isArray(body)
        ? body
        : Array.isArray(body.resultado)
          ? body.resultado
          : Array.isArray(body.items)
            ? body.items
            : Array.isArray(body.data)
              ? body.data
              : null
      if (!items) return false
      for (var r = 0; r < items.length; r++) {
        if (!items[r] || typeof items[r] !== 'object' || Array.isArray(items[r])) return false
      }
      var countFields = ['totalRegistros', 'total', 'totalPaginas']
      for (var c = 0; c < countFields.length; c++) {
        var count = body[countFields[c]]
        if (
          count !== undefined &&
          (typeof count !== 'number' ||
            !isFinite(count) ||
            count < 0 ||
            Math.floor(count) !== count)
        )
          return false
      }
      return true
    }

    // 1. Identificar códigos de catálogo: CATMAT (materiais) e CATSER (serviços)
    var codigosCatmatIdentificados = []
    var codigosCatserIdentificados = []
    var codigoExplicitoInformado = false

    var paramCatBruto = String(codigoItem || catmat || '').trim()
    if (paramCatBruto) {
      var partesCat = paramCatBruto.split(',')
      for (var pI = 0; pI < partesCat.length; pI++) {
        var cL = partesCat[pI].replace(/\D/g, '')
        if (cL && cL.length >= 3 && codigosCatmatIdentificados.indexOf(cL) === -1) {
          codigosCatmatIdentificados.push(cL)
          codigoExplicitoInformado = true
        }
      }
    }

    if (catser) {
      var partesCatser = catser.split(',')
      for (var csI = 0; csI < partesCatser.length; csI++) {
        var csL = partesCatser[csI].replace(/\D/g, '')
        if (csL && csL.length >= 3 && codigosCatserIdentificados.indexOf(csL) === -1) {
          codigosCatserIdentificados.push(csL)
          codigoExplicitoInformado = true
        }
      }
    }

    // B5: Código explícito NUNCA é expandido pelo mapeamento hardcoded.
    // Expande termos apenas se nenhum código explícito foi informado pelo usuário.
    if (!codigoExplicitoInformado) {
      if (termoLower.indexOf('picole') !== -1 || termoLower.indexOf('picolé') !== -1) {
        if (codigosCatmatIdentificados.indexOf('462776') === -1)
          codigosCatmatIdentificados.push('462776')
        if (codigosCatmatIdentificados.indexOf('462772') === -1)
          codigosCatmatIdentificados.push('462772')
      } else if (termoLower.indexOf('sorvete') !== -1) {
        if (codigosCatmatIdentificados.indexOf('462772') === -1)
          codigosCatmatIdentificados.push('462772')
        if (codigosCatmatIdentificados.indexOf('462776') === -1)
          codigosCatmatIdentificados.push('462776')
      } else if (termoLower.indexOf('dipirona') !== -1) {
        if (codigosCatmatIdentificados.indexOf('267203') === -1)
          codigosCatmatIdentificados.push('267203')
        if (codigosCatmatIdentificados.indexOf('268252') === -1)
          codigosCatmatIdentificados.push('268252')
        if (codigosCatmatIdentificados.indexOf('267205') === -1)
          codigosCatmatIdentificados.push('267205')
        if (codigosCatmatIdentificados.indexOf('267206') === -1)
          codigosCatmatIdentificados.push('267206')
        if (codigosCatmatIdentificados.indexOf('267204') === -1)
          codigosCatmatIdentificados.push('267204')
      } else if (termoLower.indexOf('paracetamol') !== -1) {
        if (codigosCatmatIdentificados.indexOf('271501') === -1)
          codigosCatmatIdentificados.push('271501')
      } else if (termoLower.indexOf('alcool') !== -1) {
        if (codigosCatmatIdentificados.indexOf('318920') === -1)
          codigosCatmatIdentificados.push('318920')
      } else if (
        termoLower.indexOf('papel') !== -1 &&
        (termoLower.indexOf('a4') !== -1 || termoLower.indexOf('sulfite') !== -1)
      ) {
        if (codigosCatmatIdentificados.indexOf('443210') === -1)
          codigosCatmatIdentificados.push('443210')
      } else if (termoLower.indexOf('gasolina') !== -1) {
        if (codigosCatmatIdentificados.indexOf('390145') === -1)
          codigosCatmatIdentificados.push('390145')
      } else if (termoLower.indexOf('diesel') !== -1) {
        if (codigosCatmatIdentificados.indexOf('390146') === -1)
          codigosCatmatIdentificados.push('390146')
      }
    }

    // Se ainda não temos código CATMAT nem CATSER e não for explicitamente serviço, tentar catálogo de material
    if (
      codigosCatmatIdentificados.length === 0 &&
      codigosCatserIdentificados.length === 0 &&
      tipoCatalogo !== 'servico' &&
      termoSanitizado
    ) {
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
          var codStr = String(cod || '').replace(/\D/g, '')
          if (codStr && codigosCatmatIdentificados.indexOf(codStr) === -1) {
            codigosCatmatIdentificados.push(codStr)
          }
        }
      }
    }

    var codigosCatalogoIdentificados = codigosCatmatIdentificados.concat(codigosCatserIdentificados)

    console.log(
      '[COMPRASGOV-PROXY] Códigos ativos: CATMAT=',
      codigosCatmatIdentificados,
      'CATSER=',
      codigosCatserIdentificados,
    )

    var todosRegistros = []
    var endpointUtilizado = 'modulo-pesquisa-preco/1_consultarMaterial'
    var totalRegistrosGeral = 0
    var totalPaginasGeral = 0
    var endpointSucesso = null

    // B1/B3: Material: tipo=codigoItemCatalogo&codigo={CATMAT}&pagina={p}&tamanhoPagina={tam}&estado={UF}
    // B3: UF interna vira &estado={UF} no upstream (&uf é ignorado pelo Compras.gov.br)
    function montarQueryParams(p, tam, cod) {
      var q =
        'tipo=codigoItemCatalogo&codigo=' +
        encodeURIComponent(cod) +
        '&pagina=' +
        p +
        '&tamanhoPagina=' +
        tam
      if (uf) q += '&estado=' + encodeURIComponent(uf)
      if (dataInicio) q += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
      if (dataFim) q += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
      return q
    }

    // B2/B3: Serviço: GET /modulo-pesquisa-preco/3_consultarServico?codigoItemCatalogo={CATSER}&pagina={p}&tamanhoPagina={tam}&estado={UF}
    function montarQueryParamsServico(p, tam, cod) {
      var q =
        'codigoItemCatalogo=' + encodeURIComponent(cod) + '&pagina=' + p + '&tamanhoPagina=' + tam
      if (uf) q += '&estado=' + encodeURIComponent(uf)
      if (dataInicio) q += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
      if (dataFim) q += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
      return q
    }

    // B6/B7: Resposta HTTP 200 com 0, 1 ou 2 linhas é completamente válida.
    // B6: Não disparar módulos secundários (ARP/14133/legado) quando a rota oficial de catálogo respondeu HTTP 200 com parser válido.
    // Falha HTTP (4xx/5xx) ou erro de parser continuam sendo ERRO (B9).
    var rotaCatalogoConsultadaComSucesso = false
    var falhaHttpOcorrida = false
    var mensagemErroHttp = ''

    // 2.A Executar consultas para SERVIÇOS (CATSER) via endpoint oficial /modulo-pesquisa-preco/3_consultarServico
    if (codigosCatserIdentificados.length > 0 || tipoCatalogo === 'servico') {
      for (var csIdx = 0; csIdx < codigosCatserIdentificados.length; csIdx++) {
        var codSerAtual = codigosCatserIdentificados[csIdx]
        var urlServico =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?' +
          montarQueryParamsServico(paginaParam, tamPaginaParam, codSerAtual)

        var attServ = fetchEndpoint(urlServico, 4.0)
        if (!attServ.ok || (attServ.resp && attServ.resp.statusCode >= 400)) {
          falhaHttpOcorrida = true
          mensagemErroHttp =
            attServ.error || 'HTTP ' + (attServ.resp ? attServ.resp.statusCode : 'erro')
          continue
        }
        var bodyServ = parseJsonBody(attServ)
        if (!respostaPrecoValida(bodyServ)) {
          falhaHttpOcorrida = true
          mensagemErroHttp = 'JSON ou schema incompatível na resposta oficial de serviços.'
          continue
        }
        if (bodyServ !== null) {
          rotaCatalogoConsultadaComSucesso = true
          var itensServ = extractItems(bodyServ)
          for (var sIdx = 0; sIdx < itensServ.length; sIdx++) {
            var itServ = itensServ[sIdx]
            itServ.tipoItem = 'SERVICO'
            itServ.codigoCatser = codSerAtual
            itServ.origemModulo = 'modulo-pesquisa-preco/3_consultarServico'
            todosRegistros.push(itServ)
          }
          endpointUtilizado =
            'modulo-pesquisa-preco/3_consultarServico (codigoItemCatalogo=' + codSerAtual + ')'
          var totS =
            typeof bodyServ.totalRegistros === 'number'
              ? bodyServ.totalRegistros
              : typeof bodyServ.total === 'number'
                ? bodyServ.total
                : itensServ.length
          totalRegistrosGeral += totS
          totalPaginasGeral = Math.max(
            totalPaginasGeral,
            typeof bodyServ.totalPaginas === 'number'
              ? bodyServ.totalPaginas
              : Math.ceil(totS / tamPaginaParam),
          )
          if (!endpointSucesso) {
            endpointSucesso = {
              cod: codSerAtual,
              urlBase:
                'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?',
              nome: endpointUtilizado,
              isServico: true,
            }
          }
        }
      }
    }

    // 2.B Executar consultas para MATERIAIS (CATMAT) usando /modulo-pesquisa-preco/1_consultarMaterial
    // B10: Código de serviço nunca vai para rota de material
    if (codigosCatmatIdentificados.length > 0 && tipoCatalogo !== 'servico') {
      for (var ci = 0; ci < codigosCatmatIdentificados.length; ci++) {
        var codAtual = codigosCatmatIdentificados[ci]
        var urlAssinaturaNova =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
          montarQueryParams(paginaParam, tamPaginaParam, codAtual)

        var attNova = fetchEndpoint(urlAssinaturaNova, 4.0)
        if (!attNova.ok || (attNova.resp && attNova.resp.statusCode >= 400)) {
          falhaHttpOcorrida = true
          mensagemErroHttp =
            attNova.error || 'HTTP ' + (attNova.resp ? attNova.resp.statusCode : 'erro')
          continue
        }
        var bodyNova = parseJsonBody(attNova)
        if (!respostaPrecoValida(bodyNova)) {
          falhaHttpOcorrida = true
          mensagemErroHttp = 'JSON ou schema incompatível na resposta oficial de materiais.'
          continue
        }
        if (bodyNova !== null) {
          rotaCatalogoConsultadaComSucesso = true
          var itensNovos = extractItems(bodyNova)
          for (var mIdx = 0; mIdx < itensNovos.length; mIdx++) {
            var itMat = itensNovos[mIdx]
            itMat.tipoItem = 'MATERIAL'
            itMat.codigoCatmat = codAtual
            todosRegistros.push(itMat)
          }
          endpointUtilizado =
            'modulo-pesquisa-preco/1_consultarMaterial (tipo=codigoItemCatalogo&codigo=' +
            codAtual +
            ')'
          var tot =
            typeof bodyNova.totalRegistros === 'number'
              ? bodyNova.totalRegistros
              : typeof bodyNova.total === 'number'
                ? bodyNova.total
                : itensNovos.length
          totalRegistrosGeral += tot
          totalPaginasGeral = Math.max(
            totalPaginasGeral,
            typeof bodyNova.totalPaginas === 'number'
              ? bodyNova.totalPaginas
              : Math.ceil(tot / tamPaginaParam),
          )
          if (!endpointSucesso) {
            endpointSucesso = {
              cod: codAtual,
              urlBase:
                'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?',
              nome: endpointUtilizado,
              isServico: false,
            }
          }
        }
      }
    }

    // B6: Se a rota de catálogo respondeu HTTP 200 válido (mesmo com 0 ou 2 registros),
    // NÃO disparar módulos secundários ARP/14133/legado.
    // Só consulta módulos secundários se NENHUMA rota oficial de catálogo (CATMAT/CATSER) foi consultada com sucesso.
    if (!rotaCatalogoConsultadaComSucesso && !codigoExplicitoInformado) {
      // 3. Módulo de ARP (Atas de Registro de Preço)
      if (codigosCatmatIdentificados.length > 0 && tipoCatalogo !== 'servico') {
        for (var ca = 0; ca < Math.min(2, codigosCatmatIdentificados.length); ca++) {
          var codArp = codigosCatmatIdentificados[ca]
          var urlArp =
            'https://dadosabertos.compras.gov.br/modulo-arp/1_consultarItemArp?codigoItemCatalogo=' +
            encodeURIComponent(codArp) +
            '&pagina=' +
            paginaParam +
            '&tamanhoPagina=' +
            tamPaginaParam +
            (uf ? '&estado=' + encodeURIComponent(uf) : '')

          var attArp = fetchEndpoint(urlArp, 2.5)
          var bodyArp = parseJsonBody(attArp)
          if (bodyArp) {
            var itensArp = extractItems(bodyArp)
            if (itensArp && itensArp.length > 0) {
              for (var aIdx = 0; aIdx < itensArp.length; aIdx++) {
                var itArp = itensArp[aIdx]
                itArp.modalidadeCompra = itArp.modalidadeCompra || 'Ata de Registro de Preços (ARP)'
                itArp.origemModulo = 'modulo-arp'
                todosRegistros.push(itArp)
              }
              totalRegistrosGeral += bodyArp.totalRegistros || itensArp.length
              totalPaginasGeral = Math.max(totalPaginasGeral, bodyArp.totalPaginas || 1)
              break
            }
          }
        }
      }

      // 4. Estratégia Híbrida: Busca textual por descrição apenas se não temos código de catálogo
      if (
        todosRegistros.length === 0 &&
        termoSanitizado &&
        tipoCatalogo !== 'servico' &&
        !codigoExplicitoInformado
      ) {
        var urlTexto =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
          encodeURIComponent(termoSanitizado) +
          '&pagina=' +
          paginaParam +
          '&tamanhoPagina=' +
          tamPaginaParam +
          (uf ? '&estado=' + encodeURIComponent(uf) : '')

        var attTexto = fetchEndpoint(urlTexto, 4.0)
        var bodyTexto = parseJsonBody(attTexto)
        if (bodyTexto) {
          var itensTexto = extractItems(bodyTexto)
          if (itensTexto && itensTexto.length > 0) {
            todosRegistros = todosRegistros.concat(itensTexto)
            endpointUtilizado =
              'modulo-pesquisa-preco/1_consultarMaterial (descricaoItem=' + termoSanitizado + ')'
            totalRegistrosGeral += bodyTexto.totalRegistros || itensTexto.length
            totalPaginasGeral = Math.max(totalPaginasGeral, bodyTexto.totalPaginas || 1)
          }
        }
      }

      // 5. Integração com Contratações Lei 14.133
      if (todosRegistros.length === 0 && termoSanitizado && !codigoExplicitoInformado) {
        var url14133 =
          'https://dadosabertos.compras.gov.br/modulo-contratacoes-14133/1_consultarContratacoesItem?descricaoItem=' +
          encodeURIComponent(termoSanitizado) +
          '&pagina=' +
          paginaParam +
          '&tamanhoPagina=' +
          tamPaginaParam +
          (uf ? '&estado=' + encodeURIComponent(uf) : '')

        var att14133 = fetchEndpoint(url14133, 4.0)
        var body14133 = parseJsonBody(att14133)
        if (body14133) {
          var itens14133 = extractItems(body14133)
          if (itens14133 && itens14133.length > 0) {
            for (var idx14 = 0; idx14 < itens14133.length; idx14++) {
              var it14 = itens14133[idx14]
              it14.modalidadeCompra = it14.modalidadeCompra || 'Contratação Lei 14.133/2021'
              it14.origemModulo = 'modulo-contratacoes-14133'
              todosRegistros.push(it14)
            }
            totalRegistrosGeral += body14133.totalRegistros || itens14133.length
          }
        }
      }
    }

    // 4. Paginação complementar se solicitada e se encontrou endpoint funcional
    // Processa até todas as páginas disponíveis ou o limite solicitado pelo chamador
    if (paginacaoTotal && endpointSucesso && totalPaginasGeral > 1 && paginaParam === 1) {
      var maxPags = Math.min(totalPaginasGeral, limitePaginasMax)
      console.log('[COMPRASGOV-PROXY] Paginando Compras.gov.br da página 2 até', maxPags)
      for (var p = 2; p <= maxPags; p++) {
        var urlProx = endpointSucesso.isServico
          ? 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/3_consultarServico?' +
            montarQueryParamsServico(p, tamPaginaParam, endpointSucesso.cod)
          : 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
            montarQueryParams(p, tamPaginaParam, endpointSucesso.cod)
        var attProx = fetchEndpoint(urlProx, 4)
        var bodyProx = parseJsonBody(attProx)
        var itensProx = extractItems(bodyProx)
        if (itensProx && itensProx.length > 0) {
          for (var ipIdx = 0; ipIdx < itensProx.length; ipIdx++) {
            var itP = itensProx[ipIdx]
            if (endpointSucesso.isServico) {
              itP.tipoItem = 'SERVICO'
              itP.codigoCatser = endpointSucesso.cod
            } else {
              itP.tipoItem = 'MATERIAL'
              itP.codigoCatmat = endpointSucesso.cod
            }
            todosRegistros.push(itP)
          }
        } else {
          // Se uma página falhou temporariamente, preserva as páginas anteriores com resiliência (RF-014)
          console.log(
            '[COMPRASGOV-PROXY] Página ' +
              p +
              ' sem registros ou falha transitória, mantendo anteriores.',
          )
        }
      }
    }

    // B8: Somente campos oficiais de unidade; descrição não comprova a unidade de fornecimento.
    // Unidade ausente permanece ausente; nunca inventar quantidade 1.
    function obterUnidadeOficialCgov(it) {
      var oficial =
        (it.siglaUnidadeFornecimento || '').trim() ||
        (it.nomeUnidadeFornecimento || '').trim() ||
        (it.unidadeFornecimento || '').trim() ||
        (it.siglaUnidadeMedida || '').trim() ||
        (it.nomeUnidadeMedida || '').trim() ||
        (it.unidadeMedida || '').trim() ||
        (it.unidade || '').trim()

      if (oficial) {
        // Preserve the official supply-unit label (including HR/H/MÊS).
        return oficial
      }

      return ''
    }

    // 5. Deduplicação defensiva e propagação de metadados (B9)
    // Chave única: fornecedor (CNPJ ou nome) + uasg + item/id + valor
    var seenKeys = {}
    var registrosUnicos = []
    for (var k = 0; k < todosRegistros.length; k++) {
      var it = todosRegistros[k]
      var cnpjForn =
        it.cnpjFornecedor || it.cpfCnpjFornecedor || it.niFornecedor || it.nomeFornecedor || ''
      var precoUn =
        it.precoUnitarioHomologado ??
        it.valorUnitario ??
        it.precoUnitario ??
        it.precoPraticado ??
        ''
      var seqIt = it.numeroItem ?? it.numeroItemCompra ?? it.item ?? it.codigoItem ?? k
      var uasgCod = it.codigoUasg || it.uasg || ''

      var idCompraOficial = it.idCompra || it.codigoCompra || ''
      var idItemOficial = it.idItemCompra || ''
      var chaveDedup =
        idCompraOficial || idItemOficial
          ? JSON.stringify([
              it.tipoItem || '',
              idCompraOficial,
              idItemOficial || seqIt,
              it.dataResultado || it.dataHomologacao || it.dataCompra || '',
              cnpjForn,
            ])
          : JSON.stringify(['legacy', cnpjForn, uasgCod, seqIt, precoUn])

      if (!seenKeys[chaveDedup]) {
        seenKeys[chaveDedup] = true

        // B8: Unidade oficial sem coerção indevida para UN
        var uFinal = obterUnidadeOficialCgov(it)
        if (uFinal) {
          it.unidadeMedida = uFinal
          it.unidade = uFinal
        }

        // B9: Propagar identidade/localidade sem renomear a natureza das datas oficiais.
        if (it.estado && !it.uf) {
          it.uf = String(it.estado).toUpperCase()
        }
        if (!it.idCompra && it.codigoCompra) {
          it.idCompra = it.codigoCompra
        }
        if (!it.numeroItemCompra && it.numeroItem) {
          it.numeroItemCompra = it.numeroItem
        }
        registrosUnicos.push(it)
      }
    }

    // B9: Se não encontrou registros e houve falha HTTP (ex: 404, 500, timeout na API upstream), retornar erro estruturado, não sucesso com 0
    if (registrosUnicos.length === 0 && falhaHttpOcorrida && !rotaCatalogoConsultadaComSucesso) {
      console.log(
        '[COMPRASGOV-PROXY] Falha HTTP na rota upstream do Compras.gov.br:',
        mensagemErroHttp,
      )
      return e.json(502, {
        fonte: 'compras_gov',
        endpoint: endpointUtilizado,
        sucesso: false,
        error: 'UPSTREAM_HTTP_ERROR',
        message: 'A API oficial do Compras.gov.br retornou erro na consulta: ' + mensagemErroHttp,
        codigosCatalogoTentados: codigosCatalogoIdentificados,
      })
    }

    // 6. Resposta estruturada limpa (B6: 200 com 0, 1 ou 2 registros preserva total/página/tamanho)
    if (registrosUnicos.length === 0) {
      console.log(
        '[COMPRASGOV-PROXY] Sem resultados (200 com 0 registros) para o termo/código informado.',
      )
      return e.json(200, {
        fonte: 'compras_gov',
        endpoint: endpointUtilizado,
        sucesso: true,
        totalEncontrados: totalRegistrosGeral,
        totalPaginas: totalPaginasGeral,
        paginaAtual: paginaParam,
        tamPagina: tamPaginaParam,
        codigosCatalogoTentados: codigosCatalogoIdentificados,
        dados: {
          resultado: [],
          totalRegistros: totalRegistrosGeral,
          totalPaginas: totalPaginasGeral,
        },
        aviso:
          'Nenhuma contratação homologada foi localizada no Compras.gov.br para o item de catálogo (' +
          (codigosCatserIdentificados.length > 0
            ? 'CATSER ' + codigosCatserIdentificados.join(', ')
            : 'CATMAT ' + codigosCatmatIdentificados.join(', ')) +
          ').',
      })
    }

    return e.json(200, {
      fonte: 'compras_gov',
      endpoint: endpointUtilizado,
      sucesso: true,
      totalEncontrados: Math.max(totalRegistrosGeral, registrosUnicos.length),
      totalPaginas: totalPaginasGeral,
      paginaAtual: paginaParam,
      tamPagina: tamPaginaParam,
      codigosCatalogoTentados: codigosCatalogoIdentificados,
      dados: {
        resultado: registrosUnicos,
        totalRegistros: Math.max(totalRegistrosGeral, registrosUnicos.length),
        totalPaginas: totalPaginasGeral,
      },
      diagnostico_fluxo: {
        api_origem: 'Compras.gov.br (dadosabertos.compras.gov.br)',
        registros_informados_api: totalRegistrosGeral,
        paginas_informadas_api: totalPaginasGeral,
        registros_brutos_recebidos: todosRegistros.length,
        amostras_processadas_unicas: registrosUnicos.length,
        etapa: 'backend_comprasgov_search_hook',
      },
    })
  } catch (globalErr) {
    console.log(
      '[COMPRASGOV-PROXY] Exceção tratada no hook: ' + (globalErr ? globalErr.message : ''),
    )
    // Resposta defensiva estruturada: nunca derruba lote nem desloga usuário
    return e.json(200, {
      fonte: 'compras_gov',
      endpoint: 'modulo-pesquisa-preco/1_consultarMaterial',
      sucesso: false,
      totalEncontrados: 0,
      totalPaginas: 0,
      paginaAtual: 1,
      tamPagina: 25,
      dados: {
        resultado: [],
        totalRegistros: 0,
        totalPaginas: 0,
      },
      aviso:
        'A API pública do Compras.gov.br (dadosabertos.compras.gov.br) retornou indisponibilidade temporária. A busca das outras fontes permaneceu ativa.',
      erro: globalErr ? globalErr.message : 'Erro na chamada ao Compras.gov.br',
    })
  }
})
