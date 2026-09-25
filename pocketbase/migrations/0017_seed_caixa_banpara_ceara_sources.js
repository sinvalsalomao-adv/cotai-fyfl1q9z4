/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // Inserir as fontes pendentes (Banpará, Caixa e Compras CE) usando raw SQL com ID único
    const fontesAdicionaisSql = [
      [
        'compras_ce',
        'Portal de Compras CE — Governo do Estado do Ceará',
        'regional',
        'geral',
        'api_rest',
        'diaria',
        'em_homologacao',
        0,
        'https://compras.seplag.ce.gov.br',
        'Pública Estadual / Requer Convênio',
        'CE',
        'Governo do Estado do Ceará - SEPLAG',
        'contratado',
        0,
        'v1.0.0',
        'AGUARDA CREDENCIAMENTO: Licitações e cotações eletrônicas do Estado do Ceará.',
      ],
      [
        'banpara_compras',
        'Banpará Licitações Eletrônicas',
        'regional',
        'geral',
        'api_rest',
        'diaria',
        'em_homologacao',
        0,
        'https://www.banpara.b.br/licitacoes',
        'Requer Convênio Bancário',
        'PA',
        'Banco do Estado do Pará (Banpará)',
        'contratado',
        0,
        'v1.0.0',
        'AGUARDA CREDENCIAMENTO: Portal de compras públicas e pregões do Banpará para entes da região Norte.',
      ],
      [
        'caixa_compras',
        'Caixa Licitações Eletrônicas (e-Compras Caixa)',
        'governamental',
        'geral',
        'api_rest',
        'diaria',
        'em_homologacao',
        0,
        'https://www.caixa.gov.br/compras-governamentais',
        'Requer Convênio / Caixa',
        '',
        'Caixa Econômica Federal',
        'contratado',
        0,
        'v1.0.0',
        'AGUARDA CREDENCIAMENTO: Plataforma de pregões eletrônicos e compras governamentais da Caixa Econômica Federal.',
      ],
    ]

    for (const f of fontesAdicionaisSql) {
      const randomId = 'fnt' + Math.random().toString(36).substring(2, 14)
      app
        .db()
        .newQuery(
          "INSERT OR IGNORE INTO fontes_catalogo (id, codigo, nome, tipo, categoria, formato, frequencia, status, runtime_enabled, endpoint_url, autenticacao_tipo, uf_regional, orgao_regional, tipo_preco, is_regulatorio, versao_adaptador, observacoes, created, updated) VALUES ({:id}, {:codigo}, {:nome}, {:tipo}, {:categoria}, {:formato}, {:frequencia}, {:status}, {:runtime_enabled}, {:endpoint_url}, {:autenticacao_tipo}, {:uf_regional}, {:orgao_regional}, {:tipo_preco}, {:is_regulatorio}, {:versao_adaptador}, {:observacoes}, DATETIME('now'), DATETIME('now'))",
        )
        .bind({
          id: randomId,
          codigo: f[0],
          nome: f[1],
          tipo: f[2],
          categoria: f[3],
          formato: f[4],
          frequencia: f[5],
          status: f[6],
          runtime_enabled: f[7],
          endpoint_url: f[8],
          autenticacao_tipo: f[9],
          uf_regional: f[10],
          orgao_regional: f[11],
          tipo_preco: f[12],
          is_regulatorio: f[13],
          versao_adaptador: f[14],
          observacoes: f[15],
        })
        .execute()
    }
  },
  (app) => {
    try {
      app
        .db()
        .newQuery(
          "DELETE FROM fontes_catalogo WHERE codigo IN ('compras_ce', 'banpara_compras', 'caixa_compras')",
        )
        .execute()
    } catch (_) {}
  },
)
