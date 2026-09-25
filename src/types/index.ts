export type PapelUsuario =
  | 'super_admin'
  | 'admin'
  | 'gestor'
  | 'compras'
  | 'licitacao'
  | 'consultor'
  | 'visualizacao'
  | 'auditor'
  | 'responsavel_pesquisa'
  | 'aprovador'
  | 'integracoes'

export interface Usuario {
  id: string
  email: string
  name: string
  avatar?: string
  papel?: PapelUsuario
  organizacao_id?: string
}

export type OrigemRecursos =
  | 'recursos_proprios'
  | 'transferencia_voluntaria_federal'
  | 'emenda_parlamentar'
  | 'outro'

export interface PerfilNormativo {
  id: string
  nome: string
  norma_id: 'lei_14133' | 'in_seges_me_65'
  vigencia?: string
  exigencias?: Record<string, string>
  regras_especificas?: Record<string, any>
  metodo_permitido?: 'media_ou_mediana' | 'mediana' | 'menor' | 'media'
  autoridade_competente?: string
  created?: string
}

export interface PlanoSaas {
  id: string
  nome: string
  codigo: 'basico' | 'profissional' | 'premium' | 'enterprise'
  descricao?: string
  limite_usuarios: number
  limite_pesquisas_mes: number
  limite_armazenamento_mb: number
  acesso_api: boolean
  automacoes_lote: boolean
  fontes_premium: boolean
  relatorios_avancados: boolean
  ativo: boolean
  created?: string
  updated?: string
}

export type StatusLicenca = 'ativa' | 'bloqueada' | 'degustacao' | 'vencida' | 'suspensa'
export type MetodoOutlier =
  | 'distancia_mediana'
  | 'iqr'
  | 'desvio_padrao'
  | 'percentual_fixo'
  | 'nenhum'

export interface OrgaoConfiguracao {
  id: string
  organizacao_id: string
  plano_id?: string
  status_licenca: StatusLicenca
  vencimento_licenca?: string
  quantidade_minima_precos?: number
  metodo_outlier_padrao?: MetodoOutlier
  limite_outlier_superior?: number // ex 130 para 130% da mediana
  limite_outlier_inferior?: number // ex 70 para 70% da mediana
  metodo_calculo_padrao?: 'mediana' | 'media' | 'menor' | 'media_saneada'
  exigir_justificativa_insuficiente?: boolean
  priorizar_fontes_governamentais?: boolean
  permitir_cotacao_fornecedor?: boolean
  periodo_maximo_meses?: number
  fontes_prioritarias?: string[]
  fontes_bloqueadas?: string[]
  regras_pesquisa?: Record<string, any>
  cabecalho_relatorio?: string
  rodape_relatorio?: string
  responsavel_assinatura_nome?: string
  responsavel_assinatura_cargo?: string
  created?: string
  updated?: string
  expand?: {
    organizacao_id?: Organizacao
    plano_id?: PlanoSaas
  }
}

export interface Organizacao {
  id: string
  nome: string
  cnpj: string
  municipio_ibge: string
  endereco?: string
  unidade?: string
  responsavel_legal?: string
  responsavel_pesquisa?: string
  origem_recursos?: OrigemRecursos
  regulamento_local?: string
  perfil_normativo_id?: string
  expand?: {
    perfil_normativo_id?: PerfilNormativo
    responsavel_pesquisa?: Usuario
    configuracao?: OrgaoConfiguracao
  }
}

export type StatusDemanda =
  | 'rascunho'
  | 'confirmada'
  | 'em_pesquisa'
  | 'em_documentacao'
  | 'concluida'
  | 'cancelada'

export interface Demanda {
  id: string
  organizacao_id: string
  numero: string
  versao: number
  origem_recursos: OrigemRecursos
  objeto: string
  status: StatusDemanda
  responsavel_id?: string
  questoes_faltantes?: string[] | string
  created?: string
  updated?: string
  expand?: {
    organizacao_id?: Organizacao
    responsavel_id?: Usuario
  }
}

