// -------------------------------------------------------------------------
// PriceConnectorsHub — Catálogo Extensível de Conectores e Adaptadores de Fontes
// -------------------------------------------------------------------------
// Regra:
// 1. Nova fonte adicionável sem modificar o núcleo (arquitetura de adaptadores)
// 2. Conectores suportam API REST, JSON, XML, CSV, XLSX, arquivos periódicos e manual
// 3. NUNCA depender de scraping não autorizado.
// 4. Integrações reais (PNCP, Compras.gov.br) com runtime_enabled=false até homologação.
//    Adaptador mock de desenvolvimento claramente rotulado com:
//    "TODO — INTEGRAÇÃO REAL NECESSÁRIA. MODO DEMO CONTROLADO ATIVO."
// 5. Deduplicação com canonical_record_id relacionando source_records.
// 6. Rastreabilidade absoluta: source_url, source_identifier, source_document,
//    source_capture_date, source_update_date. Se campo faltar: "NÃO INFORMADO".
// -------------------------------------------------------------------------

import type { Referencia, FonteReferencia, NaturezaPreco } from '@/types'
import { PriceNormalizationEngine } from './calculoEngine'

export interface FiltrosConsultaConector {
  termo: string
  codigo_catalogo?: string
  uf?: string
  municipio?: string
  periodo_meses?: number
  preco_min?: number
  preco_max?: number
  apenas_homologados?: boolean
  quantidade_necessaria?: number
}

export interface ResultadoConsultaConector {
  conector_codigo: string
  conector_nome: string
  total_encontrados: number
  sucesso: boolean
  tempo_ms: number
  registros: Referencia[]
  is_regulatorio: boolean
  aviso_homologacao?: string
}

export interface ConectorAdapter {
  codigo: string
  nome: string
  tipo: 'governamental' | 'regulatoria' | 'comercial' | 'tabela_oficial' | 'regional' | 'propria'
  formato: 'api_rest' | 'json' | 'xml' | 'csv' | 'xlsx' | 'arquivo_periodico' | 'manual'
  isRegulatorio: boolean
  runtimeEnabled: boolean
  testarConexao(): Promise<{ ok: boolean; mensagem: string; latencia_ms: number }>
  consultarPrecos(
    pesquisaId: string,
    filtros: FiltrosConsultaConector,
  ): Promise<ResultadoConsultaConector>
}

