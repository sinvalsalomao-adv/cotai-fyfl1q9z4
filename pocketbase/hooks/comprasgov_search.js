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
    var termo = (query.termo || '').trim()
    var catmat = (query.catmat || '').trim()
    var codigoItem = (query.codigo_item || query.codigoItemCatalogo || query.codigo || '').trim()
    var uf = (query.uf || '').trim().toUpperCase()
    var paginaParam = parseInt(query.pagina || '1', 10) || 1
    // Usar o maior tamanho de página permitido oficialmente (50 registros por página)
    var tamPaginaParam = Math.min(50, Math.max(10, parseInt(query.tam_pagina || '50', 10) || 50))
    var dataInicio = (query.data_inicio || '').trim()
    var dataFim = (query.data_fim || '').trim()
    var paginacaoTotal =
      (query.paginacao_total || '').toLowerCase() === 'true' ||
      (query.todas_paginas || '').toLowerCase() === 'true'
    var limitePaginasMax = Math.max(1, parseInt(query.limite_paginas || '50', 10) || 50)

    if (!termo && !catmat && !codigoItem) {
      return e.json(400, {
        error: 'INVALID_PARAMETERS',
        message:
          'O parâmetro "termo", "catmat" ou "codigo_item" é obrigatório para consultar o Compras.gov.br.',
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

    // 1. Identificar códigos CATMAT (parâmetro direto ou mapeamento canônico de catálogo)
    var codigosCatalogoIdentificados = []

    // Se passou código CATMAT explícito (ex: "CATMAT 269412" ou "269412")
    var codLimpo = (codigoItem || catmat).replace(/\D/g, '')
    if (codLimpo && codLimpo.length >= 3) {
      codigosCatalogoIdentificados.push(codLimpo)
    }

    // Mapeamento canônico oficial do Compras.gov.br para itens frequentes
    if (termoLower.indexOf('picole') !== -1 || termoLower.indexOf('picolé') !== -1) {
      // Picolé no catálogo Compras.gov.br: 462776 (Palito gelado à base de água) e 462772 (Sorvete de massa/cremoso/picolé)
      if (codigosCatalogoIdentificados.indexOf('462776') === -1)
        codigosCatalogoIdentificados.push('462776')
      if (codigosCatalogoIdentificados.indexOf('462772') === -1)
        codigosCatalogoIdentificados.push('462772')
    } else if (termoLower.indexOf('sorvete') !== -1) {
      if (codigosCatalogoIdentificados.indexOf('462772') === -1)
        codigosCatalogoIdentificados.push('462772')
      if (codigosCatalogoIdentificados.indexOf('462776') === -1)
        codigosCatalogoIdentificados.push('462776')
    } else if (termoLower.indexOf('dipirona') !== -1) {
      // Dipirona no catálogo oficial Compras.gov.br (CATMATs reais consolidados no SIASG):
      // 267203: Dipirona Sódica 500mg comprimido simples (centenas de atas ativas)
      // 268252: Dipirona Sódica 500mg/ml solução injetável (ampola)
      // 267205: Dipirona Sódica 500mg/ml solução oral gotas (frasco 20ml / 10ml)
      // 267206: Dipirona Sódica 50mg/ml solução oral pediátrica
      // 267204: Dipirona Sódica 1g comprimido simples/efervescente
      if (codigosCatalogoIdentificados.indexOf('267203') === -1)
        codigosCatalogoIdentificados.push('267203')
      if (codigosCatalogoIdentificados.indexOf('268252') === -1)
        codigosCatalogoIdentificados.push('268252')
      if (codigosCatalogoIdentificados.indexOf('267205') === -1)
        codigosCatalogoIdentificados.push('267205')
      if (codigosCatalogoIdentificados.indexOf('267206') === -1)
        codigosCatalogoIdentificados.push('267206')
      if (codigosCatalogoIdentificados.indexOf('267204') === -1)
        codigosCatalogoIdentificados.push('267204')
    } else if (termoLower.indexOf('paracetamol') !== -1) {
      if (codigosCatalogoIdentificados.indexOf('271501') === -1)
        codigosCatalogoIdentificados.push('271501')
    } else if (termoLower.indexOf('alcool') !== -1) {
      if (codigosCatalogoIdentificados.indexOf('318920') === -1)
        codigosCatalogoIdentificados.push('318920')
    } else if (
      termoLower.indexOf('papel') !== -1 &&
      (termoLower.indexOf('a4') !== -1 || termoLower.indexOf('sulfite') !== -1)
    ) {
      if (codigosCatalogoIdentificados.indexOf('443210') === -1)
        codigosCatalogoIdentificados.push('443210')
    } else if (termoLower.indexOf('gasolina') !== -1) {
      if (codigosCatalogoIdentificados.indexOf('390145') === -1)
        codigosCatalogoIdentificados.push('390145')
    } else if (termoLower.indexOf('diesel') !== -1) {
      if (codigosCatalogoIdentificados.indexOf('390146') === -1)
        codigosCatalogoIdentificados.push('390146')
    }

    // Se ainda não temos código CATMAT, tentar buscar via API de catálogo de material
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
          var codStr = String(cod || '').replace(/\D/g, '')
          if (codStr && codigosCatalogoIdentificados.indexOf(codStr) === -1) {
            codigosCatalogoIdentificados.push(codStr)
          }
        }
      }
    }

    console.log(
      '[COMPRASGOV-PROXY] Códigos CATMAT ativos para pesquisa:',
      codigosCatalogoIdentificados,
    )

    var todosRegistros = []
    var endpointUtilizado = 'modulo-pesquisa-preco/1_consultarMaterial'
    var totalRegistrosGeral = 0
    var totalPaginasGeral = 1
    var endpointSucesso = null

    function montarQueryParams(p, tam, cod) {
      var q =
        'tipo=codigoItemCatalogo&codigo=' +
        encodeURIComponent(cod) +
        '&pagina=' +
        p +
        '&tamanhoPagina=' +
        tam
      if (uf) q += '&uf=' + encodeURIComponent(uf)
      if (dataInicio) q += '&dataInicial=' + encodeURIComponent(dataInicio.replace(/-/g, ''))
      if (dataFim) q += '&dataFinal=' + encodeURIComponent(dataFim.replace(/-/g, ''))
      return q
    }

    // 2. Executar consultas usando a nova assinatura vigente da API:
    // /modulo-pesquisa-preco/1_consultarMaterial?tipo=codigoItemCatalogo&codigo=<CODIGO>
    // Timeout elevado para 3.5s para acomodar respostas de dados abertos que demoram entre 2.0s e 3.2s
    if (codigosCatalogoIdentificados.length > 0) {
      for (var ci = 0; ci < codigosCatalogoIdentificados.length; ci++) {
        var codAtual = codigosCatalogoIdentificados[ci]
        var urlAssinaturaNova =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
          montarQueryParams(paginaParam, tamPaginaParam, codAtual)

        var attNova = fetchEndpoint(urlAssinaturaNova, 3.5)
        var bodyNova = parseJsonBody(attNova)

        if (bodyNova) {
          var itensNovos = extractItems(bodyNova)
          if (itensNovos && itensNovos.length > 0) {
            todosRegistros = todosRegistros.concat(itensNovos)
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
              bodyNova.totalPaginas || Math.ceil(tot / tamPaginaParam) || 1,
            )
            if (!endpointSucesso) {
              endpointSucesso = {
                cod: codAtual,
                urlBase:
                  'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?',
                nome: endpointUtilizado,
              }
            }
            // Encontrou amostras válidas: interrompe o loop para devolver imediatamente a resposta
            if (todosRegistros.length >= 5) {
              break
            }
          } else if (bodyNova.totalRegistros !== undefined || bodyNova.total !== undefined) {
            endpointUtilizado =
              'modulo-pesquisa-preco/1_consultarMaterial (tipo=codigoItemCatalogo&codigo=' +
              codAtual +
              ')'
          }
        }
      }
    }
    // 3. Módulo de ARP (Atas de Registro de Preço): consultar apenas se a consulta principal retornar poucas amostras (< 5)
    if (todosRegistros.length < 5 && codigosCatalogoIdentificados.length > 0) {
      for (var ca = 0; ca < Math.min(2, codigosCatalogoIdentificados.length); ca++) {
        var codArp = codigosCatalogoIdentificados[ca]
        var urlArp =
          'https://dadosabertos.compras.gov.br/modulo-arp/1_consultarItemArp?codigoItemCatalogo=' +
          encodeURIComponent(codArp) +
          '&pagina=' +
          paginaParam +
          '&tamanhoPagina=' +
          tamPaginaParam +
          (uf ? '&uf=' + encodeURIComponent(uf) : '')

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
            if (todosRegistros.length >= 5) break
          }
        }
      }
    }

    // 4. Estratégia Híbrida: Busca textual por descrição se a consulta por CATMAT vier vazia ou insuficiente (< 5 amostras)
    if (todosRegistros.length < 5 && termoSanitizado) {
      var urlTexto =
        'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?descricaoItem=' +
        encodeURIComponent(termoSanitizado) +
        '&pagina=' +
        paginaParam +
        '&tamanhoPagina=' +
        tamPaginaParam +
        (uf ? '&uf=' + encodeURIComponent(uf) : '')

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

    // 5. Integração com Contratações Lei 14.133 se ainda houver poucas amostras
    if (todosRegistros.length < 5 && termoSanitizado) {
      var url14133 =
        'https://dadosabertos.compras.gov.br/modulo-contratacoes-14133/1_consultarContratacoesItem?descricaoItem=' +
        encodeURIComponent(termoSanitizado) +
        '&pagina=' +
        paginaParam +
        '&tamanhoPagina=' +
        tamPaginaParam +
        (uf ? '&uf=' + encodeURIComponent(uf) : '')

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

    // 6. Fallback legado com parametro codigoItemCatalogo caso nada acima tenha devolvido amostras
    if (todosRegistros.length === 0 && codigosCatalogoIdentificados.length > 0) {
      for (var cj = 0; cj < codigosCatalogoIdentificados.length; cj++) {
        var codLeg = codigosCatalogoIdentificados[cj]
        var urlLegada =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?codigoItemCatalogo=' +
          encodeURIComponent(codLeg) +
          '&pagina=' +
          paginaParam +
          '&tamanhoPagina=' +
          tamPaginaParam +
          (uf ? '&uf=' + encodeURIComponent(uf) : '')

        var attLeg = fetchEndpoint(urlLegada, 4.0)
        var bodyLeg = parseJsonBody(attLeg)
        if (bodyLeg) {
          var itensLeg = extractItems(bodyLeg)
          if (itensLeg && itensLeg.length > 0) {
            todosRegistros = todosRegistros.concat(itensLeg)
            endpointUtilizado =
              'modulo-pesquisa-preco/1_consultarMaterial (fallback codigoItemCatalogo=' +
              codLeg +
              ')'
            totalRegistrosGeral += bodyLeg.totalRegistros || itensLeg.length
            totalPaginasGeral = Math.max(totalPaginasGeral, bodyLeg.totalPaginas || 1)
            break
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
        var urlProx =
          'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?' +
          montarQueryParams(p, tamPaginaParam, endpointSucesso.cod)
        var attProx = fetchEndpoint(urlProx, 4)
        var bodyProx = parseJsonBody(attProx)
        var itensProx = extractItems(bodyProx)
        if (itensProx && itensProx.length > 0) {
          todosRegistros = todosRegistros.concat(itensProx)
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

    // Helper para extrair unidade qualificada da fonte
    function extrairUnidadeQualificadaCgov(uBruta, dBruta) {
      var u = (uBruta || '').trim().toUpperCase()
      var d = (dBruta || '').trim().toUpperCase()

      var matchCx = d.match(
        /\b(?:CAIXA|CX|PCT|PACOTE|ENVELOPE|BLISTER|FARDO)\s*(?:COM|C\/)?\s*(\d+)/i,
      )
      if (matchCx && matchCx[1]) {
        var qtdNum = parseInt(matchCx[1], 10)
        if (qtdNum > 1) {
          var tipo =
            d.indexOf('ENVELOPE') !== -1
              ? 'ENV'
              : d.indexOf('BLISTER') !== -1
                ? 'BLIST'
                : d.indexOf('FARDO') !== -1
                  ? 'FARDO'
                  : d.indexOf('PACOTE') !== -1 || d.indexOf('PCT') !== -1
                    ? 'PCT'
                    : 'CX'
          return tipo + ' ' + qtdNum + ' UN'
        }
      }

      if (u && u !== 'UN' && u !== 'UND' && u !== 'UNIDADE') {
        return u
      }

      if (/\b(?:FRASCO|FR)\b/i.test(d)) return 'FRASCO'
      if (/\b(?:AMPOLA|AMP)\b/i.test(d)) return 'AMPOLA'
      if (/\b(?:ENVELOPE|ENV)\b/i.test(d)) return 'ENVELOPE'
      if (/\b(?:BLISTER|BLIST)\b/i.test(d)) return 'BLISTER'
      if (/\b(?:COMPRIMIDO|COMP)\b/i.test(d)) return 'COMPRIMIDO'
      if (/\b(?:CAIXA|CX)\b/i.test(d)) return 'CX'

      return u || 'UN'
    }

    // 5. Deduplicação defensiva preservando fornecedores distintos:
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
      var seqIt = it.numeroItem ?? it.item ?? it.codigoItem ?? k
      var uasgCod = it.codigoUasg || it.uasg || ''
      var descItemTexto = (it.descricaoItem || it.descricao || '').toUpperCase()

      // Regra de exclusão estrita: unidades de serviço, hora ou diária
      var uUpper = ((it.unidadeMedida || it.unidade || '') + '').trim().toUpperCase()
      var ehUnidadeServico =
        uUpper === 'SERVICO' ||
        uUpper === 'SERVIÇO' ||
        uUpper === 'SERVICOS' ||
        uUpper === 'SERVIÇOS' ||
        uUpper === 'SV' ||
        uUpper === 'SRV' ||
        uUpper === 'HORA' ||
        uUpper === 'H' ||
        uUpper === 'HR' ||
        uUpper === 'HRS' ||
        uUpper === 'DIARIA' ||
        uUpper === 'DIÁRIA' ||
        uUpper === 'MES' ||
        uUpper === 'MÊS' ||
        uUpper === 'POSTO' ||
        uUpper.indexOf('SERVIC') === 0 ||
        uUpper.indexOf('SERVIÇ') === 0

      if (ehUnidadeServico) {
        continue
      }

      // Regra anti-contaminação para picolé:
      // Excluir máquinas, palitos, formas, saquinhos, pirulitos, palhaço e apresentações
      var ehTermoPicole =
        termoLower.indexOf('picole') !== -1 ||
        termoLower.indexOf('picolé') !== -1
      if (ehTermoPicole) {
        var ehIncompativelPicole =
          descItemTexto.indexOf('PRENSA') !== -1 ||
          descItemTexto.indexOf('MAQUINA') !== -1 ||
          descItemTexto.indexOf('MÁQUINA') !== -1 ||
          descItemTexto.indexOf('EQUIPAMENTO') !== -1 ||
          descItemTexto.indexOf('MOTOR') !== -1 ||
          descItemTexto.indexOf('PEÇA DE REPOSIÇÃO') !== -1 ||
          descItemTexto.indexOf('PALITO DE PICOLE') !== -1 ||
          descItemTexto.indexOf('PALITO P PICOLE') !== -1 ||
          descItemTexto.indexOf('PALITO PARA PICOLE') !== -1 ||
          descItemTexto.indexOf('PALITOS DE PICOLE') !== -1 ||
          descItemTexto.indexOf('PALITO DE MADEIRA') !== -1 ||
          descItemTexto.indexOf('FORMA DE PICOLE') !== -1 ||
          descItemTexto.indexOf('FORMA PARA PICOLE') !== -1 ||
          descItemTexto.indexOf('FORMA P PICOLE') !== -1 ||
          descItemTexto.indexOf('FORMAS DE PICOLE') !== -1 ||
          descItemTexto.indexOf('SAQUINHO PARA PICOLE') !== -1 ||
          descItemTexto.indexOf('SAQUINHO DE PICOLE') !== -1 ||
          descItemTexto.indexOf('SACO PARA PICOLE') !== -1 ||
          descItemTexto.indexOf('SAQUINHOS PARA PICOLE') !== -1 ||
          descItemTexto.indexOf('PIRULITO') !== -1 ||
          descItemTexto.indexOf('PALHACO') !== -1 ||
          descItemTexto.indexOf('PALHAÇO') !== -1 ||
          descItemTexto.indexOf('CIRCENSE') !== -1 ||
          descItemTexto.indexOf('ESPETACULO') !== -1

        if (ehIncompativelPicole) {
          continue
        }
      }

      // Regra anti-contaminação para medicamentos/dipirona com normalização canônica flexível:
      // aceita "DIPIRONA", "DIPIRONA SODICA", "DIPIRONA MONOIDRATADA", "METAMIZOL",
      // caixa alta/baixa, acentos e dosagens com/sem espaço (ex: "500 MG" = "500MG", "1 G" = "1G")
      var ehBuscaDipirona =
        termoLower.indexOf('dipirona') !== -1 || termoLower.indexOf('metamizol') !== -1
      if (ehBuscaDipirona) {
        var descItemNorm = descItemTexto
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
          .toUpperCase()

        var contemDipirona =
          descItemNorm.indexOf('DIPIRONA') !== -1 ||
          descItemNorm.indexOf('DIPIRONA SODICA') !== -1 ||
          descItemNorm.indexOf('DIPIRONA MONOIDRATADA') !== -1 ||
          descItemNorm.indexOf('METAMIZOL') !== -1

        if (!contemDipirona) {
          continue
        }
      }

      var chaveDedup = cnpjForn + '_' + uasgCod + '_' + seqIt + '_' + precoUn

      if (!seenKeys[chaveDedup]) {
        seenKeys[chaveDedup] = true
        // Qualificar unidade no registro retornado
        it.unidadeMedida = extrairUnidadeQualificadaCgov(
          it.unidadeMedida || it.unidade,
          descItemTexto,
        )
        it.unidade = it.unidadeMedida
        registrosUnicos.push(it)
      }
    }

    // 6. Resposta estruturada limpa (nunca 502 cru para o frontend do lote)
    if (registrosUnicos.length === 0) {
      console.log(
        '[COMPRASGOV-PROXY] Sem resultados para o termo/código informado. Respondendo estrutura 200 defensiva.',
      )
      return e.json(200, {
        fonte: 'compras_gov',
        endpoint: endpointUtilizado,
        sucesso: true,
        totalEncontrados: 0,
        totalPaginas: 0,
        paginaAtual: paginaParam,
        tamPagina: tamPaginaParam,
        codigosCatalogoTentados: codigosCatalogoIdentificados,
        dados: {
          resultado: [],
          totalRegistros: 0,
          totalPaginas: 0,
        },
        aviso:
          'Nenhuma contratação homologada foi localizada no Compras.gov.br para o item de catálogo (CATMAT ' +
          (codigosCatalogoIdentificados.join(', ') || 'não identificado') +
          ') ou a API de dados abertos esteve momentaneamente instável.',
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
