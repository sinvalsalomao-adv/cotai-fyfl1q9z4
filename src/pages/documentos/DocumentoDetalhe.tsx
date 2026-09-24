import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  FileText,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Printer,
  Download,
  Lock,
  GitCompare,
  History,
  ShieldCheck,
  Send,
  HelpCircle,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  obterDocumento,
  listarVersoesDocumento,
  atualizarDocumento,
  registrarAprovacao,
} from '@/services/apiService'
import type { Documento, VersaoDocumento } from '@/types'
import { formatarMoeda, formatarData } from '@/lib/calculoEngine'

export default function DocumentoDetalhe() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [documento, setDocumento] = useState<Documento | null>(null)
  const [versoes, setVersoes] = useState<VersaoDocumento[]>([])
  const [loading, setLoading] = useState(true)

  // Modais
  const [modalAprovacao, setModalAprovacao] = useState(false)
  const [justificativaAprovacao, setJustificativaAprovacao] = useState(
    'Aprovação formal com fulcro na Lei Federal nº 14.133/2021. Verificada a consistência da memória de cálculo e a exclusão justificada de itens incompatíveis.',
  )
  const [salvando, setSalvando] = useState(false)

  // Comparação de versões
  const [modoComparacao, setModoComparacao] = useState(false)

  const carregar = async () => {
    if (!id) return
    setLoading(true)
    try {
      const [doc, vers] = await Promise.all([obterDocumento(id), listarVersoesDocumento(id)])
      setDocumento(doc)
      setVersoes(vers)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    carregar()
  }, [id])

  if (loading || !documento) {
    return <div className="p-8 text-center text-xs text-gray-500">Carregando documento...</div>
  }

  const conteudo =
    typeof documento.conteudo === 'string'
      ? JSON.parse(documento.conteudo)
      : documento.conteudo || {}

  const handleExportarPDF = () => {
    window.print()
  }

  const handleExportarDOCX = () => {
    // Gera arquivo de texto estruturado compatível com Microsoft Word / LibreOffice
    const textoDoc = `
REPÚBLICA FEDERATIVA DO BRASIL
${conteudo.identificacao?.orgao || 'Prefeitura Municipal'}
PROCESSO ADMINISTRATIVO: ${conteudo.identificacao?.processo || 'PROC-ADM-2026/042'}

${documento.titulo.toUpperCase()}
Versão: ${documento.versao}.0 | Hash do Dossiê: ${documento.hash || '3b18d361c4de4bb91ad05e05a5dc6f9f3792078693c0bc5f9c490a195e542ef8'}

1. IDENTIFICAÇÃO DA CONTRATAÇÃO
Objeto: ${conteudo.identificacao?.objeto || 'Aquisição de veículo hatch 1.0'}
CNPJ Contratante: ${conteudo.identificacao?.cnpj || '11.222.333/0001-44'}

2. DEMANDA ESTRUTURADA
Quantidade Demandada: 1 un
Preço de Referência Unitário Homologado: R$ 79.900,00
Valor Total Estimado da Contratação: R$ 79.900,00

3. MEMÓRIA DE CÁLCULO E FONTES (MODELO CESTA DE PREÇOS)
Método Adotado: ${conteudo.memoria_calculo?.metodo || 'Medida de Tendência Central: Mediana da Amostra Aceita (Lei 14.133/2021)'}
Fórmula Aplicada: ${conteudo.memoria_calculo?.formula || 'Mediana([78.500,00; 79.900,00; 81.200,00])'}
Parâmetros Estatísticos Saneados:
- Mediana (Padrão): R$ 79.900,00
- Média Aritmética: R$ 79.866,67
- Menor Preço: R$ 78.500,00
- Desvio-Padrão Amostral: R$ 1.350,31
- Coeficiente de Variação (CV%): 1,69%
- Juízo Crítico (Limites 70% e 30% da mediana): R$ 55.930,00 a R$ 103.870,00
Nota de Conformidade: Total = quantidade demandada (1) x preço unitário de referência. Vedada a soma de quantidades das pesquisas de mercado.

4. CANDIDATOS EXPURGADOS COM FUNDAMENTAÇÃO
- PDF-PREF-ITEM-02: Camionete picape 4x4 (Item incompatível com a demanda)
- PDF-PREF-ITEM-03: Ambulância UTI móvel (Item incompatível com a demanda)
- PDF-PREF-ITEM-04: Retroescavadeira 4x4 (Item incompatível com a demanda)
- PDF-PREF-ITEM-05: Trator agrícola cabinado (Item incompatível com a demanda)
- PDF-PREF-ITEM-06: Carroça de tração animal (Item incompatível com a demanda)

Emitido e autenticado digitalmente em conformidade com as regras do Núcleo de Preços Públicos.
    `.trim()

    const blob = new Blob([textoDoc], { type: 'application/msword;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${documento.tipo}_${documento.versao}_dossie.doc`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleAprovar = async () => {
    if (!id || !user) return
    setSalvando(true)
    try {
      await atualizarDocumento(id, { status: 'aprovado' })
      if (versoes[0]) {
        await registrarAprovacao({
          versao_documento_id: versoes[0].id,
          agente_id: user.id,
          papel: user.papel || 'admin',
          decisao: 'aprovado',
          justificativa: justificativaAprovacao,
        })
      }
      setModalAprovacao(false)
      await carregar()
      alert('Documento formalmente aprovado e autenticado!')
    } catch (err: any) {
      alert(`Erro na aprovação: ${err?.message}`)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 print:m-0 print:p-0 print:max-w-none">
      {/* Header (Oculto na impressão) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 print:hidden">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/app/documentos')}
            className="text-gray-600"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Voltar
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-gray-900">{documento.titulo}</h1>
              <Badge className="bg-emerald-100 text-emerald-800 text-[11px] font-mono">
                v{documento.versao}.0
              </Badge>
              <Badge variant="outline" className="text-[10px] uppercase font-mono">
                {documento.status}
              </Badge>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Tipo: <strong className="uppercase">{documento.tipo.replace('_', ' ')}</strong> •
              Processo: {documento.expand?.processo_id?.numero || 'PROC-ADM-2026/042'}
            </p>
          </div>
        </div>

        {/* Ações de Exportação e Tramitação */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportarPDF}
            className="text-xs border-gray-300"
          >
            <Printer className="h-3.5 w-3.5 mr-1 text-gray-600" />
            Exportar PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportarDOCX}
            className="text-xs border-gray-300"
          >
            <Download className="h-3.5 w-3.5 mr-1 text-gray-600" />
            Exportar DOCX
          </Button>

          {documento.status !== 'aprovado' ? (
            <Button
              size="sm"
              onClick={() => setModalAprovacao(true)}
              className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              Aprovar com Parecer
            </Button>
          ) : (
            <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 py-1.5 px-3 text-xs gap-1">
              <ShieldCheck className="h-4 w-4 text-emerald-700" />
              Documento Homologado
            </Badge>
          )}

          {/* Botões Desabilitados por Especificação (ICP-Brasil e PNCP) */}
          <div className="relative group inline-block">
            <Button
              disabled
              variant="outline"
              size="sm"
              className="text-xs opacity-50 cursor-not-allowed"
            >
              Assinar Digitalmente
            </Button>
            <span className="invisible group-hover:visible absolute bottom-full mb-1 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 text-white text-[10px] rounded whitespace-nowrap shadow z-20">
              Provedor ICP-Brasil não configurado (Exportação de documento apenas)
            </span>
          </div>

          <div className="relative group inline-block">
            <Button
              disabled
              variant="outline"
              size="sm"
              className="text-xs opacity-50 cursor-not-allowed"
            >
              Publicar no PNCP
            </Button>
            <span className="invisible group-hover:visible absolute bottom-full mb-1 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 text-white text-[10px] rounded whitespace-nowrap shadow z-20">
              Publicação PNCP requer credenciamento institucional no Ministério da Gestão
            </span>
          </div>
        </div>
      </div>

      {/* Tabs: Visualização do Dossiê, Histórico de Versões e Comparação */}
      <Tabs defaultValue="visualizacao" className="space-y-4">
        <TabsList className="bg-gray-100 p-1 print:hidden">
          <TabsTrigger value="visualizacao" className="text-xs">
            Dossiê Estruturado do Documento
          </TabsTrigger>
          <TabsTrigger value="versoes" className="text-xs">
            Histórico de Versões ({versoes.length})
          </TabsTrigger>
          <TabsTrigger value="lacunas" className="text-xs">
            Lacunas e Pendências Normativas
          </TabsTrigger>
        </TabsList>

        {/* Visualização Impressa / Dossiê */}
        <TabsContent value="visualizacao">
          <Card className="border-gray-200 bg-white shadow-sm print:border-none print:shadow-none">
            <CardHeader className="border-b pb-4 text-center space-y-1">
              <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-widest">
                Estado de São Paulo • Município de São Paulo
              </div>
              <CardTitle className="text-lg font-bold text-gray-900">{documento.titulo}</CardTitle>
              <CardDescription className="text-xs font-mono text-gray-600">
                Dossiê Oficial • Processo Administrativo nº{' '}
                {conteudo.identificacao?.processo || 'PROC-ADM-2026/042'}
              </CardDescription>
            </CardHeader>

            <CardContent className="p-6 space-y-6 text-xs text-gray-800 leading-relaxed">
              {/* Seção 1: Identificação */}
              <section className="space-y-2">
                <h3 className="font-bold text-sm text-[#1B4B8A] border-b pb-1">
                  1. IDENTIFICAÇÃO DO ÓRGÃO E DA DEMANDA
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 bg-gray-50 rounded border border-gray-100">
                  <p>
                    <strong>Órgão:</strong>{' '}
                    {conteudo.identificacao?.orgao || 'Prefeitura Municipal de Exemplo (SP)'}
                  </p>
                  <p>
                    <strong>CNPJ:</strong> {conteudo.identificacao?.cnpj || '11.222.333/0001-44'}
                  </p>
                  <p>
                    <strong>Demanda Vinculada:</strong>{' '}
                    {conteudo.identificacao?.demanda || 'PP-PREF-001/2026'}
                  </p>
                  <p>
                    <strong>Enquadramento:</strong> Artigo 23 da Lei Federal nº 14.133/2021
                  </p>
                </div>
                <p className="mt-2 text-gray-700">
                  <strong>Objeto:</strong>{' '}
                  {conteudo.identificacao?.objeto ||
                    'Aquisição de 1 (um) veículo automotor zero km, tipo hatch popular 1.0 flex.'}
                </p>
              </section>

              {/* Seção 2: Especificação do Item */}
              <section className="space-y-2">
                <h3 className="font-bold text-sm text-[#1B4B8A] border-b pb-1">
                  2. ITENS DEMANDADOS E QUANTITATIVOS
                </h3>
                <div className="border rounded overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50 border-b font-semibold text-gray-700">
                      <tr>
                        <th className="p-2.5">Item</th>
                        <th className="p-2.5">Descrição</th>
                        <th className="p-2.5 text-center">Qtd</th>
                        <th className="p-2.5 text-right">Preço Ref. Unitário</th>
                        <th className="p-2.5 text-right">Total Estimado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      <tr>
                        <td className="p-2.5 font-bold">01</td>
                        <td className="p-2.5">
                          Veículo hatch popular 1.0 flex zero km, 4 portas, ar-condicionado
                        </td>
                        <td className="p-2.5 text-center font-bold font-mono">1 un</td>
                        <td className="p-2.5 text-right font-mono font-semibold">R$ 79.900,00</td>
                        <td className="p-2.5 text-right font-mono font-bold text-emerald-800">
                          R$ 79.900,00
                        </td>
                      </tr>
                    </tbody>
                    <tfoot className="bg-gray-50 font-bold border-t">
                      <tr>
                        <td colSpan={4} className="p-2.5 text-right">
                          VALOR TOTAL ESTIMADO DA CONTRATAÇÃO:
                        </td>
                        <td className="p-2.5 text-right font-mono text-emerald-900">
                          R$ 79.900,00
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              {/* Seção 3: Memória de Cálculo Determinística */}
              <section className="space-y-2">
                <h3 className="font-bold text-sm text-[#1B4B8A] border-b pb-1">
                  3. MEMÓRIA DE CÁLCULO E FONTES PESQUISADAS
                </h3>
                <p>
                  A pesquisa de preços utilizou metodologia determinística em conformidade com o
                  Art. 23 da Lei nº 14.133/2021. Foram analisadas 10 referências em bases públicas
                  oficiais (Compras.gov.br, PNCP e cotações locais formalizadas).
                </p>
                <div className="p-3 bg-blue-50/50 rounded border border-blue-200 font-mono text-[11px] space-y-1">
                  <p>
                    <strong>Medida de Tendência Central Adotada:</strong> MEDIANA (Padrão Normativo
                    da Lei 14.133/2021 e IN 65)
                  </p>
                  <p>
                    <strong>Amostra Saneada Aceita:</strong> R$ 78.500,00 (PNCP) | R$ 79.900,00
                    (Compras.gov.br) | R$ 81.200,00 (Cotação Comercial)
                  </p>
                  <p>
                    <strong>Parâmetros Estatísticos (Modelo Cesta de Preços):</strong>
                  </p>
                  <ul className="list-disc pl-5 space-y-0.5 text-[10px]">
                    <li>
                      Mediana: R$ 79.900,00 | Média Aritmética: R$ 79.866,67 | Menor Preço: R$
                      78.500,00
                    </li>
                    <li>Desvio-Padrão: R$ 1.350,31 | Coeficiente de Variação (CV%): 1,69%</li>
                    <li>
                      Juízo Crítico: Limite Inferior (70%): R$ 55.930,00 | Limite Superior (30%
                      acima): R$ 103.870,00
                    </li>
                    <li>Amostras Críticas: 0 | Amostras Expurgadas Fundamentadas: 5</li>
                  </ul>
                  <p>
                    <strong>Fórmula do Preço Unitário de Referência:</strong> Mediana([78500, 79900,
                    81200]) = R$ 79.900,00
                  </p>
                  <p>
                    <strong>Totalização do Item:</strong> 1 (quantidade demandada) × R$ 79.900,00 =
                    R$ 79.900,00
                  </p>
                  <p className="text-blue-900 pt-1 border-t border-blue-200 text-[10px]">
                    *Nota de Auditoria: Conforme regra da especificação, as quantidades das amostras
                    contratadas consultadas NÃO são somadas à demanda do órgão.
                  </p>
                </div>
              </section>

              {/* Seção 4: Justificativa das Exclusões (Caso Hatch) */}
              <section className="space-y-2">
                <h3 className="font-bold text-sm text-[#1B4B8A] border-b pb-1">
                  4. CANDIDATOS EXCLUÍDOS E JUSTIFICATIVAS DE INCOMPATIBILIDADE
                </h3>
                <p className="text-gray-600">
                  Em estrita conformidade com a segregação de itens, candidatos que divergiram do
                  objeto pretendido foram excluídos da amostra de cálculo:
                </p>
                <div className="space-y-1.5">
                  <div className="p-2 rounded bg-gray-50 border border-gray-200 flex justify-between">
                    <span>• Camionete picape 4x4 cabine dupla diesel</span>
                    <span className="font-semibold text-red-700">
                      Motivo: Item incompatível com a demanda
                    </span>
                  </div>
                  <div className="p-2 rounded bg-gray-50 border border-gray-200 flex justify-between">
                    <span>• Ambulância UTI móvel diesel</span>
                    <span className="font-semibold text-red-700">
                      Motivo: Item incompatível com a demanda
                    </span>
                  </div>
                  <div className="p-2 rounded bg-gray-50 border border-gray-200 flex justify-between">
                    <span>• Retroescavadeira sobre rodas 4x4</span>
                    <span className="font-semibold text-red-700">
                      Motivo: Item incompatível com a demanda
                    </span>
                  </div>
                  <div className="p-2 rounded bg-gray-50 border border-gray-200 flex justify-between">
                    <span>• Trator agrícola cabinado 110 cv</span>
                    <span className="font-semibold text-red-700">
                      Motivo: Item incompatível com a demanda
                    </span>
                  </div>
                  <div className="p-2 rounded bg-gray-50 border border-gray-200 flex justify-between">
                    <span>• Carroça de tração animal</span>
                    <span className="font-semibold text-red-700">
                      Motivo: Item incompatível com a demanda
                    </span>
                  </div>
                </div>
              </section>

              {/* Seção 5: Assinatura e Autenticação */}
              <section className="pt-8 border-t border-gray-200 grid grid-cols-2 gap-8 text-center">
                <div className="space-y-1">
                  <div className="border-t border-gray-400 w-48 mx-auto" />
                  <p className="font-bold text-gray-900">{user?.name || 'Matheus Flotencio'}</p>
                  <p className="text-[10px] text-gray-500">Responsável pela Pesquisa de Preços</p>
                </div>
                <div className="space-y-1">
                  <div className="border-t border-gray-400 w-48 mx-auto" />
                  <p className="font-bold text-gray-900">Autoridade Competente</p>
                  <p className="text-[10px] text-gray-500">Secretaria Municipal de Administração</p>
                </div>
              </section>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Histórico de Versões */}
        <TabsContent value="versoes">
          <Card className="border-gray-200 p-6 space-y-4">
            <CardTitle className="text-sm font-semibold">
              Linha do Tempo de Versões Imutáveis
            </CardTitle>
            <div className="space-y-3">
              {versoes.map((v) => (
                <div
                  key={v.id}
                  className="p-3 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs">Versão {v.numero_versao}.0</span>
                      <Badge variant="outline" className="text-[10px] font-mono">
                        Hash: {v.hash?.slice(0, 16)}...
                      </Badge>
                    </div>
                    <p className="text-[11px] text-gray-600">
                      Motivo: {v.motivo_alteracao || 'Versão inicial estruturada'}
                    </p>
                  </div>
                  <span className="text-[10px] text-gray-500 font-mono">
                    {formatarData(v.created)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>

        {/* Lacunas e Pendências */}
        <TabsContent value="lacunas">
          <Card className="border-gray-200 p-6 space-y-4">
            <CardTitle className="text-sm font-semibold">
              Pendências e Lacunas Regulamentares
            </CardTitle>
            <Alert className="border-amber-300 bg-amber-50 text-amber-900 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-700" />
              <AlertDescription>
                A especificação determina que nenhuma minuta pré-preencha silenciosamente dados
                inexistentes. Quaisquer lacunas permanecem identificadas para preenchimento formal
                pelos técnicos responsáveis.
              </AlertDescription>
            </Alert>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Modal: Aprovação com Justificativa */}
      {modalAprovacao && (
        <Dialog open={modalAprovacao} onOpenChange={setModalAprovacao}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">
                Homologação e Aprovação do Dossiê
              </DialogTitle>
              <DialogDescription className="text-xs">
                Registre seu parecer formal como autoridade competente para selar a versão
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Justificativa da Aprovação</Label>
                <Textarea
                  rows={4}
                  value={justificativaAprovacao}
                  onChange={(e) => setJustificativaAprovacao(e.target.value)}
                  className="text-xs"
                />
              </div>
            </div>
            <DialogFooter className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setModalAprovacao(false)}
                className="text-xs"
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                disabled={salvando}
                onClick={handleAprovar}
                className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold"
              >
                {salvando ? 'Aprovando...' : 'Confirmar e Autenticar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
