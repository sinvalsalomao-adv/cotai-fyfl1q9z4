import React, { useState, useEffect } from 'react'
import {
  X,
  Plus,
  Edit2,
  Trash2,
  Copy,
  Sliders,
  AlertTriangle,
  HelpCircle,
  FileText,
  Building,
  RotateCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { BudgetItem } from '@/services/budgetService'

interface ModalItemOrcamentoProps {
  isOpen: boolean
  onClose: () => void
  itemParaEditar: BudgetItem | null
  orgaoPadraoNome?: string
  municipioPadraoNome?: string
  onSalvar: (dados: {
    description: string
    unit: string
    quantity: number
    brand?: string
    type: 'PRODUTO' | 'SERVICO'
    tipoQuantidade?: 'INTEIRO' | 'FRACIONADO'
    tipoMarca?: 'DE_REFERENCIA' | 'VINCULATIVA'
    reference_price?: number
    cidade_orgao?: string
    lote?: string
    alterar_dados_fontes?: boolean
  }) => Promise<void>
}

export const ModalItemOrcamento: React.FC<ModalItemOrcamentoProps> = ({
  isOpen,
  onClose,
  itemParaEditar,
  orgaoPadraoNome = '',
  municipioPadraoNome = '',
  onSalvar,
}) => {
  const [descricao, setDescricao] = useState('')
  const [unidade, setUnidade] = useState('')
  const [quantidade, setQuantidade] = useState<number>(1)
  const [tipoQuantidade, setTipoQuantidade] = useState<'INTEIRO' | 'FRACIONADO'>('INTEIRO')
  const [marca, setMarca] = useState('')
  const [tipoMarca, setTipoMarca] = useState<'DE_REFERENCIA' | 'VINCULATIVA'>('DE_REFERENCIA')
  const [tipoItem, setTipoItem] = useState<'PRODUTO' | 'SERVICO'>('PRODUTO')
  const [referencePrice, setReferencePrice] = useState<string>('')
  const [cidadeOrgao, setCidadeOrgao] = useState<string>('')
  const [lote, setLote] = useState<string>('')
  const [alterarDadosFontes, setAlterarDadosFontes] = useState<boolean>(false)
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    if (isOpen) {
      if (itemParaEditar) {
        setDescricao(itemParaEditar.description || '')
        setUnidade(itemParaEditar.unit || 'UNIDADE')
        setQuantidade(itemParaEditar.quantity || 1)
        setTipoQuantidade(Number.isInteger(itemParaEditar.quantity) ? 'INTEIRO' : 'FRACIONADO')
        setMarca(itemParaEditar.brand || '')
        setTipoMarca('DE_REFERENCIA')
        setTipoItem(itemParaEditar.type || 'PRODUTO')
        setCidadeOrgao(itemParaEditar.cidade_orgao || '')
        setLote(itemParaEditar.lote || '')
        setReferencePrice(
          itemParaEditar.reference_price && itemParaEditar.reference_price > 0
            ? String(itemParaEditar.reference_price)
            : '',
        )
        setAlterarDadosFontes(itemParaEditar.alterar_dados_fontes ?? false)
      } else {
        setDescricao('')
        setUnidade('Unidade')
        setQuantidade(1)
        setTipoQuantidade('INTEIRO')
        setMarca('')
        setTipoMarca('DE_REFERENCIA')
        setTipoItem('PRODUTO')
        setCidadeOrgao(
          orgaoPadraoNome
            ? `${orgaoPadraoNome}${municipioPadraoNome ? ` (${municipioPadraoNome})` : ''}`
            : '',
        )
        setLote('00')
        setReferencePrice('')
        setAlterarDadosFontes(false)
      }
    }
  }, [isOpen, itemParaEditar, orgaoPadraoNome, municipioPadraoNome])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!descricao.trim()) {
      alert('A descrição do item é obrigatória.')
      return
    }
    if (!unidade.trim()) {
      alert('A medida de fornecimento é obrigatória.')
      return
    }
    if (quantidade <= 0) {
      alert('A quantidade deve ser maior que zero.')
      return
    }

    setSalvando(true)
    try {
      const refPriceParsed =
        referencePrice.trim() !== '' ? parseFloat(referencePrice.replace(',', '.')) : undefined

      await onSalvar({
        description: descricao,
        unit: unidade,
        quantity: quantidade,
        brand: marca,
        type: tipoItem,
        tipoQuantidade,
        tipoMarca,
        cidade_orgao: cidadeOrgao.trim(),
        lote: lote.trim(),
        reference_price:
          refPriceParsed !== undefined && !isNaN(refPriceParsed) ? refPriceParsed : 0,
        alterar_dados_fontes: alterarDadosFontes,
      })
      onClose()
    } catch (err: any) {
      alert('Erro ao salvar item: ' + (err.message || 'Verifique os dados.'))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-3xl my-6 rounded-none overflow-hidden flex flex-col">
        {/* Barra Superior Cesta de Preços: #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex items-center justify-between select-none">
          <span className="font-bold text-xs uppercase tracking-wider">
            {itemParaEditar ? 'ALTERAR ITEM DO ORÇAMENTO' : 'ADICIONAR NOVO ITEM DO ORÇAMENTO'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-white/80 hover:text-white p-1"
            title="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4 text-xs">
          {/* LOTE E CIDADE / ÓRGÃO DESTINO DO ITEM (Para agrupamento de múltiplos órgãos no PDF) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-gray-50 border border-gray-300">
            <div className="space-y-1 sm:col-span-1">
              <label className="block text-gray-800 font-bold uppercase text-[11px]">Lote:</label>
              <Input
                value={lote}
                onChange={(e) => setLote(e.target.value)}
                placeholder="Ex: 00, 01, Lote A..."
                className="h-9 text-xs font-mono font-bold rounded-none border-gray-400 bg-white"
              />
              <span className="text-[10px] text-gray-500 block">
                Agrupador do lote no relatório.
              </span>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <label className="block text-gray-800 font-bold uppercase text-[11px]">
                Cidade / Órgão Interessado deste Item:
              </label>
              <Input
                value={cidadeOrgao}
                onChange={(e) => setCidadeOrgao(e.target.value)}
                placeholder="Ex: Prefeitura de São Paulo (SP) ou Município de Florânia - RN"
                className="h-9 text-xs font-semibold rounded-none border-gray-400 bg-white"
              />
              <span className="text-[10px] text-gray-500 block">
                Usado para agrupar as seções do documento em PDF por cada cidade/órgão.
              </span>
            </div>
          </div>

          {/* Descrição com instrução do Termo de Referência */}
          <div className="space-y-1">
            <label className="block text-gray-800 font-bold uppercase text-[11px]">
              Descrição:*
            </label>
            <Textarea
              rows={4}
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Descreva o item com todas as características técnicas essenciais..."
              className="text-xs sm:text-sm font-medium rounded-none border-gray-400 bg-white resize-y"
              required
            />
            <span className="text-[10px] text-gray-500 italic block">
              Reproduzir a descrição constante do termo de referência ou do projeto básico.
            </span>
          </div>

          {/* Medida de Fornecimento / Quantidade / Indicação de Marca */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Medida de fornecimento */}
            <div className="space-y-1">
              <label className="block text-gray-800 font-bold uppercase text-[11px]">
                Medida de fornecimento:*
              </label>
              <div className="relative">
                <Input
                  value={unidade}
                  onChange={(e) => setUnidade(e.target.value)}
                  placeholder="Unidade, Caixa, Frasco, Serviço..."
                  className="h-9 text-xs rounded-none border-gray-400 bg-white"
                  required
                />
              </div>
            </div>

            {/* Quantidade + Radio (Nº INTEIRO / FRACIONADO) */}
            <div className="space-y-1">
              <label className="block text-gray-800 font-bold uppercase text-[11px]">
                Quantidade:*
              </label>
              <Input
                type="number"
                step={tipoQuantidade === 'FRACIONADO' ? '0.001' : '1'}
                min="0.001"
                value={quantidade}
                onChange={(e) => setQuantidade(parseFloat(e.target.value) || 0)}
                className="h-9 text-xs font-mono font-bold rounded-none border-gray-400 bg-white"
                required
              />
              <div className="flex items-center gap-4 pt-1">
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[10px] font-bold text-gray-700">
                  <input
                    type="radio"
                    name="tipoQtd"
                    checked={tipoQuantidade === 'INTEIRO'}
                    onChange={() => setTipoQuantidade('INTEIRO')}
                    className="text-[#124268]"
                  />
                  <span>Nº INTEIRO</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[10px] font-bold text-gray-700">
                  <input
                    type="radio"
                    name="tipoQtd"
                    checked={tipoQuantidade === 'FRACIONADO'}
                    onChange={() => setTipoQuantidade('FRACIONADO')}
                    className="text-[#124268]"
                  />
                  <span>FRACIONADO</span>
                </label>
              </div>
            </div>

            {/* Indicação de marca + Radio (DE REFERÊNCIA / VINCULATIVA) */}
            <div className="space-y-1">
              <label className="block text-gray-800 font-bold uppercase text-[11px]">
                Indicação de marca:
              </label>
              <Input
                value={marca}
                onChange={(e) => setMarca(e.target.value)}
                placeholder="Ex: Prati, EMS, Referência..."
                className="h-9 text-xs rounded-none border-gray-400 bg-white"
              />
              <div className="flex items-center gap-4 pt-1">
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[10px] font-bold text-gray-700">
                  <input
                    type="radio"
                    name="tipoMarca"
                    checked={tipoMarca === 'DE_REFERENCIA'}
                    onChange={() => setTipoMarca('DE_REFERENCIA')}
                    className="text-[#124268]"
                  />
                  <span>DE REFERÊNCIA</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[10px] font-bold text-gray-700">
                  <input
                    type="radio"
                    name="tipoMarca"
                    checked={tipoMarca === 'VINCULATIVA'}
                    onChange={() => setTipoMarca('VINCULATIVA')}
                    className="text-[#124268]"
                  />
                  <span>VINCULATIVA</span>
                </label>
              </div>
            </div>
          </div>

          {/* SEÇÃO: VALORES VANTAJOSOS / VALOR DE REFERÊNCIA (PREÇO VIGENTE/CONTRATADO) */}
          <div className="p-3 bg-blue-50/60 border border-blue-200 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-gray-900 font-bold uppercase text-[11px] flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 bg-[#124268]" />
                VALORES VANTAJOSOS — VALOR DE REFERÊNCIA (CONTRATO VIGENTE)
              </label>
              <span className="text-[10px] text-blue-700 bg-blue-100 font-bold px-2 py-0.5 border border-blue-300">
                OPCIONAL • PRORROGAÇÃO CONTRATUAL
              </span>
            </div>
            <p className="text-[10.5px] text-gray-600">
              Informe o preço unitário atualmente contratado para comprovar a vantajosidade de
              prorrogação. Nas buscas, valores de mercado iguais ou superiores a esta referência
              demonstrarão que a manutenção do contrato é mais vantajosa para a Administração.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block text-gray-700 font-bold text-[10.5px] uppercase mb-1">
                  Preço Vigente / Referência (R$):
                </label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="0,00 (Preço atual do contrato)"
                  value={referencePrice}
                  onChange={(e) => setReferencePrice(e.target.value)}
                  className="h-9 text-xs font-mono font-bold rounded-none border-blue-300 bg-white focus-visible:ring-1 focus-visible:ring-[#124268]"
                />
              </div>
              <div className="flex items-center text-[10.5px] text-gray-500 italic pt-2 sm:pt-5">
                <span>
                  {referencePrice && parseFloat(referencePrice.replace(',', '.')) > 0 ? (
                    <strong className="text-emerald-800 font-semibold not-italic">
                      ✓ Ativo: Cotações ≥ R${' '}
                      {parseFloat(referencePrice.replace(',', '.')).toLocaleString('pt-BR', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      serão destacadas como favoráveis à prorrogação.
                    </strong>
                  ) : (
                    'Deixe em branco ou zero se não desejar análise de vantajosidade de prorrogação para este item.'
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Este item é um: PRODUTO / SERVIÇO e Opção Alterar em Fontes */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-gray-200">
            {/* Este item é um: PRODUTO / SERVIÇO */}
            <div className="space-y-1">
              <label className="block text-gray-800 font-bold uppercase text-[11px]">
                Este item é um:*
              </label>
              <div className="flex items-center gap-6 pt-1">
                <label className="inline-flex items-center gap-2 cursor-pointer font-bold text-gray-700">
                  <input
                    type="radio"
                    name="tipoItem"
                    checked={tipoItem === 'PRODUTO'}
                    onChange={() => setTipoItem('PRODUTO')}
                    className="text-[#124268]"
                  />
                  <span>PRODUTO</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer font-bold text-gray-700">
                  <input
                    type="radio"
                    name="tipoItem"
                    checked={tipoItem === 'SERVICO'}
                    onChange={() => setTipoItem('SERVICO')}
                    className="text-[#124268]"
                  />
                  <span>SERVIÇO</span>
                </label>
              </div>
            </div>

            {/* Alterar os dados do item em CDFs, Entes Públicos e Sites de comércio eletrônico? */}
            <div className="space-y-1">
              <label className="block text-gray-800 font-bold uppercase text-[11px]">
                Alterar os dados do item em CDFs, Entes Públicos e Sites de comércio eletrônico?
              </label>
              <div className="flex items-center gap-6 pt-1">
                <label className="inline-flex items-center gap-2 cursor-pointer font-bold text-gray-700">
                  <input
                    type="radio"
                    name="alterarFontes"
                    checked={alterarDadosFontes === true}
                    onChange={() => setAlterarDadosFontes(true)}
                    className="text-[#124268]"
                  />
                  <span>SIM</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer font-bold text-gray-700">
                  <input
                    type="radio"
                    name="alterarFontes"
                    checked={alterarDadosFontes === false}
                    onChange={() => setAlterarDadosFontes(false)}
                    className="text-[#124268]"
                  />
                  <span>NÃO</span>
                </label>
              </div>
              <span className="text-[10px] text-gray-500 block">
                Permite personalizar como os termos técnicos serão consultados nas fontes de coleta.
              </span>
            </div>
          </div>

          {/* Rodapé com botões fiéis ao documento Cesta de Preços */}
          <div className="pt-4 border-t border-gray-300 flex items-center justify-between">
            <Button
              type="submit"
              disabled={salvando}
              className="h-9 px-6 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none"
            >
              {salvando ? 'SALVANDO...' : 'SALVAR'}
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={salvando}
              className="h-9 px-5 text-xs font-bold uppercase rounded-none border-gray-400 bg-gray-100 text-gray-800 hover:bg-gray-200"
            >
              ✕ FECHAR
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
