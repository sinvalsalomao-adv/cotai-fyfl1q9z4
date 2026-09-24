import type {
  Budget,
  BudgetItem,
  BudgetMethodology,
  BudgetPriceResult,
  BudgetExpurgatedPrice,
  BudgetStatistics,
} from '@/services/budgetService'

export interface DadosRelatorioOrcamentoPdf {
  budget: Budget
  methodology?: BudgetMethodology | null
  itens: BudgetItem[]
  cotacoesPorItem?: Record<string, BudgetPriceResult[]>
  expurgadosPorItem?: Record<string, BudgetExpurgatedPrice[]>
  estatisticasPorItem?: Record<string, BudgetStatistics>
  orgaoNome?: string
  municipioUf?: string
  cnpj?: string
  responsavelNome?: string
  justificativaConclusao?: string
}

export interface GrupoCidadeOrgao {
  nome: string
  subtitulo?: string
  itens: BudgetItem[]
  subtotal: number
}

export class BudgetPdfGeneratorService {
  /**
   * Agrupa itens por cidade/órgão.
   * Se o item possui `cidade_orgao`, agrupa por ele.
   * Caso contrário, usa o nome do órgão interessado ou município padrão do orçamento.
   */
  public static agruparItensPorCidadeOrgao(
    itens: BudgetItem[],
    orgaoPadrao: string,
    municipioPadrao?: string,
  ): GrupoCidadeOrgao[] {
    const gruposMap = new Map<string, BudgetItem[]>()

    for (const item of itens) {
      let chave = (item.cidade_orgao || '').trim()
      if (!chave) {
        chave = orgaoPadrao || 'Órgão Contratante'
      }
      if (!gruposMap.has(chave)) {
        gruposMap.set(chave, [])
      }
      gruposMap.get(chave)!.push(item)
    }

    const resultado: GrupoCidadeOrgao[] = []
    gruposMap.forEach((itensGrupo, chave) => {
      const subtotal = itensGrupo.reduce((acc, it) => acc + (it.total_price || 0), 0)
      const isPadrao = chave === (orgaoPadrao || 'Órgão Contratante')
      resultado.push({
        nome: chave,
        subtitulo: isPadrao && municipioPadrao ? municipioPadrao : undefined,
        itens: itensGrupo.sort((a, b) => a.sequence - b.sequence),
        subtotal,
      })
    })

    return resultado
  }