export interface DemandaItem {
  id: string
  demanda_id: string
  descricao: string
  quantidade: number
  unidade: string
  caracteristicas_essenciais?: string
  prazo_entrega?: string
  local_entrega?: string
  catalogo?: string
  anexos?: string[]
  versao: number
  confirmado?: boolean
  // Metadados farmacêuticos / estruturados
  principio_ativo?: string
  concentracao?: string
  forma_farmaceutica?: string
  apresentacao?: string
  codigo_catmat?: string
  codigo_bps?: string
  created?: string
  updated?: string
  expand?: {
    demanda_id?: Demanda
  }
}

export type StatusPesquisa =
  | 'em_andamento'
  | 'aguardando_revisao'
  | 'parcial'
  | 'concluida'
  | 'falha'

export interface Pesquisa {
  id: string
  demanda_item_id: string
  numero: string
  status: StatusPesquisa
  conectores?: Record<string, any>
  filtros?: Record<string, any>
  cobertura?: Record<string, any>
  falhas?: any[]
  inicio?: string
  fim?: string
  responsavel_id?: string
  versao?: number
  created?: string
  updated?: string
  expand?: {
    demanda_item_id?: DemandaItem & {
      expand?: { demanda_id?: Demanda }
    }
    responsavel_id?: Usuario
  }
}

export type FonteReferencia =
  | 'compras_gov'
  | 'pncp'
  | 'bps'
  | 'cmed'
  | 'sinapi'
  | 'sicro'
  | 'ceasa'
  | 'conab'
  | 'bec_sp'
  | 'comercio_eletronico'
  | 'fornecedor_direto'
  | 'regional_estadual'
  | 'manual'

export type NaturezaPreco =
  | 'estimado'
  | 'homologado'
  | 'contratado'
  | 'cotacao_comercial'
  | 'cotacao_mercado'
  | 'regulatorio_tabela'
  | 'desconhecido'

export type StatusRevisao = 'pendente' | 'aceito' | 'excluido' | 'necessita_esclarecimento'

export interface Referencia {
  id: string
  pesquisa_id: string
  fonte: FonteReferencia
  id_externo?: string
  item_externo?: string
  natureza_preco: NaturezaPreco
  valor_original: number
  valor_normalizado?: number
  unidade?: string
  quantidade?: number
  data_contratacao?: string
  fornecedor?: string
  cnpj_fornecedor?: string
  orgao_comprador?: string
  municipio_uf?: string
  modalidade_licitacao?: string
  processo_origem?: string
  marca_modelo?: string
  codigo_catalogo?: string
  url?: string
  hash?: string
  status_revisao: StatusRevisao
  motivo_exclusao?: string
  possivel_duplicata?: boolean
  canonico_id?: string
  source_capture_date?: string
  source_update_date?: string
  source_identifier?: string
  confidence_score?: number
  similarity_score?: number
  is_demo?: boolean
  detalhes_tecnicos?: Record<string, any> | string
  created?: string
  updated?: string
  expand?: {
    canonico_id?: Referencia
  }
}

export interface Evidencia {
  id: string
  referencia_id: string
  url?: string
  arquivo?: string
  hash: string
  momento_coleta: string
  campo_origem?: string
  permissao?: string
  retencao?: string
  trecho_resposta?: string
  created?: string
}

export type MetodoCalculo =
  | 'media'
  | 'mediana'
  | 'menor'
  | 'maior'
  | 'media_saneada'
  | 'media_ponderada'

export interface Calculo {
  id: string
  pesquisa_id: string
  metodo: MetodoCalculo
  valores_entrada?: any
  arredondamento?: string
  resultado?: number
  total_item?: number
  total_demanda?: number
  versao_motor: string
  justificativa_metodo?: string
  status: 'rascunho' | 'aprovado' | 'invalidado'
  metricas_n?: any
  analise_outliers?: any
  created?: string
  updated?: string
}

