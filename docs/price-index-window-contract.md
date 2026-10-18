# Contrato de janela do índice de preços

O modal solicita no máximo 100 resultados na primeira resposta. Essa resposta inclui o resumo da população (`total`, agregações e estatísticas) sem exigir que toda a população seja transferida ao navegador.

O cliente aceita dois contratos de continuação:

1. **Cursor/snapshot (preferencial):** a primeira resposta informa `snapshot`, `next_cursor` e `has_more`. Cada continuação envia o mesmo `snapshot` e o cursor opaco. A resposta deve repetir o snapshot, informar `has_more` explicitamente e, quando houver mais dados, fornecer um novo cursor.
2. **Página numérica (compatibilidade atual):** a primeira resposta informa `page` e `pages`. As continuações usam `include_summary: false`; o total de páginas comprovado na primeira resposta permanece vinculado à sessão.

Uma página curta, uma falha ou a ausência desses campos não comprovam o fim da população. Nesses casos, os resultados já exibidos são preservados e o estado terminal não é inventado.

No navegador, ficam no máximo seis páginas (aproximadamente 600 amostras) em memória. Esse é apenas o limite de memória da grade, não um limite da pesquisa. Ao chegar perto do fim, a próxima página do snapshot completo é carregada automaticamente; páginas antigas saem da memória e a navegação pode prosseguir até o último resultado. Amostras escolhidas ficam pinadas quando uma página antiga sai da janela.

O servidor materializa a população correspondente aos filtros diretamente no SQLite, uma linha compacta por amostra, sem agregar toda a população em um JSON gigante, sem trazer todos os registros para o JavaScript e sem chamar PNCP ou Compras.gov.br durante a paginação. O snapshot é imutável por dez minutos, vinculado ao usuário e aos filtros, e preserva a ordem e o conteúdo mesmo se o índice receber inclusões, alterações ou exclusões concorrentes. Existem no máximo três snapshots ativos por usuário. Cada amostra, cada página reconstruída e o total do snapshot têm limites explícitos de bytes; se um desses limites de segurança for excedido, a busca falha de forma explícita e nunca informa falsamente que entregou todos os resultados.

O filtro de fonte separa dois contratos:

- **coleta oficial:** sempre permanece em PNCP + Compras.gov.br e não é reiniciada quando o usuário muda a fonte da grade;
- **visão do índice:** cada aplicação, remoção ou limpeza do filtro faz uma nova consulta rápida à população persistida, com `sources`/`fonte`, página 1 e resumo próprios. A continuação conserva exatamente o mesmo filtro.

Assim, uma fonte que só apareceria depois das primeiras 600 linhas também pode ser encontrada ao continuar o scroll, sem um corte arbitrário no servidor. Uma troca de fonte invalida somente a janela anterior. Se alguma seleção ficar invisível na nova visão, ela é explicitamente desmarcada e a interface informa quantas seleções foram removidas; nenhuma linha invisível pode ser confirmada.
