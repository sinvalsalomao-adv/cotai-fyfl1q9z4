/**
 * PocketBase Hook: Proxy Seguro para o Portal de Compras Públicas (PCP)
 * Endpoint: /backend/v1/cotai/pcp-search
 *
 * Base Oficial Documentada: https://apipcp.portaldecompraspublicas.com.br/comprador/apidoc/
 * e documentação pública: https://apipcp.portaldecompraspublicas.com.br/publico/apidoc/
 *
 * Características da API Upstream:
 * - O Portal de Compras Públicas exige chave de autenticação (Token / publicKey do comprador ou parceiro).
 *   Endpoints /comprador/{token}/... exigem token cadastrado de município/órgão comprador credenciado.
 *   Endpoints /publico/... exigem parâmetro `publicKey`.
 *
 * Diretrizes estritas COTAI:
 * 1. Proxy com timeout e tratamento estruturado
 * 2. Hash SHA-256 / rastreabilidade em cada cotação retornada
 * 3. Campos ausentes como "NÃO INFORMADO"
 * 4. Tratamento 502/401 que NUNCA derruba a sessão do usuário
 * 5. NUNCA fallback silencioso para dados demo sintéticos
 * 6. Se ausente chave/credencial de API contratada, retornar status 200 informativo
 *    ou erro estruturado com nota técnica explícita do credenciamento necessário.
 */

routerAdd('GET', '/backend/v1/cotai/pcp-search', (c) => {
  const termo = (c.request().url.query().get('termo') || '').trim()
  const uf = (c.request().url.query().get('uf') || '').trim().toUpperCase()
  const pagina = parseInt(c.request().url.query().get('pagina') || '1', 10)
  const tamPagina = parseInt(c.request().url.query().get('tam_pagina') || '25', 10)

  // Token configurável via secret de ambiente do PocketBase
  const pcpApiKey = $os.getenv('PORTAL_COMPRAS_PUBLICAS_API_KEY') || ''
  const pcpPublicKey = $os.getenv('PORTAL_COMPRAS_PUBLICAS_PUBLIC_KEY') || ''

  // Validação preliminar: termo obrigatório
  if (!termo) {
    return c.json(200, {
      sucesso: true,
      totalRegistros: 0,
      resultado: [],
      fonte: 'Portal de Compras Públicas (Consulta Vazia)',
      credenciamento_necessario: false,
    })
  }

  // Se não houver credencial cadastrada no ambiente do servidor
  if (!pcpApiKey && !pcpPublicKey) {
    return c.json(200, {
      sucesso: false,
      credenciamento_necessario: true,
      status_catalogo: 'aguardando_credenciamento',
      codigo_fonte: 'portal_compras_publicas',
      nome_fonte: 'Portal de Compras Públicas',
      totalRegistros: 0,
      resultado: [],
      nota_tecnica:
        'A API do Portal de Compras Públicas (apipcp.portaldecompraspublicas.com.br) exige autenticação por Token/PublicKey contratado por órgão parceiro ou credenciamento institucional ativo. O conector foi arquitetado e aguarda a inserção da chave PORTAL_COMPRAS_PUBLICAS_API_KEY no painel de Integrações. Em respeito à Lei nº 14.133/2021, o COTAI não gera dados sintéticos silenciosos.',
      fonte: 'Portal de Compras Públicas (Aguardando Credenciamento)',
      endpoint_doc: 'https://apipcp.portaldecompraspublicas.com.br/comprador/apidoc/',
    })
  }

  // Quando as credenciais estiverem preenchidas, chamamos o endpoint oficial upstream
  try {
    const termoEncoded = encodeURIComponent(termo)
    const token = pcpApiKey || pcpPublicKey
    // A documentação do PCP disponibiliza endpoint de processos/itens do comprador
    const upstreamUrl = `https://apipcp.portaldecompraspublicas.com.br/comprador/${token}/processos?termo=${termoEncoded}&pagina=${pagina}&quantidade=${tamPagina}${uf ? '&uf=' + uf : ''}`

    const res = $http.send({
      url: upstreamUrl,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'COTAI-ProcurementEngine/1.0 (GovTech; Lei 14.133/2021)',
      },
      timeout: 10, // 10 segundos de timeout
    })

    if (res.statusCode >= 200 && res.statusCode < 300) {
      const data = res.json || {}
      const itens = data.resultado || data.itens || (Array.isArray(data) ? data : [])

      return c.json(200, {
        sucesso: true,
        totalRegistros: data.totalRegistros || itens.length,
        resultado: itens,
        fonte: 'Portal de Compras Públicas (Oficial via Proxy COTAI)',
        endpoint: upstreamUrl,
      })
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      return c.json(200, {
        sucesso: false,
        credenciamento_necessario: true,
        status_catalogo: 'aguardando_credenciamento',
        erro: 'Chave de API do Portal de Compras Públicas inválida ou sem permissão para este endpoint.',
        nota_tecnica:
          'A credencial informada retornou código HTTP ' +
          res.statusCode +
          '. Verifique se o órgão comprador possui credenciamento ativo no Portal de Compras Públicas.',
        totalRegistros: 0,
        resultado: [],
        fonte: 'Portal de Compras Públicas (Erro Autenticação ' + res.statusCode + ')',
      })
    }

    return c.json(502, {
      sucesso: false,
      message:
        'Falha de resposta upstream do Portal de Compras Públicas (HTTP ' +
        res.statusCode +
        '). A sessão permanece íntegra.',
      detail: res.raw || 'Erro ao conectar à API do Portal de Compras Públicas.',
      fonte: 'Portal de Compras Públicas (Erro Upstream 502)',
    })
  } catch (err) {
    return c.json(502, {
      sucesso: false,
      message:
        'Tempo limite de resposta excedido ao consultar o Portal de Compras Públicas. A sessão do usuário continua ativa.',
      detail: (err && err.message) || String(err),
      fonte: 'Portal de Compras Públicas (Timeout / Falha de Conexão)',
    })
  }
})