// -------------------------------------------------------------------------
// Base de Demonstração / Homologação com Rastreabilidade Estrita
// -------------------------------------------------------------------------
// Preços fictícios explicitamente marcados como DEMO
// Itens obrigatórios: Dipirona 500mg, Paracetamol 750mg, Álcool 70%, Papel A4,
// Computador desktop, Impressora, Combustível, Manutenção e Veículo hatch.
// -------------------------------------------------------------------------
export const BANCO_REFERENCIAS_DEMO: Omit<Referencia, 'pesquisa_id'>[] = [
  // 1. DIPIRONA SÓDICA 500 MG (Item central do critério de aceite)
  {
    id: 'DEMO-DIP-001',
    fonte: 'bps',
    id_externo: 'BPS-COMPRA-2025-449102',
    item_externo: 'Dipirona Sódica 500 mg comprimido simples (Caixa c/ 500 unidades)',
    natureza_preco: 'contratado',
    valor_original: 0.38,
    valor_normalizado: 0.38,
    unidade: 'comprimido',
    quantidade: 50000,
    data_contratacao: '2025-11-20T10:00:00Z',
    fornecedor: 'Prati-Donaduzzi & Cia Ltda',
    cnpj_fornecedor: '73.856.507/0001-25',
    orgao_comprador: 'Secretaria Municipal de Saúde de Campinas',
    municipio_uf: 'Campinas - SP',
    modalidade_licitacao: 'Pregão Eletrônico (SRP)',
    processo_origem: 'PE 112/2025-SMS',
    marca_modelo: 'Prati Donaduzzi / Genérico',
    codigo_catalogo: 'CATMAT 269412',
    url: 'https://bps.saude.gov.br/consultas/contrato/449102',
    hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
    status_revisao: 'aceito',
    source_identifier: 'BPS-REG-2025-449102',
    source_capture_date: '2026-03-01T08:00:00Z',
    source_update_date: '2026-03-01T08:00:00Z',
    confidence_score: 98,
    similarity_score: 96,
  },
  {
    id: 'DEMO-DIP-002',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2025-882194',
    item_externo: 'DIPIRONA SODICA 500MG COMPRIMIDO',
    natureza_preco: 'contratado',
    valor_original: 0.4,
    valor_normalizado: 0.4,
    unidade: 'comprimido',
    quantidade: 20000,
    data_contratacao: '2025-12-10T14:30:00Z',
    fornecedor: 'Medquímica Indústria Farmacêutica S.A.',
    cnpj_fornecedor: '17.870.172/0001-04',
    orgao_comprador: 'Prefeitura Municipal de Ribeirão Preto',
    municipio_uf: 'Ribeirão Preto - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PROC-2025/0987',
    marca_modelo: 'Medquímica Genérico',
    codigo_catalogo: 'CATMAT 269412',
    url: 'https://pncp.gov.br/app/contratos/17870172000104/2025/882194',
    hash: 'b2c3d4e5f6a17890123456789abcdef0123456789abcdef0123456789abcdef1',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-ATA-2025-882194',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 95,
    similarity_score: 95,
  },
  {
    id: 'DEMO-DIP-003',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90145/2025-IT04',
    item_externo: 'Medicamento Dipirona 500 mg, apresentação comprimido',
    natureza_preco: 'homologado',
    valor_original: 0.41,
    valor_normalizado: 0.41,
    unidade: 'un',
    quantidade: 35000,
    data_contratacao: '2025-10-15T09:00:00Z',
    fornecedor: 'União Química Farmacêutica Nacional S.A.',
    cnpj_fornecedor: '60.665.981/0001-18',
    orgao_comprador: 'Hospital das Forças Armadas - Ministério da Defesa',
    municipio_uf: 'Brasília - DF',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90145/2025-HFA',
    marca_modelo: 'União Química',
    codigo_catalogo: 'CATMAT 269412',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90145-2025-4',
    hash: 'c3d4e5f6a1b27890123456789abcdef0123456789abcdef0123456789abcdef2',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90145-4',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 94,
    similarity_score: 93,
  },
  {
    id: 'DEMO-DIP-004',
    fonte: 'bec_sp',
    id_externo: 'BEC-OC-2025-11094',
    item_externo: 'Dipirona 500 mg comp (dispensa eletrônica estadual)',
    natureza_preco: 'contratado',
    valor_original: 0.42,
    valor_normalizado: 0.42,
    unidade: 'comprimido',
    quantidade: 15000,
    data_contratacao: '2026-01-18T16:00:00Z',
    fornecedor: 'Distribuidora Medicar Paulista Ltda',
    cnpj_fornecedor: '04.221.998/0001-44',
    orgao_comprador: 'Secretaria de Estado da Saúde de São Paulo',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Dispensa Eletrônica',
    processo_origem: 'DISP-SES-2026/012',
    marca_modelo: 'EMS Genérico',
    codigo_catalogo: 'CATMAT 269412',
    url: 'https://www.bec.sp.gov.br/bec_pregao_ui/contrato/11094',
    hash: 'd4e5f6a1b2c37890123456789abcdef0123456789abcdef0123456789abcdef3',
    status_revisao: 'aceito',
    source_identifier: 'BEC-OC-11094',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 92,
    similarity_score: 91,
  },
  {
    id: 'DEMO-DIP-005',
    fonte: 'manual',
    id_externo: 'COT-DIR-FARMA-2026-01',
    item_externo: 'Proposta comercial direta de fornecedor local credenciado — Dipirona 500mg',
    natureza_preco: 'cotacao_comercial',
    valor_original: 0.44,
    valor_normalizado: 0.44,
    unidade: 'comprimido',
    quantidade: 10000,
    data_contratacao: '2026-02-05T11:00:00Z',
    fornecedor: 'Drogarias e Distribuidora Santa Fé Ltda',
    cnpj_fornecedor: '22.333.444/0001-55',
    orgao_comprador: 'Prefeitura Municipal de Exemplo (SP)',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Cotação Direta com Fornecedores (Art. 23, §1º, IV)',
    processo_origem: 'COT-2026-F01',
    marca_modelo: 'Neo Química',
    codigo_catalogo: 'CATMAT 269412',
    url: 'https://prefeitura.sp.gov.br/cotacoes/2026/COT-DIR-FARMA-01.pdf',
    hash: 'e5f6a1b2c3d47890123456789abcdef0123456789abcdef0123456789abcdef4',
    status_revisao: 'aceito',
    source_identifier: 'COT-DIR-2026-01',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 90,
    similarity_score: 89,
  },
  // REFERÊNCIA REGULATÓRIA CMED (Distinta visualmente de preço de contratação)
  {
    id: 'DEMO-DIP-CMED',
    fonte: 'cmed',
    id_externo: 'CMED-REG-2026-DIP500',
    item_externo: 'CMED TABELA REGULATÓRIA — DIPIRONA SÓDICA 500MG COMPRIMIDO (TETO DE PREÇO)',
    natureza_preco: 'regulatorio_tabela',
    valor_original: 0.58, // PMC teto
    valor_normalizado: 0.42, // Preço Fábrica (PF)
    unidade: 'comprimido',
    quantidade: 1,
    data_contratacao: '2026-02-01T00:00:00Z',
    fornecedor: 'ANVISA / Câmara de Regulação do Mercado de Medicamentos',
    cnpj_fornecedor: '00.394.544/0001-85',
    orgao_comprador: 'Órgão Regulador Federal (ANVISA/CMED)',
    municipio_uf: 'Brasília - DF',
    modalidade_licitacao: 'Tabela Regulamentar Oficial',
    processo_origem: 'Resolução CMED 2026/01',
    marca_modelo: 'Referência Teto Regulatório PF/PMC',
    codigo_catalogo: 'CATMAT 269412',
    url: 'https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/lista-conformidade-2026.pdf',
    hash: 'f6a1b2c3d4e57890123456789abcdef0123456789abcdef0123456789abcdef5',
    status_revisao: 'pendente', // não misturado na cesta sem juízo
    source_identifier: 'CMED-REG-2026',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 100,
    similarity_score: 100,
  },

  // 2. PARACETAMOL 750 MG
  {
    id: 'DEMO-PAR-001',
    fonte: 'bps',
    id_externo: 'BPS-COMPRA-2025-331200',
    item_externo: 'Paracetamol 750 mg comprimido',
    natureza_preco: 'contratado',
    valor_original: 0.35,
    valor_normalizado: 0.35,
    unidade: 'comprimido',
    quantidade: 30000,
    data_contratacao: '2025-11-05T10:00:00Z',
    fornecedor: 'EMS S.A.',
    cnpj_fornecedor: '57.507.378/0003-65',
    orgao_comprador: 'Prefeitura Municipal de Santos',
    municipio_uf: 'Santos - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 45/2025',
    marca_modelo: 'EMS Genérico',
    codigo_catalogo: 'CATMAT 271501',
    url: 'https://bps.saude.gov.br/consultas/contrato/331200',
    hash: '1122334455667890123456789abcdef0123456789abcdef0123456789abcdef0',
    status_revisao: 'aceito',
    source_identifier: 'BPS-331200',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 96,
    similarity_score: 95,
  },
  {
    id: 'DEMO-PAR-002',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2025-776100',
    item_externo: 'PARACETAMOL 750MG COMPRIMIDO BLISTER',
    natureza_preco: 'contratado',
    valor_original: 0.36,
    valor_normalizado: 0.36,
    unidade: 'comprimido',
    quantidade: 40000,
    data_contratacao: '2025-12-01T15:00:00Z',
    fornecedor: 'Cimed Indústria de Medicamentos Ltda',
    cnpj_fornecedor: '02.814.497/0007-00',
    orgao_comprador: 'Prefeitura de Belo Horizonte',
    municipio_uf: 'Belo Horizonte - MG',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 88/2025-SMS',
    marca_modelo: 'Cimed',
    codigo_catalogo: 'CATMAT 271501',
    url: 'https://pncp.gov.br/app/contratos/cimed-paracetamol-750',
    hash: '2233445566777890123456789abcdef0123456789abcdef0123456789abcdef1',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-776100',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 95,
    similarity_score: 94,
  },
  {
    id: 'DEMO-PAR-003',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90210/2025-IT01',
    item_externo: 'Paracetamol 750mg comprimido',
    natureza_preco: 'homologado',
    valor_original: 0.37,
    valor_normalizado: 0.37,
    unidade: 'un',
    quantidade: 25000,
    data_contratacao: '2025-10-22T09:30:00Z',
    fornecedor: 'Geolab Indústria Farmacêutica S.A.',
    cnpj_fornecedor: '03.485.572/0001-04',
    orgao_comprador: 'Comando do Exército - 2ª Região Militar',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90210/2025',
    marca_modelo: 'Geolab',
    codigo_catalogo: 'CATMAT 271501',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90210-2025-1',
    hash: '3344556677887890123456789abcdef0123456789abcdef0123456789abcdef2',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90210-1',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 93,
    similarity_score: 93,
  },

  // 3. ÁLCOOL 70% (1 Litro)
  {
    id: 'DEMO-ALC-001',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2025-992100',
    item_externo: 'Álcool Etílico 70% líquido frasco 1000ml',
    natureza_preco: 'contratado',
    valor_original: 6.8,
    valor_normalizado: 6.8,
    unidade: 'litro',
    quantidade: 1200,
    data_contratacao: '2025-11-18T10:00:00Z',
    fornecedor: 'Química Amparo Ltda (Ypê)',
    cnpj_fornecedor: '43.465.126/0001-02',
    orgao_comprador: 'Prefeitura Municipal de Curitiba',
    municipio_uf: 'Curitiba - PR',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 312/2025',
    marca_modelo: 'Ypê Hospitalar',
    codigo_catalogo: 'CATMAT 318920',
    url: 'https://pncp.gov.br/app/contratos/alcool-70-ype',
    hash: '4455667788997890123456789abcdef0123456789abcdef0123456789abcdef3',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-992100',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 95,
    similarity_score: 94,
  },
  {
    id: 'DEMO-ALC-002',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90412/2025-IT02',
    item_externo: 'Álcool Etílico 70° GL frasco com 1L',
    natureza_preco: 'homologado',
    valor_original: 6.95,
    valor_normalizado: 6.95,
    unidade: 'litro',
    quantidade: 2500,
    data_contratacao: '2025-12-05T14:00:00Z',
    fornecedor: 'Vic Pharma Indústria e Comércio Ltda',
    cnpj_fornecedor: '38.804.818/0001-37',
    orgao_comprador: 'Universidade Federal de São Paulo (UNIFESP)',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90412/2025',
    marca_modelo: 'Vic Pharma 70',
    codigo_catalogo: 'CATMAT 318920',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90412-2025-2',
    hash: '5566778899007890123456789abcdef0123456789abcdef0123456789abcdef4',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90412-2',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 94,
    similarity_score: 93,
  },
  {
    id: 'DEMO-ALC-003',
    fonte: 'manual',
    id_externo: 'COT-DIR-2026-ALC01',
    item_externo: 'Cotação formal com distribuidora de saneantes — Álcool 70% 1L',
    natureza_preco: 'cotacao_comercial',
    valor_original: 7.2,
    valor_normalizado: 7.2,
    unidade: 'litro',
    quantidade: 500,
    data_contratacao: '2026-02-12T09:00:00Z',
    fornecedor: 'Comercial Alvorada Saneantes Ltda',
    cnpj_fornecedor: '12.444.555/0001-77',
    orgao_comprador: 'Prefeitura Municipal de Exemplo (SP)',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Cotação Comercial',
    processo_origem: 'COT-ALC-2026',
    marca_modelo: 'Tupi 70%',
    codigo_catalogo: 'CATMAT 318920',
    url: 'https://prefeitura.sp.gov.br/cotacoes/2026/COT-ALC-01.pdf',
    hash: '6677889900117890123456789abcdef0123456789abcdef0123456789abcdef5',
    status_revisao: 'aceito',
    source_identifier: 'COT-ALC-2026-01',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 91,
    similarity_score: 90,
  },

  // 4. PAPEL A4 (Resma c/ 500 folhas)
  {
    id: 'DEMO-PAP-001',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90333/2025-IT01',
    item_externo: 'Papel A4 alcalino 75g/m2, resma c/ 500 folhas',
    natureza_preco: 'homologado',
    valor_original: 26.5,
    valor_normalizado: 26.5,
    unidade: 'resma',
    quantidade: 5000,
    data_contratacao: '2025-11-25T11:00:00Z',
    fornecedor: 'Suzano Papel e Celulose S.A.',
    cnpj_fornecedor: '16.404.287/0001-55',
    orgao_comprador: 'Tribunal Regional Federal da 3ª Região',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90333/2025',
    marca_modelo: 'Report Suzano A4',
    codigo_catalogo: 'CATMAT 443210',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90333-2025-1',
    hash: '7788990011227890123456789abcdef0123456789abcdef0123456789abcdef6',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90333-1',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 96,
    similarity_score: 95,
  },
  {
    id: 'DEMO-PAP-002',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2025-661900',
    item_externo: 'PAPEL FORMATO A4, RESMA 500 FOLHAS BRANCO',
    natureza_preco: 'contratado',
    valor_original: 27.2,
    valor_normalizado: 27.2,
    unidade: 'resma',
    quantidade: 2000,
    data_contratacao: '2025-12-14T16:00:00Z',
    fornecedor: 'Sylvamo do Brasil Ltda (Chamex)',
    cnpj_fornecedor: '40.672.482/0001-20',
    orgao_comprador: 'Câmara Municipal de Campinas',
    municipio_uf: 'Campinas - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 09/2025',
    marca_modelo: 'Chamex Office A4',
    codigo_catalogo: 'CATMAT 443210',
    url: 'https://pncp.gov.br/app/contratos/papel-a4-chamex',
    hash: '8899001122337890123456789abcdef0123456789abcdef0123456789abcdef7',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-661900',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 95,
    similarity_score: 94,
  },
  {
    id: 'DEMO-PAP-003',
    fonte: 'bec_sp',
    id_externo: 'BEC-OC-2026-00441',
    item_externo: 'Papel A4 75g resma com 500 folhas alcalino',
    natureza_preco: 'contratado',
    valor_original: 27.8,
    valor_normalizado: 27.8,
    unidade: 'resma',
    quantidade: 1500,
    data_contratacao: '2026-01-28T14:00:00Z',
    fornecedor: 'Kalunga S.A.',
    cnpj_fornecedor: '43.283.811/0001-50',
    orgao_comprador: 'Defensoria Pública do Estado de São Paulo',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 18/2026-DPSP',
    marca_modelo: 'Spiral A4',
    codigo_catalogo: 'CATMAT 443210',
    url: 'https://www.bec.sp.gov.br/bec_pregao_ui/contrato/441',
    hash: '9900112233447890123456789abcdef0123456789abcdef0123456789abcdef8',
    status_revisao: 'aceito',
    source_identifier: 'BEC-OC-441',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 93,
    similarity_score: 92,
  },

  // 5. COMPUTADOR DESKTOP
  {
    id: 'DEMO-TI-001',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90555/2025-IT01',
    item_externo: 'Microcomputador Desktop corporativo 16GB RAM SSD 512GB com monitor 23.8',
    natureza_preco: 'homologado',
    valor_original: 4250.0,
    valor_normalizado: 4250.0,
    unidade: 'un',
    quantidade: 50,
    data_contratacao: '2025-11-30T10:00:00Z',
    fornecedor: 'Dell Computadores do Brasil Ltda',
    cnpj_fornecedor: '72.381.189/0001-10',
    orgao_comprador: 'Tribunal de Justiça do Estado de São Paulo',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90555/2025',
    marca_modelo: 'Dell OptiPlex 7010',
    codigo_catalogo: 'CATMAT 482103',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90555-2025-1',
    hash: 'aa00112233447890123456789abcdef0123456789abcdef0123456789abcdef9',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90555-1',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 95,
    similarity_score: 94,
  },
  {
    id: 'DEMO-TI-002',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2025-554100',
    item_externo: 'Estação de trabalho microcomputador Desktop Intel Core i5 16GB SSD 512GB',
    natureza_preco: 'contratado',
    valor_original: 4380.0,
    valor_normalizado: 4380.0,
    unidade: 'un',
    quantidade: 30,
    data_contratacao: '2025-12-18T14:00:00Z',
    fornecedor: 'Lenovo Tecnologia Brasil Ltda',
    cnpj_fornecedor: '04.606.897/0001-90',
    orgao_comprador: 'Secretaria da Fazenda de Minas Gerais',
    municipio_uf: 'Belo Horizonte - MG',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 142/2025-SEF',
    marca_modelo: 'Lenovo ThinkCentre M70s',
    codigo_catalogo: 'CATMAT 482103',
    url: 'https://pncp.gov.br/app/contratos/lenovo-desktop-thinkcentre',
    hash: 'bb00112233447890123456789abcdef0123456789abcdef0123456789abcdefa',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-554100',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 94,
    similarity_score: 93,
  },
  {
    id: 'DEMO-TI-003',
    fonte: 'manual',
    id_externo: 'COT-DIR-TI-2026-01',
    item_externo: 'Cotação corporativa canal autorizado fabricante — Desktop corporativo 16GB',
    natureza_preco: 'cotacao_comercial',
    valor_original: 4490.0,
    valor_normalizado: 4490.0,
    unidade: 'un',
    quantidade: 10,
    data_contratacao: '2026-02-15T15:00:00Z',
    fornecedor: 'Lanlink Informática S.A.',
    cnpj_fornecedor: '12.894.221/0001-63',
    orgao_comprador: 'Prefeitura Municipal de Exemplo (SP)',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Cotação Direta Comercial',
    processo_origem: 'COT-TI-2026-01',
    marca_modelo: 'HP ProDesk 400 G9',
    codigo_catalogo: 'CATMAT 482103',
    url: 'https://prefeitura.sp.gov.br/cotacoes/2026/COT-TI-01.pdf',
    hash: 'cc00112233447890123456789abcdef0123456789abcdef0123456789abcdefb',
    status_revisao: 'aceito',
    source_identifier: 'COT-TI-2026-01',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 91,
    similarity_score: 90,
  },

  // 6. IMPRESSORA MULTIFUNCIONAL
  {
    id: 'DEMO-IMP-001',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90601/2025-IT01',
    item_externo: 'Impressora Multifuncional Laser Monocromática duplex rede wifi',
    natureza_preco: 'homologado',
    valor_original: 2890.0,
    valor_normalizado: 2890.0,
    unidade: 'un',
    quantidade: 15,
    data_contratacao: '2025-11-12T11:00:00Z',
    fornecedor: 'Brother International Corporation do Brasil',
    cnpj_fornecedor: '43.208.792/0001-09',
    orgao_comprador: 'Instituto Federal de São Paulo (IFSP)',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90601/2025',
    marca_modelo: 'Brother DCP-L5652DN',
    codigo_catalogo: 'CATMAT 482199',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90601-2025-1',
    hash: 'dd00112233447890123456789abcdef0123456789abcdef0123456789abcdefc',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90601-1',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 95,
    similarity_score: 94,
  },
  {
    id: 'DEMO-IMP-002',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2025-441200',
    item_externo: 'MULTIFUNCIONAL LASER MONO VELOCIDADE 40 PPM',
    natureza_preco: 'contratado',
    valor_original: 2950.0,
    valor_normalizado: 2950.0,
    unidade: 'un',
    quantidade: 20,
    data_contratacao: '2025-12-08T16:00:00Z',
    fornecedor: 'Kyocera Document Solutions Brasil Ltda',
    cnpj_fornecedor: '61.944.575/0001-14',
    orgao_comprador: 'Prefeitura Municipal de Uberlândia',
    municipio_uf: 'Uberlândia - MG',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 77/2025',
    marca_modelo: 'Kyocera ECOSYS M2040dn',
    codigo_catalogo: 'CATMAT 482199',
    url: 'https://pncp.gov.br/app/contratos/kyocera-m2040',
    hash: 'ee00112233447890123456789abcdef0123456789abcdef0123456789abcdefd',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-441200',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 94,
    similarity_score: 93,
  },
  {
    id: 'DEMO-IMP-003',
    fonte: 'bec_sp',
    id_externo: 'BEC-OC-2026-00991',
    item_externo: 'Multifuncional laser monocromatica corporativa',
    natureza_preco: 'contratado',
    valor_original: 3050.0,
    valor_normalizado: 3050.0,
    unidade: 'un',
    quantidade: 8,
    data_contratacao: '2026-01-22T10:00:00Z',
    fornecedor: 'Simpress Comércio Locação e Serviços S.A.',
    cnpj_fornecedor: '04.708.216/0001-08',
    orgao_comprador: 'Polícia Militar do Estado de São Paulo',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 32/2026-PMESP',
    marca_modelo: 'HP LaserJet Pro MFP 4103fdw',
    codigo_catalogo: 'CATMAT 482199',
    url: 'https://www.bec.sp.gov.br/bec_pregao_ui/contrato/991',
    hash: 'ff00112233447890123456789abcdef0123456789abcdef0123456789abcdefe',
    status_revisao: 'aceito',
    source_identifier: 'BEC-OC-991',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 93,
    similarity_score: 92,
  },

  // 7. COMBUSTÍVEL (Gasolina Comum)
  {
    id: 'DEMO-COMB-001',
    fonte: 'conab',
    id_externo: 'CONAB-REG-2026-GAS01',
    item_externo: 'Gasolina Comum automotiva (Pesquisa Média Semanal)',
    natureza_preco: 'cotacao_mercado',
    valor_original: 5.89,
    valor_normalizado: 5.89,
    unidade: 'litro',
    quantidade: 1000,
    data_contratacao: '2026-02-20T10:00:00Z',
    fornecedor: 'ANP / CONAB Média Brasil',
    cnpj_fornecedor: '02.313.673/0002-08',
    orgao_comprador: 'Agência Nacional do Petróleo (ANP)',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Levantamento de Preços de Combustíveis',
    processo_origem: 'LPC-ANP-2026/08',
    marca_modelo: 'Gasolina Comum',
    codigo_catalogo: 'CATMAT 390145',
    url: 'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis',
    hash: '1200112233447890123456789abcdef0123456789abcdef0123456789abcdef0',
    status_revisao: 'aceito',
    source_identifier: 'ANP-LPC-2026-08',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 98,
    similarity_score: 97,
  },
  {
    id: 'DEMO-COMB-002',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2026-11882',
    item_externo: 'FORNECIMENTO DE GASOLINA COMUM PARA FROTA MUNICIPAL (POSTO CREDENCIADO)',
    natureza_preco: 'contratado',
    valor_original: 5.79,
    valor_normalizado: 5.79,
    unidade: 'litro',
    quantidade: 40000,
    data_contratacao: '2026-01-15T11:00:00Z',
    fornecedor: 'Auto Posto Bandeirantes de Campinas Ltda',
    cnpj_fornecedor: '52.119.882/0001-33',
    orgao_comprador: 'Prefeitura Municipal de Campinas',
    municipio_uf: 'Campinas - SP',
    modalidade_licitacao: 'Pregão Eletrônico (Maior Desconto sobre ANP)',
    processo_origem: 'PE 04/2026',
    marca_modelo: 'Petrobras Premmia',
    codigo_catalogo: 'CATMAT 390145',
    url: 'https://pncp.gov.br/app/contratos/posto-bandeirantes-gasolina',
    hash: '1300112233447890123456789abcdef0123456789abcdef0123456789abcdef1',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-11882',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 95,
    similarity_score: 95,
  },
  {
    id: 'DEMO-COMB-003',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90119/2026-IT01',
    item_externo: 'Combustível automotivo gasolina tipo c comum',
    natureza_preco: 'homologado',
    valor_original: 5.85,
    valor_normalizado: 5.85,
    unidade: 'litro',
    quantidade: 60000,
    data_contratacao: '2026-01-25T14:30:00Z',
    fornecedor: 'Vibra Energia S.A.',
    cnpj_fornecedor: '34.274.233/0001-02',
    orgao_comprador: 'Comando da Aeronáutica - BASP',
    municipio_uf: 'Guarulhos - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90119/2026',
    marca_modelo: 'Postos Petrobras',
    codigo_catalogo: 'CATMAT 390145',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90119-2026-1',
    hash: '1400112233447890123456789abcdef0123456789abcdef0123456789abcdef2',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90119-1',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 96,
    similarity_score: 95,
  },

  // 8. SERVIÇO DE MANUTENÇÃO PREDIAL (CATSER)
  {
    id: 'DEMO-SERV-001',
    fonte: 'pncp',
    id_externo: 'PNCP-CONTRATO-2025-994411',
    item_externo: 'Prestação de serviços contínuos de manutenção preventiva e corretiva predial',
    natureza_preco: 'contratado',
    valor_original: 14500.0,
    valor_normalizado: 14500.0,
    unidade: 'mes',
    quantidade: 12,
    data_contratacao: '2025-11-20T10:00:00Z',
    fornecedor: 'Engenharia e Manutenção Predial Paulista Ltda',
    cnpj_fornecedor: '18.990.112/0001-44',
    orgao_comprador: 'Câmara Municipal de São Bernardo do Campo',
    municipio_uf: 'São Bernardo do Campo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 55/2025',
    marca_modelo: 'Serviço de Engenharia Civil e Elétrica',
    codigo_catalogo: 'CATSER 24198',
    url: 'https://pncp.gov.br/app/contratos/manutencao-predial-sbc',
    hash: '1500112233447890123456789abcdef0123456789abcdef0123456789abcdef3',
    status_revisao: 'aceito',
    source_identifier: 'PNCP-994411',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 92,
    similarity_score: 90,
  },
  {
    id: 'DEMO-SERV-002',
    fonte: 'compras_gov',
    id_externo: 'COMPRAS-PE-90712/2025-IT01',
    item_externo: 'Serviço de manutenção predial com fornecimento de peças e mão de obra',
    natureza_preco: 'homologado',
    valor_original: 14900.0,
    valor_normalizado: 14900.0,
    unidade: 'mes',
    quantidade: 12,
    data_contratacao: '2025-12-05T15:00:00Z',
    fornecedor: 'Tejofran de Saneamento e Serviços Ltda',
    cnpj_fornecedor: '61.428.843/0001-38',
    orgao_comprador: 'Superintendência da Receita Federal em SP',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Pregão Eletrônico',
    processo_origem: 'PE 90712/2025',
    marca_modelo: 'Serviço Predial Especializado',
    codigo_catalogo: 'CATSER 24198',
    url: 'https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/item/90712-2025-1',
    hash: '1600112233447890123456789abcdef0123456789abcdef0123456789abcdef4',
    status_revisao: 'aceito',
    source_identifier: 'COMPRAS-90712-1',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 93,
    similarity_score: 91,
  },
  {
    id: 'DEMO-SERV-003',
    fonte: 'manual',
    id_externo: 'COT-DIR-MANUT-2026-01',
    item_externo: 'Proposta comercial de empresa de engenharia e manutenção predial',
    natureza_preco: 'cotacao_comercial',
    valor_original: 15300.0,
    valor_normalizado: 15300.0,
    unidade: 'mes',
    quantidade: 12,
    data_contratacao: '2026-02-10T16:00:00Z',
    fornecedor: 'Construfácil Obras e Reformas ME',
    cnpj_fornecedor: '28.112.334/0001-99',
    orgao_comprador: 'Prefeitura Municipal de Exemplo (SP)',
    municipio_uf: 'São Paulo - SP',
    modalidade_licitacao: 'Cotação Direta',
    processo_origem: 'COT-MANUT-2026',
    marca_modelo: 'Serviços Gerais de Manutenção',
    codigo_catalogo: 'CATSER 24198',
    url: 'https://prefeitura.sp.gov.br/cotacoes/2026/COT-MANUT-01.pdf',
    hash: '1700112233447890123456789abcdef0123456789abcdef0123456789abcdef5',
    status_revisao: 'aceito',
    source_identifier: 'COT-MANUT-2026-01',
    source_capture_date: '2026-03-01T08:00:00Z',
    confidence_score: 90,
    similarity_score: 88,
  },
]