export interface FonteCatalogo {
  id: string
  nome: string
  codigo: string
  tipo: 'governamental' | 'regulatoria' | 'comercial' | 'tabela_oficial' | 'regional' | 'propria'
  categoria:
    | 'geral'
    | 'medicamentos'
    | 'saude'
    | 'obras'
    | 'alimentacao'
    | 'veiculos'
    | 'tecnologia'
  formato: 'api_rest' | 'json' | 'xml' | 'csv' | 'xlsx' | 'arquivo_periodico' | 'manual'
  frequencia?: 'tempo_real' | 'diaria' | 'semanal' | 'mensal' | 'anual' | 'sob_demanda'
  status: 'ativo' | 'inativo' | 'em_homologacao' | 'desatualizado' | 'manutencao'
  runtime_enabled: boolean
  endpoint_url?: string
  autenticacao_tipo?: string
  ultima_sincronizacao?: string
  proxima_sincronizacao?: string
  uf_regional?: string
  orgao_regional?: string
  metodologia?: string
  tipo_preco?:
    | 'contratado'
    | 'homologado'
    | 'regulatorio'
    | 'cotacao_mercado'
    | 'estimado_edital'
    | 'tabela'
  is_regulatorio?: boolean
  versao_adaptador?: string
  observacoes?: string
  created?: string
  updated?: string
}

export interface SyncLog {
  id: string
  fonte_id: string
  status: 'sucesso' | 'parcial' | 'falha' | 'em_execucao'
  quantidade_coletada: number
  novos_registros: number
  registros_atualizados: number
  duplicados_identificados: number
  erros_count: number
  tempo_processamento_ms: number
  detalhes?: string
  created?: string
  updated?: string
  expand?: {
    fonte_id?: FonteCatalogo
  }
}

export type TipoDocumento =
  | 'dfd'
  | 'etp'
  | 'tr'
  | 'relatorio_precos'
  | 'relatorio_tecnico_16'
  | 'mapa_riscos'
  | 'matriz_riscos'

export type StatusDocumento = 'rascunho' | 'em_revisao' | 'aprovado' | 'assinado' | 'publicado'

export interface Documento {
  id: string
  processo_id: string
  tipo: TipoDocumento
  titulo: string
  versao: number
  conteudo?: any
  evidencias_ids?: string[]
  modelo_id?: string
  modelo_versao?: string
  prompt_versao?: string
  modelo_ia?: string
  custo_execucao?: number
  status: StatusDocumento
  hash?: string
  created?: string
  updated?: string
  expand?: {
    processo_id?: Processo
  }
}

export interface VersaoDocumento {
  id: string
  documento_id: string
  numero_versao: number
  conteudo?: any
  hash?: string
  motivo_alteracao?: string
  created?: string
}

export interface Aprovacao {
  id: string
  versao_documento_id: string
  agente_id?: string
  papel?: string
  decisao: 'aprovado' | 'rejeitado'
  justificativa: string
  created?: string
  expand?: {
    agente_id?: Usuario
  }
}

export interface Processo {
  id: string
  organizacao_id: string
  demanda_id: string
  numero: string
  status: 'planejamento' | 'em_pesquisa' | 'em_revisao' | 'aprovado' | 'concluido' | 'arquivado'
  responsavel_id?: string
  pendencia_atual?: string
  prazo?: string
  proxima_acao?: string
  created?: string
  updated?: string
  expand?: {
    organizacao_id?: Organizacao
    demanda_id?: Demanda
    responsavel_id?: Usuario
  }
}

export interface Integracao {
  id: string
  nome: string
  uso?: string
  documentation_status: 'confirmada' | 'pendente' | 'nao_confirmada'
  runtime_enabled: boolean
  condicao?: string
  secreto_ref?: string
  ambiente?: string
  created?: string
}

