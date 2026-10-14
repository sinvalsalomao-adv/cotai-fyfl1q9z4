# Changelog COTAI

## [v0.0.115] - 2025-04-16

### Corrigido e Aprimorado

- **Canonicalização defensiva de fontes nos endpoints do backend (`pocketbase/hooks/prices_search.js`)**:
  - Tanto no `POST /backend/v1/prices/search` quanto no `GET /backend/v1/precos/busca`, os parâmetros `fonte`/`sources` agora são normalizados canonicamente antes de montar as cláusulas SQL (`source = {:...}`). Qualquer entrada contendo substring "PNCP" (case-insensitive) é convertida para `'PNCP'`; qualquer entrada com "COMPRAS" é convertida para `'Compras.gov.br'`.
- **Normalização no SDK Fallback e Conversão de Hits (`src/lib/priceIndexService.ts`)**:
  - `searchIndexFallbackSdk`: canonicalização de `params.fonte` antes de montar o filtro PocketBase (`source = "PNCP"` / `source = "Compras.gov.br"`).
  - `hitToAmostraPreco`: normalização estrita de `fonte` para `'PNCP'` ou `'Compras.gov.br'`, mantendo a transparência em `fonteNomeExibicao`.
- **Grade e Hidratação Imediata no Modal (`src/components/ModalPesquisarPrecos.tsx`)**:
  - `fonteNormalizada`: mapeamento ampliado cobrindo variantes `'PNCP (pncp.gov.br)'`, `'pncp.gov.br'` e `'PORTAL NACIONAL DE CONTRATACOES PUBLICAS'` para a chave canônica `'PNCP'`.
  - `carregarDadosIniciais`: hidratação imediata da grade via `PriceIndexService.searchIndex({ palavra_chave: searchTerm, tamanho_pagina: 100 })` quando `BudgetService.listarPrecosDoItem` retornar vazio, fazendo com que a grade nasça preenchida com as amostras do índice persistido local.
  - Sobrevivência de amostras com `source='PNCP'` no merge e na filtragem por fontes selecionadas.
