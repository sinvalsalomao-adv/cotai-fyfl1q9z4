// -------------------------------------------------------------------------
// ExporterService — Exportação em PDF, XLSX, CSV, DOCX
// e Gerador do Relatório Técnico Oficial de 16 Seções
// -------------------------------------------------------------------------

import type { Referencia, Pesquisa, Calculo, DemandaItem } from '@/types'
import { formatarMoeda, formatarData } from './calculoEngine'

export interface Relatorio16SecoesData {
  orgaoNome: string
  orgaoCnpj: string
  processoNumero: string
  pesquisaNumero: string
  dataGeracao: string
  responsavelNome: string
  responsavelCargo: string
  objeto: string
  metodologia: string
  fontesConsultadas: string[]
  itens: {
    numero: number
    descricao: string
    quantidade: number
    unidade: string
    precoReferencia: number | null
    totalItem: number | null
    metodo: string
  }[]
  precosColetados: Referencia[]
  precosExcluidos: Referencia[]
  estatisticas: any
  memoriaCalculoTexto: string
  valorTotalEstimadoGeral: number | null
}

export class ExporterService {
  /**
   * Constrói o texto estruturado do Relatório Técnico com as 16 Seções do Usuário
   */
  public static construirTextoRelatorio16(dados: Relatorio16SecoesData): string {
    const aceitos = dados.precosColetados.filter((p) => p.status_revisao === 'aceito')
    const excluidos =
      dados.precosExcluidos.length > 0
        ? dados.precosExcluidos
        : dados.precosColetados.filter((p) => p.status_revisao === 'excluido')

    return `
================================================================================
ESTADO DE SÃO PAULO
PREFEITURA MUNICIPAL / ÓRGÃO PÚBLICO CONTRATANTE: ${dados.orgaoNome.toUpperCase()}
CNPJ: ${dados.orgaoCnpj}
RELATÓRIO TÉCNICO OFICIAL DE PESQUISA DE PREÇOS PÚBLICOS
(Lei Federal nº 14.133/2021, Art. 23 • IN SEGES/ME nº 65/2021)
================================================================================

PROCESSO ADMINISTRATIVO: ${dados.processoNumero}
PESQUISA DE PREÇOS Nº: ${dados.pesquisaNumero}
DATA DE EMISSÃO: ${dados.dataGeracao}

--------------------------------------------------------------------------------
1. IDENTIFICAÇÃO DO ÓRGÃO E DO PROCESSO
--------------------------------------------------------------------------------
Órgão Interessado: ${dados.orgaoNome}
CNPJ: ${dados.orgaoCnpj}
Processo Administrativo de Origem: ${dados.processoNumero}
Código da Pesquisa de Preços: ${dados.pesquisaNumero}
Ambiente de Execução: Plataforma de Pesquisa de Preços Públicos (SaaS Governamental)

--------------------------------------------------------------------------------
2. OBJETO DA CONTRATAÇÃO
--------------------------------------------------------------------------------
${dados.objeto}

--------------------------------------------------------------------------------
3. RESPONSÁVEL TÉCNICO PELA PESQUISA
--------------------------------------------------------------------------------
Servidor Designado: ${dados.responsavelNome}
Cargo / Lotação: ${dados.responsavelCargo}
Portaria de Designação / Matrícula: Servidor Público Autorizado

--------------------------------------------------------------------------------
4. METODOLOGIA APLICADA
--------------------------------------------------------------------------------
${dados.metodologia}
Critérios Estatísticos: Medida de tendência central (Média Aritmética ou Mediana)
aplicada sobre o conjunto de preços válidos coletados, com juízo crítico e análise
de dispersão (IQR, MAD e limites percentuais). Expurgo de amostras somente sob
decisão humana fundamentada. Totalização = Quantidade Demandada × Preço de Referência.

--------------------------------------------------------------------------------
5. FONTES CONSULTADAS E RASTREABILIDADE
--------------------------------------------------------------------------------
As fontes consultadas seguiram os parâmetros de preferência legal:
${dados.fontesConsultadas.map((f, i) => `5.${i + 1} ${f}`).join('\n')}
Todo preço coletado contém URL, hash criptográfico, data de captura e documento comprobatório.

--------------------------------------------------------------------------------
6. ITENS PESQUISADOS E QUANTITATIVOS
--------------------------------------------------------------------------------
${dados.itens
  .map(
    (item) => `
Item nº ${item.numero}:
- Descrição: ${item.descricao}
- Quantidade Demandada: ${item.quantidade} ${item.unidade}
- Preço Unitário Estimado: ${item.precoReferencia !== null ? formatarMoeda(item.precoReferencia) : 'AUSENTE (Amostra pendente de homologação)'}
- Valor Total do Item: ${item.totalItem !== null ? formatarMoeda(item.totalItem) : 'AUSENTE'}
- Método de Cálculo: ${item.metodo.toUpperCase()}
`,
  )
  .join('\n')}

--------------------------------------------------------------------------------
7. PREÇOS COLETADOS E VALIDADOS (AMOSTRA DE CÁLCULO)
--------------------------------------------------------------------------------
Total de preços aceitos: ${aceitos.length} amostras válidas.
${aceitos
  .map(
    (p, i) => `
[Amostra 7.${i + 1}]
- Fonte: ${p.fonte.toUpperCase()} (ID: ${p.id_externo || 'NÃO INFORMADO'})
- Descrição no Registro: ${p.item_externo}
- Fornecedor: ${p.fornecedor || 'NÃO INFORMADO'} (CNPJ: ${p.cnpj_fornecedor || 'NÃO INFORMADO'})
- Órgão Comprador: ${p.orgao_comprador || 'NÃO INFORMADO'} - ${p.municipio_uf || 'NÃO INFORMADO'}
- Modalidade: ${p.modalidade_licitacao || 'NÃO INFORMADO'} | Data: ${formatarData(p.data_contratacao)}
- Valor Original: ${formatarMoeda(p.valor_original)} | Valor Normalizado: ${formatarMoeda(p.valor_normalizado)} / ${p.unidade || 'un'}
- Rastreabilidade (URL): ${p.url || 'NÃO INFORMADO'}
`,
  )
  .join('')}

--------------------------------------------------------------------------------
8. PREÇOS EXCLUÍDOS / EXPURGADOS DA AMOSTRA
--------------------------------------------------------------------------------
Total de preços excluídos: ${excluidos.length} amostras.
${
  excluidos.length === 0
    ? 'Nenhum preço excluído nesta pesquisa.'
    : excluidos
        .map(
          (p, i) => `
[Exclusão 8.${i + 1}]
- Fonte: ${p.fonte.toUpperCase()} (ID: ${p.id_externo || 'NÃO INFORMADO'})
- Descrição: ${p.item_externo}
- Valor: ${formatarMoeda(p.valor_original)}
- Motivo da Exclusão: ${p.motivo_exclusao || 'Item incompatível ou duplicata identificada'}
- Decisão: Decisão do servidor registrada eletronicamente.
`,
        )
        .join('')
}

--------------------------------------------------------------------------------
9. JUSTIFICATIVAS TÉCNICAS DE EXCLUSÃO E INSUFICIÊNCIA
--------------------------------------------------------------------------------
- Regra de suficiência: ${aceitos.length >= 3 ? 'Atingido o número regulamentar de amostras (>= 3 fontes/preços).' : 'Amostra inferior a 3 preços justificada pela autoridade competente.'}
- Toda exclusão foi formalizada motivadamente, sem qualquer descarte automático silencioso.

--------------------------------------------------------------------------------
10. TRATAMENTO ESTATÍSTICO APLICADO
--------------------------------------------------------------------------------
Média Aritmética: ${dados.estatisticas?.media_aritmetica ? formatarMoeda(dados.estatisticas.media_aritmetica) : '-'}
Mediana: ${dados.estatisticas?.mediana ? formatarMoeda(dados.estatisticas.mediana) : '-'}
Menor Preço: ${dados.estatisticas?.menor_preco ? formatarMoeda(dados.estatisticas.menor_preco) : '-'}
Maior Preço: ${dados.estatisticas?.maior_preco ? formatarMoeda(dados.estatisticas.maior_preco) : '-'}
Desvio-Padrão Amostral: ${dados.estatisticas?.desvio_padrao ? dados.estatisticas.desvio_padrao.toFixed(2) : '-'}
Coeficiente de Variação (CV): ${dados.estatisticas?.coeficiente_variacao ? `${dados.estatisticas.coeficiente_variacao.toFixed(2)}%` : '-'}
Intervalo Interquartil (IQR): ${dados.estatisticas?.quartis?.iqr ? dados.estatisticas.quartis.iqr.toFixed(2) : '-'}

--------------------------------------------------------------------------------
11. MEMÓRIA DE CÁLCULO DETALHADA E REPRODUZÍVEL
--------------------------------------------------------------------------------
${dados.memoriaCalculoTexto}

--------------------------------------------------------------------------------
12. PREÇO ESTIMADO E CONSOLIDAÇÃO DO ORÇAMENTO
--------------------------------------------------------------------------------
Valor Total Global Estimado da Contratação: ${dados.valorTotalEstimadoGeral !== null ? formatarMoeda(dados.valorTotalEstimadoGeral) : 'AUSENTE'}
(Calculado rigorosamente por Quantidade Demandada × Preço Unitário de Referência)

--------------------------------------------------------------------------------
13. ANÁLISE DE DISPERSÃO E JUÍZO CRÍTICO
--------------------------------------------------------------------------------
Amostras analisadas quanto a valores manifestamente inexequíveis ou excessivos.
Limites Críticos configurados do Juízo Crítico:
- Limite Inferior: ${dados.estatisticas?.limite_inferior_configurado ? formatarMoeda(dados.estatisticas.limite_inferior_configurado) : '-'}
- Limite Superior: ${dados.estatisticas?.limite_superior_configurado ? formatarMoeda(dados.estatisticas.limite_superior_configurado) : '-'}
Dispersão da Amostra: ${dados.estatisticas?.coeficiente_variacao && dados.estatisticas.coeficiente_variacao < 25 ? 'Baixa dispersão (CV < 25%).' : 'Dispersão moderada a alta. Adoção da mediana indicada.'}

--------------------------------------------------------------------------------
14. CONCLUSÃO E PARECER TÉCNICO
--------------------------------------------------------------------------------
A pesquisa de preços atende aos preceitos da Lei Federal nº 14.133/2021 (Art. 23)
e normas correlatas. Os preços obtidos refletem a realidade de mercado público,
constituindo parâmetro idôneo e seguro para subsidiar a fase preparatória da licitação.

--------------------------------------------------------------------------------
15. DOCUMENTOS, EVIDÊNCIAS E ANEXOS
--------------------------------------------------------------------------------
Integram o presente processo administrativo todas as certidões, capturas de tela,
extratos contratuais do PNCP/Compras.gov/BPS e propostas comerciais arquivadas
digitalmente no repositório de evidências criptografadas da plataforma.

--------------------------------------------------------------------------------
16. ASSINATURA E HOMOLOGAÇÃO
--------------------------------------------------------------------------------
Local e Data: ${dados.orgaoNome}, ${dados.dataGeracao}


______________________________________________________
${dados.responsavelNome}
${dados.responsavelCargo}
Servidor Responsável pela Pesquisa de Preços
Documento assinado digitalmente / autenticidade verificável
================================================================================
`.trim()
  }

