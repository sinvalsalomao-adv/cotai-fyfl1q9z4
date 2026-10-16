import React, { useState, useEffect, useMemo } from 'react'
import { Filter, Check, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'

export interface ItemFonteContagem {
  /** Chave unificada para filtro interno (ex: 'PNCP', 'Compras.gov.br', 'BPS') */
  key: string
  /** Rótulo legível para exibição ao usuário */
  label: string
  /** Quantidade de amostras disponíveis nesta fonte na grade */
  count: number
  /** População de preços no índice para a consulta; ausente significa desconhecida, não zero. */
  indexedCount?: number
}

interface FiltroFonteMultiploProps {
  /** Lista de fontes computadas dinamicamente a partir das amostras carregadas */
  fontesDisponiveis: ItemFonteContagem[]
  /** Fontes ativas aplicadas na grade ([] significa todas as fontes) */
  fontesSelecionadas: string[]
  /** Callback disparado quando o usuário clica em "Aplicar" ou remove um filtro */
  onAplicar: (novasFontes: string[]) => void
  /** Variante visual: cabeçalho da grade ('header') ou painel lateral ('sidebar') */
  variante?: 'header' | 'sidebar'
  /** Desabilitado se não houver amostras */
  disabled?: boolean
}

export const FiltroFonteMultiplo: React.FC<FiltroFonteMultiploProps> = ({
  fontesDisponiveis,
  fontesSelecionadas,
  onAplicar,
  variante = 'header',
  disabled = false,
}) => {
  const [aberto, setAberto] = useState(false)
  // Rascunho interno: só comita no onAplicar após o clique do botão [Aplicar]
  const [rascunho, setRascunho] = useState<string[]>(fontesSelecionadas)

  // Sincroniza rascunho quando o popover abre ou fontesSelecionadas mudam externamente
  useEffect(() => {
    setRascunho(fontesSelecionadas)
  }, [fontesSelecionadas, aberto])

  const totalAmostrasGeral = useMemo(() => {
    return fontesDisponiveis.reduce((acc, f) => acc + f.count, 0)
  }, [fontesDisponiveis])

  const todasSelecionadas = rascunho.length === 0

  const handleToggleFonte = (key: string) => {
    if (rascunho.length === 0) {
      // Estava em "Todas" e o usuário marcou uma específica
      setRascunho([key])
      return
    }

    if (rascunho.includes(key)) {
      const proximo = rascunho.filter((k) => k !== key)
      setRascunho(proximo)
    } else {
      setRascunho([...rascunho, key])
    }
  }

  const handleSelecionarTodas = () => {
    setRascunho([]) // Lista vazia = Todas
  }

  const handleConfirmar = () => {
    onAplicar(rascunho)
    setAberto(false)
  }

  const handleCancelar = () => {
    setRascunho(fontesSelecionadas)
    setAberto(false)
  }

  const temFiltroAtivo = fontesSelecionadas.length > 0

  // Formatação do resumo no botão do trigger
  const labelTrigger = useMemo(() => {
    if (!temFiltroAtivo) {
      return 'Fonte: Todas'
    }
    if (fontesSelecionadas.length === 1) {
      const match = fontesDisponiveis.find((f) => f.key === fontesSelecionadas[0])
      return `Fonte: ${match?.label || fontesSelecionadas[0]}`
    }
    return `Fontes: (${fontesSelecionadas.length}) selecionadas`
  }, [fontesSelecionadas, temFiltroAtivo, fontesDisponiveis])

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        {variante === 'header' ? (
          <button
            type="button"
            disabled={disabled || fontesDisponiveis.length === 0}
            className={`h-6 text-[10px] uppercase font-bold px-2 inline-flex items-center gap-1.5 transition-colors border select-none ${
              temFiltroAtivo
                ? 'bg-amber-400 text-gray-950 border-amber-500 hover:bg-amber-300 shadow-xs'
                : 'bg-white text-gray-800 border-gray-300 hover:bg-gray-100'
            } ${disabled || fontesDisponiveis.length === 0 ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            title="Filtrar grade por uma ou mais fontes com confirmação obrigatória"
          >
            <Filter className="h-3 w-3 flex-shrink-0" />
            <span className="truncate max-w-[190px]">{labelTrigger}</span>
            {temFiltroAtivo && (
              <span className="ml-0.5 rounded-full bg-gray-900 text-white text-[9px] w-4 h-4 flex items-center justify-center font-mono">
                {fontesSelecionadas.length}
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || fontesDisponiveis.length === 0}
            className={`w-full h-7 text-[11px] rounded-none border px-2 font-medium flex items-center justify-between transition-colors ${
              temFiltroAtivo
                ? 'bg-amber-50 border-amber-400 text-amber-950 font-bold'
                : 'bg-white border-[#94a3b8] text-gray-800 hover:bg-gray-50'
            }`}
          >
            <span className="flex items-center gap-1.5 truncate">
              <Filter className="h-3 w-3 text-gray-600 flex-shrink-0" />
              <span className="truncate">{labelTrigger}</span>
            </span>
            <span className="text-[10px] text-gray-500 font-mono">
              {temFiltroAtivo ? `[${fontesSelecionadas.length}]` : '▼'}
            </span>
          </button>
        )}
      </PopoverTrigger>

      <PopoverContent
        align={variante === 'header' ? 'end' : 'start'}
        sideOffset={6}
        className="w-72 p-0 bg-white border border-gray-300 shadow-lg rounded-none text-xs z-50"
      >
        {/* Cabeçalho do Popover */}
        <div className="bg-[#124268] text-white px-3 py-2 flex items-center justify-between select-none">
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-amber-300" />
            <span className="font-bold text-[11px] uppercase tracking-wide">Filtrar por Fonte</span>
          </div>
          <span className="text-[10px] text-white/80 font-mono">
            {fontesDisponiveis.length} fontes
          </span>
        </div>

        {/* Instrução clara do usuário */}
        <div className="px-3 pt-2 pb-1 bg-gray-50 border-b border-gray-200 text-[10.5px] text-gray-600">
          Selecione uma ou mais fontes e clique em <strong>Aplicar</strong> para atualizar a grade.
        </div>

        {/* Lista de Opções com Contagem */}
        <div className="p-2 space-y-1 max-h-60 overflow-y-auto">
          {/* Opção "Todas as Fontes" */}
          <label
            className={`flex items-center justify-between px-2 py-1.5 cursor-pointer text-[11px] font-semibold border transition-colors ${
              todasSelecionadas
                ? 'bg-blue-50 border-blue-300 text-blue-900'
                : 'border-transparent hover:bg-gray-100 text-gray-800'
            }`}
          >
            <div className="flex items-center gap-2">
              <Checkbox
                checked={todasSelecionadas}
                onCheckedChange={handleSelecionarTodas}
                className="rounded-none data-[state=checked]:bg-[#124268]"
              />
              <span>Todas as Fontes</span>
            </div>
            <span className="text-[10px] font-mono text-gray-500">
              ({totalAmostrasGeral.toLocaleString('pt-BR')} carregadas)
            </span>
          </label>

          <div className="my-1 border-t border-gray-200" />

          {/* Lista de fontes com checkboxes individuais */}
          {fontesDisponiveis.length === 0 ? (
            <div className="p-3 text-center text-gray-400 text-[11px]">
              Nenhuma fonte encontrada nas amostras carregadas.
            </div>
          ) : (
            fontesDisponiveis.map((f) => {
              const isChecked = rascunho.includes(f.key)
              return (
                <label
                  key={f.key}
                  className={`flex flex-wrap items-center justify-between gap-1 px-2 py-1.5 cursor-pointer text-[11px] border transition-colors ${
                    isChecked
                      ? 'bg-amber-50 border-amber-300 text-amber-950 font-bold'
                      : 'border-transparent hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 pr-1">
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => handleToggleFonte(f.key)}
                      className="rounded-none data-[state=checked]:bg-[#124268]"
                    />
                    <span className="truncate" title={f.label}>
                      {f.label}
                    </span>
                  </div>
                  <Badge
                    variant="outline"
                    className="font-mono text-[9.5px] px-1 py-0 rounded-none bg-white border-gray-300 text-gray-700 flex-shrink-0"
                  >
                    {`${f.count.toLocaleString('pt-BR')} carregadas${typeof f.indexedCount === 'number' ? ` · ${f.indexedCount.toLocaleString('pt-BR')} no índice` : ''}`}
                  </Badge>
                </label>
              )
            })
          )}
        </div>

        {/* Rodapé com Botão CONFIRMAR / APLICAR e Cancelar */}
        <div className="p-2 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleSelecionarTodas}
            className="text-[10px] text-gray-600 hover:text-gray-900 underline cursor-pointer"
          >
            Limpar seleção
          </button>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCancelar}
              className="h-6 px-2 text-[10px] rounded-none uppercase font-semibold text-gray-700 border-gray-300"
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleConfirmar}
              className="h-6 px-3 text-[10px] rounded-none uppercase font-bold bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex items-center gap-1"
            >
              <Check className="h-3 w-3" />
              <span>Aplicar</span>
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Chip / Badge visual que fica acima ou no topo da grade indicando fontes ativas
 * e permitindo remoção rápida com um clique no "x".
 */
