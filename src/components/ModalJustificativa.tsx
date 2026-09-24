import React, { useState } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AlertTriangle, ShieldCheck } from 'lucide-react'

interface ModalJustificativaProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tipoPadrao?: string
  titulo?: string
  descricao?: string
  onSalvar: (tipo: string, texto: string) => Promise<void>
}

export const ModalJustificativa: React.FC<ModalJustificativaProps> = ({
  open,
  onOpenChange,
  tipoPadrao = 'quantidade_insuficiente',
  titulo = 'Registrar Justificativa Formal',
  descricao = 'Em atendimento à Lei 14.133/2021, registre a fundamentação técnica para constar nos autos do processo.',
  onSalvar,
}) => {
  const [tipo, setTipo] = useState<string>(tipoPadrao)
  const [texto, setTexto] = useState<string>('')
  const [salvando, setSalvando] = useState<boolean>(false)

  const handleConfirmar = async () => {
    if (!texto.trim()) return
    setSalvando(true)
    try {
      await onSalvar(tipo, texto)
      setTexto('')
      onOpenChange(false)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center space-x-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-5 h-5" />
            <DialogTitle className="text-base">{titulo}</DialogTitle>
          </div>
          <DialogDescription className="text-xs">{descricao}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <div className="space-y-1">
            <Label className="text-xs">Motivo da Justificativa</Label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quantidade_insuficiente">
                  Amostra com menos de 3 preços válidos
                </SelectItem>
                <SelectItem value="exclusao_preco">
                  Exclusão de preço incompatível / inexequível
                </SelectItem>
                <SelectItem value="manutencao_outlier">
                  Manutenção de preço classificado como possível outlier
                </SelectItem>
                <SelectItem value="alteracao_metodo">
                  Alteração de método estatístico (ex: adoção da Média ou Menor Preço)
                </SelectItem>
                <SelectItem value="utilizacao_fonte_especifica">
                  Utilização de fonte específica ou restrição geográfica
                </SelectItem>
                <SelectItem value="outro">Outro motivo fundamentado</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Texto da Justificativa Técnica *</Label>
            <Textarea
              rows={4}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Descreva detalhadamente a justificativa para constar no relatório formal e no processo administrativo..."
              className="text-xs"
            />
            <span className="text-[10px] text-muted-foreground block">
              Esta manifestação será gravada de forma perene na trilha de auditoria e constará no
              documento final emitido.
            </span>
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={salvando}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmar}
            disabled={salvando || !texto.trim()}
            className="gap-1.5"
          >
            <ShieldCheck className="w-4 h-4" />
            Salvar Justificativa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
