# Integração do COTAI entre Codex e Skip

Este registro descreve o fluxo de alterações do projeto COTAI pelo Codex, usando o GitHub como ponte para o editor do Skip.

## Repositório e fluxo

O repositório conectado é [sinvalsalomao-adv/cotai-fyfl1q9z4](https://github.com/sinvalsalomao-adv/cotai-fyfl1q9z4), com a branch `main` como destino deste teste documental.

1. O usuário solicita a alteração no Codex.
2. A alteração é preparada, revisada e verificada antes do envio ao GitHub.
3. No editor do Skip, a opção **Configurações e Estatísticas > Github > Sincronizar do GitHub** importa as alterações do repositório conectado.
4. O resultado é conferido no editor. A publicação em produção é uma etapa separada, sujeita à autorização do usuário.

Esse fluxo usa a conexão GitHub existente e a sessão autenticada do editor. Não constitui uma integração MCP nativa com o Skip nem garante sincronização automática.

## Escopo do teste documental

A autorização de 14 de outubro de 2026 abrange somente este arquivo e sua sincronização no Skip. Não inclui publicação em produção, alterações de banco de dados, migrações, execução de coletores ou envio das correções de preços em desenvolvimento local.

A validação exige conferir que o commit contém apenas este documento e que a sincronização foi concluída no editor. O envio do arquivo, isoladamente, não comprova a sincronização.

## Dados de preços

O requisito do projeto permanece: utilizar somente dados reais do PNCP e do Compras.gov.br, com rastreabilidade e links de origem. Este documento não adiciona amostras, não executa buscas e não declara concluída a implementação do acervo nacional.