  /**
   * Constrói o HTML completo e rigoroso do Orçamento Estimativo (Padrão Cesta de Preços)
   */
  public static construirHtmlOrcamento(dados: DadosRelatorioOrcamentoPdf): string {
    const {
      budget,
      methodology,
      itens,
      cotacoesPorItem = {},
      expurgadosPorItem = {},
      estatisticasPorItem = {},
      orgaoNome = budget.expand?.organization_id?.nome || 'Órgão Contratante',
      municipioUf = 'NÃO INFORMADO',
      cnpj = budget.expand?.organization_id?.cnpj || 'NÃO INFORMADO',
      responsavelNome = 'Comissão de Contratação / Servidor Designado',
      justificativaConclusao = '',
    } = dados

    const decimals = methodology?.decimal_places || 2
    const grupos = this.agruparItensPorCidadeOrgao(itens, orgaoNome, municipioUf)
    const valorTotalGeral = itens.reduce((s, it) => s + (it.total_price || 0), 0)
    const itensCotadosCount = itens.filter((i) => i.status === 'cotado').length
    const itensPendentesCount = itens.length - itensCotadosCount

    // Amostras com vantajosidade
    const itensComVantajosidade = itens.filter(
      (i) => i.reference_price !== undefined && i.reference_price !== null && i.reference_price > 0,
    )
    const itensVantajososConfirmados = itensComVantajosidade.filter(
      (i) => (i.unit_price || 0) >= (i.reference_price || 0),
    )

    // Coleta todas as fontes consultadas distintas
    const fontesSet = new Set<string>()
    let totalAmostrasValidas = 0
    let totalExpurgosGerais = 0

    Object.values(cotacoesPorItem).forEach((prices) => {
      prices.forEach((p) => {
        if (p.source) fontesSet.add(p.source)
        if (p.status === 'selecionado' || p.status === 'encontrado') totalAmostrasValidas++
      })
    })

    Object.values(expurgadosPorItem).forEach((exps) => {
      totalExpurgosGerais += exps.length
    })

    const fontesFormatadas =
      fontesSet.size > 0 ? Array.from(fontesSet).join(', ') : 'PNCP, Compras.gov.br, BPS, BEC-SP'

    // Formatação de data/hora oficial
    const dataHoraEmissao = new Date().toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Orçamento Estimativo - ${this.escapeXml(budget.internal_number || 'ORCAMENTO')}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 15mm 12mm 15mm 12mm;
    }
    *, *:before, *:after {
      box-sizing: border-box;
    }
    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 10px;
      line-height: 1.35;
      color: #1a202c;
      background: #ffffff;
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    /* Barra Superior Azul-Escura Cesta de Preços */
    .brand-bar {
      background-color: #124268 !important;
      color: #ffffff !important;
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 3px solid #f59e0b;
    }
    .brand-bar h1 {
      margin: 0;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .brand-bar .doc-ref {
      font-family: "Courier New", Courier, monospace;
      font-size: 12px;
      font-weight: 700;
      color: #fde68a;
      background: rgba(255,255,255,0.12);
      padding: 3px 8px;
    }

    /* Subtítulos Caixa Alta Cinza #828892 */
    .section-title {
      background-color: #828892 !important;
      color: #ffffff !important;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 5px 8px;
      margin-top: 14px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .section-title.city-group {
      background-color: #1e3a5f !important;
      border-left: 4px solid #f59e0b;
      margin-top: 16px;
    }

    /* Painel de Identificação */
    .info-card {
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px 12px;
    }
    .info-item {
      display: flex;
      flex-direction: column;
    }
    .info-item.col-full {
      grid-column: 1 / -1;
    }
    .info-label {
      font-size: 8.5px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      margin-bottom: 1px;
    }
    .info-val {
      font-size: 10px;
      color: #0f172a;
      font-weight: 600;
    }
    .info-val.highlight {
      color: #124268;
      font-weight: 700;
    }
    .info-val.mono {
      font-family: "Courier New", Courier, monospace;
    }
    .info-box-text {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      padding: 6px 8px;
      font-size: 9.5px;
      color: #334155;
      margin-top: 2px;
      white-space: pre-line;
    }

    /* Badges e Contadores */
    .metrics-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin-bottom: 10px;
      text-align: center;
    }
    .metric-cell {
      border: 1px solid #cbd5e1;
      background: #ffffff;
      padding: 6px 4px;
    }
    .metric-cell .num {
      font-size: 13px;
      font-weight: 800;
      font-family: "Courier New", Courier, monospace;
      color: #124268;
      display: block;
    }
    .metric-cell.total .num {
      color: #047857;
      font-size: 14px;
    }
    .metric-cell .desc {
      font-size: 8px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      display: block;
      margin-top: 1px;
    }

    /* Tabelas Rigorosas */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9px;
      margin-bottom: 6px;
    }
    table thead th {
      background-color: #f1f5f9;
      color: #334155;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      border: 1px solid #cbd5e1;
      padding: 5px 4px;
      text-align: left;
    }
    table tbody td {
      border: 1px solid #e2e8f0;
      padding: 4px 5px;
      vertical-align: middle;
    }
    table tbody tr:nth-child(even) {
      background-color: #f8fafc;
    }
    table tfoot td {
      background-color: #f1f5f9;
      border: 1px solid #cbd5e1;
      padding: 6px 5px;
      font-weight: 700;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .font-mono { font-family: "Courier New", Courier, monospace; }
    .font-bold { font-weight: 700; }

    .tag-abc-A {
      background: #fee2e2;
      color: #991b1b;
      font-weight: 800;
      padding: 1px 4px;
      font-size: 8.5px;
      border: 1px solid #fecaca;
    }
    .tag-abc-B {
      background: #fef3c7;
      color: #92400e;
      font-weight: 800;
      padding: 1px 4px;
      font-size: 8.5px;
      border: 1px solid #fde68a;
    }
    .tag-abc-C {
      background: #e0f2fe;
      color: #075985;
      font-weight: 800;
      padding: 1px 4px;
      font-size: 8.5px;
      border: 1px solid #bae6fd;
    }

    .tag-status-cotado {
      color: #065f46;
      background: #d1fae5;
      padding: 1px 4px;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      border: 1px solid #a7f3d0;
    }
    .tag-status-pendente {
      color: #9a3412;
      background: #ffedd5;
      padding: 1px 4px;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      border: 1px solid #fed7aa;
    }

    /* Seção de Vantajosidade */
    .vantajosidade-panel {
      border: 1px solid #10b981;
      background: #f0fdf4;
      padding: 8px 10px;
      margin-top: 10px;
    }
    .vantajosidade-header {
      font-size: 9.5px;
      font-weight: 700;
      color: #065f46;
      text-transform: uppercase;
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      border-bottom: 1px dashed #6ee7b7;
      padding-bottom: 3px;
    }

    /* Seção de Expurgos */
    .expurgos-panel {
      border: 1px solid #f59e0b;
      background: #fffbeb;
      padding: 8px 10px;
      margin-top: 10px;
    }

    /* Assinaturas / Rodapé de Auditoria */
    .audit-footer {
      border-top: 1px solid #cbd5e1;
      padding-top: 8px;
      margin-top: 16px;
      font-size: 8px;
      color: #64748b;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .signatures-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
      margin-top: 36px;
      margin-bottom: 20px;
      text-align: center;
    }
    .sig-line {
      border-top: 1px solid #475569;
      padding-top: 4px;
    }
    .sig-name {
      font-weight: 700;
      font-size: 9px;
      color: #0f172a;
    }
    .sig-role {
      font-size: 8px;
      color: #64748b;
    }

    /* Controle de Impressão */
    @media print {
      body {
        margin: 0;
      }
      .no-print {
        display: none !important;
      }
      .page-break {
        page-break-after: always;
      }
    }

    .toolbar-actions {
      background: #0f172a;
      color: #ffffff;
      padding: 8px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 11px;
    }
    .toolbar-btn {
      background: #f59e0b;
      color: #0f172a;
      border: none;
      padding: 6px 14px;
      font-weight: 800;
      font-size: 11px;
      text-transform: uppercase;
      cursor: pointer;
      border-radius: 2px;
    }
    .toolbar-btn:hover {
      background: #fbbf24;
    }
    .toolbar-btn-secondary {
      background: #334155;
      color: #ffffff;
      border: 1px solid #64748b;
      padding: 5px 12px;
      font-size: 11px;
      cursor: pointer;
      margin-right: 6px;
    }
  </style>
</head>
<body>
  <div class="toolbar-actions no-print">
    <div>
      <strong>ORÇAMENTO ESTIMATIVO OFICIAL EM PDF</strong> — Organizado por Órgão/Cidade
    </div>
    <div>
      <button class="toolbar-btn-secondary" onclick="window.close()">Fechar</button>
      <button class="toolbar-btn" onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
    </div>
  </div>

  <!-- Barra Superior Azul-Escura Cesta de Preços -->
  <div class="brand-bar">
    <div>
      <h1>CESTA DE PREÇOS — ORÇAMENTO ESTIMATIVO OFICIAL</h1>
      <div style="font-size: 8.5px; opacity: 0.9; margin-top: 1px;">
        Conformidade com a Lei Federal nº 14.133/2021 (Nova Lei de Licitações e Contratos)
      </div>
    </div>
    <div class="doc-ref">
      ${this.escapeXml(budget.internal_number || 'ORCAMENTO')}
    </div>
  </div>

  <!-- Identificação Geral do Orçamento -->
  <div class="info-card" style="margin-top: 8px;">
    <div class="info-grid">
      <div class="info-item">
        <span class="info-label">Nome do Orçamento:</span>
        <span class="info-val highlight">${this.escapeXml(budget.name || 'NÃO INFORMADO')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Referência Externa (Processo):</span>
        <span class="info-val mono">${this.escapeXml(budget.external_reference || 'NÃO INFORMADO')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Órgão Interessado / Contratante:</span>
        <span class="info-val">${this.escapeXml(orgaoNome)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">CNPJ:</span>
        <span class="info-val mono">${this.escapeXml(cnpj)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Município / UF:</span>
        <span class="info-val">${this.escapeXml(municipioUf)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Órgãos Participantes / Cidades:</span>
        <span class="info-val">${grupos.map((g) => this.escapeXml(g.nome)).join('; ') || this.escapeXml(orgaoNome)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Data e Hora da Pesquisa:</span>
        <span class="info-val mono">${dataHoraEmissao}</span>
      </div>

      <div class="info-item col-full">
        <span class="info-label">Objeto da Contratação:</span>
        <div class="info-box-text">${this.escapeXml(budget.object || 'NÃO INFORMADO')}</div>
      </div>
    </div>
  </div>

  <!-- Metodologia e Parâmetros Aplicados -->
  <div class="section-title">
    <span>1. METODOLOGIA E CRITÉRIOS DE FORMAÇÃO DE PREÇOS</span>
    <span style="font-size: 8.5px; font-weight: normal;">Art. 23 da Lei 14.133/2021</span>
  </div>
  <div class="info-card">
    <div class="info-grid">
      <div class="info-item">
        <span class="info-label">Método do Preço Estimado:</span>
        <span class="info-val highlight" style="text-transform: uppercase;">
          ${this.escapeXml(methodology?.estimated_price_method || 'mediana')}
        </span>
      </div>
      <div class="info-item">
        <span class="info-label">Juízo Crítico de Preços:</span>
        <span class="info-val" style="text-transform: uppercase;">
          ${this.escapeXml(methodology?.critical_judgment_method || 'percentual')}
          (±${methodology?.percentage_upper || 30}%)
        </span>
      </div>
      <div class="info-item">
        <span class="info-label">Casas Decimais Utilizadas:</span>
        <span class="info-val mono">${decimals} casas decimais</span>
      </div>
      <div class="info-item">
        <span class="info-label">Fontes Públicas Consultadas:</span>
        <span class="info-val">${this.escapeXml(fontesFormatadas)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Amostras Válidas Utilizadas:</span>
        <span class="info-val mono">${totalAmostrasValidas} cotação(ões)</span>
      </div>
      <div class="info-item">
        <span class="info-label">Amostras Expurgadas:</span>
        <span class="info-val mono">${totalExpurgosGerais} cotação(ões) expurgada(s)</span>
      </div>
    </div>
  </div>

  <!-- Resumo Geral em Números -->
  <div class="metrics-bar">
    <div class="metric-cell">
      <span class="num">${itens.length}</span>
      <span class="desc">Itens do Orçamento</span>
    </div>
    <div class="metric-cell">
      <span class="num" style="color: #047857;">${itensCotadosCount}</span>
      <span class="desc">Itens Cotados</span>
    </div>
    <div class="metric-cell">
      <span class="num" style="color: #b45309;">${itensPendentesCount}</span>
      <span class="desc">Itens Pendentes</span>
    </div>
    <div class="metric-cell total">
      <span class="num">
        R$ ${valorTotalGeral.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      </span>
      <span class="desc">Valor Estimado Global</span>
    </div>
  </div>

  <!-- 2. TABELA DE ITENS AGRUPADOS POR CIDADE / ÓRGÃO INTERESSADO -->
  <div class="section-title">
    <span>2. MAPA DE ITENS DO ORÇAMENTO ESTIMATIVO POR ÓRGÃO / CIDADE</span>
    <span style="font-size: 8.5px; font-weight: normal;">${grupos.length} grupo(s) de órgão/cidade</span>
  </div>

  ${grupos
    .map((grupo, gIndex) => {
      return `
    <div style="margin-bottom: 12px;">
      <div class="section-title city-group">
        <span>ÓRGÃO / CIDADE: ${this.escapeXml(grupo.nome)} ${
          grupo.subtitulo ? `— ${this.escapeXml(grupo.subtitulo)}` : ''
        }</span>
        <span style="font-size: 8.5px; font-weight: normal;">
          ${grupo.itens.length} item(ns) | Subtotal: R$ ${grupo.subtotal.toLocaleString('pt-BR', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th class="text-center" style="width: 55px;">LOTE/ITEM</th>
            <th>DESCRIÇÃO DO ITEM</th>
            <th class="text-center" style="width: 45px;">UND</th>
            <th class="text-right" style="width: 55px;">QUANT.</th>
            <th class="text-right" style="width: 80px;">REF. CONTRATO</th>
            <th class="text-right" style="width: 85px;">PREÇO UNIT.</th>
            <th class="text-right" style="width: 90px;">PREÇO TOTAL</th>
            <th class="text-center" style="width: 45px;">ABC</th>
            <th class="text-center" style="width: 65px;">SITUAÇÃO</th>
          </tr>
        </thead>
        <tbody>
          ${grupo.itens
            .map((item) => {
              const temRef =
                item.reference_price !== undefined &&
                item.reference_price !== null &&
                item.reference_price > 0
              const refTxt = temRef ? `R$ ${item.reference_price!.toFixed(decimals)}` : 'NÃO INF.'
              const unitTxt =
                item.unit_price && item.unit_price > 0
                  ? `R$ ${item.unit_price.toFixed(decimals)}`
                  : 'R$ 0,00'
              const totTxt =
                item.total_price && item.total_price > 0
                  ? `R$ ${item.total_price.toFixed(decimals)}`
                  : 'R$ 0,00'
              const abcClass = item.abc_class && item.abc_class !== '—' ? item.abc_class : '—'
              const tagAbc =
                abcClass === 'A'
                  ? 'tag-abc-A'
                  : abcClass === 'B'
                    ? 'tag-abc-B'
                    : abcClass === 'C'
                      ? 'tag-abc-C'
                      : ''

              const loteTexto = item.lote
                ? `${this.escapeXml(item.lote)}/${String(item.sequence).padStart(3, '0')}`
                : `00/${String(item.sequence).padStart(3, '0')}`

              return `
            <tr>
              <td class="text-center font-mono font-bold">${loteTexto}</td>
              <td>
                <div style="font-weight: 700; color: #0f172a;">${this.escapeXml(item.description)}</div>
                <div style="font-size: 8px; color: #64748b;">
                  Tipo: ${this.escapeXml(item.type)}
                  ${item.brand ? `• Marca: ${this.escapeXml(item.brand)}` : ''}
                  • Amostras válidas: ${item.quotation_count || 0}
                </div>
              </td>
              <td class="text-center font-mono font-bold">${this.escapeXml(item.unit)}</td>
              <td class="text-right font-mono">${item.quantity.toLocaleString('pt-BR')}</td>
              <td class="text-right font-mono" style="color: #1e3a5f;">${refTxt}</td>
              <td class="text-right font-mono font-bold" style="color: #124268;">${unitTxt}</td>
              <td class="text-right font-mono font-bold" style="color: #0f172a;">${totTxt}</td>
              <td class="text-center font-mono">${
                tagAbc ? `<span class="${tagAbc}">${abcClass}</span>` : '—'
              }</td>
              <td class="text-center">
                <span class="${
                  item.status === 'cotado' ? 'tag-status-cotado' : 'tag-status-pendente'
                }">
                  ${item.status === 'cotado' ? 'COTADO' : 'PENDENTE'}
                </span>
              </td>
            </tr>
            `
            })
            .join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="6" class="text-right">
              SUBTOTAL (${this.escapeXml(grupo.nome)}):
            </td>
            <td class="text-right font-mono font-bold" style="color: #124268;">
              R$ ${grupo.subtotal.toLocaleString('pt-BR', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals,
              })}
            </td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
    `
    })
    .join('')}

  <!-- Total Geral Homologado -->
  <div style="background: #124268; color: #ffffff; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 800; margin-top: 6px;">
    <span>VALOR ESTIMADO GLOBAL DO ORÇAMENTO:</span>
    <span style="font-family: 'Courier New', Courier, monospace; font-size: 13px; color: #fde68a;">
      R$ ${valorTotalGeral.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  </div>

  <!-- 3. DEMONSTRATIVO DE VANTAJOSIDADE QUANDO HOUVER VALORES DE REFERÊNCIA -->
  ${
    itensComVantajosidade.length > 0
      ? `
  <div class="section-title" style="margin-top: 14px;">
    <span>3. DEMONSTRATIVO DE VANTAJOSIDADE — PRORROGAÇÃO CONTRATUAL (ARTS. 106 E 107 DA LEI 14.133/2021)</span>
    <span style="font-size: 8.5px; font-weight: normal;">${itensVantajososConfirmados.length} de ${itensComVantajosidade.length} vantajosos</span>
  </div>
  <div class="vantajosidade-panel">
    <div class="vantajosidade-header">
      <span>Comprovação Econômica para Renovação da Vigência Contratual</span>
      <span>${(
        (itensVantajososConfirmados.length / (itensComVantajosidade.length || 1)) *
        100
      ).toFixed(1)}% Vantajosidade Comprovada</span>
    </div>
    <p style="font-size: 8.5px; color: #334155; margin: 4px 0 8px 0; line-height: 1.4;">
      Em observância aos arts. 106 e 107 da Lei nº 14.133/2021, a vantajosidade da prorrogação de vigência resta comprovada quando o preço atualmente contratado é igual ou inferior aos preços vigentes praticados no mercado público.
    </p>

    <table>
      <thead>
        <tr>
          <th class="text-center" style="width: 50px;">ITEM</th>
          <th>DESCRIÇÃO DO ITEM</th>
          <th class="text-right" style="width: 85px;">VALOR CONTRATADO</th>
          <th class="text-right" style="width: 85px;">PREÇO DE MERCADO</th>
          <th class="text-right" style="width: 75px;">DIFERENÇA (R$)</th>
          <th class="text-right" style="width: 65px;">DIFERENÇA (%)</th>
          <th class="text-center" style="width: 110px;">CONCLUSÃO TÉCNICA</th>
        </tr>
      </thead>
      <tbody>
        ${itensComVantajosidade
          .map((it) => {
            const refVal = it.reference_price || 0
            const mktVal = it.unit_price || 0
            const diffRs = mktVal - refVal
            const diffPct = refVal > 0 ? (diffRs / refVal) * 100 : 0
            const isVant = mktVal >= refVal

            return `
          <tr>
            <td class="text-center font-mono font-bold">${String(it.sequence).padStart(2, '0')}</td>
            <td><strong>${this.escapeXml(it.description)}</strong></td>
            <td class="text-right font-mono">R$ ${refVal.toFixed(decimals)}</td>
            <td class="text-right font-mono font-bold" style="color: #124268;">R$ ${mktVal.toFixed(decimals)}</td>
            <td class="text-right font-mono font-bold" style="color: ${diffRs >= 0 ? '#047857' : '#b45309'};">
              ${diffRs >= 0 ? '+' : ''}R$ ${diffRs.toFixed(decimals)}
            </td>
            <td class="text-right font-mono font-bold" style="color: ${diffPct >= 0 ? '#047857' : '#b45309'};">
              ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%
            </td>
            <td class="text-center font-bold" style="font-size: 8px;">
              ${
                isVant
                  ? '<span style="color: #065f46; background: #d1fae5; padding: 2px 5px; border: 1px solid #a7f3d0;">✓ PRORROGAÇÃO VANTAJOSA</span>'
                  : '<span style="color: #9a3412; background: #ffedd5; padding: 2px 5px; border: 1px solid #fed7aa;">⚠ MERCADO INFERIOR</span>'
              }
            </td>
          </tr>
          `
          })
          .join('')}
      </tbody>
    </table>
  </div>
  `
      : ''
  }

  <!-- 4. VALORES EXPURGADOS PELO JUÍZO CRÍTICO -->
  ${
    totalExpurgosGerais > 0
      ? `
  <div class="section-title" style="margin-top: 14px;">
    <span>4. TRILHA DE JUÍZO CRÍTICO E VALORES EXPURGADOS (RASTREABILIDADE)</span>
    <span style="font-size: 8.5px; font-weight: normal;">Nenhum preço excluído silenciosamente</span>
  </div>
  <div class="expurgos-panel">
    <p style="font-size: 8.5px; color: #78350f; margin: 0 0 6px 0;">
      Abaixo constam as amostras identificadas e expurgadas pelo mecanismo de juízo crítico, em observância ao princípio da rastreabilidade da pesquisa pública.
    </p>
    <table>
      <thead>
        <tr>
          <th style="width: 50px;" class="text-center">ITEM</th>
          <th style="width: 75px;">FONTE</th>
          <th class="text-right" style="width: 75px;">VALOR EXP.</th>
          <th style="width: 80px;">MÉTODO</th>
          <th style="width: 90px;">LIMITE</th>
          <th>MOTIVO DA DESCONSIDERAÇÃO</th>
        </tr>
      </thead>
      <tbody>
        ${itens
          .flatMap((it) => {
            const exps = expurgadosPorItem[it.id] || []
            return exps.map((e) => {
              const precoNum = e.expand?.price_result_id?.unit_price
              const fonte = e.expand?.price_result_id?.source || 'Oficial'
              return `
              <tr>
                <td class="text-center font-mono font-bold">${String(it.sequence).padStart(2, '0')}</td>
                <td class="font-bold">${this.escapeXml(fonte)}</td>
                <td class="text-right font-mono" style="color: #dc2626;">
                  ${precoNum ? `R$ ${precoNum.toFixed(decimals)}` : 'NÃO INFORMADO'}
                </td>
                <td style="text-transform: uppercase;">${this.escapeXml(e.method || 'Percentual')}</td>
                <td class="font-mono">${this.escapeXml(e.threshold || '±30%')}</td>
                <td style="color: #475569;">${this.escapeXml(e.reason)}</td>
              </tr>
            `
            })
          })
          .join('')}
      </tbody>
    </table>
  </div>
  `
      : ''
  }

  <!-- 5. JUSTIFICATIVA TÉCNICA E OBSERVAÇÕES DO RESPONSÁVEL -->
  <div class="section-title" style="margin-top: 14px;">
    <span>5. JUSTIFICATIVA TÉCNICA E OBSERVAÇÕES DO RESPONSÁVEL</span>
    <span style="font-size: 8.5px; font-weight: normal;">Obrigatoriedade e motivação do ato administrativo</span>
  </div>
  <div class="info-card">
    <div style="font-size: 9.5px; color: #1e293b; white-space: pre-line; line-height: 1.45;">
      ${
        justificativaConclusao
          ? this.escapeXml(justificativaConclusao)
          : 'Orçamento estimativo concluído com base nos parâmetros definidos pelo órgão, metodologias estatísticas e juízo crítico conforme prescrições da Lei nº 14.133/2021.'
      }
    </div>
  </div>

  <!-- 6. RESUMO FINAL E DEMONSTRATIVO CONSOLIDADO POR ÓRGÃO/CIDADE -->
  <div class="section-title" style="margin-top: 14px;">
    <span>6. RESUMO FINAL CONSOLIDADO POR ÓRGÃO / CIDADE</span>
  </div>
  <div class="info-card">
    <table>
      <thead>
        <tr>
          <th class="text-center" style="width: 45px;">Nº</th>
          <th>ÓRGÃO / CIDADE</th>
          <th class="text-center" style="width: 90px;">QUANT. ITENS</th>
          <th class="text-right" style="width: 120px;">SUBTOTAL ESTIMADO</th>
          <th class="text-right" style="width: 80px;">PARTICIPAÇÃO</th>
        </tr>
      </thead>
      <tbody>
        ${grupos
          .map((g, idx) => {
            const pct = valorTotalGeral > 0 ? (g.subtotal / valorTotalGeral) * 100 : 0
            return `
          <tr>
            <td class="text-center font-mono font-bold">${idx + 1}</td>
            <td><strong>${this.escapeXml(g.nome)}</strong></td>
            <td class="text-center font-mono">${g.itens.length} item(ns)</td>
            <td class="text-right font-mono font-bold" style="color: #124268;">
              R$ ${g.subtotal.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
            </td>
            <td class="text-right font-mono">${pct.toFixed(1)}%</td>
          </tr>`
          })
          .join('')}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3" class="text-right font-bold uppercase">VALOR GLOBAL CONSOLIDADO:</td>
          <td class="text-right font-mono font-bold" style="color: #047857;">
            R$ ${valorTotalGeral.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
          </td>
          <td class="text-right font-mono font-bold">100.0%</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Assinaturas Formais -->
  <div class="signatures-grid">
    <div class="sig-line">
      <div class="sig-name">${this.escapeXml(responsavelNome)}</div>
      <div class="sig-role">Responsável pela Pesquisa de Preços / Comissão de Contratação</div>
    </div>
    <div class="sig-line">
      <div class="sig-name">Autoridade Competente</div>
      <div class="sig-role">Ordenador de Despesas / Secretário Responsável</div>
    </div>
  </div>

  <!-- Rodapé Institucional -->
  <div class="audit-footer">
    <div>
      Documento gerado eletronicamente em <strong>${dataHoraEmissao}</strong> • Plataforma Cesta de Preços
    </div>
    <div class="font-mono">
      Hash de Auditoria: ${this.gerarHashAuditoria(budget.id, itens.length, valorTotalGeral)}
    </div>
  </div>

  <script>
    // Auto-impressão após carregamento completo
    window.onload = function() {
      setTimeout(function() {
        try {
          window.focus();
          window.print();
        } catch (e) {
          console.warn('Auto print error:', e);
        }
      }, 350);
    };
  </script>
</body>
</html>`
  }

  /**
   * Constrói o HTML rigoroso do Orçamento Estimativo e dispara a janela de impressão/salvar em PDF
   * com suporte completo a Blob URL e fallback imediato caso popup seja bloqueado pelo navegador.
   * Retorna true se abriu a janela com sucesso, false se o bloqueador de popups interceptou (ou se foi feito download direto).
   */
  public static gerarPdfOrcamento(dados: DadosRelatorioOrcamentoPdf): {
    sucesso: boolean
    bloqueadoPorPopup: boolean
    blobUrl?: string
    nomeArquivo: string
  } {
    const numLimpo = (dados.budget?.internal_number || 'ORCAMENTO').replace(/[^a-zA-Z0-9_-]/g, '_')
    const nomeArquivo = `Orcamento_Estimativo_${numLimpo}.html`

    let html = ''
    try {
      html = this.construirHtmlOrcamento(dados)
    } catch (err) {
      console.error('Erro na construção do HTML do PDF:', err)
      throw new Error('Falha ao compilar o relatório do orçamento: ' + (err as any)?.message)
    }

    // Criar Blob independente da sessão
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const blobUrl = URL.createObjectURL(blob)

    let abriuJanela = false
    try {
      // Tentativa 1: Abrir via Blob URL em nova janela (compatível e independente de sessão)
      const printWindow = window.open(blobUrl, '_blank', 'width=1020,height=900,menubar=yes,toolbar=yes')
      if (printWindow && !printWindow.closed) {
        abriuJanela = true
        try {
          printWindow.focus()
        } catch { /* intentionally ignored */ }
      }
    } catch (openErr) {
      console.warn('window.open com blobUrl foi bloqueado ou falhou:', openErr)
    }

    if (!abriuJanela) {
      // Tentativa 2: window.open vazio com document.write
      try {
        const fallbackWindow = window.open('', '_blank', 'width=1020,height=900')
        if (fallbackWindow && !fallbackWindow.closed) {
          fallbackWindow.document.open()
          fallbackWindow.document.write(html)
          fallbackWindow.document.close()
          fallbackWindow.focus()
          abriuJanela = true
        }
      } catch (fallbackErr) {
        console.warn('Fallback window.open vazio também foi bloqueado:', fallbackErr)
      }
    }

    // Se o navegador bloqueou popups, faz o download automático de emergência para não deixar o usuário sem o arquivo
    if (!abriuJanela) {
      this.dispararDownloadBlob(blob, nomeArquivo)
      return {
        sucesso: true,
        bloqueadoPorPopup: true,
        blobUrl,
        nomeArquivo,
      }
    }

    return {
      sucesso: true,
      bloqueadoPorPopup: false,
      blobUrl,
      nomeArquivo,
    }
  }

  /**
   * Força o download direto do arquivo de impressão sem depender de popup
   */
  public static baixarArquivoHtmlPdf(dados: DadosRelatorioOrcamentoPdf): string {
    const numLimpo = (dados.budget?.internal_number || 'ORCAMENTO').replace(/[^a-zA-Z0-9_-]/g, '_')
    const nomeArquivo = `Orcamento_Estimativo_${numLimpo}.html`
    const html = this.construirHtmlOrcamento(dados)
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    this.dispararDownloadBlob(blob, nomeArquivo)
    return nomeArquivo
  }

  /**
   * Helper para disparo de download no browser
   */
  public static dispararDownloadBlob(blob: Blob, nomeArquivo: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = nomeArquivo
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }, 1500)
  }
    const {
      budget,
      methodology,
      itens,
      cotacoesPorItem = {},
      expurgadosPorItem = {},
      estatisticasPorItem = {},
      orgaoNome = budget.expand?.organization_id?.nome || 'Órgão Contratante',
      municipioUf = 'NÃO INFORMADO',
      cnpj = budget.expand?.organization_id?.cnpj || 'NÃO INFORMADO',
      responsavelNome = 'Comissão de Contratação / Servidor Designado',
      justificativaConclusao = '',
    } = dados

    const decimals = methodology?.decimal_places || 2
    const grupos = this.agruparItensPorCidadeOrgao(itens, orgaoNome, municipioUf)
    const valorTotalGeral = itens.reduce((s, it) => s + (it.total_price || 0), 0)
    const itensCotadosCount = itens.filter((i) => i.status === 'cotado').length
    const itensPendentesCount = itens.length - itensCotadosCount

    // Amostras com vantajosidade
    const itensComVantajosidade = itens.filter(
      (i) => i.reference_price !== undefined && i.reference_price !== null && i.reference_price > 0,
    )
    const itensVantajososConfirmados = itensComVantajosidade.filter(
      (i) => (i.unit_price || 0) >= (i.reference_price || 0),
    )

    // Coleta todas as fontes consultadas distintas
    const fontesSet = new Set<string>()
    let totalAmostrasValidas = 0
    let totalExpurgosGerais = 0

    Object.values(cotacoesPorItem).forEach((prices) => {
      prices.forEach((p) => {
        if (p.source) fontesSet.add(p.source)
        if (p.status === 'selecionado' || p.status === 'encontrado') totalAmostrasValidas++
      })
    })

    Object.values(expurgadosPorItem).forEach((exps) => {
      totalExpurgosGerais += exps.length
    })

    const fontesFormatadas =
      fontesSet.size > 0 ? Array.from(fontesSet).join(', ') : 'PNCP, Compras.gov.br, BPS, BEC-SP'

    // Formatação de data/hora oficial
    const dataHoraEmissao = new Date().toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    // Construção do HTML do documento
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Orçamento Estimativo - ${this.escapeXml(budget.internal_number || 'ORCAMENTO')}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 15mm 12mm 15mm 12mm;
    }
    *, *:before, *:after {
      box-sizing: border-box;
    }
    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 10px;
      line-height: 1.35;
      color: #1a202c;
      background: #ffffff;
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    /* Barra Superior Azul-Escura Cesta de Preços */
    .brand-bar {
      background-color: #124268 !important;
      color: #ffffff !important;
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 3px solid #f59e0b;
    }
    .brand-bar h1 {
      margin: 0;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .brand-bar .doc-ref {
      font-family: "Courier New", Courier, monospace;
      font-size: 12px;
      font-weight: 700;
      color: #fde68a;
      background: rgba(255,255,255,0.12);
      padding: 3px 8px;
    }

    /* Subtítulos Caixa Alta Cinza #828892 */
    .section-title {
      background-color: #828892 !important;
      color: #ffffff !important;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 5px 8px;
      margin-top: 14px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .section-title.city-group {
      background-color: #1e3a5f !important;
      border-left: 4px solid #f59e0b;
      margin-top: 16px;
    }

    /* Painel de Identificação */
    .info-card {
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px 12px;
    }
    .info-item {
      display: flex;
      flex-direction: column;
    }
    .info-item.col-full {
      grid-column: 1 / -1;
    }
    .info-label {
      font-size: 8.5px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      margin-bottom: 1px;
    }
    .info-val {
      font-size: 10px;
      color: #0f172a;
      font-weight: 600;
    }
    .info-val.highlight {
      color: #124268;
      font-weight: 700;
    }
    .info-val.mono {
      font-family: "Courier New", Courier, monospace;
    }
    .info-box-text {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      padding: 6px 8px;
      font-size: 9.5px;
      color: #334155;
      margin-top: 2px;
      white-space: pre-line;
    }

    /* Badges e Contadores */
    .metrics-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin-bottom: 10px;
      text-align: center;
    }
    .metric-cell {
      border: 1px solid #cbd5e1;
      background: #ffffff;
      padding: 6px 4px;
    }
    .metric-cell .num {
      font-size: 13px;
      font-weight: 800;
      font-family: "Courier New", Courier, monospace;
      color: #124268;
      display: block;
    }
    .metric-cell.total .num {
      color: #047857;
      font-size: 14px;
    }
    .metric-cell .desc {
      font-size: 8px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      display: block;
      margin-top: 1px;
    }

    /* Tabelas Rigorosas */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9px;
      margin-bottom: 6px;
    }
    table thead th {
      background-color: #f1f5f9;
      color: #334155;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      border: 1px solid #cbd5e1;
      padding: 5px 4px;
      text-align: left;
    }
    table tbody td {
      border: 1px solid #e2e8f0;
      padding: 4px 5px;
      vertical-align: middle;
    }
    table tbody tr:nth-child(even) {
      background-color: #f8fafc;
    }
    table tfoot td {
      background-color: #f1f5f9;
      border: 1px solid #cbd5e1;
      padding: 6px 5px;
      font-weight: 700;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .font-mono { font-family: "Courier New", Courier, monospace; }
    .font-bold { font-weight: 700; }

    .tag-abc-A {
      background: #fee2e2;
      color: #991b1b;
      font-weight: 800;
      padding: 1px 4px;
      font-size: 8.5px;
      border: 1px solid #fecaca;
    }
    .tag-abc-B {
      background: #fef3c7;
      color: #92400e;
      font-weight: 800;
      padding: 1px 4px;
      font-size: 8.5px;
      border: 1px solid #fde68a;
    }
    .tag-abc-C {
      background: #e0f2fe;
      color: #075985;
      font-weight: 800;
      padding: 1px 4px;
      font-size: 8.5px;
      border: 1px solid #bae6fd;
    }

    .tag-status-cotado {
      color: #065f46;
      background: #d1fae5;
      padding: 1px 4px;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      border: 1px solid #a7f3d0;
    }
    .tag-status-pendente {
      color: #9a3412;
      background: #ffedd5;
      padding: 1px 4px;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      border: 1px solid #fed7aa;
    }

    /* Seção de Vantajosidade */
    .vantajosidade-panel {
      border: 1px solid #10b981;
      background: #f0fdf4;
      padding: 8px 10px;
      margin-top: 10px;
    }
    .vantajosidade-header {
      font-size: 9.5px;
      font-weight: 700;
      color: #065f46;
      text-transform: uppercase;
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      border-bottom: 1px dashed #6ee7b7;
      padding-bottom: 3px;
    }

    /* Seção de Expurgos */
    .expurgos-panel {
      border: 1px solid #f59e0b;
      background: #fffbeb;
      padding: 8px 10px;
      margin-top: 10px;
    }

    /* Assinaturas / Rodapé de Auditoria */
    .audit-footer {
      border-top: 1px solid #cbd5e1;
      padding-top: 8px;
      margin-top: 16px;
      font-size: 8px;
      color: #64748b;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .signatures-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
      margin-top: 36px;
      margin-bottom: 20px;
      text-align: center;
    }
    .sig-line {
      border-top: 1px solid #475569;
      padding-top: 4px;
    }
    .sig-name {
      font-weight: 700;
      font-size: 9px;
      color: #0f172a;
    }
    .sig-role {
      font-size: 8px;
      color: #64748b;
    }

    /* Controle de Impressão */
    @media print {
      body {
        margin: 0;
      }
      .no-print {
        display: none !important;
      }
      .page-break {
        page-break-after: always;
      }
    }

    .toolbar-actions {
      background: #0f172a;
      color: #ffffff;
      padding: 8px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 11px;
    }
    .toolbar-btn {
      background: #f59e0b;
      color: #0f172a;
      border: none;
      padding: 6px 14px;
      font-weight: 800;
      font-size: 11px;
      text-transform: uppercase;
      cursor: pointer;
      border-radius: 2px;
    }
    .toolbar-btn:hover {
      background: #fbbf24;
    }
    .toolbar-btn-secondary {
      background: #334155;
      color: #ffffff;
      border: 1px solid #64748b;
      padding: 5px 12px;
      font-size: 11px;
      cursor: pointer;
      margin-right: 6px;
    }
  </style>
</head>
<body>
  <div class="toolbar-actions no-print">
    <div>
      <strong>ORÇAMENTO ESTIMATIVO OFICIAL EM PDF</strong> — Organizado por Órgão/Cidade
    </div>
    <div>
      <button class="toolbar-btn-secondary" onclick="window.close()">Fechar</button>
      <button class="toolbar-btn" onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
    </div>
  </div>

  <!-- Barra Superior Azul-Escura Cesta de Preços -->
  <div class="brand-bar">
    <div>
      <h1>CESTA DE PREÇOS — ORÇAMENTO ESTIMATIVO OFICIAL</h1>
      <div style="font-size: 8.5px; opacity: 0.9; margin-top: 1px;">
        Conformidade com a Lei Federal nº 14.133/2021 (Nova Lei de Licitações e Contratos)
      </div>
    </div>
    <div class="doc-ref">
      ${this.escapeXml(budget.internal_number || 'ORCAMENTO')}
    </div>
  </div>

  <!-- Identificação Geral do Orçamento -->
  <div class="info-card" style="margin-top: 8px;">
    <div class="info-grid">
      <div class="info-item">
        <span class="info-label">Nome do Orçamento:</span>
        <span class="info-val highlight">${this.escapeXml(budget.name || 'NÃO INFORMADO')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Referência Externa (Processo):</span>
        <span class="info-val mono">${this.escapeXml(budget.external_reference || 'NÃO INFORMADO')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Órgão Interessado / Contratante:</span>
        <span class="info-val">${this.escapeXml(orgaoNome)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">CNPJ:</span>
        <span class="info-val mono">${this.escapeXml(cnpj)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Município / UF:</span>
        <span class="info-val">${this.escapeXml(municipioUf)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Órgãos Participantes / Cidades:</span>
        <span class="info-val">${grupos.map((g) => this.escapeXml(g.nome)).join('; ') || this.escapeXml(orgaoNome)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Data e Hora da Pesquisa:</span>
        <span class="info-val mono">${dataHoraEmissao}</span>
      </div>

      <div class="info-item col-full">
        <span class="info-label">Objeto da Contratação:</span>
        <div class="info-box-text">${this.escapeXml(budget.object || 'NÃO INFORMADO')}</div>
      </div>
    </div>
  </div>

  <!-- Metodologia e Parâmetros Aplicados -->
  <div class="section-title">
    <span>1. METODOLOGIA E CRITÉRIOS DE FORMAÇÃO DE PREÇOS</span>
    <span style="font-size: 8.5px; font-weight: normal;">Art. 23 da Lei 14.133/2021</span>
  </div>
  <div class="info-card">
    <div class="info-grid">
      <div class="info-item">
        <span class="info-label">Método do Preço Estimado:</span>
        <span class="info-val highlight" style="text-transform: uppercase;">
          ${this.escapeXml(methodology?.estimated_price_method || 'mediana')}
        </span>
      </div>
      <div class="info-item">
        <span class="info-label">Juízo Crítico de Preços:</span>
        <span class="info-val" style="text-transform: uppercase;">
          ${this.escapeXml(methodology?.critical_judgment_method || 'percentual')}
          (±${methodology?.percentage_upper || 30}%)
        </span>
      </div>
      <div class="info-item">
        <span class="info-label">Casas Decimais Utilizadas:</span>
        <span class="info-val mono">${decimals} casas decimais</span>
      </div>
      <div class="info-item">
        <span class="info-label">Fontes Públicas Consultadas:</span>
        <span class="info-val">${this.escapeXml(fontesFormatadas)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Amostras Válidas Utilizadas:</span>
        <span class="info-val mono">${totalAmostrasValidas} cotação(ões)</span>
      </div>
      <div class="info-item">
        <span class="info-label">Amostras Expurgadas:</span>
        <span class="info-val mono">${totalExpurgosGerais} cotação(ões) expurgada(s)</span>
      </div>
    </div>
  </div>

  <!-- Resumo Geral em Números -->
  <div class="metrics-bar">
    <div class="metric-cell">
      <span class="num">${itens.length}</span>
      <span class="desc">Itens do Orçamento</span>
    </div>
    <div class="metric-cell">
      <span class="num" style="color: #047857;">${itensCotadosCount}</span>
      <span class="desc">Itens Cotados</span>
    </div>
    <div class="metric-cell">
      <span class="num" style="color: #b45309;">${itensPendentesCount}</span>
      <span class="desc">Itens Pendentes</span>
    </div>
    <div class="metric-cell total">
      <span class="num">
        R$ ${valorTotalGeral.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      </span>
      <span class="desc">Valor Estimado Global</span>
    </div>
  </div>

  <!-- 2. TABELA DE ITENS AGRUPADOS POR CIDADE / ÓRGÃO INTERESSADO -->
  <div class="section-title">
    <span>2. MAPA DE ITENS DO ORÇAMENTO ESTIMATIVO POR ÓRGÃO / CIDADE</span>
    <span style="font-size: 8.5px; font-weight: normal;">${grupos.length} grupo(s) de órgão/cidade</span>
  </div>

  ${grupos
    .map((grupo, gIndex) => {
      return `
    <div style="margin-bottom: 12px;">
      <div class="section-title city-group">
        <span>ÓRGÃO / CIDADE: ${this.escapeXml(grupo.nome)} ${
          grupo.subtitulo ? `— ${this.escapeXml(grupo.subtitulo)}` : ''
        }</span>
        <span style="font-size: 8.5px; font-weight: normal;">
          ${grupo.itens.length} item(ns) | Subtotal: R$ ${grupo.subtotal.toLocaleString('pt-BR', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th class="text-center" style="width: 55px;">LOTE/ITEM</th>
            <th>DESCRIÇÃO DO ITEM</th>
            <th class="text-center" style="width: 45px;">UND</th>
            <th class="text-right" style="width: 55px;">QUANT.</th>
            <th class="text-right" style="width: 80px;">REF. CONTRATO</th>
            <th class="text-right" style="width: 85px;">PREÇO UNIT.</th>
            <th class="text-right" style="width: 90px;">PREÇO TOTAL</th>
            <th class="text-center" style="width: 45px;">ABC</th>
            <th class="text-center" style="width: 65px;">SITUAÇÃO</th>
          </tr>
        </thead>
        <tbody>
          ${grupo.itens
            .map((item) => {
              const temRef =
                item.reference_price !== undefined &&
                item.reference_price !== null &&
                item.reference_price > 0
              const refTxt = temRef ? `R$ ${item.reference_price!.toFixed(decimals)}` : 'NÃO INF.'
              const unitTxt =
                item.unit_price && item.unit_price > 0
                  ? `R$ ${item.unit_price.toFixed(decimals)}`
                  : 'R$ 0,00'
              const totTxt =
                item.total_price && item.total_price > 0
                  ? `R$ ${item.total_price.toFixed(decimals)}`
                  : 'R$ 0,00'
              const abcClass = item.abc_class && item.abc_class !== '—' ? item.abc_class : '—'
              const tagAbc =
                abcClass === 'A'
                  ? 'tag-abc-A'
                  : abcClass === 'B'
                    ? 'tag-abc-B'
                    : abcClass === 'C'
                      ? 'tag-abc-C'
                      : ''

              const loteTexto = item.lote
                ? `${this.escapeXml(item.lote)}/${String(item.sequence).padStart(3, '0')}`
                : `00/${String(item.sequence).padStart(3, '0')}`

              return `
            <tr>
              <td class="text-center font-mono font-bold">${loteTexto}</td>
              <td>
                <div style="font-weight: 700; color: #0f172a;">${this.escapeXml(item.description)}</div>
                <div style="font-size: 8px; color: #64748b;">
                  Tipo: ${this.escapeXml(item.type)}
                  ${item.brand ? `• Marca: ${this.escapeXml(item.brand)}` : ''}
                  • Amostras válidas: ${item.quotation_count || 0}
                </div>
              </td>
              <td class="text-center font-mono font-bold">${this.escapeXml(item.unit)}</td>
              <td class="text-right font-mono">${item.quantity.toLocaleString('pt-BR')}</td>
              <td class="text-right font-mono" style="color: #1e3a5f;">${refTxt}</td>
              <td class="text-right font-mono font-bold" style="color: #124268;">${unitTxt}</td>
              <td class="text-right font-mono font-bold" style="color: #0f172a;">${totTxt}</td>
              <td class="text-center font-mono">${
                tagAbc ? `<span class="${tagAbc}">${abcClass}</span>` : '—'
              }</td>
              <td class="text-center">
                <span class="${
                  item.status === 'cotado' ? 'tag-status-cotado' : 'tag-status-pendente'
                }">
                  ${item.status === 'cotado' ? 'COTADO' : 'PENDENTE'}
                </span>
              </td>
            </tr>
            `
            })
            .join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="6" class="text-right">
              SUBTOTAL (${this.escapeXml(grupo.nome)}):
            </td>
            <td class="text-right font-mono font-bold" style="color: #124268;">
              R$ ${grupo.subtotal.toLocaleString('pt-BR', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals,
              })}
            </td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
    `
    })
    .join('')}

  <!-- Total Geral Homologado -->
  <div style="background: #124268; color: #ffffff; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 800; margin-top: 6px;">
    <span>VALOR ESTIMADO GLOBAL DO ORÇAMENTO:</span>
    <span style="font-family: 'Courier New', Courier, monospace; font-size: 13px; color: #fde68a;">
      R$ ${valorTotalGeral.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  </div>

  <!-- 3. DEMONSTRATIVO DE VANTAJOSIDADE QUANDO HOUVER VALORES DE REFERÊNCIA -->
  ${
    itensComVantajosidade.length > 0
      ? `
  <div class="section-title" style="margin-top: 14px;">
    <span>3. DEMONSTRATIVO DE VANTAJOSIDADE — PRORROGAÇÃO CONTRATUAL (ARTS. 106 E 107 DA LEI 14.133/2021)</span>
    <span style="font-size: 8.5px; font-weight: normal;">${itensVantajososConfirmados.length} de ${itensComVantajosidade.length} vantajosos</span>
  </div>
  <div class="vantajosidade-panel">
    <div class="vantajosidade-header">
      <span>Comprovação Econômica para Renovação da Vigência Contratual</span>
      <span>${(
        (itensVantajososConfirmados.length / (itensComVantajosidade.length || 1)) *
        100
      ).toFixed(1)}% Vantajosidade Comprovada</span>
    </div>
    <p style="font-size: 8.5px; color: #334155; margin: 4px 0 8px 0; line-height: 1.4;">
      Em observância aos arts. 106 e 107 da Lei nº 14.133/2021, a vantajosidade da prorrogação de vigência resta comprovada quando o preço atualmente contratado é igual ou inferior aos preços vigentes praticados no mercado público.
    </p>

    <table>
      <thead>
        <tr>
          <th class="text-center" style="width: 50px;">ITEM</th>
          <th>DESCRIÇÃO DO ITEM</th>
          <th class="text-right" style="width: 85px;">VALOR CONTRATADO</th>
          <th class="text-right" style="width: 85px;">PREÇO DE MERCADO</th>
          <th class="text-right" style="width: 75px;">DIFERENÇA (R$)</th>
          <th class="text-right" style="width: 65px;">DIFERENÇA (%)</th>
          <th class="text-center" style="width: 110px;">CONCLUSÃO TÉCNICA</th>
        </tr>
      </thead>
      <tbody>
        ${itensComVantajosidade
          .map((it) => {
            const refVal = it.reference_price || 0
            const mktVal = it.unit_price || 0
            const diffRs = mktVal - refVal
            const diffPct = refVal > 0 ? (diffRs / refVal) * 100 : 0
            const isVant = mktVal >= refVal

            return `
          <tr>
            <td class="text-center font-mono font-bold">${String(it.sequence).padStart(2, '0')}</td>
            <td><strong>${this.escapeXml(it.description)}</strong></td>
            <td class="text-right font-mono">R$ ${refVal.toFixed(decimals)}</td>
            <td class="text-right font-mono font-bold" style="color: #124268;">R$ ${mktVal.toFixed(decimals)}</td>
            <td class="text-right font-mono font-bold" style="color: ${diffRs >= 0 ? '#047857' : '#b45309'};">
              ${diffRs >= 0 ? '+' : ''}R$ ${diffRs.toFixed(decimals)}
            </td>
            <td class="text-right font-mono font-bold" style="color: ${diffPct >= 0 ? '#047857' : '#b45309'};">
              ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%
            </td>
            <td class="text-center font-bold" style="font-size: 8px;">
              ${
                isVant
                  ? '<span style="color: #065f46; background: #d1fae5; padding: 2px 5px; border: 1px solid #a7f3d0;">✓ PRORROGAÇÃO VANTAJOSA</span>'
                  : '<span style="color: #9a3412; background: #ffedd5; padding: 2px 5px; border: 1px solid #fed7aa;">⚠ MERCADO INFERIOR</span>'
              }
            </td>
          </tr>
          `
          })
          .join('')}
      </tbody>
    </table>
  </div>
  `
      : ''
  }

  <!-- 4. VALORES EXPURGADOS PELO JUÍZO CRÍTICO -->
  ${
    totalExpurgosGerais > 0
      ? `
  <div class="section-title" style="margin-top: 14px;">
    <span>4. TRILHA DE JUÍZO CRÍTICO E VALORES EXPURGADOS (RASTREABILIDADE)</span>
    <span style="font-size: 8.5px; font-weight: normal;">Nenhum preço excluído silenciosamente</span>
  </div>
  <div class="expurgos-panel">
    <p style="font-size: 8.5px; color: #78350f; margin: 0 0 6px 0;">
      Abaixo constam as amostras identificadas e expurgadas pelo mecanismo de juízo crítico, em observância ao princípio da rastreabilidade da pesquisa pública.
    </p>
    <table>
      <thead>
        <tr>
          <th style="width: 50px;" class="text-center">ITEM</th>
          <th style="width: 75px;">FONTE</th>
          <th class="text-right" style="width: 75px;">VALOR EXP.</th>
          <th style="width: 80px;">MÉTODO</th>
          <th style="width: 90px;">LIMITE</th>
          <th>MOTIVO DA DESCONSIDERAÇÃO</th>
        </tr>
      </thead>
      <tbody>
        ${itens
          .flatMap((it) => {
            const exps = expurgadosPorItem[it.id] || []
            return exps.map((e) => {
              const precoNum = e.expand?.price_result_id?.unit_price
              const fonte = e.expand?.price_result_id?.source || 'Oficial'
              return `
              <tr>
                <td class="text-center font-mono font-bold">${String(it.sequence).padStart(2, '0')}</td>
                <td class="font-bold">${this.escapeXml(fonte)}</td>
                <td class="text-right font-mono" style="color: #dc2626;">
                  ${precoNum ? `R$ ${precoNum.toFixed(decimals)}` : 'NÃO INFORMADO'}
                </td>
                <td style="text-transform: uppercase;">${this.escapeXml(e.method || 'Percentual')}</td>
                <td class="font-mono">${this.escapeXml(e.threshold || '±30%')}</td>
                <td style="color: #475569;">${this.escapeXml(e.reason)}</td>
              </tr>
            `
            })
          })
          .join('')}
      </tbody>
    </table>
  </div>
  `
      : ''
  }

  <!-- 5. JUSTIFICATIVA TÉCNICA E OBSERVAÇÕES DO RESPONSÁVEL -->
  <div class="section-title" style="margin-top: 14px;">
    <span>5. JUSTIFICATIVA TÉCNICA E OBSERVAÇÕES DO RESPONSÁVEL</span>
    <span style="font-size: 8.5px; font-weight: normal;">Obrigatoriedade e motivação do ato administrativo</span>
  </div>
  <div class="info-card">
    <div style="font-size: 9.5px; color: #1e293b; white-space: pre-line; line-height: 1.45;">
      ${
        justificativaConclusao
          ? this.escapeXml(justificativaConclusao)
          : 'Orçamento estimativo concluído com base nos parâmetros definidos pelo órgão, metodologias estatísticas e juízo crítico conforme prescrições da Lei nº 14.133/2021.'
      }
    </div>
  </div>

  <!-- 6. RESUMO FINAL E DEMONSTRATIVO CONSOLIDADO POR ÓRGÃO/CIDADE -->
  <div class="section-title" style="margin-top: 14px;">
    <span>6. RESUMO FINAL CONSOLIDADO POR ÓRGÃO / CIDADE</span>
  </div>
  <div class="info-card">
    <table>
      <thead>
        <tr>
          <th style="width: 40px;" class="text-center">#</th>
          <th>ÓRGÃO / CIDADE DEMANDANTE</th>
          <th class="text-center" style="width: 70px;">ITENS</th>
          <th class="text-right" style="width: 110px;">SUBTOTAL ESTIMADO</th>
          <th class="text-right" style="width: 70px;">PARTICIPAÇÃO</th>
        </tr>
      </thead>
      <tbody>
        ${grupos
          .map((g, idx) => {
            const pct = valorTotalGeral > 0 ? (g.subtotal / valorTotalGeral) * 100 : 0
            return `
          <tr>
            <td class="text-center font-mono font-bold">${idx + 1}</td>
            <td><strong>${this.escapeXml(g.nome)}</strong></td>
            <td class="text-center font-mono">${g.itens.length} item(ns)</td>
            <td class="text-right font-mono font-bold" style="color: #124268;">
              R$ ${g.subtotal.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
            </td>
            <td class="text-right font-mono">${pct.toFixed(1)}%</td>
          </tr>`
          })
          .join('')}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3" class="text-right font-bold uppercase">VALOR GLOBAL CONSOLIDADO:</td>
          <td class="text-right font-mono font-bold" style="color: #047857;">
            R$ ${valorTotalGeral.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
          </td>
          <td class="text-right font-mono font-bold">100.0%</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Assinaturas Formais -->
  <div class="signatures-grid">
    <div class="sig-line">
      <div class="sig-name">${this.escapeXml(responsavelNome)}</div>
      <div class="sig-role">Responsável pela Pesquisa de Preços / Comissão de Contratação</div>
    </div>
    <div class="sig-line">
      <div class="sig-name">Autoridade Competente</div>
      <div class="sig-role">Ordenador de Despesas / Secretário Responsável</div>
    </div>
  </div>

  <!-- Rodapé Institucional -->
  <div class="audit-footer">
    <div>
      Documento gerado eletronicamente em <strong>${dataHoraEmissao}</strong> • Plataforma Cesta de Preços
    </div>
    <div class="font-mono">
      Hash de Auditoria: ${this.gerarHashAuditoria(budget.id, itens.length, valorTotalGeral)}
    </div>
  </div>

  <script>
    // Auto-impressão opcional após carregamento completo
    window.onload = function() {
      // Abre a caixa de diálogo de impressão nativa
      setTimeout(function() {
        window.print();
      }, 350);
    };
  </script>
</body>
</html>`

    const printWindow = window.open('', '_blank', 'width=1000,height=900')
    if (!printWindow) {
      alert(
        'O bloqueador de popups impediu a abertura da visualização do PDF. Por favor, permita popups para este site.',
      )
      return
    }

    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
  }

  /**
   * Faz o download direto de um arquivo HTML formatado como PDF autônomo impresso
   */
  public static baixarArquivoHtmlPdf(dados: DadosRelatorioOrcamentoPdf): void {
    // Gerar visualização e disparo via janela de impressão
    this.gerarPdfOrcamento(dados)
  }

  private static escapeXml(unsafe: string): string {
    if (!unsafe) return ''
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  private static gerarHashAuditoria(id: string, totalItens: number, totalValor: number): string {
    const raw = `${id}:${totalItens}:${totalValor.toFixed(2)}:${new Date().toISOString().slice(0, 10)}`
    let hash = 0
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash |= 0
    }
    const hex = Math.abs(hash).toString(16).toUpperCase().padStart(8, '0')
    return `SHA256-${hex.slice(0, 4)}-${hex.slice(4, 8)}`
  }
}
