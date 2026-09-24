import React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  TrendingUp,
  DollarSign,
  CheckCircle,
  AlertTriangle,
  Clock,
  Sparkles,
  BarChart3,
  Layers,
  Building,
  HelpCircle,
} from 'lucide-react'
import { formatarMoeda } from '@/lib/calculoEngine'

interface ResumoCotacaoCardsProps {
  totalItens: number
  itensConcluidos: number
  itensProcessando: number
  itensRevisao: number
  itensSemResultados: number
  precosEncontrados: number
  precosValidos: number
  precosSelecionados: number
  fornecedoresEncontrados: number
  valorMinimoTotal: number
  valorMediaTotal: number
  valorMedianaTotal: number
  valorPonderadaTotal: number
}

export const ResumoCotacaoCards: React.FC<ResumoCotacaoCardsProps> = ({
  totalItens,
  itensConcluidos,
  itensProcessando,
  itensRevisao,
  itensSemResultados,
  precosEncontrados,
  precosValidos,
  precosSelecionados,
  fornecedoresEncontrados,
  valorMinimoTotal,
  valorMediaTotal,
  valorMedianaTotal,
  valorPonderadaTotal,
}) => {
  return (
    <div className="space-y-4">
      {/* 1. Métricas Financeiras Globais */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="border-l-4 border-l-emerald-500 bg-white dark:bg-slate-900 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">
                Estimativa por Mediana (Ref.)
              </p>
              <h3 className="text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">
                {formatarMoeda(valorMedianaTotal)}
              </h3>
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5 flex items-center gap-1 font-medium">
                <CheckCircle className="w-3 h-3" /> Padrão Cesta de Preços
              </p>
            </div>
            <div className="w-10 h-10 rounded-full bg-emerald-50 dark:bg-emerald-950/60 flex items-center justify-center text-emerald-600">
              <DollarSign className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-blue-500 bg-white dark:bg-slate-900 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">
                Estimativa por Média
              </p>
              <h3 className="text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">
                {formatarMoeda(valorMediaTotal)}
              </h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">Média aritmética saneada</p>
            </div>
            <div className="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-950/60 flex items-center justify-center text-blue-600">
              <BarChart3 className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-indigo-500 bg-white dark:bg-slate-900 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">
                Média Ponderada
              </p>
              <h3 className="text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">
                {formatarMoeda(valorPonderadaTotal)}
              </h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Ponderada pelo volume contratado
              </p>
            </div>
            <div className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center text-indigo-600">
              <TrendingUp className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500 bg-white dark:bg-slate-900 shadow-sm">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">
                Menor Preço Encontrado
              </p>
              <h3 className="text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">
                {formatarMoeda(valorMinimoTotal)}
              </h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">Piso entre itens válidos</p>
            </div>
            <div className="w-10 h-10 rounded-full bg-amber-50 dark:bg-amber-950/60 flex items-center justify-center text-amber-600">
              <DollarSign className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. Funil de Estágios de Preços e Contadores de Itens */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <div className="p-2.5 rounded-lg border bg-slate-50 dark:bg-slate-900/60 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase">
            Total Itens
          </span>
          <span className="text-lg font-bold">{totalItens}</span>
        </div>

        <div className="p-2.5 rounded-lg border bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase">
            Concluídos
          </span>
          <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400">
            {itensConcluidos}
          </span>
        </div>

        <div className="p-2.5 rounded-lg border bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400 uppercase">
            Revisão
          </span>
          <span className="text-lg font-bold text-amber-700 dark:text-amber-400">
            {itensRevisao}
          </span>
        </div>

        <div className="p-2.5 rounded-lg border bg-rose-50/50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-rose-700 dark:text-rose-400 uppercase">
            Sem Resultados
          </span>
          <span className="text-lg font-bold text-rose-700 dark:text-rose-400">
            {itensSemResultados}
          </span>
        </div>

        {/* Funil de Preços */}
        <div className="p-2.5 rounded-lg border bg-slate-50 dark:bg-slate-900/60 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase">
            Encontrados
          </span>
          <span className="text-lg font-bold">{precosEncontrados}</span>
        </div>

        <div className="p-2.5 rounded-lg border bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-blue-700 dark:text-blue-400 uppercase">
            Válidos
          </span>
          <span className="text-lg font-bold text-blue-700 dark:text-blue-400">
            {precosValidos}
          </span>
        </div>

        <div className="p-2.5 rounded-lg border bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase">
            Na Cesta
          </span>
          <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400">
            {precosSelecionados}
          </span>
        </div>

        <div className="p-2.5 rounded-lg border bg-purple-50/50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-900 flex flex-col justify-between">
          <span className="text-[10px] font-semibold text-purple-700 dark:text-purple-400 uppercase">
            Fornecedores
          </span>
          <span className="text-lg font-bold text-purple-700 dark:text-purple-400">
            {fornecedoresEncontrados}
          </span>
        </div>
      </div>
    </div>
  )
}
