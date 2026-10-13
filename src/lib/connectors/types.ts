/**
 * Price Connector Protocol & Core Contracts
 * Contrato único e padronizado de conector para todas as fontes de pesquisa de preços públicos.
 * Nenhuma lógica específica de PNCP, Compras.gov ou BPS no motor genérico.
 */

export type FonteStatus =
  | 'ATIVA'
  | 'HOMOLOGACAO'
  | 'CREDENCIAL_NECESSARIA'
  | 'INDISPONIVEL'
  | 'DESATIVADA'
  | 'MOCK'

export type NaturezaPreco = 'homologado' | 'contratado' | 'estimado' | 'referencial'

export interface AmostraPreco {
  id: string
  fonte: string
  fonteNomeExibicao: string
  idExterno: string
  urlOriginal: string
  dataPublicacaoOuContrato: string

  // Dados mínimos obrigatórios pelo termo de referência
  produto: string
  descricaoCompleta: string
  descricaoNormalizada?: string

  // Órgão comprador real (ex: "Prefeitura Municipal de X", nunca nome genérico da API)
  orgaoComprador: string
  orgaoCnpj?: string
  municipio?: string
  uf?: string

  // Fornecedor
  fornecedorNome: string
  fornecedorCnpjOuCpf?: string
  fornecedorPorte?: 'ME_EPP' | 'DEMAIS' | 'NÃO INFORMADO'

  // Valores e Quantidades
  unidade: string
  quantidade: number
  valorUnitario: number
  valorTotal?: number

  // Metadados contratuais e de processo
  modalidadeLicitacao?: string
  numeroProcessoOuContrato?: string
  numeroAta?: string
  marca?: string
  fabricante?: string
  codigoCatalogo?: string // CATMAT / CATSER / Código Próprio

  // Rastreabilidade e conformidade
  hashRastreabilidade: string
  scoreSimilaridade?: number
  natureza: NaturezaPreco
  isDemo: boolean
  detalhesAdicionais?: Record<string, any>
}

export interface PaginationInfo {
  paginaAtual: number
  tamanhoPagina: number
  totalRegistrosInformadoApi: number
  totalPaginasInformadoApi: number
  temMaisPaginas: boolean
  proximoCursor?: string
}

export interface ConnectorSearchParams {
  termo: string
  catmatOuCodigo?: string
  uf?: string
  municipio?: string
  periodoMeses?: number
  dataInicio?: string
  dataFim?: string
  precoMin?: number
  precoMax?: number
  marca?: string
  unidade?: string
  apenasMe?: boolean
  pagina?: number
  tamanhoPagina?: number
  paginacaoTotal?: boolean
  limitePaginas?: number
  maxDetalharAoVivo?: number
  forcarAtualizacaoCache?: boolean
  signal?: AbortSignal
}

export interface ConnectorPageResult {
  sucesso: boolean
  amostras: AmostraPreco[]
  pagination: PaginationInfo
  tempoMs: number
  statusHttp?: number
  erro?: string
  isIndisponivel?: boolean
  tentativasRealizadas?: number
  aviso?: string
}

export interface ConnectorSearchResult {
  sucesso: boolean
  fonte: string
  fonteNomeExibicao: string
  amostras: AmostraPreco[]
  totalAmostrasRecuperadas: number
  totalRegistrosInformadosApi: number
  paginasProcessadas: number
  tempoMs: number
  status: 'CONCLUIDA' | 'CONCLUIDA_PARCIAL' | 'FALHA_TOTAL' | 'INDISPONIVEL'
  erro?: string
  observabilidade: ObservabilidadeFonte
}

export interface ObservabilidadeFonte {
  fonte: string
  tempoTotalMs: number
  tempoAtePrimeiroResultadoMs?: number
  quantidadeInformadaApi: number
  quantidadeRecebidaBruta: number
  quantidadeProcessadaValida: number
  quantidadeEntregue: number
  quantidadeDescartadaAntiContaminacao: number
  quantidadeDuplicidadesInternas: number
  paginasProcessadas: number
  totalPaginasApi: number
  retriesExecutados: number
  statusHttpFinal: number
  timeoutsCount: number
  errosEncontrados: string[]
  circuitBreakerAcionado: boolean
  cacheHit: boolean
  itens_fila_pendente?: number
  detalhamento_paralelo?: {
    total_encontrado?: number
    total_detalhado?: number
    itens_fila_pendente?: number
    cache_hits?: number
    amostras_extraidas?: number
  }
}

export interface SourceMetadata {
  id: string
  nome: string
  sigla: string
  tipo: 'OFICIAL_GOV' | 'DADOS_ABERTOS' | 'SISTEMA_COMPRAS' | 'TABELA_REFERENCIAL'
  status: FonteStatus
  descricao: string
  urlPortal: string
  suportaPaginacaoCompleta: boolean
  maxTamanhoPaginaPermitido: number
  rateLimitRequisicoesPorSegundo: number
  concorrenciaMaximaRecomendada: number
  requerCredencial: boolean
  credencialConfigurada: boolean
  isDemo: boolean
}

export interface FailureStatus {
  indisponivel: boolean
  motivo?: string
  statusHttp?: number
  tempoCooldownRestanteMs?: number
  circuitOpen: boolean
}

/**
 * CONTRATO ÚNICO DE CONECTOR
 * Cada fonte externa (PNCP, Compras.gov.br, BPS, Referenciais, etc.)
 * implementa esta interface, encapsulando todas as particularidades da sua API.
 */
export interface IPriceConnectorAdapter {
  readonly id: string
  readonly nome: string

  getSourceMetadata(): SourceMetadata
  healthCheck(): Promise<boolean>
  getFailureStatus(): FailureStatus

  /**
   * Busca uma única página respeitando o mecanismo de paginação específico da fonte
   */
  fetchPage(params: ConnectorSearchParams, pagina: number): Promise<ConnectorPageResult>

  /**
   * Verifica se há mais páginas a partir da resposta e parâmetros
   */
  hasNextPage(info: PaginationInfo): boolean

  /**
   * Normaliza um item bruto da API externa no modelo canônico AmostraPreco
   */
  normalize(rawItem: any, index: number, metadata?: any): AmostraPreco | null

  /**
   * Executa a coleta completa da fonte (todas as páginas disponibilizadas pela API)
   * com retry controlado, observabilidade, anti-contaminação e resiliência a falhas parciais.
   * Callback progressivo opcional para streaming em tempo real.
   */
  search(
    params: ConnectorSearchParams,
    onProgress?: (novasAmostras: AmostraPreco[], info: PaginationInfo) => void,
  ): Promise<ConnectorSearchResult>
}
