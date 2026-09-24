import React from 'react'
import {
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  BarChart3,
  Scale,
  ShieldCheck,
  TrendingDown,
} from 'lucide-react'
import type { Cotacao } from '@/types'
import { formatarMoeda } from '@/lib/calculoEngine'

interface ResumoCotacaoCardsProps {
  cotacao: Cotacao
  totalItens: number
  itensConcluidos: number
  itensPendentes: number
  itensAtencao: number
  valorTotalEstimado: number
  totalPrecosColetados: number
  totalPrecosValidos: number
  totalPrecosExpurgados: number
  economiaIdentificada?: number
}

export const ResumoCotacaoCards: React.FC<ResumoCotacaoCardsProps> = ({
  cotacao,
  totalItens,
  itensConcluidos,
  itensPendentes,
  itensAtencao,
  valorTotalEstimado,
  totalPrecosColetados,
  totalPrecosValidos,
  totalPrecosExpurgados,
  economiaIdentificada = 0,
}) => {
  const percentualConcluido = totalItens > 0 ? Math.round((itensConcluidos / totalItens) * 100) : 0

  return (
    <div className="bg-white border border-[#b8c2cc] shadow-sm">
      <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between select-none">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 bg-white/90 border border-[#4a5059] flex-shrink-0" />
          <span>RESUMO CONSOLIDADO DA COTAÇÃO — PARÂMETROS GERAIS</span>
        </span>
        <span className="text-[10px] text-white/90 font-mono">
          STATUS: {cotacao.status.toUpperCase()}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 divide-x divide-y md:divide-y-0 divide-[#cbd5e1] text-xs bg-white">
        {/* TOTAL GERAL ESTIMADO */}
        <div className="p-2.5 space-y-0.5">
          <span className="text-[10px] text-[#4b5563] font-bold uppercase block tracking-wider">
            VALOR TOTAL ESTIMADO
          </span>
          <p className="font-mono font-bold text-sm sm:text-base text-[#124268]">
            {formatarMoeda(valorTotalEstimado)}
          </p>
          <span className="text-[9.5px] text-[#6b7280] block">Mediana consolidada por item</span>
        </div>

        {/* PROGRESSO DE ITENS */}
        <div className="p-2.5 space-y-0.5">
          <span className="text-[10px] text-[#4b5563] font-bold uppercase block tracking-wider">
            PROGRESSO DOS ITENS
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono font-bold text-sm sm:text-base text-[#111827]">
              {itensConcluidos} / {totalItens}
            </span>
            <span className="text-[10px] text-[#059669] font-bold font-mono">
              ({percentualConcluido}%)
            </span>
          </div>
          <span className="text-[9.5px] text-[#6b7280] block">
            {itensPendentes > 0 ? `${itensPendentes} pendentes de busca` : 'Todos cotados'}
          </span>
        </div>

        {/* PREÇOS COLETADOS */}
        <div className="p-2.5 space-y-0.5">
          <span className="text-[10px] text-[#4b5563] font-bold uppercase block tracking-wider">
            TOTAL DE AMOSTRAS
          </span>
          <p className="font-mono font-bold text-sm sm:text-base text-[#111827]">
            {totalPrecosColetados}
          </p>
          <span className="text-[9.5px] text-[#065f46] block font-medium">
            {totalPrecosValidos} válidas na cesta
          </span>
        </div>

        {/* JUÍZO CRÍTICO / EXPURGOS */}
        <div className="p-2.5 space-y-0.5">
          <span className="text-[10px] text-[#4b5563] font-bold uppercase block tracking-wider">
            AMOSTRAS EXPURGADAS
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-sm sm:text-base text-[#991b1b]">
              {totalPrecosExpurgados}
            </span>
            {totalPrecosExpurgados > 0 && (
              <span className="px-1 py-0.2 bg-[#fee2e2] text-[#991b1b] text-[9px] font-bold border border-[#fecaca]">
                DESCARTE MOTIVADO
              </span>
            )}
          </div>
          <span className="text-[9.5px] text-[#6b7280] block">Limites 70% / 130% mediana</span>
        </div>

        {/* CRÍTICAS / ITENS COM ATENÇÃO */}
        <div className="p-2.5 space-y-0.5">
          <span className="text-[10px] text-[#4b5563] font-bold uppercase block tracking-wider">
            CRÍTICAS (&lt; 3 AMOSTRAS)
          </span>
          <div className="flex items-center gap-1.5">
            <span
              className={`font-mono font-bold text-sm sm:text-base ${
                itensAtencao > 0 ? 'text-[#dc2626]' : 'text-[#059669]'
              }`}
            >
              {itensAtencao}
            </span>
            {itensAtencao > 0 ? (
              <span className="px-1.5 py-0.2 rounded-none bg-[#dc2626] text-white text-[9.5px] font-bold">
                EXIGE JUSTIFICATIVA
              </span>
            ) : (
              <span className="px-1 py-0.2 bg-[#d1fae5] text-[#065f46] text-[9px] font-bold border border-[#a7f3d0]">
                REGULAR
              </span>
            )}
          </div>
          <span className="text-[9.5px] text-[#6b7280] block">Conformidade Art. 23 Lei 14.133</span>
        </div>

        {/* ECONOMIA IDENTIFICADA */}
        <div className="p-2.5 space-y-0.5">
          <span className="text-[10px] text-[#4b5563] font-bold uppercase block tracking-wider">
            POTENCIAL DE ECONOMIA
          </span>
          <p className="font-mono font-bold text-sm sm:text-base text-[#047857]">
            {formatarMoeda(economiaIdentificada)}
          </p>
          <span className="text-[9.5px] text-[#6b7280] block">Ref. menor vs média oficial</span>
        </div>
      </div>
    </div>
  )
}
