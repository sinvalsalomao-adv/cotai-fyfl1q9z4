# Relatório de Auditoria e Tentativa de Deploy de Migrações (Instância shrd04)

**Projeto Alvo:** `d2a89cbd-e942-417b-8502-c7b97a6b5173` (COTAI)  
**Data da Execução:** 21/10/2026  
**Ciclo Disparado:** 1 tentativa de deploy nativo (`apply_migrations`) conforme autorização expressa do usuário.

---

## 1. Resultado do Ciclo Nativo de Deploy

- **Comando disparado:** `apply_migrations()`
- **Resposta exata da plataforma:**
  ```text
  Migrations applied — the live schema is up to date.
  ```
- **Código de erro retornado:** Nenhum erro (`0 errors`, sem exceções lançadas pelo runner).

---

## 2. Ledger de Migrações (1741634517 a 1741634525)

Consulta ao estado live do backend via `list_migrations`:

| Migração   | Arquivo                                             | Estado no Ledger Nativo | Observações                                                                  |
| ---------- | --------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| 1741634517 | `1741634517_lock_price_samples_index_writes.js`     | **APPLIED**             | Regras de escrita fechadas para `price_samples_index`.                       |
| 1741634518 | `1741634518_create_official_ingestion_receipts.js`  | **PENDING**             | Coleção criada no schema físico mas pendente no ledger nativo da plataforma. |
| 1741634519 | `1741634519_lock_official_ingestion_state.js`       | **PENDING**             | Campo `server_trust_version` adicionado; regras travadas; registro pending.  |
| 1741634520 | `1741634520_secure_fast_price_search.js`            | **PENDING**             | Tentada anteriormente (18/10); não registrada como applied.                  |
| 1741634521 | `1741634521_index_task_admission_quota.js`          | **PENDING**             | Tentada anteriormente (18/10); não registrada como applied.                  |
| 1741634522 | `1741634522_secure_price_search_boundary.js`        | **NÃO REGISTRADA**      | Presente no repositório; não submetida ao ledger do servidor.                |
| 1741634523 | `1741634523_materialized_price_search_snapshots.js` | **NÃO REGISTRADA**      | Presente no repositório; não submetida ao ledger do servidor.                |
| 1741634524 | `1741634524_harden_backend_work_admission.js`       | **NÃO REGISTRADA**      | Presente no repositório; não submetida ao ledger do servidor.                |
| 1741634525 | `1741634525_owner_scope_price_index_task_keys.js`   | **NÃO REGISTRADA**      | Presente no repositório; não submetida ao ledger do servidor.                |

---

## 3. Verificação do Schema Efetivo Resultante

1. **Migração 1741634520 (`price_samples_index`):**
   - Campos `search_eligible` e `search_contract`: **Ausentes** no schema da coleção PocketBase.
   - Triggers FTS e tabela virtual `price_samples_fts`: Não ativados sobre as colunas.
   - API Rules de `price_samples_index`: Mantidas em `@request.auth.id != "" && server_trust_version = "server-v1"` para list/view; create/update/delete nulos.

2. **Migração 1741634521 (`price_index_tasks`):**
   - Campos `requested_by` e `admitted_at`: **Ausentes** na coleção.
   - ACL por proprietário (`requested_by = @request.auth.id`): Não aplicada (mantida regra geral de `server_trust_version = "server-v1"`).

3. **Migração 1741634522 (`cotai_price_search_rate_limits`):**
   - Tabela privada SQLite: Não exposta como coleção PocketBase.

4. **Migração 1741634523 (`cotai_price_search_snapshots` e items):**
   - Não criadas como coleções na Records API.

5. **Migração 1741634524 (`cotai_backend_rate_limits`):**
   - Tabela privada de rate limits não exposta na API.

6. **Migração 1741634525 (`price_index_tasks.task_key` qualificada por owner):**
   - As chaves de tarefa existentes permanecem no formato original (sem sufixo `#OWNER#`).

---

## 4. Integridade da Base `price_samples_index`

- **Amostras Legadas e Recentes:** Preservadas integralmente.
- **Fontes Auditadas:** PNCP e Compras.gov.br com registros ativos e acessíveis.
- **Valores Extremos Verificados:** De R$ 0,0001 (ampolas de dipirona/ibuprofeno) a R$ 201.797.544,94 (varrição/obras civis) preservados sem qualquer truncamento ou expurgo.
- **Nenhuma amostra foi apagada ou alterada.**
- **Crons e Workers:**
  - `price_index_worker_cron` (`*/1 * * * *`): Em execução normal com ticks ativos (processando ~3 tarefas/minuto com status OK).
  - `daily_sync_job_cron` (`0 6 * * *`): Ativo e agendado.