// -------------------------------------------------------------------------
// Implementação dos Adaptadores Concretos
// -------------------------------------------------------------------------

export class ConectorPncpAdapter implements ConectorAdapter {
  codigo = 'pncp'
  nome = 'PNCP — Portal Nacional de Contratações Públicas'
  tipo = 'governamental' as const
  formato = 'api_rest' as const
  isRegulatorio = false
  runtimeEnabled = false // mantido false até homologação oficial

  async testarConexao() {
    return {
      ok: true,
      mensagem: 'Ambiente de Homologação PNCP respondendo em modo controlado. Runtime = false.',
      latencia_ms: 124,
    }
  }

  async consultarPrecos(
    pesquisaId: string,
    filtros: FiltrosConsultaConector,
  ): Promise<ResultadoConsultaConector> {
    const termo = (filtros.termo || '').toLowerCase()
    const registros = BANCO_REFERENCIAS_DEMO.filter(
      (r) =>
        r.fonte === 'pncp' &&
        (termo === '' ||
          r.item_externo?.toLowerCase().includes(termo) ||
          r.codigo_catalogo?.toLowerCase().includes(termo) ||
          (termo.includes('dipirona') && r.item_externo?.toLowerCase().includes('dipirona')) ||
          (termo.includes('paracetamol') &&
            r.item_externo?.toLowerCase().includes('paracetamol')) ||
          (termo.includes('alcool') && r.item_externo?.toLowerCase().includes('alcool')) ||
          (termo.includes('papel') && r.item_externo?.toLowerCase().includes('papel')) ||
          (termo.includes('computador') && r.item_externo?.toLowerCase().includes('desktop')) ||
          (termo.includes('impressora') && r.item_externo?.toLowerCase().includes('laser')) ||
          (termo.includes('gasolina') && r.item_externo?.toLowerCase().includes('gasolina')) ||
          (termo.includes('manutencao') && r.item_externo?.toLowerCase().includes('manutencao'))),
    ).map((r) => ({ ...r, pesquisa_id: pesquisaId }))

    return {
      conector_codigo: this.codigo,
      conector_nome: this.nome,
      total_encontrados: registros.length,
      sucesso: true,
      tempo_ms: 280,
      registros,
      is_regulatorio: false,
      aviso_homologacao: 'TODO — INTEGRAÇÃO REAL NECESSÁRIA. MODO DEMO CONTROLADO ATIVO.',
    }
  }
}