export interface Auditoria {
  id: string
  organizacao_id: string
  agente_id: string
  evento: string
  objeto_tipo?: string
  objeto_id?: string
  antes_depois?: any
  correlacao?: string
  created?: string
  expand?: {
    agente_id?: Usuario
  }
}

// -------------------------------------------------------------
// MÓDULO DE COTAÇÃO INTELIGENTE COM IA
// -------------------------------------------------------------

export type StatusCotacao =
  | 'rascunho'
  | 'em_processamento'
  | 'revisao_necessaria'
  | 'concluida'
  | 'erro'
  | 'cancelada'

export type StatusItemCotacao =
  | 'pendente'
  | 'pesquisando'
  | 'processando'
  | 'resultados_encontrados'
  | 'normalizando'
  | 'analisando'
  | 'revisao_necessaria'
  | 'concluido'
  | 'sem_resultados'
  | 'erro'

export type EstagioPreco = 'encontrado' | 'compativel' | 'normalizado' | 'valido' | 'selecionado'

export type FaixaSimilaridade = 'ALTA' | 'BOA' | 'REVISAO' | 'BAIXA'

export interface CotacaoConfiguracao {
  modo?: 'automatico' | 'avancado'
  fontes?: string[]
  permitir_fornecedores?: boolean
  periodo_meses?: number
  uf?: string
  municipios?: string[]
  quantidade_minima?: number
  metodo_padrao?: MetodoCalculo
  deteccao_outliers?: 'automatica' | 'iqr' | 'desvio_padrao' | 'nenhuma'
  normalizacao_unidade?: boolean
  deduplicacao?: boolean
}

export interface CotacaoMetricaEstagios {
  encontrados: number
  compativeis: number
  normalizados: number
  validos: number
  selecionados: number
}

export interface Cotacao {
  id: string
  tenant_id: string
  numero: string
  numero_processo?: string
  titulo: string
  objeto?: string
  orgao_nome?: string
  demanda_id?: string
  status: StatusCotacao
  responsavel_id?: string
  versao_atual: number
  total_itens: number
  itens_concluidos: number
  itens_revisao: number
  itens_sem_resultados: number
  valor_total_estimado?: number
  configuracao_execucao?: CotacaoConfiguracao
  metrica_estagios?: CotacaoMetricaEstagios
  created?: string
  updated?: string
  expand?: {
    tenant_id?: Organizacao
    responsavel_id?: Usuario
    demanda_id?: Demanda
  }
}

export interface CotacaoItem {
  id: string
  tenant_id: string
  quotation_id: string
  numero_item: number
  codigo_interno?: string
  descricao_original: string
  descricao_normalizada?: string
  quantidade: number
  unidade: string
  unidade_normalizada?: string
  principio_ativo?: string
  concentracao?: string
  forma_farmaceutica?: string
  apresentacao?: string
  codigo_catalogo?: string
  tipo_catalogo?: string
  confidence_score?: number
  correspondencias_alternativas?: any[]
  status: StatusItemCotacao
  mensagem_status?: string
  qtd_encontrados: number
  qtd_compativeis: number
  qtd_normalizados: number
  qtd_validos: number
  qtd_selecionados: number
  qtd_outliers: number
  total_precos_validos?: number
  total_precos_coletados?: number
  justificativa_amostra_minima?: string
  preco_minimo?: number
  preco_media?: number
  preco_mediana?: number
  preco_media_ponderada?: number
  preco_referencia?: number
  valor_total_item?: number
  metodo_sugerido?: MetodoCalculo
  motivo_sugestao_metodo?: string
  metodo_adotado?: MetodoCalculo
  analise_inteligente?: Record<string, any>
  created?: string
  updated?: string
  expand?: {
    quotation_id?: Cotacao
  }
}

export type CotacaoPrecoRecord = CotacaoPriceRecord

