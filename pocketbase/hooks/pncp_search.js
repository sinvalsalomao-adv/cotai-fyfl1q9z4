// Endpoint de proxy seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts, paginação por página e enriquecimento rápido.
// Arquitetura: Uma chamada processa UMA página da listagem do PNCP (ex: tam_pagina=10 ou 15),
// detalha TODAS as contratações daquela página (sem corte arbitrário max_detalhar), com timeout defensivo (~1.5s por item),
// e devolve a página inteira detalhada. O frontend consome progressivamente página 1, 2, 3...
// GET /backend/v1/pncp/search?q=termo&pagina=1&tam_pagina=10&uf=RN

routerAdd(
  'GET',
  '/backend/v1/pncp/search',
  function (e) {
    try {
      var query = e.requestInfo().query
      var q = (query.q || '').trim()
      var paginaParam = parseInt(query.pagina || '1', 10) || 1
      // Padrão de 10 a 15 contratações por página para manter cada chamada dentro de 3-6 segundos
      var tamPaginaParam = Math.min(25, Math.max(5, parseInt(query.tam_pagina || '10', 10) || 10))
      var uf = (query.uf || '').trim().toUpperCase()

      // Suporte legado se cliente passar paginacao_total=true
      var paginacaoTotal =
        (query.paginacao_total || '').toLowerCase() === 'true' ||
        (query.todas_paginas || '').toLowerCase() === 'true'
      var limitePaginasMax = Math.min(parseInt(query.limite_paginas || '1', 10) || 1, 3)

      if (!q) {
        return e.json(400, {
          error: 'INVALID_PARAMETER',
          message: 'O parâmetro "q" de busca é obrigatório.',
        })
      }

      console.log(
        '[PNCP-PROXY] Iniciando busca para termo:',
        q,
        'UF:',
        uf,
        'Página:',
        paginaParam,
        'TamPagina:',
        tamPaginaParam,
      )

      var userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      var headers = {
        Accept: 'application/json',
        'User-Agent': userAgent,
      }

      // Função interna de requisição HTTP com try/catch rigoroso (Goja throws em timeout/DNS/egress)
      function fetchEndpoint(targetUrl, timeoutSec) {
        try {
          var resp = $http.send({
            url: targetUrl,
            method: 'GET',
            headers: headers,
            timeout: timeoutSec || 3,
          })
          return { ok: true, resp: resp }
        } catch (err) {
          return { ok: false, error: err.message || 'Falha de rede/timeout' }
        }
      }

      // Construtor de URL de busca no PNCP
      function buildSearchUrl(docTipo, pNum, pSize) {
        var u =
          'https://pncp.gov.br/api/search/?q=' +
          encodeURIComponent(q) +
          '&tipos_documento=' +
          encodeURIComponent(docTipo) +
          '&pagina=' +
          encodeURIComponent(pNum) +
          '&tam_pagina=' +
          encodeURIComponent(pSize)
        if (uf) {
          u += '&ufs=' + encodeURIComponent(uf)
        }
        return u
      }

      // Extração de itens/compras de um corpo JSON
      function extractRawItems(body) {
        if (!body) return []
        if (Array.isArray(body)) return body
        if (Array.isArray(body.items)) return body.items
        if (Array.isArray(body.data)) return body.data
        if (Array.isArray(body.resultado)) return body.resultado
        return []
      }

      // 1. Busca da listagem da página solicitada
      var todasContratacoes = []
      var totalRegistrosGeral = 0
      var totalPaginasGeral = 1
      var tipoDocumentoUtilizado = 'ata'

      // Primeira tentativa: ATAS (timeout enxuto de 3.5s)
      var urlInicialAtas = buildSearchUrl('ata', paginaParam, tamPaginaParam)
      var attempt1 = fetchEndpoint(urlInicialAtas, 3.5)

      var jsonCorpo1 = null
      if (
        attempt1.ok &&
        attempt1.resp &&
        attempt1.resp.statusCode >= 200 &&
        attempt1.resp.statusCode < 300
      ) {
        try {
          jsonCorpo1 = attempt1.resp.json || JSON.parse(attempt1.resp.raw)
        } catch (_) {}
      }

      var itensP1 = extractRawItems(jsonCorpo1)

      if (itensP1.length > 0) {
        tipoDocumentoUtilizado = 'ata'
        todasContratacoes = itensP1.slice()
        totalRegistrosGeral =
          typeof jsonCorpo1.totalRegistros === 'number'
            ? jsonCorpo1.totalRegistros
            : typeof jsonCorpo1.total === 'number'
              ? jsonCorpo1.total
              : typeof jsonCorpo1.total_registros === 'number'
                ? jsonCorpo1.total_registros
                : itensP1.length

        totalPaginasGeral =
          typeof jsonCorpo1.totalPaginas === 'number'
            ? jsonCorpo1.totalPaginas
            : Math.max(1, Math.ceil(totalRegistrosGeral / tamPaginaParam))

        // Compatibilidade legada caso explicitamente pedido paginacaoTotal
        if (paginacaoTotal && totalPaginasGeral > 1 && limitePaginasMax > 1 && paginaParam === 1) {
          var maxPagina = Math.min(totalPaginasGeral, limitePaginasMax)
          console.log('[PNCP-PROXY] Modo legado: paginando Atas até', maxPagina)
          for (var p = 2; p <= maxPagina; p++) {
            var urlProx = buildSearchUrl('ata', p, tamPaginaParam)
            var resProx = fetchEndpoint(urlProx, 2.5)
            if (
              resProx.ok &&
              resProx.resp &&
              resProx.resp.statusCode >= 200 &&
              resProx.resp.statusCode < 300
            ) {
              try {
                var bodyProx = resProx.resp.json || JSON.parse(resProx.resp.raw)
                var itemsProx = extractRawItems(bodyProx)
                if (itemsProx && itemsProx.length > 0) {
                  todasContratacoes = todasContratacoes.concat(itemsProx)
                }
              } catch (_) {}
            }
          }
        }
      } else {
        // Segunda tentativa: EDITAIS
        var urlInicialEditais = buildSearchUrl('edital', paginaParam, tamPaginaParam)
        var attempt2 = fetchEndpoint(urlInicialEditais, 3.5)
        var jsonCorpo2 = null
        if (
          attempt2.ok &&
          attempt2.resp &&
          attempt2.resp.statusCode >= 200 &&
          attempt2.resp.statusCode < 300
        ) {
          try {
            jsonCorpo2 = attempt2.resp.json || JSON.parse(attempt2.resp.raw)
          } catch (_) {}
        }

        var itensP2 = extractRawItems(jsonCorpo2)
        if (itensP2.length > 0) {
          tipoDocumentoUtilizado = 'edital'
          todasContratacoes = itensP2.slice()
          totalRegistrosGeral =
            typeof jsonCorpo2.totalRegistros === 'number'
              ? jsonCorpo2.totalRegistros
              : typeof jsonCorpo2.total === 'number'
                ? jsonCorpo2.total
                : itensP2.length

          totalPaginasGeral =
            typeof jsonCorpo2.totalPaginas === 'number'
              ? jsonCorpo2.totalPaginas
              : Math.max(1, Math.ceil(totalRegistrosGeral / tamPaginaParam))
        }
      }

      // Se ainda não achou nada ou upstream inacessível
      if (!todasContratacoes || todasContratacoes.length === 0) {
        if (!attempt1.ok && attempt1.error) {
          return e.json(502, {
            error: 'PNCP_UPSTREAM_UNAVAILABLE',
            message:
              'A API pública do PNCP está temporariamente inacessível ou não respondeu no tempo limite.',
            detail: attempt1.error,
            upstreamStatus: (attempt1.resp && attempt1.resp.statusCode) || 502,
          })
        }
        return e.json(200, {
          items: [],
          total: 0,
          totalRegistros: 0,
          totalPaginas: 1,
          paginaAtual: paginaParam,
          detalhamento_paralelo: { total_processado: 0, sucessos: 0, fila_retry: 0 },
        })
      }

      // Deduplicar contratações da página por id ou numeroControlePNCP
      var seenIds = {}
      var contratacoesUnicas = []
      for (var idx = 0; idx < todasContratacoes.length; idx++) {
        var itemObj = todasContratacoes[idx]
        var key =
          itemObj.numeroControlePNCP ||
          itemObj.numero_controle_pncp ||
          itemObj.id ||
          itemObj.itemUrl ||
          String(idx)
        if (!seenIds[key]) {
          seenIds[key] = true
          contratacoesUnicas.push(itemObj)
        }
      }

      // 2. ENRIQUECIMENTO: detalha TODAS as contratações da página atual sem corte artificial
      // Como a página tem tamPaginaParam itens (padrão 10-15), o loop processa todas com timeout defensivo de 1.8s
      var contratacoesParaDetalhar = []
      for (var i = 0; i < contratacoesUnicas.length; i++) {
        var entry = contratacoesUnicas[i]
        var jaTemPreco = false
        if (Array.isArray(entry.itensAta) && entry.itensAta.length > 0) {
          jaTemPreco = entry.itensAta.some(function (it) {
            return (
              (Number(it.valorUnitarioHomologado) ||
                Number(it.valorUnitarioEstimado) ||
                Number(it.valorUnitario)) > 0
            )
          })
        }
        if (!jaTemPreco) {
          contratacoesParaDetalhar.push(entry)
        }
      }

      console.log(
        '[PNCP-PROXY] Página:',
        paginaParam,
        'Contratações da página:',
        contratacoesUnicas.length,
        'Para detalhar itens:',
        contratacoesParaDetalhar.length,
      )

      // Extração de parâmetros de compra
      function extrairParametrosCompra(entryObj) {
        var orgaoCnpj = (
          (entryObj.orgaoEntidade && entryObj.orgaoEntidade.cnpj) ||
          (entryObj.orgaoSubRogado && entryObj.orgaoSubRogado.cnpj) ||
          entryObj.orgao_cnpj ||
          entryObj.cnpj ||
          ''
        ).replace(/\D/g, '')

        var ano = entryObj.anoCompra || entryObj.ano || entryObj.anoAta || 0
        var sequencial =
          entryObj.numero_sequencial_compra_ata ||
          entryObj.numeroSequencialCompraAta ||
          entryObj.sequencialCompra ||
          entryObj.numeroSequencialCompra ||
          0

        var itemUrl = entryObj.item_url || entryObj.itemUrl || ''
        if ((!sequencial || !ano) && itemUrl && itemUrl.indexOf('/atas/') !== -1) {
          var urlParts = itemUrl.split('/').filter(Boolean)
          if (urlParts.length >= 4) {
            ano = parseInt(urlParts[2], 10) || ano
            sequencial = parseInt(urlParts[3], 10) || sequencial
          }
        }

        var numControle =
          entryObj.numeroControlePNCP ||
          entryObj.numero_controle_pncp ||
          entryObj.numeroControlePncpCompra ||
          ''
        if ((!ano || !sequencial) && numControle && numControle.indexOf('/') !== -1) {
          var slashParts = numControle.split('/')
          if (slashParts.length >= 2) {
            var beforeSlash = slashParts[0].split('-')
            if (beforeSlash.length >= 3) {
              sequencial = parseInt(beforeSlash[2], 10) || sequencial
            }
            var afterSlash = slashParts[1].split('-')
            ano = parseInt(afterSlash[0], 10) || ano
          }
        }

        if (!sequencial) {
          sequencial = entryObj.numero_sequencial || entryObj.numeroSequencialAta || 0
        }

        return { cnpj: orgaoCnpj, ano: ano, sequencial: sequencial }
      }

      // Processamento com matching canônico estrito
      function processarItensResposta(entryObj, itensArray) {
        if (!itensArray || itensArray.length === 0) return false

        function canonicalNormalize(s) {
          if (!s) return ''
          return String(s)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/(\d+)\s*(MG|ML|G|MCG|KG|L)\b/g, '$1$2')
            .replace(/[^A-Z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        }

        function extractTokens(s) {
          var STOPWORDS = {
            DE: true,
            DA: true,
            DO: true,
            DAS: true,
            DOS: true,
            EM: true,
            PARA: true,
            COM: true,
            SEM: true,
            POR: true,
            AO: true,
            AOS: true,
            ITEM: true,
            LOTE: true,
            AQUISICAO: true,
            FORNECIMENTO: true,
            REGISTRO: true,
            PRECOS: true,
          }
          var norm = canonicalNormalize(s)
          if (!norm) return []
          return norm.split(/\s+/).filter(function (t) {
            return t.length >= 2 && !STOPWORDS[t]
          })
        }

        function stemToken(t) {
          if (!t || t.length <= 3) return t
          if (t.endsWith('ES') && t.length > 4) return t.slice(0, -2)
          if (t.endsWith('S') && !t.endsWith('SS')) return t.slice(0, -1)
          return t
        }

        var qTokens = extractTokens(q)
        var matchedItens = itensArray.filter(function (it) {
          var desc = it.descricao || it.materialOuServicoNome || ''
          var descNorm = canonicalNormalize(desc)
          if (qTokens.length === 0) return true
          var descTokens = extractTokens(desc)
          return qTokens.every(function (qt) {
            var qtStem = stemToken(qt)
            if (descNorm.indexOf(qt) !== -1 || descNorm.indexOf(qtStem) !== -1) return true
            return descTokens.some(function (dt) {
              var dtStem = stemToken(dt)
              return (
                dt.indexOf(qt) !== -1 ||
                qt.indexOf(dt) !== -1 ||
                dtStem.indexOf(qtStem) !== -1 ||
                qtStem.indexOf(dtStem) !== -1
              )
            })
          })
        })

        // GARANTIA INNEGOCIÁVEL: nenhum item compatível = ZERO amostras (sem fallback contaminante)
        if (matchedItens.length === 0) {
          entryObj.itensAta = []
          return false
        }

        // Deduplicação de subitens: numeroControle + numeroItem + valorUnitario + fornecedorCnpj
        var subItensDeduplicados = []
        var subItensChavesVistas = {}

        matchedItens.forEach(function (it) {
          var numItem = it.numeroItem || 1
          var vUnit =
            Number(it.valorUnitarioHomologado) ||
            Number(it.valorUnitarioEstimado) ||
            Number(it.valorUnitario) ||
            0
          var controle =
            entryObj.numeroControlePNCP || entryObj.numero_controle_pncp || entryObj.id || ''
          var cnpjFornec = (
            (it.fornecedor && (it.fornecedor.niFornecedor || it.fornecedor.cnpj)) ||
            (entryObj.fornecedor &&
              (entryObj.fornecedor.niFornecedor || entryObj.fornecedor.cnpj)) ||
            it.fornecedor_cnpj ||
            entryObj.fornecedor_cnpj ||
            it.fornecedorNome ||
            entryObj.fornecedor_nome ||
            'PADRAO'
          ).replace(/[^A-Z0-9]/gi, '')
          var chaveItem = controle + '_' + numItem + '_' + vUnit.toFixed(4) + '_' + cnpjFornec

          if (!subItensChavesVistas[chaveItem]) {
            subItensChavesVistas[chaveItem] = true
            subItensDeduplicados.push({
              numeroItem: numItem,
              descricao:
                it.descricao || it.materialOuServicoNome || entryObj.objeto || entryObj.description,
              materialOuServico: it.materialOuServico || 'CATMAT',
              materialOuServicoNome: it.materialOuServicoNome || '',
              valorUnitarioHomologado: vUnit,
              valorUnitarioEstimado: Number(it.valorUnitarioEstimado) || 0,
              quantidade: Number(it.quantidade) || 1,
              unidadeMedida: it.unidadeMedida || 'UN',
              marcaNome: it.marcaNome || 'NÃO INFORMADO',
              modeloNome: it.modeloNome || '',
              fornecedor: it.fornecedor || entryObj.fornecedor || null,
            })
          }
        })

        entryObj.itensAta = subItensDeduplicados
        return subItensDeduplicados.length > 0
      }

      // Detalhamento sequencial defensivo de TODAS as contratações da página (timeout 1.8s por item)
      var sucessosDetalhamento = 0
      var totalTentativas = 0

      for (var c = 0; c < contratacoesParaDetalhar.length; c++) {
        var entryItem = contratacoesParaDetalhar[c]
        var p = extrairParametrosCompra(entryItem)
        if (!p.cnpj || !p.ano || !p.sequencial) {
          entryItem._detalhamento_pendente = true
          entryItem._motivo_detalhamento = 'Parâmetros de compra insuficientes'
          continue
        }

        var itensUrl =
          'https://pncp.gov.br/api/pncp/v1/orgaos/' +
          p.cnpj +
          '/compras/' +
          p.ano +
          '/' +
          p.sequencial +
          '/itens?pagina=1&tamanhoPagina=25'

        totalTentativas++
        // Timeout balanceado de 1.4s por contratação na página inicial para garantir resposta rápida (<3s)
        var resItens = fetchEndpoint(itensUrl, 1.4)
        var okProcessado = false

        if (
          resItens.ok &&
          resItens.resp &&
          resItens.resp.statusCode >= 200 &&
          resItens.resp.statusCode < 300
        ) {
          try {
            var bodyItens = resItens.resp.json || JSON.parse(resItens.resp.raw)
            var arr = extractRawItems(bodyItens)

            if (arr && arr.length > 0) {
              for (var itIdx = 0; itIdx < arr.length; itIdx++) {
                var subIt = arr[itIdx]
                var precoVal =
                  Number(subIt.valorUnitarioHomologado) || Number(subIt.valorUnitario) || 0
                if (precoVal <= 0 && subIt.temResultado && subIt.numeroItem) {
                  var resResultados = fetchEndpoint(
                    'https://pncp.gov.br/api/pncp/v1/orgaos/' +
                      p.cnpj +
                      '/compras/' +
                      p.ano +
                      '/' +
                      p.sequencial +
                      '/itens/' +
                      subIt.numeroItem +
                      '/resultados',
                    0.9,
                  )
                  if (
                    resResultados.ok &&
                    resResultados.resp &&
                    resResultados.resp.statusCode >= 200 &&
                    resResultados.resp.statusCode < 300
                  ) {
                    try {
                      var bodyRes = resResultados.resp.json || JSON.parse(resResultados.resp.raw)
                      var arrRes = extractRawItems(bodyRes)
                      if (arrRes && arrRes.length > 0) {
                        var prime = arrRes[0]
                        subIt.valorUnitarioHomologado =
                          Number(prime.valorUnitarioHomologado) ||
                          Number(
                            prime.valorTotalHomologado && prime.quantidadeHomologada
                              ? prime.valorTotalHomologado / prime.quantidadeHomologada
                              : 0,
                          ) ||
                          0
                        if (prime.nomeRazaoSocialFornecedor) {
                          subIt.fornecedorNome = prime.nomeRazaoSocialFornecedor
                          subIt.fornecedor = {
                            nomeRazaoSocial: prime.nomeRazaoSocialFornecedor,
                            niFornecedor: prime.niFornecedor || '',
                            cnpj: prime.niFornecedor || '',
                          }
                        }
                      }
                    } catch (_) {}
                  }
                }
              }
            }

            if (processarItensResposta(entryItem, arr)) {
              okProcessado = true
              sucessosDetalhamento++
            }
          } catch (_) {}
        }

        if (!okProcessado) {
          entryItem._detalhamento_pendente = true
          entryItem._motivo_detalhamento = resItens.error || 'Timeout ou itens não homologados'
        }
      }

      // Marcar pendências remanescentes de forma transparente
      for (var k = 0; k < contratacoesUnicas.length; k++) {
        var objCheck = contratacoesUnicas[k]
        if (!objCheck.itensAta || objCheck.itensAta.length === 0) {
          if (!objCheck._detalhamento_pendente) {
            objCheck._detalhamento_pendente = true
            objCheck._motivo_detalhamento = 'Sem itens homologados compatíveis com o termo'
          }
        }
      }

      console.log(
        '[PNCP-PROXY] Página',
        paginaParam,
        'concluída. Sucessos:',
        sucessosDetalhamento,
        'Tentativas:',
        totalTentativas,
        'Total páginas no PNCP:',
        totalPaginasGeral,
      )

      return e.json(200, {
        sucesso: true,
        items: contratacoesUnicas,
        total: totalRegistrosGeral,
        totalRegistros: totalRegistrosGeral,
        totalPaginas: totalPaginasGeral,
        paginaAtual: paginaParam,
        tamPagina: tamPaginaParam,
        tipoDocumento: tipoDocumentoUtilizado,
        detalhamento_paralelo: {
          total_encontrado: contratacoesUnicas.length,
          total_detalhado: sucessosDetalhamento,
          itens_fila_pendente: Math.max(0, contratacoesUnicas.length - sucessosDetalhamento),
        },
      })
    } catch (globalErr) {
      console.log('[PNCP-PROXY] Exceção tratada no hook:', globalErr.message)
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