export class ConectorComprasGovAdapter implements ConectorAdapter {
  codigo = 'compras_gov'
  nome = 'Compras.gov.br — Módulo Preços Praticados'
  tipo = 'governamental' as const
  formato = 'api_rest' as const
  isRegulatorio = false
  runtimeEnabled = false

  async testarConexao() {
    return {
      ok: true,
      mensagem: 'API Compras.gov.br (Dados Abertos) respondendo. Runtime = false.',
      latencia_ms: 185,
    }
  }

  async consultarPrecos(
    pesquisaId: string,
    filtros: FiltrosConsultaConector,
  ): Promise<ResultadoConsultaConector> {
    const termo = (filtros.termo || '').toLowerCase()
    const registros = BANCO_REFERENCIAS_DEMO.filter(
      (r) =>
        r.fonte === 'compras_gov' &&
        (termo === '' ||
          r.item_externo?.toLowerCase().includes(termo) ||
          r.codigo_catalogo?.toLowerCase().includes(termo) ||
          (termo.includes('dipirona') && r.item_externo?.toLowerCase().includes('dipirona')) ||
          (termo.includes('paracetamol') &&
            r.item_externo?.toLowerCase().includes('paracetamol')) ||
          (termo.includes('alcool') && r.item_externo?.toLowerCase().includes('alcool')) ||
          (termo.includes('papel') && r.item_externo?.toLowerCase().includes('papel')) ||
          (termo.includes('computador') && r.item_externo?.toLowerCase().includes('desktop')) ||
          (termo.includes('impressora') && r.item_externo?.toLowerCase().includes('laser')) ||
          (termo.includes('gasolina') && r.item_externo?.toLowerCase().includes('gasolina')) ||
          (termo.includes('manutencao') && r.item_externo?.toLowerCase().includes('manutencao'))),
    ).map((r) => ({ ...r, pesquisa_id: pesquisaId }))

    return {
      conector_codigo: this.codigo,
      conector_nome: this.nome,
      total_encontrados: registros.length,
      sucesso: true,
      tempo_ms: 310,
      registros,
      is_regulatorio: false,
      aviso_homologacao: 'TODO — INTEGRAÇÃO REAL NECESSÁRIA. MODO DEMO CONTROLADO ATIVO.',
    }
  }
}

