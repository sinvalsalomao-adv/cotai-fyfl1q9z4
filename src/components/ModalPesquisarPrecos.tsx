import React, { useState } from 'react'
import {
  X,
  Search,
  Sparkles,
  ExternalLink,
  ShieldAlert,
  Check,
  Building,
  Calendar,
  FileText,
  Building2,
  Tag,
  Hash,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { BudgetItem, BudgetPriceResult } from '@/services/budgetService'
import { BudgetService } from '@/services/budgetService'

interface ModalPesquisarPrecosProps {
  item: BudgetItem
  budgetId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: (resultado: any) => void
}

export const ModalPesquisarPrecos: React.FC<ModalPesquisarPrecosProps> = ({
  item,
  budgetId,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [searchTerm, setSearchTerm] = useState(item.description)
  const [tipoPesquisa, setTipoPesquisa] = useState<'PALAVRA_CHAVE' | 'CATMAT'>('PALAVRA_CHAVE')
  const [cnpjFiltro, setCnpjFiltro] = useState('')
  const [filtroMeses, setFiltroMeses] = useState('12 MESES')
  const [filtroUf, setFiltroUf] = useState('TODOS')
  const [loadingSearch, setLoadingSearch] = useState(false)
  const [loadingConfirm, setLoadingConfirm] = useState(false)
  const [priceResults, setPriceResults] = useState<BudgetPriceResult[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detailModalPrice, setDetailModalPrice] = useState<BudgetPriceResult | null>(null)
  const [searchExecuted, setSearchExecuted] = useState(false)

  // Saneamento estatístico dinâmico em tempo real conforme as amostras selecionadas
  const precosSelecionados = priceResults.filter((p) => selectedIds.includes(p.id))
  const valoresSelecionados = precosSelecionados.map((p) => p.unit_price).sort((a, b) => a - b)
  const countSel = valoresSelecionados.length
  const precoMin = countSel > 0 ? valoresSelecionados[0] : 0
  const precoMax = countSel > 0 ? valoresSelecionados[countSel - 1] : 0
  const precoMedia = countSel > 0 ? valoresSelecionados.reduce((a, b) => a + b, 0) / countSel : 0
  const meio = Math.floor(countSel / 2)
  const precoMediana =
    countSel > 0
      ? countSel % 2 === 0
        ? (valoresSelecionados[meio - 1] + valoresSelecionados[meio]) / 2
        : valoresSelecionados[meio]
      : 0

  // Ao abrir, carregar cotações já existentes do item se houver
  React.useEffect(() => {
    if (isOpen) {
      setSearchTerm(item.last_search_term || item.description)
      carregarPrecosExistentes()
    }
  }, [isOpen, item.id])

  const carregarPrecosExistentes = async () => {
    const list = await BudgetService.listarPrecosDoItem(item.id)
    if (list.length > 0) {
      setPriceResults(list)
      // Selecionar os que estão selecionados ou todos por padrão
      const selecionados = list.filter((p) => p.status !== 'nao_selecionado').map((p) => p.id)
      setSelectedIds(selecionados.length > 0 ? selecionados : list.map((p) => p.id))
      setSearchExecuted(true)
    } else {
      setPriceResults([])
      setSelectedIds([])
      setSearchExecuted(false)
    }
  }

  const handleBuscar = async (isIa: boolean = false) => {
    setLoadingSearch(true)
    try {
      const resultados = await BudgetService.cotarItemComIA(item, searchTerm)
      setPriceResults(resultados)
      // Por padrão, selecionar todos os preços encontrados compatíveis
      setSelectedIds(resultados.map((p) => p.id))
      setSearchExecuted(true)
    } catch (err: any) {
      console.error('Erro ao pesquisar preços:', err)
      alert('Erro ao consultar as fontes: ' + (err.message || 'Falha de comunicação'))
    } finally {
      setLoadingSearch(false)
    }
  }

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    )
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(priceResults.map((p) => p.id))
    } else {
      setSelectedIds([])
    }
  }

  const handleConfirmar = async () => {
    if (selectedIds.length === 0) {
      alert('Selecione pelo menos uma cotação para o cálculo.')
      return
    }

    setLoadingConfirm(true)
    try {
      const res = await BudgetService.confirmarCotacoesECalcular(item, selectedIds, budgetId)
      onSuccess(res)
      onClose()
    } catch (err: any) {
      console.error('Erro ao confirmar cotações:', err)
      alert('Erro ao calcular cotações: ' + (err.message || 'Verifique os dados'))
    } finally {
      setLoadingConfirm(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-5xl my-6 flex flex-col rounded-none max-h-[92vh] overflow-hidden">
        {/* Barra Superior Cesta de Preços: #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex items-center justify-between select-none flex-shrink-0">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-amber-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              PESQUISAR PREÇOS — ITEM {String(item.sequence).padStart(2, '0')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white p-1 transition-colors"
            title="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* DESCRIÇÃO DO ITEM A SER COTADO (ETAPA 09) */}
        <div className="bg-gray-100 p-3 sm:p-4 border-b border-gray-300 flex-shrink-0 space-y-3">
          <div>
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block">
              DESCRIÇÃO DO ITEM A SER COTADO
            </span>
            <div className="font-bold text-[#124268] text-sm mt-0.5">
              {String(item.sequence).padStart(2, '0')}. {item.description}
            </div>
            <div className="text-[11px] text-gray-600 flex items-center gap-4 mt-0.5">
              <span>
                Medida de fornecimento: <strong>{item.unit}</strong>
              </span>
              <span>
                Quantidade: <strong>{item.quantity.toLocaleString('pt-BR')}</strong>
              </span>
              <span>
                Tipo: <strong>{item.type}</strong>
              </span>
            </div>
          </div>

          {/* ARGUMENTO DE PESQUISA (ETAPA 09 DO CESTA DE PREÇOS) */}
          <div className="bg-white p-3 border border-gray-300 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-2">
              <span className="font-bold text-[11px] uppercase text-gray-700">
                ARGUMENTO DE PESQUISA:
              </span>
              <div className="flex items-center gap-4 text-xs">
                <label className="inline-flex items-center gap-1.5 cursor-pointer font-bold text-[#124268]">
                  <input
                    type="radio"
                    name="tipoPesq"
                    checked={tipoPesquisa === 'PALAVRA_CHAVE'}
                    onChange={() => setTipoPesquisa('PALAVRA_CHAVE')}
                    className="text-[#124268]"
                  />
                  <span>PESQUISAR POR PALAVRA-CHAVE</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer font-bold text-gray-700">
                  <input
                    type="radio"
                    name="tipoPesq"
                    checked={tipoPesquisa === 'CATMAT'}
                    onChange={() => setTipoPesquisa('CATMAT')}
                    className="text-[#124268]"
                  />
                  <span>PESQUISAR POR CATMAT/CATSER</span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 pt-1">
              <div className="md:col-span-3">
                <label className="block text-[10px] font-bold text-gray-600 uppercase mb-0.5">
                  Termo da descrição técnica ou genérica do produto:
                </label>
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Ex: DIPIRONA 500MG COMPRIMIDO ou CATMAT 269412"
                  className="h-9 text-xs font-medium border-gray-400 bg-white rounded-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-gray-600 uppercase mb-0.5">
                  CNPJ (opcional):
                </label>
                <Input
                  value={cnpjFiltro}
                  onChange={(e) => setCnpjFiltro(e.target.value)}
                  placeholder="00.000.000/0000-00"
                  className="h-9 text-xs border-gray-400 bg-white rounded-none font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleBuscar(false)}
                disabled={loadingSearch || !searchTerm.trim()}
                className="h-8 px-4 text-xs font-bold uppercase rounded-none border-gray-400 text-gray-700 bg-white hover:bg-gray-50"
              >
                <Search className="h-3.5 w-3.5 mr-1" />
                {loadingSearch ? 'Buscando...' : 'PESQUISAR'}
              </Button>
              <Button
                type="button"
                onClick={() => handleBuscar(true)}
                disabled={loadingSearch || !searchTerm.trim()}
                className="h-8 px-5 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex items-center gap-1.5"
              >
                <Sparkles className="h-4 w-4 text-amber-300 animate-pulse" />
                {loadingSearch ? 'IA Consultando Fontes...' : 'COTAR COM IA'}
              </Button>
            </div>
          </div>
        </div>

        {/* Banner Orientativo Amarelo */}
        <div className="bg-[#fffbeb] border-l-4 border-amber-500 p-3 mx-4 mt-3 text-xs text-amber-900 flex items-start gap-2 flex-shrink-0">
          <ShieldAlert className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Fontes Oficiais Consultadas:</strong> PNCP, Compras.gov.br, BPS, CMED e BEC-SP.
            A IA localiza as cotações nas fontes oficiais e você realiza a validação das amostras.
            Todo preço possui rastreabilidade com fornecedor, órgão e documento de origem.
          </div>
        </div>

        {/* RESULTADO DA PESQUISA COM CARDS DE PREÇO (ETAPAS 10 E 11) */}
        {priceResults.length > 0 && (
          <div className="bg-gray-100 p-3 mx-4 border border-gray-300 grid grid-cols-2 sm:grid-cols-5 gap-3 text-center flex-shrink-0">
            <div className="bg-white p-2 border border-gray-200">
              <span className="text-[10px] font-bold text-gray-500 uppercase block">AMOSTRAS</span>
              <span className="text-base font-bold font-mono text-gray-900 block">
                {priceResults.length}
              </span>
            </div>
            <div className="bg-white p-2 border border-gray-200">
              <span className="text-[10px] font-bold text-gray-500 uppercase block">
                PREÇO MÍNIMO
              </span>
              <span className="text-base font-bold font-mono text-gray-900 block">
                R$ {precoMin.toFixed(2)}
              </span>
            </div>
            <div className="bg-white p-2 border border-gray-200">
              <span className="text-[10px] font-bold text-gray-500 uppercase block">
                PREÇO MÁXIMO
              </span>
              <span className="text-base font-bold font-mono text-gray-900 block">
                R$ {precoMax.toFixed(2)}
              </span>
            </div>
            <div className="bg-white p-2 border border-gray-200">
              <span className="text-[10px] font-bold text-gray-500 uppercase block">MÉDIA</span>
              <span className="text-base font-bold font-mono text-gray-900 block">
                R$ {precoMedia.toFixed(2)}
              </span>
            </div>
            <div className="bg-white p-2 border border-gray-200">
              <span className="text-[10px] font-bold text-[#124268] uppercase block">MEDIANA</span>
              <span className="text-base font-bold font-mono text-[#124268] block">
                R$ {precoMediana.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {/* Área Central: Lista de Cotações Encontradas (ETAPA 10 e 11) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Barra de seção Cinza #828892 */}
          <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-between select-none">
            <span>RESULTADO DA PESQUISA — FORAM ENCONTRADAS {priceResults.length} AMOSTRAS</span>
            <span className="text-[11px] font-normal lowercase">
              {selectedIds.length} selecionada(s) para compor a análise
            </span>
          </div>

          {priceResults.length === 0 ? (
            <div className="p-12 text-center border border-dashed border-gray-300 bg-gray-50 text-gray-500 text-xs space-y-2">
              <Search className="h-8 w-8 mx-auto text-gray-400" />
              <p className="font-semibold text-gray-700">
                {searchExecuted
                  ? 'Não foram encontradas cotações suficientes para este termo.'
                  : 'Nenhuma cotação pesquisada ainda.'}
              </p>
              <p className="text-gray-500">
                {searchExecuted
                  ? 'Tente refazer a busca ajustando os termos (ex: nome genérico, concentração ou CATMAT).'
                  : 'Clique em "COTAR COM IA" para que o sistema consulte automaticamente as bases públicas.'}
              </p>
            </div>
          ) : (
            <div className="border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-300">
                  <tr>
                    <th className="p-2.5 w-10 text-center">
                      <Checkbox
                        checked={
                          selectedIds.length === priceResults.length && priceResults.length > 0
                        }
                        onCheckedChange={handleSelectAll}
                        className="rounded-none data-[state=checked]:bg-[#124268]"
                      />
                    </th>
                    <th className="p-2.5">FONTE</th>
                    <th className="p-2.5">DATA</th>
                    <th className="p-2.5">ÓRGÃO / LICITANTE</th>
                    <th className="p-2.5">FORNECEDOR</th>
                    <th className="p-2.5">PRODUTO / SERVIÇO</th>
                    <th className="p-2.5 text-center">MEDIDA</th>
                    <th className="p-2.5 text-right">QUANTIDADE</th>
                    <th className="p-2.5 text-right">VALOR UNITÁRIO (R$)</th>
                    <th className="p-2.5 text-center">SIMILARIDADE</th>
                    <th className="p-2.5 text-center">ORIGEM</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {priceResults.map((p) => {
                    const isSelected = selectedIds.includes(p.id)
                    const isExpurgado = p.status === 'expurgado'
                    return (
                      <tr
                        key={p.id}
                        className={`hover:bg-blue-50/40 transition-colors ${
                          isSelected ? 'bg-blue-50/20' : ''
                        } ${isExpurgado ? 'opacity-60 bg-red-50/20' : ''}`}
                      >
                        <td className="p-2.5 text-center">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => handleToggleSelect(p.id)}
                            className="rounded-none data-[state=checked]:bg-[#124268]"
                          />
                        </td>
                        <td className="p-2.5 font-bold text-gray-900 whitespace-nowrap">
                          <Badge
                            variant="outline"
                            className={`rounded-none text-[10px] font-bold ${
                              p.source === 'PNCP'
                                ? 'bg-blue-50 text-blue-800 border-blue-300'
                                : p.source === 'BPS'
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                  : p.source === 'Compras.gov.br'
                                    ? 'bg-indigo-50 text-indigo-800 border-indigo-300'
                                    : p.source === 'CMED'
                                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                                      : 'bg-gray-100 text-gray-800 border-gray-300'
                            }`}
                          >
                            {p.source}
                          </Badge>
                        </td>
                        <td className="p-2.5 text-gray-600 whitespace-nowrap font-mono text-[11px]">
                          {p.source_date
                            ? new Date(p.source_date).toLocaleDateString('pt-BR')
                            : '—'}
                        </td>
                        <td
                          className="p-2.5 text-gray-800 max-w-[150px] truncate"
                          title={p.government_entity}
                        >
                          <div className="font-medium text-gray-900 truncate">
                            {p.government_entity || 'NÃO INFORMADO'}
                          </div>
                        </td>
                        <td
                          className="p-2.5 text-gray-700 max-w-[150px] truncate"
                          title={p.supplier}
                        >
                          <div className="truncate">{p.supplier || 'NÃO INFORMADO'}</div>
                          <div className="text-[10px] text-gray-500 font-mono">
                            CNPJ: {p.supplier_document || 'NÃO INFORMADO'}
                          </div>
                        </td>
                        <td
                          className="p-2.5 text-gray-900 font-medium max-w-[200px] truncate"
                          title={p.description_original}
                        >
                          <div>{p.description_original}</div>
                          {p.raw_data?.catmat && (
                            <span className="text-[10px] text-gray-500 font-mono">
                              {p.raw_data.catmat}
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-center font-mono text-gray-700">{p.unit}</td>
                        <td className="p-2.5 text-right font-mono text-gray-700">
                          {p.quantity.toLocaleString('pt-BR')}
                        </td>
                        <td className="p-2.5 text-right font-bold font-mono text-gray-900 whitespace-nowrap">
                          R${' '}
                          {p.unit_price.toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 4,
                          })}
                        </td>
                        <td className="p-2.5 text-center">
                          <span
                            className={`font-bold px-1.5 py-0.5 text-[11px] ${
                              (p.similarity_score || 0) >= 90
                                ? 'text-emerald-700 bg-emerald-50'
                                : (p.similarity_score || 0) >= 75
                                  ? 'text-amber-700 bg-amber-50'
                                  : 'text-red-700 bg-red-50'
                            }`}
                          >
                            {p.similarity_score || 85}%
                          </span>
                        </td>
                        <td className="p-2.5 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setDetailModalPrice(p)}
                            className="text-[#124268] hover:text-[#0c314f] font-bold underline inline-flex items-center gap-1 cursor-pointer"
                          >
                            VER ORIGEM
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Rodapé do Modal com Botões de Ação */}
        <div className="bg-gray-100 p-3 sm:p-4 border-t border-gray-300 flex flex-col sm:flex-row items-center justify-between gap-3 flex-shrink-0">
          <div className="text-xs text-gray-600">
            {selectedIds.length} cotação(ões) selecionada(s) de {priceResults.length} encontrada(s).
            Os preços desmarcados continuam no histórico para auditoria.
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={loadingConfirm}
              className="h-9 px-4 text-xs font-bold uppercase rounded-none border-gray-400 bg-white flex-1 sm:flex-none"
            >
              CANCELAR
            </Button>
            <Button
              type="button"
              onClick={handleConfirmar}
              disabled={loadingConfirm || selectedIds.length === 0}
              className="h-9 px-6 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex-1 sm:flex-none flex items-center justify-center gap-1.5"
            >
              <Check className="h-4 w-4 text-emerald-400" />
              {loadingConfirm ? 'APLICANDO CÁLCULO...' : 'CONFIRMAR COTAÇÕES'}
            </Button>
          </div>
        </div>
      </div>

      {/* POP-UP COMPLETO: VER ORIGEM DO PREÇO (Rastreabilidade Estrita) */}
      {detailModalPrice && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white border border-[#b8c2cc] shadow-2xl w-full max-w-2xl rounded-none overflow-hidden">
            <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none">
              <span className="font-bold text-xs uppercase tracking-wider flex items-center gap-2">
                <FileText className="h-4 w-4 text-amber-400" />
                ORIGEM DO PREÇO — RASTREABILIDADE PÚBLICA
              </span>
              <button
                onClick={() => setDetailModalPrice(null)}
                className="text-white/80 hover:text-white p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3 bg-gray-50 p-3 border border-gray-200">
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Fonte:
                  </span>
                  <span className="font-bold text-[#124268] text-sm">
                    {detailModalPrice.source}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Identificador / ID:
                  </span>
                  <span className="font-mono text-gray-800">
                    {detailModalPrice.source_record_id || 'NÃO INFORMADO'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Data da Contratação:
                  </span>
                  <span className="text-gray-800">
                    {detailModalPrice.source_date
                      ? new Date(detailModalPrice.source_date).toLocaleDateString('pt-BR')
                      : 'NÃO INFORMADO'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Preço Unitário:
                  </span>
                  <span className="font-bold text-emerald-700 text-sm font-mono">
                    R$ {detailModalPrice.unit_price.toFixed(4)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Órgão Comprador:
                  </span>
                  <span className="text-gray-900 font-medium">
                    {detailModalPrice.government_entity || 'NÃO INFORMADO'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Fornecedor Vencedor:
                  </span>
                  <span className="text-gray-900 font-medium">
                    {detailModalPrice.supplier || 'NÃO INFORMADO'} (CNPJ:{' '}
                    {detailModalPrice.supplier_document || 'NÃO INFORMADO'})
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block text-[10px] uppercase font-bold">
                    Descrição Registrada na Fonte:
                  </span>
                  <p className="text-gray-800 bg-gray-50 p-2 border border-gray-200 font-mono text-[11px]">
                    {detailModalPrice.description_original}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <span className="text-gray-500 block">Unidade de Fornecimento:</span>
                    <strong className="text-gray-800">{detailModalPrice.unit}</strong>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Quantidade Adquirida:</span>
                    <strong className="text-gray-800">
                      {detailModalPrice.quantity.toLocaleString('pt-BR')}
                    </strong>
                  </div>
                </div>
              </div>

              {detailModalPrice.source_url && (
                <div className="pt-2 border-t border-gray-200 flex justify-between items-center">
                  <span className="text-[11px] text-gray-500">Documento / Link Oficial:</span>
                  <a
                    href={detailModalPrice.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#124268] hover:underline font-bold text-xs inline-flex items-center gap-1"
                  >
                    Abrir URL da Fonte
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              )}
            </div>

            <div className="bg-gray-100 p-3 border-t border-gray-300 flex justify-end">
              <Button
                type="button"
                onClick={() => setDetailModalPrice(null)}
                className="h-8 px-4 text-xs font-bold uppercase rounded-none bg-[#124268] text-white"
              >
                FECHAR
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