export interface CotacaoPriceRecord {
  id: string
  tenant_id: string
  quotation_id: string
  quotation_item_id: string
  cotacao_item_id?: string
  fonte: string
  source_identifier?: string
  source_record_id?: string
  source_url?: string
  url_fonte?: string
  document_url?: string
  document_hash?: string
  hash_registro?: string
  source_capture_date?: string
  original_description: string
  normalized_description?: string
  descricao_item_fonte?: string
  catalog_code?: string
  unit: string
  normalized_unit?: string
  unidade_fornecida?: string
  quantity: number
  quantidade_fornecida?: number
  unit_price: number
  preco_unitario: number
  normalized_unit_price: number
  preco_unitario_normalizado?: number
  total_price?: number
  supplier?: string
  fornecedor_nome?: string
  supplier_cnpj?: string
  fornecedor_cnpj?: string
  orgao_comprador?: string
  municipio?: string
  uf?: string
  modalidade?: string
  numero_processo?: string
  purchase_date?: string
  publication_date?: string
  data_registro?: string
  natureza_preco?: string
  is_regulatorio?: boolean
  estagio: EstagioPreco
  status?: 'valido' | 'expurgado' | 'pendente'
  confidence_score?: number
  similarity_score?: number
  faixa_similaridade?: FaixaSimilaridade
  possivel_duplicata?: boolean
  canonical_price_id?: string
  is_outlier?: boolean
  outlier_classificacao?: string
  decisao_humana?: 'manter' | 'descartar' | 'pendente'
  motivo_decisao?: string
  justificativa_descarte?: string
  data_version?: number
  original_payload?: any
  created?: string
  updated?: string
}

export interface CotacaoJob {
  id: string
  tenant_id: string
  quotation_id: string
  tipo_job:
    | 'cotar_todos_itens'
    | 'cotar_item_individual'
    | 'atualizar_fontes'
    | 'recalcular_estatisticas'
  status: 'enfileirado' | 'executando' | 'concluido' | 'falha' | 'cancelado'
  progresso_percentual: number
  itens_processados: number
  itens_total: number
  resultados_total: number
  erros_count: number
  etapa_atual?: string
  item_atual_id?: string
  fontes_consultadas?: string[]
  fontes_com_erro?: Array<{ fonte: string; erro: string }>
  payload_config?: any
  mensagem_log?: string
  iniciado_em?: string
  finalizado_em?: string
  created?: string
  updated?: string
}

export interface CotacaoVersao {
  id: string
  tenant_id: string
  quotation_id: string
  numero_versao: number
  titulo_versao: string
  motivo_versao?: string
  snapshot_dados: any
  total_estimado?: number
  criado_por?: string
  created?: string
  updated?: string
}

export interface CotacaoOutlier {
  id: string
  tenant_id: string
  quotation_id: string
  quotation_item_id: string
  price_record_id: string
  valor: number
  mediana_referencia: number
  desvio_percentual: number
  metodo_deteccao: string
  motivo_identificacao?: string
  decisao_humana: 'pendente' | 'descartado' | 'mantido'
  justificativa?: string
  decidido_por?: string
  decidido_em?: string
  created?: string
  updated?: string
  expand?: {
    price_record_id?: CotacaoPriceRecord
    decidido_por?: Usuario
  }
}

export interface CotacaoJustificativa {
  id: string
  tenant_id: string
  quotation_id: string
  quotation_item_id?: string
  tipo:
    | 'quantidade_insuficiente'
    | 'exclusao_preco'
    | 'manutencao_outlier'
    | 'alteracao_metodo'
    | 'utilizacao_fonte_especifica'
    | 'ausencia_fornecedor'
    | 'outro'
  texto_justificativa: string
  usuario_id: string
  dados_contexto?: any
  created?: string
  updated?: string
  expand?: {
    usuario_id?: Usuario
  }
}