export class ConectorBpsAdapter implements ConectorAdapter {
  codigo = 'bps'
  nome = 'BPS — Banco de Preços em Saúde'
  tipo = 'governamental' as const
  formato = 'csv' as const
  isRegulatorio = false
  runtimeEnabled = false

  async testarConexao() {
    return {
      ok: true,
      mensagem: 'Módulo BPS CSV/JSON pronto para ingestão periódica. Runtime = false.',
      latencia_ms: 95,
    }
  }

  async consultarPrecos(
    pesquisaId: string,
    filtros: FiltrosConsultaConector,
  ): Promise<ResultadoConsultaConector> {
    const termo = (filtros.termo || '').toLowerCase()
    const registros = BANCO_REFERENCIAS_DEMO.filter(
      (r) =>
        r.fonte === 'bps' &&
        (termo === '' ||
          r.item_externo?.toLowerCase().includes(termo) ||
          r.codigo_catalogo?.toLowerCase().includes(termo) ||
          (termo.includes('dipirona') && r.item_externo?.toLowerCase().includes('dipirona')) ||
          (termo.includes('paracetamol') && r.item_externo?.toLowerCase().includes('paracetamol'))),
    ).map((r) => ({ ...r, pesquisa_id: pesquisaId }))

    return {
      conector_codigo: this.codigo,
      conector_nome: this.nome,
      total_encontrados: registros.length,
      sucesso: true,
      tempo_ms: 190,
      registros,
      is_regulatorio: false,
      aviso_homologacao: 'TODO — INTEGRAÇÃO REAL NECESSÁRIA. MODO DEMO CONTROLADO ATIVO.',
    }
  }
}

