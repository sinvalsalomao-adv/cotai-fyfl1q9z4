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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sparkles,
  Play,
  RotateCcw,
  SlidersHorizontal,
  CheckCircle2,
  Clock,
  Layers,
  ShieldAlert,
} from 'lucide-react'
import type { CotacaoConfiguracao } from '@/types'

interface ModalCotacaoInteligenteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onIniciarCotacao: (config: CotacaoConfiguracao) => void
  totalItens: number
  isExecutando?: boolean
}

export const ModalCotacaoInteligente: React.FC<ModalCotacaoInteligenteProps> = ({
  open,
  onOpenChange,
  onIniciarCotacao,
  totalItens,
  isExecutando = false,
}) => {
  const [modo, setModo] = useState<'automatico' | 'avancado'>('automatico')

  // Configurações do modo avançado
  const [fontes, setFontes] = useState<{ [key: string]: boolean }>({
    pncp: true,
    compras_gov: true,
    bps: true,
    cmed: true,
    bec_sp: true,
    sinapi: false,
    sicro: false,
    fornecedores: false,
  })

  const [periodoMeses, setPeriodoMeses] = useState<number>(12)
  const [quantidadeMinima, setQuantidadeMinima] = useState<number>(3)
  const [metodoPadrao, setMetodoPadrao] = useState<
    'mediana' | 'media' | 'menor_preco' | 'media_saneada' | 'media_ponderada'
  >('mediana')
  const [deteccaoOutliers, setDeteccaoOutliers] = useState<
    'automatica' | 'iqr' | 'desvio_padrao' | 'nenhuma'
  >('automatica')
  const [normalizacaoUnidade, setNormalizacaoUnidade] = useState<boolean>(true)
  const [deduplicacao, setDeduplicacao] = useState<boolean>(true)
  const [ufFiltro, setUfFiltro] = useState<string>('TODAS')

  const toggleFonte = (key: string) => {
    setFontes((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const handleIniciar = () => {
    const fontesAtivas = Object.keys(fontes).filter((k) => fontes[k])
    const config: CotacaoConfiguracao = {
      modo,
      fontes:
        modo === 'automatico' ? ['pncp', 'compras_gov', 'bps', 'cmed', 'bec_sp'] : fontesAtivas,
      periodo_meses: periodoMeses,
      quantidade_minima: quantidadeMinima,
      metodo_padrao: metodoPadrao as any,
      deteccao_outliers: deteccaoOutliers,
      normalizacao_unidade: normalizacaoUnidade,
      deduplicacao,
      uf: ufFiltro === 'TODAS' ? undefined : ufFiltro,
    }
    onIniciarCotacao(config)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center space-x-2 text-primary">
            <Sparkles className="w-6 h-6 animate-pulse" />
            <DialogTitle className="text-xl">COTAÇÃO INTELIGENTE COM IA</DialogTitle>
          </div>
          <DialogDescription>
            O sistema realizará automaticamente a pesquisa de preços para os {totalItens} itens
            desta cotação com busca multifonte, normalização semântica, deduplicação e análise
            estatística.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={modo} onValueChange={(v) => setModo(v as any)} className="w-full mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="automatico" className="flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4" />
              <span>Modo Automático (Padrão do Órgão)</span>
            </TabsTrigger>
            <TabsTrigger value="avancado" className="flex items-center space-x-2">
              <SlidersHorizontal className="w-4 h-4" />
              <span>Modo Avançado (Personalizado)</span>
            </TabsTrigger>
          </TabsList>

          {/* MODO AUTOMÁTICO */}
          <TabsContent value="automatico" className="space-y-4 pt-4">
            <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
              <h4 className="font-semibold text-sm flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" />
                Parâmetros Regulamentares Pré-definidos
              </h4>
              <p className="text-xs text-muted-foreground">
                Configurações alinhadas com as diretrizes da Lei 14.133/2021, Instrução Normativa
                SEGES e o regulamento interno do órgão:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="p-2.5 bg-white dark:bg-slate-800 rounded border">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Fontes Oficiais:
                  </span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge variant="secondary" className="text-[10px]">
                      PNCP
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      Compras.gov.br
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      BPS (Saúde)
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      CMED (Regulatório)
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      BEC-SP
                    </Badge>
                  </div>
                </div>

                <div className="p-2.5 bg-white dark:bg-slate-800 rounded border">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Período de Validade:
                  </span>
                  <p className="text-muted-foreground mt-1">
                    Últimos 12 meses (priorização por contemporaneidade)
                  </p>
                </div>

                <div className="p-2.5 bg-white dark:bg-slate-800 rounded border">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Amostra Mínima:
                  </span>
                  <p className="text-muted-foreground mt-1">
                    3 preços válidos (alerta com justificativa obrigatória)
                  </p>
                </div>

                <div className="p-2.5 bg-white dark:bg-slate-800 rounded border">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Critério Estatístico:
                  </span>
                  <p className="text-muted-foreground mt-1">
                    Mediana de referência com juízo crítico (70% - 130%)
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 p-2.5 rounded border border-amber-200 text-xs">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>
                  <strong>Aviso de Rastreabilidade:</strong> Nenhuma exclusão silenciosa será feita.
                  Todos os outliers ou anomalias serão apresentados para ratificação humana.
                </span>
              </div>
            </div>
          </TabsContent>

          {/* MODO AVANÇADO */}
          <TabsContent value="avancado" className="space-y-4 pt-4">
            <div className="space-y-4">
              {/* Fontes */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Selecione as Fontes Habilitadas
                </Label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox checked={fontes.pncp} onCheckedChange={() => toggleFonte('pncp')} />
                    <span className="text-xs font-medium">PNCP</span>
                  </label>
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox
                      checked={fontes.compras_gov}
                      onCheckedChange={() => toggleFonte('compras_gov')}
                    />
                    <span className="text-xs font-medium">Compras.gov.br</span>
                  </label>
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox checked={fontes.bps} onCheckedChange={() => toggleFonte('bps')} />
                    <span className="text-xs font-medium">BPS (Saúde)</span>
                  </label>
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox checked={fontes.cmed} onCheckedChange={() => toggleFonte('cmed')} />
                    <span className="text-xs font-medium">CMED (Teto ANVISA)</span>
                  </label>
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox
                      checked={fontes.bec_sp}
                      onCheckedChange={() => toggleFonte('bec_sp')}
                    />
                    <span className="text-xs font-medium">BEC-SP</span>
                  </label>
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox
                      checked={fontes.sinapi}
                      onCheckedChange={() => toggleFonte('sinapi')}
                    />
                    <span className="text-xs font-medium">SINAPI</span>
                  </label>
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox checked={fontes.sicro} onCheckedChange={() => toggleFonte('sicro')} />
                    <span className="text-xs font-medium">SICRO</span>
                  </label>
                  <label className="flex items-center space-x-2 p-2 border rounded-md cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox
                      checked={fontes.fornecedores}
                      onCheckedChange={() => toggleFonte('fornecedores')}
                    />
                    <span className="text-xs font-medium">Cotação Direta (Fornec.)</span>
                  </label>
                </div>
              </div>

              {/* Parâmetros Quantitativos */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Período de Análise</Label>
                  <Select
                    value={String(periodoMeses)}
                    onValueChange={(v) => setPeriodoMeses(Number(v))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="6">Últimos 6 meses</SelectItem>
                      <SelectItem value="12">Últimos 12 meses (Recomendado)</SelectItem>
                      <SelectItem value="18">Últimos 18 meses</SelectItem>
                      <SelectItem value="24">Últimos 24 meses</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Qtd. Mínima de Preços Válidos</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={quantidadeMinima}
                    onChange={(e) => setQuantidadeMinima(Number(e.target.value) || 3)}
                    className="h-8 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Filtro de UF (Opcional)</Label>
                  <Select value={ufFiltro} onValueChange={setUfFiltro}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TODAS">Brasil (Todas as UFs)</SelectItem>
                      <SelectItem value="SP">São Paulo (SP)</SelectItem>
                      <SelectItem value="RJ">Rio de Janeiro (RJ)</SelectItem>
                      <SelectItem value="MG">Minas Gerais (MG)</SelectItem>
                      <SelectItem value="PR">Paraná (PR)</SelectItem>
                      <SelectItem value="DF">Distrito Federal (DF)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Métodos Estatísticos e Normalização */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                <div className="space-y-1">
                  <Label className="text-xs">Método Estatístico Padrão</Label>
                  <Select value={metodoPadrao} onValueChange={(v) => setMetodoPadrao(v as any)}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mediana">Mediana (Recomendada p/ assimetrias)</SelectItem>
                      <SelectItem value="media">Média Aritmética</SelectItem>
                      <SelectItem value="media_ponderada">
                        Média Ponderada por Quantidade
                      </SelectItem>
                      <SelectItem value="media_saneada">
                        Média Saneada (Exclusão Outliers)
                      </SelectItem>
                      <SelectItem value="menor_preco">Menor Preço Válido</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Detecção de Outliers</Label>
                  <Select
                    value={deteccaoOutliers}
                    onValueChange={(v) => setDeteccaoOutliers(v as any)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="automatica">
                        Automática (Juízo Crítico 70%–130%)
                      </SelectItem>
                      <SelectItem value="iqr">Intervalo Interquartil (IQR 1,5x)</SelectItem>
                      <SelectItem value="desvio_padrao">Desvio Padrão (2x Sigma)</SelectItem>
                      <SelectItem value="nenhuma">Sem exclusão prévia</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Chaves de automação */}
              <div className="pt-2 border-t flex flex-wrap gap-4 text-xs">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <Checkbox
                    checked={normalizacaoUnidade}
                    onCheckedChange={(c) => setNormalizacaoUnidade(Boolean(c))}
                  />
                  <span>Normalização Automática de Unidade (ex: cx 500 un → unitário)</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <Checkbox
                    checked={deduplicacao}
                    onCheckedChange={(c) => setDeduplicacao(Boolean(c))}
                  />
                  <span>Deduplicação Trans-fontes (vincular ao registro canônico)</span>
                </label>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4 flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isExecutando}
          >
            Cancelar
          </Button>

          <Button
            type="button"
            onClick={handleIniciar}
            disabled={isExecutando}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2 font-semibold shadow-sm"
          >
            {isExecutando ? (
              <>
                <Clock className="w-4 h-4 animate-spin" />
                Processando Cotação...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                INICIAR COTAÇÃO COM IA
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
