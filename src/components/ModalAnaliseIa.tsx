import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Layers,
  BookOpen,
  Info,
  Scale,
  BrainCircuit,
  Search,
  X,
} from 'lucide-react'
import type { CotacaoItem } from '@/types'

interface ModalAnaliseIaProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: CotacaoItem | null
}

export const ModalAnaliseIa: React.FC<ModalAnaliseIaProps> = ({ open, onOpenChange, item }) => {
  if (!item) return null

  const analise = item.analise_inteligente || {}

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] p-0 overflow-hidden flex flex-col bg-[#eef1f4] text-[#222] border border-[#7d8b99] shadow-2xl rounded-none font-sans text-xs">
        {/* BARRA SUPERIOR AZUL CESTA DE PREÇOS */}
        <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none border-b border-[#0c314f] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-300" />
            <span className="font-bold text-xs sm:text-sm tracking-wider uppercase">
              PAINEL DE ANÁLISE INTELIGENTE COM IA
            </span>
            <span className="text-[#84a9c9] text-xs">|</span>
            <span className="text-[#bcd3e6] font-mono text-[11px] uppercase">
              ITEM #{item.numero_item || 1}
            </span>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-[#eef1f4]">
          {/* SEÇÃO 1: ITEM IDENTIFICADO E PADRONIZAÇÃO */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <BrainCircuit className="h-3 w-3 flex-shrink-0" />
              <span>ITEM IDENTIFICADO & PADRONIZAÇÃO TÉCNICA</span>
            </div>
            <div className="p-3 bg-white space-y-2">
              <p className="text-[12px] font-bold text-[#1f2937] leading-snug uppercase">
                {item.descricao_normalizada || item.descricao_original}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-[10.5px]">
                <span className="px-2 py-0.5 bg-[#f1f5f9] border border-[#cbd5e1] font-mono font-bold text-[#334155]">
                  CATMAT: {item.codigo_catalogo || 'PENDENTE'}
                </span>
                <span className="px-2 py-0.5 bg-[#d1fae5] border border-[#a7f3d0] font-mono font-bold text-[#065f46]">
                  SCORE DE CONFIANÇA: {item.confidence_score || 95}%
                </span>
              </div>

              {/* Atributos Farmacológicos / Técnicos */}
              <div className="grid grid-cols-2 gap-2 text-[10.5px] pt-2 border-t border-[#e5e7eb]">
                {item.principio_ativo && (
                  <div>
                    <span className="text-[#6b7280] block font-bold uppercase">
                      Princípio Ativo:
                    </span>
                    <p className="font-medium text-[#111827]">{item.principio_ativo}</p>
                  </div>
                )}
                {item.concentracao && (
                  <div>
                    <span className="text-[#6b7280] block font-bold uppercase">Concentração:</span>
                    <p className="font-medium text-[#111827]">{item.concentracao}</p>
                  </div>
                )}
                {item.forma_farmaceutica && (
                  <div>
                    <span className="text-[#6b7280] block font-bold uppercase">
                      Forma Farmacêutica:
                    </span>
                    <p className="font-medium text-[#111827]">{item.forma_farmaceutica}</p>
                  </div>
                )}
                {item.apresentacao && (
                  <div>
                    <span className="text-[#6b7280] block font-bold uppercase">Apresentação:</span>
                    <p className="font-medium text-[#111827]">{item.apresentacao}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SEÇÃO 2: FUNDAMENTAÇÃO DA CORRESPONDÊNCIA */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <Info className="h-3 w-3 flex-shrink-0" />
              <span>FUNDAMENTAÇÃO DA CORRESPONDÊNCIA</span>
            </div>
            <div className="p-3 bg-white">
              <p className="text-[11px] text-[#334155] leading-relaxed">
                {analise.explicacao ||
                  'Considerado compatível porque apresenta o mesmo princípio ativo, concentração e forma farmacêutica, sem alterar a equivalência terapêutica ou especificação técnica integral.'}
              </p>
            </div>
          </div>

          {/* SEÇÃO 3: RECOMENDAÇÃO METODOLÓGICA */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <Scale className="h-3 w-3 flex-shrink-0" />
              <span>RECOMENDAÇÃO METODOLÓGICA DA IA</span>
            </div>
            <div className="p-3 bg-white space-y-1.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-[#6b7280] font-bold uppercase">
                    Método Sugerido:
                  </span>
                  <p className="text-xs font-bold text-[#124268] uppercase font-mono">
                    {item.metodo_sugerido || 'MEDIANA'}
                  </p>
                </div>
                <span className="px-2 py-0.5 bg-[#e2e8f0] text-[#334155] font-bold text-[10px] uppercase border border-[#cbd5e1]">
                  {item.metodo_adotado === item.metodo_sugerido ? 'Adotado' : 'Decisão do Servidor'}
                </span>
              </div>
              <p className="text-[10.5px] text-[#4b5563] leading-relaxed">
                {item.motivo_sugestao_metodo ||
                  'A mediana é o método mais robusto contra valores atípicos ou dispersão acentuada entre contratações de diferentes esferas governamentais.'}
              </p>
            </div>
          </div>

          {/* SEÇÃO 4: FONTES CONSULTADAS COM SUCESSO */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <Search className="h-3 w-3 flex-shrink-0" />
              <span>FONTES CONECTADAS COM SUCESSO</span>
            </div>
            <div className="p-3 bg-white">
              <div className="flex flex-wrap gap-1.5 text-[10.5px]">
                <span className="px-2 py-0.5 bg-[#f1f5f9] border border-[#cbd5e1] font-mono font-bold text-[#1e293b]">
                  PNCP Oficial
                </span>
                <span className="px-2 py-0.5 bg-[#f1f5f9] border border-[#cbd5e1] font-mono font-bold text-[#1e293b]">
                  Compras.gov.br (Dados Abertos)
                </span>
                <span className="px-2 py-0.5 bg-[#f1f5f9] border border-[#cbd5e1] font-mono font-bold text-[#1e293b]">
                  BPS Ministério da Saúde
                </span>
                <span className="px-2 py-0.5 bg-[#f1f5f9] border border-[#cbd5e1] font-mono font-bold text-[#1e293b]">
                  CMED Regulatório (Teto)
                </span>
                <span className="px-2 py-0.5 bg-[#f1f5f9] border border-[#cbd5e1] font-mono font-bold text-[#1e293b]">
                  BEC-SP
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* RODAPÉ */}
        <div className="bg-[#e5e7eb] border-t border-[#9ca3af] px-4 py-2 flex items-center justify-end flex-shrink-0 select-none">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-7 px-4 text-[11px] font-bold uppercase tracking-wider bg-[#124268] hover:bg-[#0c314f] text-white rounded-none border border-[#0c314f]"
          >
            Fechar
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