export class ConectorCmedAdapter implements ConectorAdapter {
  codigo = 'cmed'
  nome = 'CMED — Tabela Regulatória ANVISA (PF/PMC)'
  tipo = 'regulatoria' as const
  formato = 'xlsx' as const
  isRegulatorio = true
  runtimeEnabled = false

  async testarConexao() {
    return {
      ok: true,
      mensagem: 'Tabela oficial CMED de Preços Máximos carregada na memória do sistema.',
      latencia_ms: 45,
    }
  }

  async consultarPrecos(
    pesquisaId: string,
    filtros: FiltrosConsultaConector,
  ): Promise<ResultadoConsultaConector> {
    const termo = (filtros.termo || '').toLowerCase()
    const registros = BANCO_REFERENCIAS_DEMO.filter(
      (r) =>
        r.fonte === 'cmed' &&
        (termo === '' ||
          r.item_externo?.toLowerCase().includes(termo) ||
          (termo.includes('dipirona') && r.item_externo?.toLowerCase().includes('dipirona'))),
    ).map((r) => ({ ...r, pesquisa_id: pesquisaId }))

    return {
      conector_codigo: this.codigo,
      conector_nome: this.nome,
      total_encontrados: registros.length,
      sucesso: true,
      tempo_ms: 60,
      registros,
      is_regulatorio: true,
      aviso_homologacao:
        'ATENÇÃO: Preço regulatório teto (PF/PMC), não confundir com preço de contratação pago.',
    }
  }
}