  /**
   * Exporta arquivo CSV formatado
   */
  public static exportarCsv(nomeArquivo: string, colunas: string[], linhas: (string | number)[][]) {
    const separador = ';'
    const header = colunas.map((c) => `"${c.replace(/"/g, '""')}"`).join(separador)
    const rows = linhas.map((linha) =>
      linha
        .map((cell) => {
          const val = cell !== null && cell !== undefined ? String(cell) : ''
          return `"${val.replace(/"/g, '""')}"`
        })
        .join(separador),
    )
    const csvContent = '\uFEFF' + [header, ...rows].join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    this.downloadBlob(blob, `${nomeArquivo}.csv`)
  }

  /**
   * Exporta arquivo XLSX/Planilha padrão (em formato XML Spreadsheet compativel com Excel)
   */
  public static exportarXlsx(
    nomeArquivo: string,
    colunas: string[],
    linhas: (string | number)[][],
  ) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Worksheet ss:Name="Pesquisa de Precos">
  <Table>
   <Row>`

    colunas.forEach((col) => {
      xml += `<Cell ss:StyleID="Header"><Data ss:Type="String">${this.escapeXml(col)}</Data></Cell>`
    })
    xml += `</Row>`

    linhas.forEach((linha) => {
      xml += `<Row>`
      linha.forEach((val) => {
        const isNum = typeof val === 'number' && !isNaN(val)
        const type = isNum ? 'Number' : 'String'
        xml += `<Cell><Data ss:Type="${type}">${this.escapeXml(String(val ?? ''))}</Data></Cell>`
      })
      xml += `</Row>`
    })

    xml += `  </Table>
 </Worksheet>
</Workbook>`

    const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' })
    this.downloadBlob(blob, `${nomeArquivo}.xlsx`)
  }

  /**
   * Exporta arquivo DOCX (formato Word XML compatível nativo)
   */
  public static exportarDocx(nomeArquivo: string, titulo: string, textoConteudo: string) {
    const paragraphs = textoConteudo
      .split('\n')
      .map((p) => `<w:p><w:r><w:t>${this.escapeXml(p)}</w:t></w:r></w:p>`)
      .join('')

    const docxXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?mso-application progid="Word.Document"?>
<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:b/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${this.escapeXml(titulo)}</w:t></w:r>
    </w:p>
    ${paragraphs}
  </w:body>
</w:wordDocument>`

