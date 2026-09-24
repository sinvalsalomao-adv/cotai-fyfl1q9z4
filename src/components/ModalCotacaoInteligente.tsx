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
  X,
  Search,
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
      <DialogContent className="max-w-3xl max-h-[92vh] p-0 overflow-hidden flex flex-col bg-[#eef1f4] text-[#222] border border-[#7d8b99] shadow-2xl rounded-none font-sans text-xs">
        {/* BARRA SUPERIOR AZUL-ESCURA */}
        <div className="bg-[#124268] text-white px-4 py-2.5 flex items-center justify-between select-none border-b border-[#0c314f] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-300" />
            <span className="font-bold text-xs sm:text-sm tracking-wider uppercase">
              COTAÇÃO INTELIGENTE COM IA — MOTOR MULTIFONTE
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
          {/* SEÇÃO 1: INFORMAÇÕES GERAIS */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <span className="inline-block w-2.5 h-2.5 bg-white/90 border border-[#4a5059] flex-shrink-0" />
              <span>PARÂMETROS DA OPERAÇÃO DE COTAÇÃO</span>
            </div>
            <div className="p-2.5 bg-white space-y-1">
              <p className="text-[11.5px] text-[#334155] leading-relaxed">
                O motor automatizado fará a busca multifonte para os{' '}
                <strong>{totalItens} itens</strong> desta cotação, executando normalização de
                unidades, identificação de catálogos e cálculo preliminar da cesta de preços.
              </p>
              <div className="p-2 bg-[#fefce8] border-l-4 border-l-[#eab308] border border-[#fef08a] text-[10.5px] text-[#854d0e] flex items-center gap-2">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                <span>
                  <strong>Aviso de Rastreabilidade e Decisão Humana:</strong> Nenhuma exclusão
                  silenciosa será realizada. Amostras fora dos limites (70% - 130% da mediana) serão
                  submetidas à análise crítica do servidor.
                </span>
              </div>
            </div>
          </div>

          {/* SEÇÃO 2: SELEÇÃO DE MODO */}
          <div className="bg-white border border-[#b8c2cc] shadow-sm">
            <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 select-none">
              <SlidersHorizontal className="h-3 w-3 flex-shrink-0" />
              <span>CONFIGURAÇÃO DE EXECUÇÃO</span>
            </div>

            {/* Abas no estilo Cesta de Preços */}
            <div className="flex border-b border-[#cbd5e1] bg-[#eef2f6] text-[11px]">
              <button
                type="button"
                onClick={() => setModo('automatico')}
                className={`px-3 py-1.5 font-bold uppercase tracking-wider text-[10.5px] transition-colors border-r border-[#cbd5e1] ${
                  modo === 'automatico'
                    ? 'bg-white text-[#124268] border-b-2 border-b-[#124268]'
                    : 'text-[#475569] hover:bg-[#e2e8f0]'
                }`}
              >
                MODO AUTOMÁTICO (PADRÃO DO ÓRGÃO)
              </button>
              <button
                type="button"
                onClick={() => setModo('avancado')}
                className={`px-3 py-1.5 font-bold uppercase tracking-wider text-[10.5px] transition-colors border-r border-[#cbd5e1] ${
                  modo === 'avancado'
                    ? 'bg-white text-[#124268] border-b-2 border-b-[#124268]'
                    : 'text-[#475569] hover:bg-[#e2e8f0]'
                }`}
              >
                MODO AVANÇADO (FILTROS PERSONALIZADOS)
              </button>
            </div>

            <div className="p-3 bg-white">
              {modo === 'automatico' ? (
                <div className="space-y-2 text-[11px]">
                  <p className="text-[#4b5563]">
                    Parâmetros regulamentares pré-configurados conforme a Lei nº 14.133/2021:
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[10.5px]">
                    <div className="p-2 border border-[#cbd5e1] bg-[#f8fafc]">
                      <strong className="block text-[#111827] font-sans uppercase">
                        FONTES OFICIAIS:
                      </strong>
                      <span>PNCP, Compras.gov, BPS, CMED e BEC-SP</span>
                    </div>
                    <div className="p-2 border border-[#cbd5e1] bg-[#f8fafc]">
                      <strong className="block text-[#111827] font-sans uppercase">
                        TEMPORALIDADE:
                      </strong>
                      <span>Últimos 12 meses (priorização contemporânea)</span>
                    </div>
                    <div className="p-2 border border-[#cbd5e1] bg-[#f8fafc]">
                      <strong className="block text-[#111827] font-sans uppercase">
                        AMOSTRA MÍNIMA:
                      </strong>
                      <span>3 preços válidos (alerta com justificativa)</span>
                    </div>
                    <div className="p-2 border border-[#cbd5e1] bg-[#f8fafc]">
                      <strong className="block text-[#111827] font-sans uppercase">
                        JUÍZO CRÍTICO:
                      </strong>
                      <span>Mediana com limites 70% e 130%</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 text-[11px]">
                  <div>
                    <Label className="text-[10px] font-bold text-[#374151] uppercase block mb-1">
                      Fontes Habilitadas
                    </Label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                      {Object.keys(fontes).map((key) => (
                        <label
                          key={key}
                          className="flex items-center gap-1.5 p-1.5 border border-[#cbd5e1] bg-white cursor-pointer hover:bg-[#f8fafc]"
                        >
                          <Checkbox
                            checked={fontes[key]}
                            onCheckedChange={() => toggleFonte(key)}
                          />
                          <span className="text-[10.5px] uppercase font-bold text-[#334155]">
                            {key}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">
                        Período de Análise
                      </Label>
                      <Select
                        value={String(periodoMeses)}
                        onValueChange={(v) => setPeriodoMeses(Number(v))}
                      >
                        <SelectTrigger className="h-7 text-xs rounded-none border-[#94a3b8] bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="text-xs">
                          <SelectItem value="6">Últimos 6 meses</SelectItem>
                          <SelectItem value="12">Últimos 12 meses (Recomendado)</SelectItem>
                          <SelectItem value="18">Últimos 18 meses</SelectItem>
                          <SelectItem value="24">Últimos 24 meses</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">
                        Amostra Mínima
                      </Label>
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={quantidadeMinima}
                        onChange={(e) => setQuantidadeMinima(Number(e.target.value) || 3)}
                        className="h-7 text-xs rounded-none border-[#94a3b8] bg-white"
                      />
                    </div>

                    <div className="space-y-0.5">
                      <Label className="text-[10px] font-bold text-[#374151] uppercase">
                        Filtro UF
                      </Label>
                      <Select value={ufFiltro} onValueChange={setUfFiltro}>
                        <SelectTrigger className="h-7 text-xs rounded-none border-[#94a3b8] bg-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="text-xs">
                          <SelectItem value="TODAS">Brasil (Todas UFs)</SelectItem>
                          <SelectItem value="SP">São Paulo (SP)</SelectItem>
                          <SelectItem value="RJ">Rio de Janeiro (RJ)</SelectItem>
                          <SelectItem value="MG">Minas Gerais (MG)</SelectItem>
                          <SelectItem value="DF">Distrito Federal (DF)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RODAPÉ CESTA DE PREÇOS */}
        <div className="bg-[#e5e7eb] border-t border-[#9ca3af] px-4 py-2.5 flex items-center justify-between select-none">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isExecutando}
            className="h-8 text-[11px] font-bold uppercase tracking-wider rounded-none border-[#9ca3af] bg-white text-[#374151]"
          >
            Cancelar
          </Button>

          <Button
            type="button"
            onClick={handleIniciar}
            disabled={isExecutando}
            className="h-8 px-5 text-[11px] font-bold uppercase tracking-wider rounded-none bg-[#124268] hover:bg-[#0c314f] text-white border border-[#0c314f] gap-1.5"
          >
            {isExecutando ? (
              <>
                <Clock className="w-3.5 h-3.5 animate-spin" />
                PROCESSANDO COTAÇÃO...
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                EXECUTAR COTAÇÃO INTELIGENTE
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