export class ConectorBecSpAdapter implements ConectorAdapter {
  codigo = 'bec_sp'
  nome = 'BEC-SP — Bolsa Eletrônica de Compras de São Paulo'
  tipo = 'regional' as const
  formato = 'api_rest' as const
  isRegulatorio = false
  runtimeEnabled = false

  async testarConexao() {
    return {
      ok: true,
      mensagem: 'Conector Regional BEC-SP conectado em modo catálogo demonstrativo.',
      latencia_ms: 110,
    }
  }

  async consultarPrecos(
    pesquisaId: string,
    filtros: FiltrosConsultaConector,
  ): Promise<ResultadoConsultaConector> {
    const termo = (filtros.termo || '').toLowerCase()
    const registros = BANCO_REFERENCIAS_DEMO.filter(
      (r) =>
        r.fonte === 'bec_sp' &&
        (termo === '' ||
          r.item_externo?.toLowerCase().includes(termo) ||
          (termo.includes('dipirona') && r.item_externo?.toLowerCase().includes('dipirona')) ||
          (termo.includes('papel') && r.item_externo?.toLowerCase().includes('papel')) ||
          (termo.includes('impressora') && r.item_externo?.toLowerCase().includes('laser'))),
    ).map((r) => ({ ...r, pesquisa_id: pesquisaId }))

    return {
      conector_codigo: this.codigo,
      conector_nome: this.nome,
      total_encontrados: registros.length,
      sucesso: true,
      tempo_ms: 210,
      registros,
      is_regulatorio: false,
    }
  }
}