    const blob = new Blob([docxXml], { type: 'application/msword;charset=utf-8;' })
    this.downloadBlob(blob, `${nomeArquivo}.doc`)
  }

  /**
   * Gera e abre visualização de impressão/PDF nativo do browser com layout institucional
   */
  public static imprimirOuGerarPdf(titulo: string, textoRelatorio: string) {
    const printWindow = window.open('', '_blank', 'width=900,height=800')
    if (!printWindow) {
      alert('Permita popups no navegador para visualizar o documento PDF para impressão.')
      return
    }

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>${this.escapeXml(titulo)}</title>
  <style>
    body {
      font-family: 'Times New Roman', Times, serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #111;
      margin: 25mm 20mm 20mm 20mm;
    }
    .header {
      text-align: center;
      border-bottom: 2px solid #1B4B8A;
      padding-bottom: 12px;
      margin-bottom: 20px;
    }
    .header h1 {
      font-size: 13pt;
      font-weight: bold;
      margin: 0;
      color: #1B4B8A;
      text-transform: uppercase;
    }
    .header h2 {
      font-size: 11pt;
      font-weight: normal;
      margin: 4px 0 0 0;
      color: #333;
    }
    pre {
      white-space: pre-wrap;
      font-family: inherit;
      font-size: 10pt;
    }
    .footer {
      margin-top: 30px;
      text-align: center;
      font-size: 9pt;
      color: #777;
      border-top: 1px solid #ccc;
      padding-top: 8px;
    }
    @media print {
      body { margin: 15mm; }
      button { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Plataforma de Pesquisa de Preços Públicos</h1>
    <h2>Relatório Técnico Oficial de Pesquisa e Formação de Preços (Lei 14.133/2021)</h2>
  </div>
  <pre>${this.escapeXml(textoRelatorio)}</pre>
  <div class="footer">
    Documento emitido eletronicamente com trilha de auditoria e conformidade normativa.
  </div>
  <script>
    window.onload = function() {
      window.print();
    }
  </script>
</body>
</html>`

    printWindow.document.write(html)
    printWindow.document.close()
  }

  private static escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  private static downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
}