export const ChipFiltroFonteAtivo: React.FC<{
  fontesSelecionadas: string[]
  fontesDisponiveis: ItemFonteContagem[]
  onRemoverFonte: (fonte: string) => void
  onLimparTodas: () => void
  totalFiltradas: number
  totalGeral: number
}> = ({
  fontesSelecionadas,
  fontesDisponiveis,
  onRemoverFonte,
  onLimparTodas,
  totalFiltradas,
  totalGeral,
}) => {
  if (fontesSelecionadas.length === 0) return null

  const getLabel = (key: string) => {
    const item = fontesDisponiveis.find((f) => f.key === key)
    return item ? item.label : key
  }

  return (
    <div className="bg-amber-50/90 border border-amber-300 px-2.5 py-1.5 text-xs flex flex-wrap items-center justify-between gap-2 select-none">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-bold text-[10.5px] uppercase tracking-wide text-amber-950 flex items-center gap-1">
          <Filter className="h-3 w-3 text-amber-700" />
          Filtro de Fonte Ativo:
        </span>
        {fontesSelecionadas.map((fonteKey) => (
          <Badge
            key={fonteKey}
            className="rounded-none bg-[#124268] text-white font-bold text-[10px] px-2 py-0.5 inline-flex items-center gap-1 hover:bg-[#0c314f] transition-colors"
          >
            <span>{getLabel(fonteKey)}</span>
            <button
              type="button"
              onClick={() => onRemoverFonte(fonteKey)}
              className="hover:text-amber-300 p-0.5 ml-0.5 cursor-pointer"
              title={`Remover filtro da fonte ${getLabel(fonteKey)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <span className="text-[10px] text-amber-900 font-mono ml-1">
          (Exibindo <strong>{totalFiltradas.toLocaleString('pt-BR')}</strong> de{' '}
          {totalGeral.toLocaleString('pt-BR')} amostras carregadas)
        </span>
      </div>

      <button
        type="button"
        onClick={onLimparTodas}
        className="text-[10.5px] font-bold text-amber-900 hover:text-amber-950 underline cursor-pointer"
        title="Remover filtro de fonte e mostrar todas"
      >
        Ver todas as fontes
      </button>
    </div>
  )
}