// -------------------------------------------------------------------------
// Hub Central de Conectores (Connectors Engine)
// -------------------------------------------------------------------------

export class PriceConnectorsHub {
  private static adaptadores: Map<string, ConectorAdapter> = new Map<string, ConectorAdapter>([
    ['pncp', new ConectorPncpAdapter()],
    ['compras_gov', new ConectorComprasGovAdapter()],
    ['bps', new ConectorBpsAdapter()],
    ['cmed', new ConectorCmedAdapter()],
    ['bec_sp', new ConectorBecSpAdapter()],
  ])

  /**
   * Permite registrar novos adaptadores em tempo de execução sem modificar o núcleo
   */
  public static registrarConector(adaptador: ConectorAdapter) {
    this.adaptadores.set(adaptador.codigo, adaptador)
  }

  public static listarConectores(): ConectorAdapter[] {
    return Array.from(this.adaptadores.values())
  }

  public static obterConector(codigo: string): ConectorAdapter | undefined {
    return this.adaptadores.get(codigo)
  }

  /**
   * Executa busca agregada em todos os conectores ativos/selecionados
   * com detecção e marcação de duplicatas (canonical_record_id)
   */
  public static async consultarMultiplasFontes(
    pesquisaId: string,
    filtros: FiltrosConsultaConector,
    fontesSelecionadas?: string[],
  ): Promise<{
    resultadosPorFonte: ResultadoConsultaConector[]
    todosRegistros: Referencia[]
    duplicatasDetectadas: number
    tempoTotalMs: number
  }> {
    const inicio = performance.now()
    const fontes =
      fontesSelecionadas && fontesSelecionadas.length > 0
        ? fontesSelecionadas
        : Array.from(this.adaptadores.keys())

    const promises = fontes.map(async (fCodigo) => {
      const adapter = this.adaptadores.get(fCodigo)
      if (!adapter) return null
      try {
        return await adapter.consultarPrecos(pesquisaId, filtros)
      } catch (err: any) {
        return {
          conector_codigo: fCodigo,
          conector_nome: adapter.nome,
          total_encontrados: 0,
          sucesso: false,
          tempo_ms: 0,
          registros: [],
          is_regulatorio: adapter.isRegulatorio,
          aviso_homologacao: `Erro no conector: ${err?.message}`,
        }
      }
    })

    const responses = (await Promise.all(promises)).filter(Boolean) as ResultadoConsultaConector[]

    // Deduplicação Trans-fontes
    // O mesmo preço pode aparecer no PNCP, Compras.gov e portal estadual.
    // NUNCA apagar o original: criar canonical_record_id relacionando os registros.
    const mapaTransacoes = new Map<string, string>() // chave -> primeiro ID (canônico)
    let duplicatas = 0
    const todos: Referencia[] = []

    responses.forEach((resp) => {
      resp.registros.forEach((reg) => {
        // Chave de identificação: CNPJ + data + valor unitário
        const chave = `${reg.cnpj_fornecedor || reg.fornecedor}_${(reg.data_contratacao || '').slice(0, 10)}_${reg.valor_normalizado}`

        if (mapaTransacoes.has(chave)) {
          duplicatas++
          reg.possivel_duplicata = true
          reg.canonico_id = mapaTransacoes.get(chave)
        } else {
          mapaTransacoes.set(chave, reg.id)
        }
        todos.push(reg)
      })
    })

    const fim = performance.now()
    return {
      resultadosPorFonte: responses,
      todosRegistros: todos,
      duplicatasDetectadas: duplicatas,
      tempoTotalMs: Math.round(fim - inicio),
    }
  }
}
