import React, { useState } from 'react'
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  HelpCircle,
  Table,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

export interface ItemImportadoPlanilha {
  item: number
  descricao: string
  unidade: string
  quantidade: number
  valorEstimado?: number
  marcaModelo?: string
  codigoCatalogo?: string
}

interface ModalImportacaoItensProps {
  aberto: boolean
  onClose: () => void
  onImportar: (itens: ItemImportadoPlanilha[]) => void
}

export default function ModalImportacaoItens({
  aberto,
  onClose,
  onImportar,
}: ModalImportacaoItensProps) {
  const [textoColado, setTextoColado] = useState('')
  const [itensPrevia, setItensPrevia] = useState<ItemImportadoPlanilha[]>([])
  const [erro, setErro] = useState<string | null>(null)

  if (!aberto) return null

  // Processa texto copiado e colado ou CSV
  const handleProcessarTexto = () => {
    setErro(null)
    if (!textoColado.trim()) {
      setErro('Cole o conteúdo da planilha ou digite as linhas.')
      return
    }

    try {
      const linhas = textoColado.split(/\r?\n/).filter((l) => l.trim().length > 0)
      if (linhas.length === 0) {
        setErro('Nenhuma linha identificada.')
        return
      }

      // Detecta separador (tabulação \t para excel colado, ou ponto e vírgula ;, ou vírgula ,)
      const primeiraLinha = linhas[0]
      let separador = '\t'
      if (primeiraLinha.includes(';') && !primeiraLinha.includes('\t')) separador = ';'
      else if (primeiraLinha.includes(',') && !primeiraLinha.includes('\t')) separador = ','

      // Identifica se a primeira linha é cabeçalho
      const colsPrimeira = primeiraLinha.split(separador).map((c) => c.trim().toLowerCase())
      let startIndex = 0
      if (
        colsPrimeira.some(
          (c) =>
            c.includes('item') ||
            c.includes('desc') ||
            c.includes('und') ||
            c.includes('unidade') ||
            c.includes('qtd'),
        )
      ) {
        startIndex = 1
      }

      const itensProcessados: ItemImportadoPlanilha[] = []

      for (let i = startIndex; i < linhas.length; i++) {
        const colunas = linhas[i].split(separador).map((c) => c.trim().replace(/^["']|["']$/g, ''))
        if (colunas.length < 2) continue

        // Heurística de colunas: ITEM | DESCRIÇÃO | UND | QTD | VALOR
        let numItem = itensProcessados.length + 1
        let desc = ''
        let und = 'un'
        let qtd = 1
        let val: number | undefined = undefined

        if (colunas.length === 2) {
          desc = colunas[0]
          qtd = parseFloat(colunas[1].replace(',', '.')) || 1
        } else if (colunas.length >= 3 && isNaN(Number(colunas[0]))) {
          // DESC | UND | QTD
          desc = colunas[0]
          und = colunas[1]
          qtd = parseFloat(colunas[2].replace(',', '.')) || 1
        } else {
          // ITEM | DESC | UND | QTD
          numItem = parseInt(colunas[0], 10) || itensProcessados.length + 1
          desc = colunas[1] || 'Item sem descrição'
          und = colunas[2] || 'un'
          qtd = parseFloat((colunas[3] || '1').replace(',', '.')) || 1
          if (colunas[4]) {
            val = parseFloat(colunas[4].replace('R$', '').replace('.', '').replace(',', '.'))
          }
        }

        if (desc.trim()) {
          itensProcessados.push({
            item: numItem,
            descricao: desc,
            unidade: und,
            quantidade: qtd,
            valorEstimado: val,
          })
        }
      }

      if (itensProcessados.length === 0) {
        setErro('Não foi possível identificar itens estruturados. Verifique o formato.')
        return
      }

      setItensPrevia(itensProcessados)
    } catch (err: any) {
      setErro(`Erro ao processar: ${err?.message}`)
    }
  }

  const handleExemplo = () => {
    const exemplo = `ITEM\tDESCRIÇÃO\tUND\tQTD
1\tDipirona Sódica 500 mg comprimido simples\tcomprimido\t20000
2\tParacetamol 750 mg comprimido\tcomprimido\t15000
3\tÁlcool Etílico 70% frasco 1000ml\tlitro\t1000
4\tPapel sulfite A4 alcalino 75g resma 500 folhas\tresma\t500
5\tMicrocomputador desktop corporativo 16GB SSD 512GB\tun\t25`
    setTextoColado(exemplo)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-gray-200">
        <div className="p-4 bg-[#1B4B8A] text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-amber-300" />
            <div>
              <h2 className="text-base font-bold">Importação Estruturada de Itens</h2>
              <p className="text-[11px] text-white/80">
                Copie e cole do Excel / CSV / Google Sheets com detecção automática de colunas
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-white hover:bg-white/10"
          >
            ✕ Fechar
          </Button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">
              Cole as linhas da planilha (copiadas do Excel / Calc / CSV):
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExemplo}
              className="text-xs text-[#1B4B8A] border-blue-200 h-7"
            >
              Preencher exemplo
            </Button>
          </div>

          <textarea
            value={textoColado}
            onChange={(e) => setTextoColado(e.target.value)}
            rows={6}
            placeholder={`ITEM\tDESCRIÇÃO\tUND\tQTD\n1\tDipirona 500mg\tcomp\t10000`}
            className="w-full text-xs font-mono p-3 border border-gray-300 rounded-lg focus:ring-1 focus:ring-blue-500"
          />

          <div className="flex items-center justify-between">
            <Button
              onClick={handleProcessarTexto}
              size="sm"
              className="bg-[#1B4B8A] text-white text-xs font-semibold"
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Detectar Colunas e Gerar Prévia
            </Button>
            {itensPrevia.length > 0 && (
              <Badge className="bg-emerald-100 text-emerald-800 text-xs">
                {itensPrevia.length} item(ns) pronto(s) para importação
              </Badge>
            )}
          </div>

          {erro && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>{erro}</span>
            </div>
          )}

          {/* Prévia da Tabela Importada */}
          {itensPrevia.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-gray-100">
              <span className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                <Table className="h-3.5 w-3.5 text-[#1B4B8A]" />
                Prévia dos Dados Reconhecidos:
              </span>
              <div className="border border-gray-200 rounded-lg overflow-x-auto max-h-48">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold">
                    <tr>
                      <th className="p-2 w-12">Item</th>
                      <th className="p-2">Descrição do Objeto</th>
                      <th className="p-2 w-20">Unidade</th>
                      <th className="p-2 w-24 text-right">Quantidade</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {itensPrevia.map((it) => (
                      <tr key={it.item} className="hover:bg-gray-50/50">
                        <td className="p-2 font-mono text-gray-500">{it.item}</td>
                        <td className="p-2 font-medium text-gray-900">{it.descricao}</td>
                        <td className="p-2 text-gray-600">{it.unidade}</td>
                        <td className="p-2 text-right font-mono font-semibold text-[#1B4B8A]">
                          {it.quantidade}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
            Cancelar
          </Button>
          <Button
            disabled={itensPrevia.length === 0}
            onClick={() => {
              onImportar(itensPrevia)
              onClose()
            }}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold"
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            Confirmar e Importar {itensPrevia.length} Itens
          </Button>
        </div>
      </div>
    </div>
  )
}
