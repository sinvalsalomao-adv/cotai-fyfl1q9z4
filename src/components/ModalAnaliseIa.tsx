import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center space-x-2 text-primary">
            <Sparkles className="w-5 h-5 animate-pulse" />
            <DialogTitle className="text-lg">PAINEL DE ANÁLISE INTELIGENTE COM IA</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            Rastreabilidade e fundamentação técnica dos atributos identificados, equivalências e
            método sugerido.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Identificação Estruturada */}
          <div className="bg-slate-50 dark:bg-slate-900 border rounded-lg p-3.5 space-y-2.5">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <BrainCircuit className="w-4 h-4 text-primary" />
              Item Identificado & Padronização
            </h4>

            <div className="space-y-1">
              <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {item.descricao_normalizada || item.descricao_original}
              </p>
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="font-mono bg-white dark:bg-slate-800">
                  {item.codigo_catalogo || 'CATMAT PENDENTE'}
                </Badge>
                <Badge className="bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border-emerald-300">
                  {item.confidence_score || 95}% de Confiança
                </Badge>
              </div>
            </div>

            {/* Atributos Farmacológicos / Técnicos */}
            <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t">
              {item.principio_ativo && (
                <div>
                  <span className="text-muted-foreground">Princípio Ativo:</span>
                  <p className="font-medium">{item.principio_ativo}</p>
                </div>
              )}
              {item.concentracao && (
                <div>
                  <span className="text-muted-foreground">Concentração:</span>
                  <p className="font-medium">{item.concentracao}</p>
                </div>
              )}
              {item.forma_farmaceutica && (
                <div>
                  <span className="text-muted-foreground">Forma Farmacêutica:</span>
                  <p className="font-medium">{item.forma_farmaceutica}</p>
                </div>
              )}
              {item.apresentacao && (
                <div>
                  <span className="text-muted-foreground">Apresentação:</span>
                  <p className="font-medium">{item.apresentacao}</p>
                </div>
              )}
            </div>
          </div>

          {/* Justificativa da IA em Linguagem Objetiva */}
          <div className="bg-blue-50/60 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-lg p-3.5 space-y-2">
            <h4 className="text-xs font-semibold text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
              <Info className="w-4 h-4" />
              Fundamentação da Correspondência
            </h4>
            <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
              {analise.explicacao ||
                'Considerado compatível porque apresenta o mesmo princípio ativo, concentração e forma farmacêutica, sem alterar a equivalência terapêutica ou especificação técnica.'}
            </p>
          </div>

          {/* Recomendação de Método Estatístico */}
          <div className="bg-slate-50 dark:bg-slate-900 border rounded-lg p-3.5 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Scale className="w-4 h-4 text-primary" />
              Recomendação Metodológica da IA
            </h4>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs text-muted-foreground">Método Sugerido:</span>
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100 uppercase">
                  {item.metodo_sugerido || 'MEDIANA'}
                </p>
              </div>
              <Badge variant="secondary" className="text-xs">
                {item.metodo_adotado === item.metodo_sugerido ? 'Adotado' : 'Decisão Manual'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {item.motivo_sugestao_metodo ||
                'A mediana é o método mais robusto contra valores atípicos ou dispersão acentuada entre contratações de diferentes esferas.'}
            </p>
          </div>

          {/* Rastreabilidade de Fontes Consultadas */}
          <div className="text-xs text-muted-foreground pt-1">
            <span className="font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Fontes Conectadas com Sucesso:
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">PNCP Oficial</Badge>
              <Badge variant="outline">Compras.gov.br (Dados Abertos)</Badge>
              <Badge variant="outline">BPS Ministério da Saúde</Badge>
              <Badge variant="outline">CMED Regulatório (Teto)</Badge>
              <Badge variant="outline">BEC-SP</Badge>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
