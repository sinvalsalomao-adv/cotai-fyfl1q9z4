import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileText,
  Info,
  Layers,
  Sparkles,
} from 'lucide-react'
import type { CotacaoItem, CotacaoPriceRecord } from '@/types'
import { formatarMoeda } from '@/lib/calculoEngine'

interface ModalPrecosDoItemProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: CotacaoItem | null
  precos: CotacaoPriceRecord[]
  onAtualizarDecisao: (precoId: string, decisao: 'manter' | 'descartar', motivo?: string) => void
}

export const ModalPrecosDoItem: React.FC<ModalPrecosDoItemProps> = ({
  open,
  onOpenChange,
  item,
  precos,
  onAtualizarDecisao,
}) => {
  const [abaEstagio, setAbaEstagio] = useState<string>('todos')

  if (!item) return null

  // Filtro por estágio dos preços
  // PREÇO ENCONTRADO -> PREÇO COMPATÍVEL -> PREÇO NORMALIZADO -> PREÇO VÁLIDO -> PREÇO SELECIONADO
  const precosFiltrados = precos.filter((p) => {
    if (abaEstagio === 'todos') return true
    if (abaEstagio === 'selecionados') return p.estagio === 'selecionado'
    if (abaEstagio === 'validos') return p.estagio === 'valido' || p.estagio === 'selecionado'
    if (abaEstagio === 'compativeis') return p.estagio !== 'encontrado'
    if (abaEstagio === 'regulatorios') return p.is_regulatorio
    if (abaEstagio === 'descartados') return p.decisao_humana === 'descartar'
    return true
  })

  const getFaixaBadge = (faixa?: string, score?: number) => {
    if (score && score >= 95) {
      return (
        <Badge className="bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border-emerald-300 text-[10px]">
          ALTA ({score}%)
        </Badge>
      )
    }
    if (score && score >= 85) {
      return (
        <Badge className="bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300 text-[10px]">
          BOA ({score}%)
        </Badge>
      )
    }
    if (score && score >= 70) {
      return (
        <Badge className="bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300 text-[10px]">
          REVISÃO ({score}%)
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        BAIXA ({score || 0}%)
      </Badge>
    )
  }

  const getFonteBadge = (fonte: string, isRegulatorio?: boolean) => {
    if (isRegulatorio || fonte === 'cmed') {
      return (
        <Badge className="bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300 border-purple-300 text-[10px] font-bold">
          CMED (TETO REGULATÓRIO)
        </Badge>
      )
    }
    const map: Record<string, string> = {
      pncp: 'PNCP (Oficial)',
      compras_gov: 'Compras.gov.br',
      bps: 'BPS Saúde',
      bec_sp: 'BEC-SP',
      sinapi: 'SINAPI',
      sicro: 'SICRO',
    }
    return (
      <Badge variant="secondary" className="text-[10px] uppercase font-mono">
        {map[fonte] || fonte}
      </Badge>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs font-mono">
                  Item #{item.numero_item}
                </Badge>
                <DialogTitle className="text-lg">{item.descricao_original}</DialogTitle>
              </div>
              <DialogDescription className="text-xs">
                {item.descricao_normalizada || item.descricao_original} — Quantidade:{' '}
                <strong>
                  {item.quantidade.toLocaleString('pt-BR')} {item.unidade}
                </strong>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Funil de Estágios do Item */}
        <div className="bg-slate-50 dark:bg-slate-900 border rounded-lg p-3 grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
          <div className="p-2 border rounded bg-white dark:bg-slate-800">
            <span className="text-muted-foreground block text-[10px] uppercase">
              1. Encontrados
            </span>
            <strong className="text-base text-slate-800 dark:text-slate-100">
              {item.qtd_encontrados || precos.length}
            </strong>
          </div>
          <div className="p-2 border rounded bg-white dark:bg-slate-800">
            <span className="text-muted-foreground block text-[10px] uppercase">
              2. Compatíveis
            </span>
            <strong className="text-base text-blue-600">
              {item.qtd_compativeis || precos.filter((p) => p.estagio !== 'encontrado').length}
            </strong>
          </div>
          <div className="p-2 border rounded bg-white dark:bg-slate-800">
            <span className="text-muted-foreground block text-[10px] uppercase">
              3. Normalizados
            </span>
            <strong className="text-base text-indigo-600">
              {item.qtd_normalizados || precos.filter((p) => p.normalized_unit_price).length}
            </strong>
          </div>
          <div className="p-2 border rounded bg-white dark:bg-slate-800">
            <span className="text-muted-foreground block text-[10px] uppercase">
              4. Válidos (Saneados)
            </span>
            <strong className="text-base text-teal-600">
              {item.qtd_validos ||
                precos.filter((p) => p.estagio === 'valido' || p.estagio === 'selecionado').length}
            </strong>
          </div>
          <div className="p-2 border rounded bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200">
            <span className="text-emerald-700 dark:text-emerald-300 block text-[10px] uppercase font-bold">
              5. Cesta Selecionada
            </span>
            <strong className="text-base text-emerald-700 dark:text-emerald-300">
              {item.qtd_selecionados || precos.filter((p) => p.estagio === 'selecionado').length}
            </strong>
          </div>
        </div>

        {/* Abas por estágio */}
        <Tabs value={abaEstagio} onValueChange={setAbaEstagio} className="w-full">
          <TabsList className="grid grid-cols-4 sm:grid-cols-6 text-xs h-8">
            <TabsTrigger value="todos" className="text-xs">
              Todos ({precos.length})
            </TabsTrigger>
            <TabsTrigger value="selecionados" className="text-xs">
              Na Cesta
            </TabsTrigger>
            <TabsTrigger value="validos" className="text-xs">
              Válidos
            </TabsTrigger>
            <TabsTrigger value="compativeis" className="text-xs">
              Compatíveis
            </TabsTrigger>
            <TabsTrigger value="regulatorios" className="text-xs">
              CMED / Teto
            </TabsTrigger>
            <TabsTrigger value="descartados" className="text-xs">
              Descartados
            </TabsTrigger>
          </TabsList>

          <TabsContent value={abaEstagio} className="pt-2">
            <div className="rounded-md border bg-white dark:bg-slate-900 overflow-x-auto">
              <Table className="text-xs">
                <TableHeader className="bg-slate-50 dark:bg-slate-800">
                  <TableRow>
                    <TableHead className="w-24">Fonte</TableHead>
                    <TableHead className="min-w-[180px]">Fornecedor & CNPJ</TableHead>
                    <TableHead className="min-w-[180px]">Órgão & Localização</TableHead>
                    <TableHead className="w-20">Data</TableHead>
                    <TableHead className="w-28 text-right">Preço Original</TableHead>
                    <TableHead className="w-28 text-right font-bold text-emerald-600">
                      Unitário Norm.
                    </TableHead>
                    <TableHead className="w-24 text-center">Similaridade</TableHead>
                    <TableHead className="w-24 text-center">Decisão</TableHead>
                    <TableHead className="w-24 text-right">Origem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {precosFiltrados.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-6 text-muted-foreground">
                        Nenhum registro para esta categoria de estágio.
                      </TableCell>
                    </TableRow>
                  ) : (
                    precosFiltrados.map((p) => {
                      const isDescartado = p.decisao_humana === 'descartar'
                      return (
                        <TableRow
                          key={p.id}
                          className={`hover:bg-slate-50/70 dark:hover:bg-slate-800/50 ${
                            isDescartado ? 'opacity-50 bg-slate-100/50 dark:bg-slate-900/40' : ''
                          }`}
                        >
                          <TableCell>
                            <div className="space-y-1">
                              {getFonteBadge(p.fonte, p.is_regulatorio)}
                              {p.possivel_duplicata && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] text-amber-600 block"
                                >
                                  Duplicata vinculada
                                </Badge>
                              )}
                            </div>
                          </TableCell>

                          <TableCell>
                            <div>
                              <p className="font-semibold text-slate-800 dark:text-slate-200">
                                {p.supplier || 'NÃO INFORMADO'}
                              </p>
                              <p className="text-[11px] text-muted-foreground font-mono">
                                {p.supplier_cnpj || 'CNPJ NÃO INFORMADO'}
                              </p>
                            </div>
                          </TableCell>

                          <TableCell>
                            <div>
                              <p className="font-medium text-slate-700 dark:text-slate-300">
                                {p.orgao_comprador || 'NÃO INFORMADO'}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {p.municipio && p.uf ? `${p.municipio} - ${p.uf}` : 'NÃO INFORMADO'}
                              </p>
                            </div>
                          </TableCell>

                          <TableCell className="text-muted-foreground text-[11px]">
                            {p.purchase_date
                              ? new Date(p.purchase_date).toLocaleDateString('pt-BR')
                              : 'NÃO INFORMADO'}
                          </TableCell>

                          <TableCell className="text-right text-muted-foreground">
                            {formatarMoeda(p.unit_price)}
                            <span className="text-[10px] block">/{p.unit}</span>
                          </TableCell>

                          <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                            {formatarMoeda(p.normalized_unit_price)}
                            <span className="text-[10px] block font-mono text-muted-foreground">
                              /{p.normalized_unit || p.unit}
                            </span>
                          </TableCell>

                          <TableCell className="text-center">
                            {getFaixaBadge(p.faixa_similaridade, p.similarity_score)}
                          </TableCell>

                          {/* Decisão Humana */}
                          <TableCell className="text-center">
                            {p.is_regulatorio ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] border-purple-300 text-purple-700"
                              >
                                Referência Teto
                              </Badge>
                            ) : isDescartado ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-[10px] text-amber-700"
                                onClick={() => onAtualizarDecisao(p.id, 'manter')}
                              >
                                Reativar
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-[10px] text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                                onClick={() =>
                                  onAtualizarDecisao(
                                    p.id,
                                    'descartar',
                                    'Descartado por juízo crítico do responsável técnico',
                                  )
                                }
                              >
                                Descartar
                              </Button>
                            )}
                          </TableCell>

                          {/* Origem e Rastreabilidade */}
                          <TableCell className="text-right">
                            {p.source_url ? (
                              <a
                                href={p.source_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline font-medium"
                              >
                                Origem <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">Base Gov</span>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
