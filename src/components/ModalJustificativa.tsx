import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { AlertCircle, FileText, CheckCircle2, ShieldAlert, X } from 'lucide-react'
import type { CotacaoItem } from '@/types'

interface ModalJustificativaProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: CotacaoItem | null
  onSalvar: (justificativa: string) => void
}

export const ModalJustificativa: React.FC<ModalJustificativaProps> = ({
  open,
  onOpenChange,
  item,
  onSalvar,
}) => {
  const [texto, setTexto] = React.useState('')

  React.useEffect(() => {
    if (item) {
      setTexto(item.justificativa_amostra_minima || '')
    }
  }, [item])

  if (!item) return null

  const handleSalvar = () => {
    if (!texto.trim() || texto.trim().length < 10) {
      alert('A justificativa técnica precisa conter pelo menos 10 caracteres fundamentados.')
      return
    }
    onSalvar(texto)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden flex flex-col bg-[#eef1f4] text-[#222] border border-[#7d8b99] shadow-2xl rounded-none font-sans text-xs">
        {/* BARRA SUPERIOR AZUL-ESCURA */}
        <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none border-b border-[#0c314f] flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-white" />
            <span className="font-bold text-xs sm:text-sm tracking-wider uppercase">
              CRÍTICA DOS DADOS: JUSTIFICATIVA OU OBSERVAÇÃO
            </span>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="text-white/80 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 bg-[#eef1f4]">
          {/* AVISO REGULATÓRIO */}
          <div className="p-2.5 bg-[#fefce8] border-l-4 border-l-[#eab308] border border-[#fef08a] text-[11px] text-[#854d0e]">
            <p className="font-bold uppercase tracking-tight">
              1. FORAM COLETADAS MENOS DE TRÊS AMOSTRAS VÁLIDAS. É PRECISO JUSTIFICAR ESTE ITEM DO
              ORÇAMENTO.
            </p>
            <p className="text-[10.5px] mt-0.5 leading-relaxed">
              Conforme as diretrizes da Lei nº 14.133/2021 e Instrução Normativa SEGES, a adoção de
              cesta de preços com menos de 3 amostras válidas exige justificativa circunstanciada
              nos autos.
            </p>
          </div>

          {/* ITEM REFERENCIADO */}
          <div className="bg-white border border-[#b8c2cc] p-2.5 space-y-1">
            <span className="text-[10px] font-bold text-[#6b7280] uppercase block">
              Item #{item.numero_item || 1}
            </span>
            <p className="font-bold text-[11px] text-[#1f2937]">
              {item.descricao_normalizada || item.descricao_original}
            </p>
            <p className="text-[10px] text-[#4b5563] font-mono">
              Amostras Válidas: <strong>{item.total_precos_validos || 0}</strong> | Preço Ref.:{' '}
              <strong>R$ {(item.preco_referencia || 0).toFixed(2)}</strong>
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-bold text-[#374151] uppercase">
              Texto da Justificativa Técnica / Motivação da Amostra
            </Label>
            <Textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Ex: Foram realizadas consultas exaustivas no PNCP, Compras.gov e BPS. Contudo, em razão da especificidade da formulação/especificação, foram encontradas somente 2 contratações públicas recentes..."
              rows={5}
              className="text-xs bg-white border-[#94a3b8] rounded-none focus-visible:ring-1 focus-visible:ring-[#124268]"
            />
          </div>
        </div>

        {/* RODAPÉ */}
        <div className="bg-[#e5e7eb] border-t border-[#9ca3af] px-4 py-2.5 flex items-center justify-between select-none">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-7 text-xs rounded-none border-[#9ca3af] bg-white text-[#374151]"
          >
            Cancelar
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSalvar}
            className="h-7 text-xs rounded-none bg-[#124268] hover:bg-[#0c314f] text-white font-bold uppercase tracking-wider"
          >
            Salvar Justificativa no Dossiê
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
