// Endpoint de proxy seguro para a API do PNCP no backend Skip Cloud (PocketBase)
// Resolve restrições de CORS do navegador, timeouts, paginação total e enriquecimento com fila de detalhamento/retry.
// GET /backend/v1/pncp/search?q=termo&pagina=1&tam_pagina=25&uf=RN&paginacao_total=true&limite_paginas=5

routerAdd(
  'GET',
  '/backend/v1/pncp/search',
  (e) => {
    try {
      const q = (e.requestInfo().query.q || '').trim()
      const paginaParam = parseInt(e.requestInfo().query.pagina || '1', 10) || 1
      const tamPaginaParam = parseInt(e.requestInfo().query.tam_pagina || '25', 10) || 25
      const uf = (e.requestInfo().query.uf || '').trim().toUpperCase()
      const paginacaoTotal =
        (e.requestInfo().query.paginacao_total || '').toLowerCase() === 'true' ||
        (e.requestInfo().query.todas_paginas || '').toLowerCase() === 'true'
      const limitePaginasMax = Math.min(
        parseInt(e.requestInfo().query.limite_paginas || '6', 10) || 6,
        15,
      )
      const maxContratacoesDetalhar = Math.min(
        parseInt(e.requestInfo().query.max_detalhar || '40', 10) || 40,
        100,
      )

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
        'Paginação Total:',
        paginacaoTotal,
      )

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
          return { ok: false, error: err.message || 'Falha de rede/timeout' }
        }
      }

      // Construtor de URL de busca no PNCP
      const buildSearchUrl = (docTipo, pNum, pSize) => {
        let u =
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
      const extractRawItems = (body) => {
        if (!body) return []
        if (Array.isArray(body)) return body
        if (Array.isArray(body.items)) return body.items
        if (Array.isArray(body.data)) return body.data
        if (Array.isArray(body.resultado)) return body.resultado
        return []
      }

      // 1. Busca sumarizada com Paginação Total quando solicitado ou paginação normal
      let todasContratacoes = []
      let totalRegistrosGeral = 0
      let totalPaginasGeral = 1
      let tipoDocumentoUtilizado = 'ata'

      // Primeira tentativa: ATAS
      let urlInicialAtas = buildSearchUrl('ata', paginaParam, tamPaginaParam)
      let attempt1 = fetchEndpoint(urlInicialAtas, 8)
      if (!attempt1.ok) {
        attempt1 = fetchEndpoint(urlInicialAtas, 9)
      }

      let jsonCorpo1 = null
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

      let itensP1 = extractRawItems(jsonCorpo1)

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

        // Se solicitada Paginação Total e houver mais páginas além da primeira
        if (paginacaoTotal && totalPaginasGeral > 1) {
          const maxPagina = Math.min(totalPaginasGeral, limitePaginasMax)
          console.log('[PNCP-PROXY] Paginando Atas da página 2 até', maxPagina)
          for (let p = 2; p <= maxPagina; p++) {
            const urlProx = buildSearchUrl('ata', p, tamPaginaParam)
            const resProx = fetchEndpoint(urlProx, 7)
            if (
              resProx.ok &&
              resProx.resp &&
              resProx.resp.statusCode >= 200 &&
              resProx.resp.statusCode < 300
            ) {
              try {
                const bodyProx = resProx.resp.json || JSON.parse(resProx.resp.raw)
                const itemsProx = extractRawItems(bodyProx)
                if (itemsProx && itemsProx.length > 0) {
                  todasContratacoes = todasContratacoes.concat(itemsProx)
                }
              } catch (_) {}
            }
          }
        }
      } else {
        // Segunda tentativa: EDITAIS
        let urlInicialEditais = buildSearchUrl('edital', paginaParam, tamPaginaParam)
        let attempt2 = fetchEndpoint(urlInicialEditais, 8)
        let jsonCorpo2 = null
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

        let itensP2 = extractRawItems(jsonCorpo2)
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

          if (paginacaoTotal && totalPaginasGeral > 1) {
            const maxPaginaEdital = Math.min(totalPaginasGeral, limitePaginasMax)
            console.log('[PNCP-PROXY] Paginando Editais da página 2 até', maxPaginaEdital)
            for (let p = 2; p <= maxPaginaEdital; p++) {
              const urlProx = buildSearchUrl('edital', p, tamPaginaParam)
              const resProx = fetchEndpoint(urlProx, 7)
              if (
                resProx.ok &&
                resProx.resp &&
                resProx.resp.statusCode >= 200 &&
                resProx.resp.statusCode < 300
              ) {
                try {
                  const bodyProx = resProx.resp.json || JSON.parse(resProx.resp.raw)
                  const itemsProx = extractRawItems(bodyProx)
                  if (itemsProx && itemsProx.length > 0) {
                    todasContratacoes = todasContratacoes.concat(itemsProx)
                  }
                } catch (_) {}
              }
            }
          }
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

      // Deduplicar contratações por id ou numeroControlePNCP
      const seenIds = {}
      const contratacoesUnicas = []
      for (let idx = 0; idx < todasContratacoes.length; idx++) {
        const itemObj = todasContratacoes[idx]
        const key =
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

      // 2. ENRIQUECIMENTO PARALELO COM FILA DE DETALHAMENTO E RETRY
      // Identificar quais contratações precisam de detalhamento de itens
      const qUpper = q.toUpperCase()
      const contratacoesParaDetalhar = []

      for (let i = 0; i < contratacoesUnicas.length; i++) {
        const entry = contratacoesUnicas[i]
        // Se já tem itensAta válidos com preço > 0, pula
        let jaTemPreco = false
        if (Array.isArray(entry.itensAta) && entry.itensAta.length > 0) {
          jaTemPreco = entry.itensAta.some(function (it) {
            return (
              (Number(it.valorUnitarioHomologado) ||
                Number(it.valorUnitarioEstimado) ||
                Number(it.valorUnitario)) > 0
            )
          })
        }
        if (!jaTemPreco && contratacoesParaDetalhar.length < maxContratacoesDetalhar) {
          contratacoesParaDetalhar.push(entry)
        }
      }

      console.log(
        '[PNCP-PROXY] Total contratações localizadas:',
        contratacoesUnicas.length,
        'Para detalhar itens:',
        contratacoesParaDetalhar.length,
      )

      // Função para extrair parâmetros de uma contratação
      const extrairParametrosCompra = (entry) => {
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
        return { cnpj: orgaoCnpj, ano: ano, sequencial: sequencial }
      }

      // Função de processamento de itens de uma compra
      const processarItensResposta = (entry, itensArray) => {
        if (!itensArray || itensArray.length === 0) return false

        let matchedItens = itensArray.filter(function (it) {
          const desc = (it.descricao || it.materialOuServicoNome || '').toUpperCase()
          return desc.indexOf(qUpper) !== -1
        })
        if (matchedItens.length === 0) {
          matchedItens = itensArray.slice(0, 5)
        }

        entry.itensAta = matchedItens.map(function (it) {
          return {
            numeroItem: it.numeroItem || 1,
            descricao:
              it.descricao || it.materialOuServicoNome || entry.objeto || entry.description,
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
        return true
      }

      // Fila de detalhamento com controle de lote e retry para timeouts
      const filaFalhasTimeout = []
      let sucessosDetalhamento = 0

      // Tamanho do lote paralelo (8 chamadas por lote)
      const TAM_LOTE = 8
      for (let b = 0; b < contratacoesParaDetalhar.length; b += TAM_LOTE) {
        const chunk = contratacoesParaDetalhar.slice(b, b + TAM_LOTE)

        // Processa as requisições do lote
        for (let c = 0; c < chunk.length; c++) {
          const entry = chunk[c]
          const p = extrairParametrosCompra(entry)
          if (!p.cnpj || !p.ano || !p.sequencial) {
            continue
          }

          const itensUrl =
            'https://pncp.gov.br/api/pncp/v1/orgaos/' +
            p.cnpj +
            '/compras/' +
            p.ano +
            '/' +
            p.sequencial +
            '/itens?pagina=1&tamanhoPagina=20'

          // Primeira passada com timeout de 3.5s
          const resItens = fetchEndpoint(itensUrl, 4)
          let okProcessado = false

          if (
            resItens.ok &&
            resItens.resp &&
            resItens.resp.statusCode >= 200 &&
            resItens.resp.statusCode < 300
          ) {
            try {
              const body = resItens.resp.json || JSON.parse(resItens.resp.raw)
              const arr = extractRawItems(body)
              if (processarItensResposta(entry, arr)) {
                okProcessado = true
                sucessosDetalhamento++
              }
            } catch (_) {}
          }

          // Se falhou por timeout ou erro transitório, adiciona à fila de retry
          if (!okProcessado) {
            filaFalhasTimeout.push({
              entry: entry,
              params: p,
              url: itensUrl,
              motivo:
                resItens.error ||
                'Status ' + ((resItens.resp && resItens.resp.statusCode) || 'desconhecido'),
            })
          }
        }
      }

      // 3. SEGUNDA PASSADA (RETRY) para itens da fila de falhas/timeout com timeout maior
      if (filaFalhasTimeout.length > 0) {
        console.log(
          '[PNCP-PROXY] Executando retry para',
          filaFalhasTimeout.length,
          'contratações em fila',
        )
        const itemsAindaPendentes = []

        for (let r = 0; r < filaFalhasTimeout.length; r++) {
          const itemFila = filaFalhasTimeout[r]
          // Retry com timeout de 6s
          const retryRes = fetchEndpoint(itemFila.url, 6)
          let resolvido = false
          if (
            retryRes.ok &&
            retryRes.resp &&
            retryRes.resp.statusCode >= 200 &&
            retryRes.resp.statusCode < 300
          ) {
            try {
              const b = retryRes.resp.json || JSON.parse(retryRes.resp.raw)
              const arr = extractRawItems(b)
              if (processarItensResposta(itemFila.entry, arr)) {
                resolvido = true
                sucessosDetalhamento++
              }
            } catch (_) {}
          }

          if (!resolvido) {
            // Marca metadado no item para rastreabilidade estrita (nunca descartar silenciosamente)
            itemFila.entry._detalhamento_pendente = true
            itemFila.entry._motivo_detalhamento = itemFila.motivo
            itemsAindaPendentes.push({
              numeroControlePNCP: itemFila.entry.numeroControlePNCP || itemFila.entry.id,
              cnpj: itemFila.params.cnpj,
              ano: itemFila.params.ano,
              sequencial: itemFila.params.sequencial,
              url: itemFila.url,
            })
          }
        }

        console.log(
          '[PNCP-PROXY] Concluído detalhamento. Sucessos:',
          sucessosDetalhamento,
          'Ainda pendentes/fila:',
          itemsAindaPendentes.length,
        )
      }

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
          itens_fila_pendente: filaFalhasTimeout.length,
        },
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
