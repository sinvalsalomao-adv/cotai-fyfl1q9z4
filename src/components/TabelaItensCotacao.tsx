import React, { useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  MoreVertical,
  Eye,
  RotateCcw,
  Sparkles,
  ShoppingBag,
  Trash2,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Clock,
  Layers,
} from 'lucide-react'
import type { CotacaoItem } from '@/types'
import { formatarMoeda } from '@/lib/calculoEngine'

interface TabelaItensCotacaoProps {
  itens: CotacaoItem[]
  onVerPrecos: (item: CotacaoItem) => void
  onVerAnaliseIa: (item: CotacaoItem) => void
  onRefazerItem: (item: CotacaoItem) => void
  onExcluirItem?: (item: CotacaoItem) => void
}

export const TabelaItensCotacao: React.FC<TabelaItensCotacaoProps> = ({
  itens,
  onVerPrecos,
  onVerAnaliseIa,
  onRefazerItem,
  onExcluirItem,
}) => {
  const [selecionados, setSelecionados] = useState<{ [id: string]: boolean }>({})

  const toggleSelectAll = (checked: boolean) => {
    const novo: { [id: string]: boolean } = {}
    if (checked) {
      itens.forEach((it) => (novo[it.id] = true))
    }
    setSelecionados(novo)
  }

  const toggleSelectOne = (id: string) => {
    setSelecionados((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const renderBadgeStatus = (status: CotacaoItem['status']) => {
    switch (status) {
      case 'concluido':
        return (
          <Badge className="bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border-emerald-300 flex items-center gap-1 font-medium">
            <CheckCircle2 className="w-3 h-3" /> Concluído
          </Badge>
        )
      case 'pesquisando':
      case 'processando':
        return (
          <Badge className="bg-blue-100 dark:bg-blue-950/80 text-blue-800 dark:text-blue-300 border-blue-300 flex items-center gap-1 font-medium animate-pulse">
            <Clock className="w-3 h-3 animate-spin" /> Pesquisando
          </Badge>
        )
      case 'revisao_necessaria':
        return (
          <Badge className="bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border-amber-300 flex items-center gap-1 font-medium">
            <AlertCircle className="w-3 h-3" /> Revisão
          </Badge>
        )
      case 'sem_resultados':
        return (
          <Badge variant="outline" className="text-muted-foreground border-dashed">
            Sem Resultados
          </Badge>
        )
      case 'erro':
        return (
          <Badge variant="destructive" className="flex items-center gap-1 font-medium">
            <AlertCircle className="w-3 h-3" /> Erro
          </Badge>
        )
      default:
        return <Badge variant="secondary">Pendente</Badge>
    }
  }

  const totalSel = Object.values(selecionados).filter(Boolean).length

  return (
    <div className="space-y-2">
      {totalSel > 0 && (
        <div className="bg-primary/10 border border-primary/20 rounded-md p-2 flex items-center justify-between text-xs">
          <span>{totalSel} item(ns) selecionado(s)</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs">
              Recotou Selecionados
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs">
              Adicionar à Cesta em Lote
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-md border bg-white dark:bg-slate-900 overflow-x-auto shadow-sm">
        <Table className="text-xs">
          <TableHeader className="bg-slate-50 dark:bg-slate-800/80">
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={itens.length > 0 && totalSel === itens.length}
                  onCheckedChange={(c) => toggleSelectAll(Boolean(c))}
                />
              </TableHead>
              <TableHead className="w-16">Item</TableHead>
              <TableHead className="min-w-[220px]">Descrição & Catálogo</TableHead>
              <TableHead className="w-24 text-right">Qtd.</TableHead>
              <TableHead className="w-20">Unidade</TableHead>
              <TableHead className="text-right">Mínimo</TableHead>
              <TableHead className="text-right">Média</TableHead>
              <TableHead className="text-right font-semibold">Mediana (Ref.)</TableHead>
              <TableHead className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                Total Estimado
              </TableHead>
              <TableHead className="text-center w-28">Estágios Preços</TableHead>
              <TableHead className="w-28 text-center">Status</TableHead>
              <TableHead className="w-14 text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {itens.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="text-center py-8 text-muted-foreground">
                  Nenhum item cadastrado nesta cotação. Clique em "+ ADICIONAR ITEM" acima.
                </TableCell>
              </TableRow>
            ) : (
              itens.map((item) => (
                <TableRow key={item.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/50">
                  <TableCell>
                    <Checkbox
                      checked={Boolean(selecionados[item.id])}
                      onCheckedChange={() => toggleSelectOne(item.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium text-slate-500">#{item.numero_item}</TableCell>
                  <TableCell>
                    <div className="space-y-0.5">
                      <div className="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                        <span>{item.descricao_original}</span>
                        {item.confidence_score && item.confidence_score >= 90 && (
                          <span
                            title={`Identificado por IA: ${item.confidence_score}% de confiança`}
                            className="inline-flex text-[10px] text-emerald-600 dark:text-emerald-400 font-bold items-center gap-0.5"
                          >
                            <Sparkles className="w-3 h-3" /> {item.confidence_score}%
                          </span>
                        )}
                      </div>

                      {item.codigo_catalogo && (
                        <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                          <span className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[10px]">
                            {item.codigo_catalogo}
                          </span>
                          {item.principio_ativo && (
                            <span className="text-slate-600 dark:text-slate-300">
                              {item.principio_ativo} {item.concentracao}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {item.quantidade?.toLocaleString('pt-BR')}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.unidade}
                    {item.unidade_normalizada && item.unidade_normalizada !== item.unidade && (
                      <span className="text-[10px] block text-primary font-mono">
                        ({item.unidade_normalizada})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {item.preco_minimo !== undefined && item.preco_minimo !== null
                      ? formatarMoeda(item.preco_minimo)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {item.preco_media !== undefined && item.preco_media !== null
                      ? formatarMoeda(item.preco_media)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-slate-900 dark:text-slate-100">
                    {item.preco_mediana !== undefined && item.preco_mediana !== null
                      ? formatarMoeda(item.preco_mediana)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                    {item.valor_total_item !== undefined && item.valor_total_item !== null
                      ? formatarMoeda(item.valor_total_item)
                      : '—'}
                  </TableCell>

                  {/* Estágios de Preços */}
                  <TableCell className="text-center">
                    <div
                      className="text-[10px] font-mono bg-slate-50 dark:bg-slate-800/60 p-1 rounded border inline-block"
                      title="Encontrados / Válidos / Na Cesta"
                    >
                      <span className="text-muted-foreground">{item.qtd_encontrados || 0}</span>
                      <span className="text-slate-300 dark:text-slate-600 mx-1">/</span>
                      <span className="text-blue-600 font-bold">{item.qtd_validos || 0}</span>
                      <span className="text-slate-300 dark:text-slate-600 mx-1">/</span>
                      <span className="text-emerald-600 font-bold">
                        {item.qtd_selecionados || 0}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell className="text-center">{renderBadgeStatus(item.status)}</TableCell>

                  {/* Ações */}
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="text-xs">
                        <DropdownMenuItem onClick={() => onVerPrecos(item)} className="gap-2">
                          <Eye className="w-3.5 h-3.5" /> Ver Preços ({item.qtd_encontrados || 0})
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onVerAnaliseIa(item)} className="gap-2">
                          <Sparkles className="w-3.5 h-3.5 text-primary" /> Análise com IA
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onRefazerItem(item)} className="gap-2">
                          <RotateCcw className="w-3.5 h-3.5" /> Refazer Pesquisa
                        </DropdownMenuItem>
                        {onExcluirItem && (
                          <DropdownMenuItem
                            onClick={() => onExcluirItem(item)}
                            className="gap-2 text-rose-600"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Remover Item
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
