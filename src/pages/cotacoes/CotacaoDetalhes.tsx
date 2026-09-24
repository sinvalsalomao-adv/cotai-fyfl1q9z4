import React, { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  obterCotacao,
  listarItensCotacao,
  listarPrecosDaCotacao,
  listarPrecosDoItem,
  executarCotacaoComIa,
  atualizarPrecoRecord,
  criarItemCotacao,
  excluirItemCotacao,
  registrarJustificativaCotacao,
  listarJustificativas,
  listarVersoesCotacao,
} from '@/services/quotationService'
import type {
  Cotacao,
  CotacaoItem,
  CotacaoPriceRecord,
  CotacaoConfiguracao,
  CotacaoJustificativa,
  CotacaoVersao,
} from '@/types'
import { ResumoCotacaoCards } from '@/components/ResumoCotacaoCards'
import { TabelaItensCotacao } from '@/components/TabelaItensCotacao'
import { ModalCotacaoInteligente } from '@/components/ModalCotacaoInteligente'
import { ModalPrecosDoItem } from '@/components/ModalPrecosDoItem'
import { ModalAnaliseIa } from '@/components/ModalAnaliseIa'
import { ModalJustificativa } from '@/components/ModalJustificativa'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import {
  Sparkles,
  Plus,
  RefreshCw,
  FileDown,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ArrowLeft,
  Share2,
  History,
  Layers,
  ChevronRight,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { formatarMoeda } from '@/lib/calculoEngine'

export const CotacaoDetalhes: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [cotacao, setCotacao] = useState<Cotacao | null>(null)
  const [itens, setItens] = useState<CotacaoItem[]>([])
  const [precos, setPrecos] = useState<CotacaoPriceRecord[]>([])
  const [justificativas, setJustificativas] = useState<CotacaoJustificativa[]>([])
  const [versoes, setVersoes] = useState<CotacaoVersao[]>([])
  const [loading, setLoading] = useState(true)

  // Estados dos modais
  const [modalCotacaoIaOpen, setModalCotacaoIaOpen] = useState(false)
  const [modalPrecosOpen, setModalPrecosOpen] = useState(false)
  const [modalAnaliseOpen, setModalAnaliseOpen] = useState(false)
  const [modalJustificativaOpen, setModalJustificativaOpen] = useState(false)
  const [itemSelecionado, setItemSelecionado] = useState<CotacaoItem | null>(null)
  const [precosDoItemSelecionado, setPrecosDoItemSelecionado] = useState<CotacaoPriceRecord[]>([])

  // Execução e Progresso
  const [isExecutando, setIsExecutando] = useState(false)
  const [progresso, setProgresso] = useState<{
    progresso_percentual: number
    etapa_atual: string
    itens_processados: number
    itens_total: number
    resultados_total: number
    erros_count: number
  } | null>(null)

  const carregarDados = async () => {
    if (!id) return
    try {
      setLoading(true)
      const [c, it, p, j, v] = await Promise.all([
        obterCotacao(id),
        listarItensCotacao(id),
        listarPrecosDaCotacao(id),
        listarJustificativas(id),
        listarVersoesCotacao(id),
      ])
      setCotacao(c)
      setItens(it)
      setPrecos(p)
      setJustificativas(j)
      setVersoes(v)
    } catch (err: any) {
      toast({
        title: 'Erro ao carregar cotação',
        description: err.message,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    carregarDados()
  }, [id])

  // Disparo da Cotação com IA
  const handleIniciarCotacaoIa = async (config: CotacaoConfiguracao) => {
    if (!cotacao) return
    setIsExecutando(true)
    setProgresso({
      progresso_percentual: 5,
      etapa_atual: 'Iniciando conectores públicos e modelos de IA...',
      itens_processados: 0,
      itens_total: itens.length,
      resultados_total: 0,
      erros_count: 0,
    })

    try {
      await executarCotacaoComIa(cotacao.id, config, (p) => {
        setProgresso(p)
      })

      toast({
        title: 'Cotação com IA Finalizada!',
        description: 'Todos os itens foram processados, normalizados e validados com sucesso.',
      })
      await carregarDados()
    } catch (err: any) {
      toast({
        title: 'Falha na cotação com IA',
        description: err.message,
        variant: 'destructive',
      })
    } finally {
      setIsExecutando(false)
      setProgresso(null)
    }
  }

  // Ações de itens
  const handleVerPrecos = async (item: CotacaoItem) => {
    setItemSelecionado(item)
    try {
      const p = await listarPrecosDoItem(item.id)
      setPrecosDoItemSelecionado(p)
      setModalPrecosOpen(true)
    } catch (err: any) {
      toast({ title: 'Erro ao buscar preços do item', description: err.message })
    }
  }

  const handleVerAnaliseIa = (item: CotacaoItem) => {
    setItemSelecionado(item)
    setModalAnaliseOpen(true)
  }

  const handleDecisaoPreco = async (
    precoId: string,
    decisao: 'manter' | 'descartar',
    motivo?: string,
  ) => {
    try {
      await atualizarPrecoRecord(precoId, {
        decisao_humana: decisao,
        motivo_decisao: motivo,
        estagio: decisao === 'descartar' ? 'valido' : 'selecionado',
      })
      if (itemSelecionado) {
        const atualizados = await listarPrecosDoItem(itemSelecionado.id)
        setPrecosDoItemSelecionado(atualizados)
      }
      await carregarDados()
      toast({
        title:
          decisao === 'descartar' ? 'Preço descartado com sucesso' : 'Preço reativado na cesta',
        description: 'A memória de cálculo e os resumos foram recalculados.',
      })
    } catch (err: any) {
      toast({
        title: 'Erro ao atualizar decisão',
        description: err.message,
        variant: 'destructive',
      })
    }
  }

  const handleSalvarJustificativa = async (tipo: string, texto: string) => {
    if (!cotacao) return
    try {
      await registrarJustificativaCotacao({
        quotation_id: cotacao.id,
        tipo: tipo as any,
        texto_justificativa: texto,
      })
      toast({
        title: 'Justificativa Formal Registrada',
        description: 'Consta na trilha perene de auditoria e no relatório oficial.',
      })
      await carregarDados()
    } catch (err: any) {
      toast({
        title: 'Erro ao registrar justificativa',
        description: err.message,
        variant: 'destructive',
      })
    }
  }

  // Cálculos agregados para os cards
  const totalItens = itens.length
  const itensConcluidos = itens.filter((i) => i.status === 'concluido').length
  const itensProcessando = itens.filter(
    (i) => i.status === 'pesquisando' || i.status === 'processando',
  ).length
  const itensRevisao = itens.filter((i) => i.status === 'revisao_necessaria').length
  const itensSemResultados = itens.filter((i) => i.status === 'sem_resultados').length

  const precosValidos = precos.filter(
    (p) => p.estagio === 'valido' || p.estagio === 'selecionado',
  ).length
  const precosSelecionados = precos.filter((p) => p.estagio === 'selecionado').length

  const fornecedoresUnicos = new Set(
    precos.map((p) => p.supplier_cnpj || p.supplier).filter(Boolean),
  ).size

  const valorMedianaTotal = itens.reduce((acc, it) => acc + (it.valor_total_item || 0), 0)
  const valorMediaTotal = itens.reduce((acc, it) => {
    const unit = it.preco_media || it.preco_mediana || 0
    return acc + unit * it.quantidade
  }, 0)
  const valorMinimoTotal = itens.reduce((acc, it) => {
    const unit = it.preco_minimo || it.preco_mediana || 0
    return acc + unit * it.quantidade
  }, 0)
  const valorPonderadaTotal = itens.reduce((acc, it) => {
    const unit = it.preco_media_ponderada || it.preco_mediana || 0
    return acc + unit * it.quantidade
  }, 0)

  // Itens que exigem revisão (Fila de Revisão)
  const itensParaRevisao = itens.filter(
    (it) => it.status === 'revisao_necessaria' || it.status === 'sem_resultados',
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[500px]">
        <div className="text-center space-y-3">
          <Clock className="w-8 h-8 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Carregando detalhes da cotação...</p>
        </div>
      </div>
    )
  }

  if (!cotacao) {
    return (
      <div className="p-8 text-center space-y-4">
        <h2 className="text-xl font-bold">Cotação não encontrada</h2>
        <Button onClick={() => navigate('/pesquisas')}>Voltar para Pesquisas</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* 1. TOPO: Identificação e Ações Principais */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/pesquisas')}
              className="h-7 w-7 p-0"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <Badge variant="outline" className="font-mono text-xs">
              {cotacao.numero}
            </Badge>
            <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              Versão {cotacao.versao_atual || 1}
            </Badge>
            {cotacao.status === 'concluida' ? (
              <Badge className="bg-emerald-600 text-white">Concluída</Badge>
            ) : cotacao.status === 'revisao_necessaria' ? (
              <Badge variant="destructive">Revisão Necessária</Badge>
            ) : (
              <Badge variant="secondary">Rascunho</Badge>
            )}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {cotacao.titulo}
          </h1>
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <span>
              Órgão: <strong>{cotacao.expand?.tenant_id?.nome || 'Prefeitura Municipal'}</strong>
            </span>
            <span>•</span>
            <span>
              Criado em:{' '}
              {cotacao.created ? new Date(cotacao.created).toLocaleDateString('pt-BR') : '2026'}
            </span>
          </p>
        </div>

        {/* Botões do Topo */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => carregarDados()}
            className="gap-1.5 h-9"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Atualizar
          </Button>

          <Button
            size="sm"
            onClick={() => setModalCotacaoIaOpen(true)}
            disabled={isExecutando}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2 font-semibold shadow-sm h-9"
          >
            <Sparkles className="w-4 h-4 fill-emerald-200" />
            COTAR COM IA
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setModalJustificativaOpen(true)}
            className="gap-1.5 h-9"
          >
            <FileText className="w-3.5 h-3.5" /> Justificar
          </Button>
        </div>
      </div>

      {/* 2. BARRA DE PROGRESSO EM TEMPO REAL QUANDO EXECUTANDO */}
      {isExecutando && progresso && (
        <Card className="border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                <Sparkles className="w-4 h-4 animate-spin text-emerald-600" />
                {progresso.etapa_atual}
              </span>
              <span>{progresso.progresso_percentual}%</span>
            </div>
            <Progress value={progresso.progresso_percentual} className="h-2 bg-emerald-100" />
            <div className="flex justify-between text-[11px] text-muted-foreground pt-1">
              <span>
                Processados: {progresso.itens_processados}/{progresso.itens_total}
              </span>
              <span>Resultados: {progresso.resultados_total}</span>
              <span>Erros: {progresso.erros_count}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 3. CARDS DE RESUMO RECALCULADOS AUTOMATICAMENTE */}
      <ResumoCotacaoCards
        totalItens={totalItens}
        itensConcluidos={itensConcluidos}
        itensProcessando={itensProcessando}
        itensRevisao={itensRevisao}
        itensSemResultados={itensSemResultados}
        precosEncontrados={cotacao.metrica_estagios?.encontrados || precos.length}
        precosValidos={precosValidos}
        precosSelecionados={precosSelecionados}
        fornecedoresEncontrados={fornecedoresUnicos}
        valorMinimoTotal={valorMinimoTotal}
        valorMediaTotal={valorMediaTotal}
        valorMedianaTotal={valorMedianaTotal}
        valorPonderadaTotal={valorPonderadaTotal}
      />

      {/* 4. FILA DE REVISÃO HUMANA (Se houver pendências) */}
      {itensParaRevisao.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 shadow-sm">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
                <AlertTriangle className="w-5 h-5" />
                <CardTitle className="text-sm font-bold">
                  ITENS QUE EXIGEM REVISÃO HUMANA ({itensParaRevisao.length})
                </CardTitle>
              </div>
              <Badge variant="outline" className="border-amber-300 text-amber-800 text-[10px]">
                Ação Obrigatória
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-1 space-y-2">
            <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
              Conforme a regra do órgão e a Lei 14.133/2021, itens com menos de 3 preços válidos ou
              com dispersão excessiva requerem justificativa ou ampliação de pesquisa:
            </p>
            <div className="space-y-1.5">
              {itensParaRevisao.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center justify-between bg-white dark:bg-slate-900 p-2.5 rounded border border-amber-200 text-xs"
                >
                  <div>
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      Item #{it.numero_item} — {it.descricao_original}
                    </span>
                    <p className="text-muted-foreground text-[11px]">{it.mensagem_status}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-50"
                      onClick={() => handleVerPrecos(it)}
                    >
                      Analisar Preços ({it.qtd_encontrados || 0})
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                      onClick={() => {
                        setItemSelecionado(it)
                        setModalJustificativaOpen(true)
                      }}
                    >
                      Justificar Amostra
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 5. TABELA PRINCIPAL DE ITENS */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Itens da Cotação ({itens.length})
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8 text-xs"
            onClick={async () => {
              const desc = prompt('Informe a descrição do novo item:')
              if (desc && cotacao) {
                await criarItemCotacao({
                  quotation_id: cotacao.id,
                  numero_item: itens.length + 1,
                  descricao_original: desc,
                  quantidade: 1000,
                  unidade: 'un',
                })
                await carregarDados()
                toast({ title: 'Item adicionado com sucesso!' })
              }
            }}
          >
            <Plus className="w-3.5 h-3.5" /> Adicionar Item
          </Button>
        </div>

        <TabelaItensCotacao
          itens={itens}
          onVerPrecos={handleVerPrecos}
          onVerAnaliseIa={handleVerAnaliseIa}
          onRefazerItem={(it) => {
            handleIniciarCotacaoIa({
              modo: 'automatico',
              periodo_meses: 12,
              quantidade_minima: 3,
            })
          }}
          onExcluirItem={async (it) => {
            if (confirm(`Deseja remover o item #${it.numero_item}?`)) {
              await excluirItemCotacao(it.id, cotacao.id)
              await carregarDados()
              toast({ title: 'Item removido' })
            }
          }}
        />
      </div>

      {/* 6. MODAIS */}
      <ModalCotacaoInteligente
        open={modalCotacaoIaOpen}
        onOpenChange={setModalCotacaoIaOpen}
        onIniciarCotacao={handleIniciarCotacaoIa}
        totalItens={itens.length}
        isExecutando={isExecutando}
      />

      <ModalPrecosDoItem
        open={modalPrecosOpen}
        onOpenChange={setModalPrecosOpen}
        item={itemSelecionado}
        precos={precosDoItemSelecionado}
        onAtualizarDecisao={handleDecisaoPreco}
      />

      <ModalAnaliseIa
        open={modalAnaliseOpen}
        onOpenChange={setModalAnaliseOpen}
        item={itemSelecionado}
      />

      <ModalJustificativa
        open={modalJustificativaOpen}
        onOpenChange={setModalJustificativaOpen}
        onSalvar={handleSalvarJustificativa}
      />
    </div>
  )
}
