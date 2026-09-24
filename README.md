# Plataforma de Pesquisa de Preços Públicos — Fase 1 & Arquitetura SaaS

Plataforma governamental de pesquisa e formação de preços públicos em conformidade com o **Art. 23 da Lei Federal nº 14.133/2021**, a **Instrução Normativa SEGES/ME nº 65/2021** e regulamentos municipais/estaduais específicos.

---

## 1. Regras Absolutas do Motor de Preços

- **Nunca excluir um preço silenciosamente**: Toda exclusão de amostra (inclusive sugerida por juízo crítico ou algoritmo de outlier) exige fundamentação expressa do servidor com justificativa obrigatória registrada na trilha de auditoria.
- **Nunca inventar dados**: Fontes externas sem dados específicos exibem expressamente `"NÃO INFORMADO"` — jamais se inventa fornecedor, CNPJ, órgão comprador, código ou número de processo.
- **Rastreabilidade obrigatória**: Cada preço carrega `source_url`, `source_identifier`, `source_capture_date`, `source_update_date` e hash criptográfico SHA-256.
- **Conjunto de preços configurável**: Quantidade mínima de amostras configurável por órgão (padrão 3). Pesquisas com amostra abaixo do mínimo bloqueiam a homologação e exigem justificativa do servidor.
- **Decisão humana soberana**: Recomendações estatísticas (mediana vs. média) são sugestões algorítmicas; a decisão final e motivação pertencem ao servidor público responsável.
- **Regra do Total da Demanda**: O valor estimado total de um item é rigorosamente `Quantidade Demandada × Preço de Referência Unitário`. Quantidades negociadas em compras externas nunca são somadas à demanda do órgão.

---

## 2. Metodologia Estatística e PriceEngine

O motor determinístico `PriceEngine` calcula:
- **Medidas de Tendência Central**: Média aritmética, Mediana (50º percentil), Menor preço, Média saneada (aparando 10% dos extremos) e Média ponderada por quantidade.
- **Medidas de Dispersão**: Desvio-padrão amostral ($s$), Variância, Coeficiente de Variação ($CV\%$), Intervalo Interquartil ($IQR = Q3 - Q1$), 10º e 90º percentis, e Desvio Absoluto da Mediana ($MAD$).
- **Detecção de Outliers Configurável**: Distância da mediana (padrão 70% a 130%), Critério Tukey IQR ($[Q1 - 1.5 \times IQR, Q3 + 1.5 \times IQR]$), Desvio-padrão ($|Z| > 2.0$) ou percentual fixo. Classificação em `NORMAL`, `ATENCAO`, `INCONSISTENTE` ou `FORA_DA_FAIXA`.
- **Memória de Cálculo Automática**: Texto estruturado reprodutível com resumo de rastreabilidade: *"Valor estimado calculado com base em N preços válidos provenientes de M fontes."*
- **Normalização de Unidades (`PriceNormalizationEngine`)**: Converte caixas, resmas, pacotes, frascos e lotes (ex: R$ 500,00 / 10 unidades $\rightarrow$ R$ 50,00/unidade).

---

## 3. Identificação do Item e Fluxo de Medicamentos

- **ItemIdentificationEngine**: Tokenização, remoção de stopwords de compras públicas, sinônimos e matching fuzzy com score percentual (`"Correspondência encontrada: 96%"`).
- **Catálogo Integrado**: Códigos oficiais CATMAT / CATSER / BPS.
- **Fluxo Especializado da Saúde**: Princípio Ativo $\rightarrow$ Concentração $\rightarrow$ Forma Farmacêutica $\rightarrow$ Apresentação $\rightarrow$ Unidade $\rightarrow$ Quantidade.
- **Referência Regulatória CMED**: Consulta integrada ao Preço Fábrica (PF) e Preço Máximo ao Consumidor (PMC) da ANVISA, destacados visualmente para que o usuário não confunda teto regulatório com preço praticado pago em contratação pública.

---

## 4. Conectores e Fontes de Dados (Adapters)

O sistema conta com um catálogo extensível de adaptadores (`PriceConnectorsHub`):
1. **PNCP** (Portal Nacional de Contratações Públicas) — API REST
2. **Compras.gov.br** (Módulo Preços Praticados) — Dados Abertos
3. **BPS** (Banco de Preços em Saúde / Ministério da Saúde) — Ingestão CSV / Anual
4. **CMED** (Tabela Oficial ANVISA) — Preços Regulatórios
5. **SINAPI** (Construção Civil CAIXA/IBGE) & **SICRO** (Obras Rodoviárias DNIT)
6. **CONAB / CEASA** (Gêneros Alimentícios)
7. **BEC-SP** (Bolsa Eletrônica de Compras de São Paulo) & Portais Estaduais
8. **Cotações Comerciais Diretas** com fornecedores locais

> **Status de Integração Real:** As integrações de APIs externas permanecem configuradas com `runtime_enabled: false` até a fase de homologação oficial em produção, utilizando adaptadores mock de desenvolvimento com dados realistas rastreáveis e aviso explícito de *"TODO — INTEGRAÇÃO REAL NECESSÁRIA"*.

---

## 5. Estrutura SaaS e Multi-Tenant

- **Isolamento por Órgão (`organizacao_id`)**: Segurança em nível de registro.
- **Papéis RBAC**: Super Admin, Administrador, Gestor, Compras, Licitação, Consultor, Visualização e Auditor.
- **Planos SaaS**: Básico, Profissional, Premium e Enterprise Governamental, com limites de usuários, pesquisas/mês e armazenamento.
- **Painel Super Admin (`/app/saas-admin`)**: Gestão de órgãos, planos, bloqueio/ativação de licenças e acompanhamento técnico sem acesso indevido aos dados privados dos órgãos.
- **Regulamentos Locais (`/app/regulamentos`)**: Personalização de limites de outliers, identidade visual dos relatórios e autoridades signatárias.

---

## 6. Workspace de Pesquisa e Relatórios

- **Abas do Workspace**: Resultados, Minha Cesta, Estatística, Mapa Comparativo, Curva ABC (Classes A, B e C), Relatório, Evidências Criptografadas, Histórico/Auditoria e Itens da Demanda.
- **Relatório Técnico Oficial de 16 Seções**: Emissão em PDF, DOCX, XLSX e CSV cobrindo da Identificação à Assinatura Digital do Servidor Responsável.
- **Importação de Itens**: Leitura de planilhas copiadas e coladas do Excel/CSV com detecção automática de colunas.

---

## 7. Critério de Aceite (Fluxo Ponta a Ponta Homologado)

- Demanda seed com **Dipirona Sódica 500 mg comprimido simples** (Item `PESQ-DIP-2026/01`).
- Cotações com origens distintas: **BPS**, **PNCP**, **Compras.gov.br**, **BEC-SP** e **Teto CMED ANVISA**.
- Cálculo de mediana de R$ 0,41/unidade, desvio-padrão de R$ 0,02 e valor total de R$ 20.500,00 para 50.000 comprimidos.
- Geração validada da memória de cálculo e exportações em XLSX e PDF.
