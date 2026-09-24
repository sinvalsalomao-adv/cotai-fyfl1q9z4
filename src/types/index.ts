export type PapelUsuario = 'admin' | 'gestor' | 'responsavel_pesquisa' | 'aprovador' | 'integracoes'

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
  created?: string
  updated?: string
  expand?: {
    demanda_item_id?: DemandaItem & {
      expand?: { demanda_id?: Demanda }
    }
    responsavel_id?: Usuario
  }
}

export type FonteReferencia = 'compras_gov' | 'pncp' | 'manual'
export type NaturezaPreco =
  | 'estimado'
  | 'homologado'
  | 'contratado'
  | 'cotacao_comercial'
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
  url?: string
  hash?: string
  status_revisao: StatusRevisao
  motivo_exclusao?: string
  possivel_duplicata?: boolean
  canonico_id?: string
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

export type MetodoCalculo = 'media' | 'mediana' | 'menor' | 'maior'

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

export type TipoDocumento =
  | 'dfd'
  | 'etp'
  | 'tr'
  | 'relatorio_precos'
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
