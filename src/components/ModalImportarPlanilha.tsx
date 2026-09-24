import React, { useState } from 'react'
import {
  X,
  FileSpreadsheet,
  Download,
  Upload,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Edit2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

export interface ItemPlanilhaValidado {
  linha: number
  item: number
  descricao: string
  unidade: string
  quantidade: number
  marca: string
  tipo: 'PRODUTO' | 'SERVICO'
  valido: boolean
  erro?: string
}

interface ModalImportarPlanilhaProps {
  budgetId: string
  isOpen: boolean
  onClose: () => void
  onImportSuccess: (
    itens: Array<{
      description: string
      unit: string
      quantity: number
      brand?: string
      type: 'PRODUTO' | 'SERVICO'
    }>,
  ) => Promise<void>
}

export const ModalImportarPlanilha: React.FC<ModalImportarPlanilhaProps> = ({
  budgetId,
  isOpen,
  onClose,
  onImportSuccess,
}) => {
  const [itens, setItens] = useState<ItemPlanilhaValidado[]>([])
  const [arquivoNome, setArquivoNome] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [itemEmEdicao, setItemEmEdicao] = useState<ItemPlanilhaValidado | null>(null)

  if (!isOpen) return null

  // Modelo padrão CSV para download
  const handleBaixarModelo = () => {
    const csvContent =
      'ITEM;DESCRICAO;UNIDADE DE MEDIDA;QUANTIDADE;MARCA;TIPO\n' +
      '1;DIPIRONA SODICA 500MG COMPRIMIDO;CX;1000;Genérico;PRODUTO\n' +
      '2;PARACETAMOL 750MG COMPRIMIDO;CX;1500;Cimed;PRODUTO\n' +
      '3;AMOXICILINA 500MG CAPSULA;CX;800;EMS;PRODUTO\n' +
      '4;SERVICO DE MANUTENCAO PREVENTIVA DE AR-CONDICIONADO;SERV;12;Nao se aplica;SERVICO\n'

    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', 'modelo_importacao_orcamento.csv')
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Leitura do arquivo selecionado (.csv ou .xlsx simulado via texto/parser)
  const handleArquivoSelecionado = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setArquivoNome(file.name)
    const reader = new FileReader()

    reader.onload = (event) => {
      const text = event.target?.result as string
      if (!text) return

      processarConteudoCsv(text)
    }

    reader.readAsText(file, 'UTF-8')
  }

  // Parser robusto de CSV/Planilha
  const processarConteudoCsv = (conteudo: string) => {
    const linhas = conteudo.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (linhas.length <= 1) {
      alert('Arquivo vazio ou contém apenas o cabeçalho.')
      return
    }

    const resultado: ItemPlanilhaValidado[] = []

    for (let i = 1; i < linhas.length; i++) {
      const linhaNum = i + 1
      const linhaTexto = linhas[i].trim()
      // Detectar separador (; ou , ou tab)
      const separador = linhaTexto.includes(';') ? ';' : linhaTexto.includes('\t') ? '\t' : ','
      const colunas = linhaTexto.split(separador).map((c) => c.trim().replace(/^"|"$/g, ''))

      const itemNum = parseInt(colunas[0], 10) || i
      const descricao = colunas[1] || ''
      const unidade = (colunas[2] || '').toUpperCase()
      const quantidadeTexto = colunas[3] || ''
      const marca = colunas[4] || ''
      const tipoRaw = (colunas[5] || 'PRODUTO').toUpperCase()
      const tipo: 'PRODUTO' | 'SERVICO' = tipoRaw.includes('SERV') ? 'SERVICO' : 'PRODUTO'

      // Validação das regras da especificação
      let erro: string | undefined = undefined
      let quantidade = parseFloat(quantidadeTexto.replace(',', '.'))

      if (!descricao || descricao.trim().length < 3) {
        erro = `Linha ${linhaNum}: Descrição do item obrigatória (mínimo 3 caracteres).`
      } else if (!unidade) {
        erro = `Linha ${linhaNum}: Unidade de medida obrigatória.`
      } else if (isNaN(quantidade) || quantidade <= 0) {
        erro = `Linha ${linhaNum}: Quantidade inválida ("${quantidadeTexto}").`
        quantidade = 0
      }

      resultado.push({
        linha: linhaNum,
        item: itemNum,
        descricao,
        unidade,
        quantidade,
        marca,
        tipo,
        valido: !erro,
        erro,
      })
    }

    setItens(resultado)
  }

  // Preencher itens demonstrativos rápidos caso o usuário queira testar sem arquivo
  const handleCarregarExemplo = () => {
    const demoCsv =
      'ITEM;DESCRICAO;UNIDADE DE MEDIDA;QUANTIDADE;MARCA;TIPO\n' +
      '1;DIPIRONA SODICA 500MG COMPRIMIDO;CX;1000;Genérico;PRODUTO\n' +
      '2;PARACETAMOL 750MG COMPRIMIDO;CX;1500;Cimed;PRODUTO\n' +
      '3;AMOXICILINA 500MG CAPSULA;CX;800;EMS;PRODUTO\n'

    setArquivoNome('exemplo_medicamentos.csv')
    processarConteudoCsv(demoCsv)
  }

  const handleSalvarEdicao = (itemAtualizado: ItemPlanilhaValidado) => {
    let erro: string | undefined = undefined
    if (!itemAtualizado.descricao || itemAtualizado.descricao.trim().length < 3) {
      erro = `Linha ${itemAtualizado.linha}: Descrição obrigatória.`
    } else if (!itemAtualizado.unidade) {
      erro = `Linha ${itemAtualizado.linha}: Unidade obrigatória.`
    } else if (!itemAtualizado.quantidade || itemAtualizado.quantidade <= 0) {
      erro = `Linha ${itemAtualizado.linha}: Quantidade inválida.`
    }

    const corrigido = {
      ...itemAtualizado,
      valido: !erro,
      erro,
    }

    setItens((prev) => prev.map((it) => (it.linha === itemAtualizado.linha ? corrigido : it)))
    setItemEmEdicao(null)
  }

  const handleRemoverLinha = (linhaNum: number) => {
    setItens((prev) => prev.filter((it) => it.linha !== linhaNum))
  }

  const handleImportarFinal = async () => {
    const invalidos = itens.filter((i) => !i.valido)
    if (invalidos.length > 0) {
      alert(`Corrija os ${invalidos.length} erro(s) antes de importar.`)
      return
    }

    if (itens.length === 0) {
      alert('Nenhum item válido para importar.')
      return
    }

    setLoading(true)
    try {
      const payload = itens.map((i) => ({
        description: i.descricao,
        unit: i.unidade,
        quantity: i.quantidade,
        brand: i.marca,
        type: i.tipo,
      }))

      await onImportSuccess(payload)
      onClose()
    } catch (err: any) {
      alert('Erro ao importar itens: ' + (err.message || 'Erro inesperado'))
    } finally {
      setLoading(false)
    }
  }

  const totalLinhas = itens.length
  const itensValidos = itens.filter((i) => i.valido).length
  const errosCount = itens.filter((i) => !i.valido).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-4xl my-6 flex flex-col rounded-none max-h-[92vh] overflow-hidden">
        {/* Barra Superior Cesta de Preços: #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex items-center justify-between select-none flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-amber-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              IMPORTAR ITENS DO ORÇAMENTO (.XLSX / .CSV)
            </span>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Painel Superior: Seleção de Arquivo e Modelo */}
        <div className="bg-gray-100 p-4 border-b border-gray-300 flex flex-col sm:flex-row items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <label className="cursor-pointer inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-gray-400 hover:bg-gray-50 text-gray-800 text-xs font-bold uppercase rounded-none shadow-xs">
              <Upload className="h-3.5 w-3.5 text-gray-600" />
              <span>SELECIONAR ARQUIVO</span>
              <input
                type="file"
                accept=".csv, .xlsx, .xls, text/csv"
                onChange={handleArquivoSelecionado}
                className="hidden"
              />
            </label>
            <span className="text-xs text-gray-600 truncate max-w-[220px]">
              {arquivoNome || 'Nenhum arquivo selecionado'}
            </span>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleBaixarModelo}
              className="h-8 px-3 text-xs font-bold uppercase rounded-none border-gray-400 bg-white"
            >
              <Download className="h-3.5 w-3.5 mr-1 text-[#124268]" />
              BAIXAR MODELO DE PLANILHA
            </Button>
            {itens.length === 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleCarregarExemplo}
                className="h-8 px-3 text-xs text-[#124268] font-bold uppercase underline"
              >
                Carregar Exemplo (3 Medicamentos)
              </Button>
            )}
          </div>
        </div>

        {/* Resumo da Validação */}
        {totalLinhas > 0 && (
          <div className="bg-white px-4 py-2.5 border-b border-gray-200 flex flex-wrap items-center gap-4 text-xs select-none flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 uppercase font-bold text-[10px]">
                Total de Linhas:
              </span>
              <strong className="text-gray-900 font-mono text-sm">{totalLinhas}</strong>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-gray-500 uppercase font-bold text-[10px]">Itens Válidos:</span>
              <strong className="text-emerald-700 font-mono text-sm">{itensValidos}</strong>
            </div>
            {errosCount > 0 && (
              <div className="flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-red-600" />
                <span className="text-gray-500 uppercase font-bold text-[10px]">Erros:</span>
                <strong className="text-red-700 font-mono text-sm">{errosCount}</strong>
              </div>
            )}
          </div>
        )}

        {/* Lista de Pré-visualização com Tabela */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="bg-[#828892] text-white px-3 py-1 text-xs font-bold uppercase tracking-wider select-none">
            PRÉ-VISUALIZAÇÃO DOS ITENS DA PLANILHA
          </div>

          {itens.length === 0 ? (
            <div className="p-12 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-2">
              <FileSpreadsheet className="h-8 w-8 mx-auto text-gray-400" />
              <p className="font-semibold text-gray-700">
                Selecione uma planilha ou clique em "Carregar Exemplo"
              </p>
              <p className="text-gray-500">
                Colunas obrigatórias: ITEM | DESCRIÇÃO | UNIDADE DE MEDIDA | QUANTIDADE | MARCA |
                TIPO
              </p>
            </div>
          ) : (
            <div className="border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300">
                  <tr>
                    <th className="p-2 text-center w-12">LINHA</th>
                    <th className="p-2">DESCRIÇÃO</th>
                    <th className="p-2 text-center">UNIDADE</th>
                    <th className="p-2 text-right">QUANTIDADE</th>
                    <th className="p-2">MARCA</th>
                    <th className="p-2 text-center">TIPO</th>
                    <th className="p-2 text-center">STATUS</th>
                    <th className="p-2 text-center w-24">AÇÕES</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {itens.map((it) => (
                    <tr
                      key={it.linha}
                      className={`hover:bg-gray-50 ${!it.valido ? 'bg-red-50/40' : ''}`}
                    >
                      <td className="p-2 text-center font-mono text-gray-600">{it.linha}</td>
                      <td className="p-2 font-medium text-gray-900">
                        <div>{it.descricao}</div>
                        {it.erro && (
                          <div className="text-red-600 font-bold text-[10px]">{it.erro}</div>
                        )}
                      </td>
                      <td className="p-2 text-center font-mono">{it.unidade}</td>
                      <td className="p-2 text-right font-mono font-bold">
                        {it.quantidade > 0 ? it.quantidade.toLocaleString('pt-BR') : '—'}
                      </td>
                      <td className="p-2 text-gray-700">{it.marca || 'Não informada'}</td>
                      <td className="p-2 text-center">
                        <Badge
                          variant="outline"
                          className={`rounded-none text-[9px] font-bold ${
                            it.tipo === 'PRODUTO'
                              ? 'bg-blue-50 text-blue-800 border-blue-300'
                              : 'bg-amber-50 text-amber-800 border-amber-300'
                          }`}
                        >
                          {it.tipo}
                        </Badge>
                      </td>
                      <td className="p-2 text-center">
                        {it.valido ? (
                          <span className="text-emerald-700 font-bold text-[11px] inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Válido
                          </span>
                        ) : (
                          <span className="text-red-700 font-bold text-[11px] inline-flex items-center gap-1">
                            <AlertCircle className="h-3 w-3" /> Inválido
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-center space-x-1 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setItemEmEdicao(it)}
                          className="p-1 text-gray-600 hover:text-[#124268]"
                          title="Corrigir linha"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoverLinha(it.linha)}
                          className="p-1 text-gray-400 hover:text-red-600"
                          title="Remover linha"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Rodapé de Ações */}
        <div className="bg-gray-100 p-4 border-t border-gray-300 flex flex-col sm:flex-row items-center justify-between gap-3 flex-shrink-0">
          <div className="text-xs text-gray-600">
            {errosCount > 0 ? (
              <span className="text-red-700 font-bold">
                Atenção: existem {errosCount} linha(s) com dados inválidos que impedem a importação.
              </span>
            ) : totalLinhas > 0 ? (
              <span className="text-emerald-700 font-bold">
                Todos os {itensValidos} itens estão validados e prontos para cadastramento.
              </span>
            ) : (
              'Aguardando planilha.'
            )}
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={loading}
              className="h-9 px-4 text-xs font-bold uppercase rounded-none border-gray-400 bg-white flex-1 sm:flex-none"
            >
              CANCELAR
            </Button>
            <Button
              type="button"
              onClick={handleImportarFinal}
              disabled={loading || totalLinhas === 0 || errosCount > 0}
              className="h-9 px-6 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex-1 sm:flex-none"
            >
              {loading ? 'IMPORTANDO...' : 'IMPORTAR ITENS'}
            </Button>
          </div>
        </div>
      </div>

      {/* POP-UP CORRIGIR LINHA */}
      {itemEmEdicao && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-md rounded-none overflow-hidden">
            <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none">
              <span className="font-bold text-xs uppercase tracking-wider">
                CORRIGIR LINHA {itemEmEdicao.linha}
              </span>
              <button
                onClick={() => setItemEmEdicao(null)}
                className="text-white/80 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div>
                <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                  Descrição do Item *
                </label>
                <Input
                  value={itemEmEdicao.descricao}
                  onChange={(e) => setItemEmEdicao({ ...itemEmEdicao, descricao: e.target.value })}
                  className="h-8 text-xs rounded-none border-gray-400"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    Unidade de Medida *
                  </label>
                  <Input
                    value={itemEmEdicao.unidade}
                    onChange={(e) => setItemEmEdicao({ ...itemEmEdicao, unidade: e.target.value })}
                    className="h-8 text-xs rounded-none border-gray-400 uppercase"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    Quantidade *
                  </label>
                  <Input
                    type="number"
                    min="1"
                    value={itemEmEdicao.quantidade || ''}
                    onChange={(e) =>
                      setItemEmEdicao({
                        ...itemEmEdicao,
                        quantidade: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="h-8 text-xs rounded-none border-gray-400"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    Marca
                  </label>
                  <Input
                    value={itemEmEdicao.marca}
                    onChange={(e) => setItemEmEdicao({ ...itemEmEdicao, marca: e.target.value })}
                    className="h-8 text-xs rounded-none border-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-bold uppercase text-[10px] mb-1">
                    Tipo *
                  </label>
                  <select
                    value={itemEmEdicao.tipo}
                    onChange={(e) =>
                      setItemEmEdicao({
                        ...itemEmEdicao,
                        tipo: e.target.value as 'PRODUTO' | 'SERVICO',
                      })
                    }
                    className="h-8 w-full text-xs rounded-none border border-gray-400 bg-white px-2"
                  >
                    <option value="PRODUTO">PRODUTO</option>
                    <option value="SERVICO">SERVIÇO</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="bg-gray-100 p-3 border-t border-gray-300 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItemEmEdicao(null)}
                className="h-8 px-3 text-xs font-bold uppercase rounded-none border-gray-400 bg-white"
              >
                CANCELAR
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => handleSalvarEdicao(itemEmEdicao)}
                className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
              >
                SALVAR ALTERAÇÃO
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
