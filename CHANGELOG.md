# Changelog COTAI

## [v0.0.122] - 2025-05-18

### Corrigido e Aprimorado

- **Contagem Efetiva de Amostras por Termo (`src/services/budgetService.ts`)**:
  - Corrigido `totalEncontrados` em `BudgetService.buscarPrecosAvancado` para retornar `precosAgregados.length` (a contagem real de amostras retornadas para o item/termo pesquisado) em vez de herdar `resultadoOrquestrador.observabilidade.totalAmostrasInformadasApis`.
  - Isso elimina o problema em que o total de contratações globais informado pela API upstream do PNCP (~12.000 contratações gerais do portal) era exibido de forma indiscriminada para qualquer termo pesquisado (ex.: "dipirona" e "picolé" exibindo o mesmo valor).

- **Discriminação de Busca e Eliminação de Falso-Positivo Textual (`pocketbase/hooks/price_index_worker.js`)**:
  - `itemEhCompativelWorker`: eliminadas comparações invertidas (`tokenPrincipal.indexOf(dt) === 0` e `tokenStem.indexOf(dtStem) === 0`), que faziam qualquer token curto iniciado com prefixos casuais casar erroneamente com termos de busca (ex.: serviços com "kit guloseimas" do Município de Itambé sendo associados a "picolé").
  - Exigida igualdade estrita de token ou de radical (stem) com comprimento mínimo (>= 4 caracteres) e tolerância de comprimento restrita a no máximo 3 caracteres no prefixo.

- **Cálculo de Similaridade Real Dice/Jaccard (`pocketbase/hooks/price_index_worker.js`)**:
  - Implementada a função `calcularDiceScoreWorker(tokensTermo, tokensDesc)` baseada na sobreposição (Dice Coefficient) entre os tokens e radicais do termo de pesquisa e da descrição do item.
  - O campo `matching_score` agora armazena o score real calculado (10 a 100), eliminando a atribuição estática e fictícia de score 95 fixo para todas as amostras salvas por texto.

- **Eliminação de Código Curinga "CATMAT" (`pocketbase/hooks/price_index_worker.js`, `pocketbase/hooks/daily_sync_job.js` e Migração 0065)**:
  - Implementadas funções de extração `extrairCodigoItemWorker` e `extrairCodigoItemDaily`: quando a API upstream não informa código numérico CATMAT válido (padrão `\d{4,8}`), o campo `codigo_item` é gravado vazio (`''`), nunca mais com a string literal `'CATMAT'`.
  - Migração `0065_purge_false_positives_and_clean_catmat.js` executada para purgar o registro falso-positivo de "kit guloseimas" (Município de Itambé) e sanear os registros existentes no `price_samples_index`, removendo o literal `'CATMAT'` solto.

## [v0.0.121] - 2025-05-18

### Corrigido e Aprimorado

- **Correção de Escopo de Variável no Modal de Pesquisa (`src/components/ModalPesquisarPrecos.tsx`)**:
  - Declarada explicitamente a variável `resIndex` no escopo do método `carregarDadosIniciais` para armazenar o resultado da chamada inicial a `PriceIndexService.searchIndex`.
  - Corrigidas as referências de leitura de agregação por fonte (`resIndex?.aggregations?.por_fonte`) e status da tarefa de coleta (`resIndex?.status_tarefa`), sanando o erro de compilação/TypeScript da v0.0.120.
  - O card de diagnóstico no modal agora consome corretamente a contagem agregada do índice persistente, refletindo as centenas de amostras reais homologadas indexadas.

## [v0.0.120] - 2025-05-18

### Corrigido e Aprimorado

- **Cards de Status das Fontes no Modal de Pesquisa de Preços (`src/components/ModalPesquisarPrecos.tsx`)**:
  - A contagem de amostras recuperadas de cada fonte (`diag.amostrasObtidas`) agora adota como fonte da verdade primária a agregação por fonte retornada pelo backend (`resIndex.aggregations.por_fonte`), evitando que o card exiba apenas as poucas cotações prévias salvas do item na sessão anterior (ex.: 3) quando o acervo indexado possui centenas de amostras (ex.: 763 PNCP para dipirona).
  - Mensagem do card atualizada para refletir a indexação real (ex.: "763 amostras oficiais homologadas indexadas").
  - Formatação com separador de milhar (`.toLocaleString('pt-BR')`) para contagens expressivas do índice.
- **Badge Coerente com o Ciclo Real de Coleta**:
  - Se houver tarefa de coleta/indexação ativa para o termo ou itens pendentes na fila (`status_tarefa.ativa`, `itensFilaPendente > 0`, `coletaEmTempoRealAtiva`), o badge de status exibe "COLETA EM ANDAMENTO / DETALHANDO" com estilo em azul/sky.
  - O badge "CONCLUÍDO" só é exibido quando não há pendências na fila de coleta e a contagem de amostras estiver consolidada, eliminando estado congelado enganoso.
- **Endpoint de Busca do Índice (`pocketbase/hooks/prices_search.js` e `src/lib/priceIndexService.ts`)**:
  - `POST /backend/v1/prices/search`: expõe o objeto `status_tarefa` consultando a tabela `price_index_tasks` para a chave canônica `AMBAS#<TERMO>#<UF>`, trazendo `status`, se está `ativa`, `pendentes_count`, `itens_processados` e métricas do ciclo.
  - Tipagem atualizada em `PriceIndexSearchResult` em `src/lib/priceIndexService.ts`.

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
