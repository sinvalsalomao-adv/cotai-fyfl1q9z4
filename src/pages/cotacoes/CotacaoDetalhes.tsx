import React, { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  Sparkles,
  ArrowLeft,
  FileSpreadsheet,
  Download,
  Play,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Building2,
  Calendar,
  Layers,
  Clock,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  obterCotacao,
  listarItensCotacao,
  listarPrecosDaCotacao,
  iniciarCotacaoInteligente,
  atualizarPrecoRecord,
  atualizarItemCotacao,
  atualizarCotacao,
  exportarRelatorioCotacao,
  criarItemCotacao,
  excluirItemCotacao,
} from '@/services/quotationService'
import type { Cotacao, CotacaoItem, CotacaoPrecoRecord, CotacaoConfiguracao } from '@/types'
import { ResumoCotacaoCards } from '@/components/ResumoCotacaoCards'
import { TabelaItensCotacao } from '@/components/TabelaItensCotacao'
import { ModalPrecosDoItem } from '@/components/ModalPrecosDoItem'
import { ModalAnaliseIa } from '@/components/ModalAnaliseIa'
import { ModalJustificativa } from '@/components/ModalJustificativa'
import { ModalCotacaoInteligente } from '@/components/ModalCotacaoInteligente'
import { formatarMoeda, formatarData } from '@/lib/calculoEngine'
import { useToast } from '@/hooks/use-toast'

export const CotacaoDetalhes: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [cotacao, setCotacao] = useState<Cotacao | null>(null)
  const [itens, setItens] = useState<CotacaoItem[]>([])
  const [precos, setPrecos] = useState<CotacaoPrecoRecord[]>([])
  const [carregando, setCarregando] = useState(true)
  const [executandoCotacao, setExecutandoCotacao] = useState(false)

  // Modais
  const [itemSelecionado, setItemSelecionado] = useState<CotacaoItem | null>(null)
  const [modalPrecosAberto, setModalPrecosAberto] = useState(false)
  const [modalAnaliseIaAberto, setModalAnaliseIaAberto] = useState(false)
  const [modalJustificativaAberto, setModalJustificativaAberto] = useState(false)
  const [modalCotacaoIaAberto, setModalCotacaoIaAberto] = useState(false)

  const carregarDados = async () => {
    if (!id) return
    try {
      setCarregando(true)
      const cotacaoData = await obterCotacao(id)
      if (!cotacaoData) {
        toast({
          title: 'Cotação não encontrada',
          description: 'Não foi possível carregar a cotação solicitada.',
          variant: 'destructive',
        })
        navigate('/pesquisas')
        return
      }
      setCotacao(cotacaoData)

      const itensData = await listarItensCotacao(id)
      setItens(itensData)

      const precosData = await listarPrecosDaCotacao(id)
      setPrecos(precosData)
    } catch (error) {
      console.error('Erro ao carregar dados da cotação:', error)
      toast({
        title: 'Erro ao carregar',
        description: 'Falha ao sincronizar dados com o backend.',
        variant: 'destructive',
      })
    } finally {
      setCarregando(false)
    }
  }

  useEffect(() => {
    carregarDados()
  }, [id])

  // Cálculos consolidados da cotação
  const totalItens = itens.length
  const itensConcluidos = itens.filter((i) => i.status === 'concluido').length
  const itensPendentes = itens.filter((i) => i.status === 'pendente').length
  const itensAtencao = itens.filter((i) => (i.total_precos_validos || 0) < 3).length

  const valorTotalEstimado = itens.reduce((acc, item) => {
    const unit = item.preco_referencia || 0
    return acc + unit * item.quantidade
  }, 0)

  const totalPrecosColetados = precos.length
  const totalPrecosValidos = precos.filter((p) => p.status === 'valido').length
  const totalPrecosExpurgados = precos.filter((p) => p.status === 'expurgado').length

  // Economia identificada (diferença entre média bruta e mediana saneada)
  const economiaIdentificada = itens.reduce((acc, item) => {
    const precosItem = precos.filter((p) => p.cotacao_item_id === item.id)
    if (precosItem.length === 0) return acc
    const mediaBruta = precosItem.reduce((s, p) => s + p.preco_unitario, 0) / precosItem.length
    const valorAdotado = item.preco_referencia || 0
    if (mediaBruta > valorAdotado && valorAdotado > 0) {
      return acc + (mediaBruta - valorAdotado) * item.quantidade
    }
    return acc
  }, 0)

  // Disparo do Motor de Cotação Inteligente
  const handleIniciarCotacaoIa = async (config: CotacaoConfiguracao) => {
    if (!cotacao) return
    try {
      setExecutandoCotacao(true)
      toast({
        title: 'Iniciando Cotação com IA',
        description: 'Buscando preços em PNCP, Compras.gov, BPS, CMED e BEC-SP...',
      })

      const resultado = await iniciarCotacaoInteligente(cotacao.id, config)

      toast({
        title: 'Cotação Concluída com Sucesso',
        description: `${resultado.precos_coletados} preços coletados para ${resultado.itens_processados} itens.`,
      })

      await carregarDados()
    } catch (error) {
      console.error('Erro ao executar cotação IA:', error)
      toast({
        title: 'Falha na Cotação',
        description: 'Ocorreu um erro ao coletar preços automaticamente.',
        variant: 'destructive',
      })
    } finally {
      setExecutandoCotacao(false)
    }
  }

  // Atualizar status de um preço específico
  const handleAtualizarStatusPreco = async (
    precoId: string,
    novoStatus: 'valido' | 'expurgado' | 'pendente',
    justificativa?: string,
  ) => {
    try {
      await atualizarPrecoRecord(precoId, {
        status: novoStatus,
        justificativa_descarte: justificativa,
      })

      // Atualiza lista local
      setPrecos((prev) =>
        prev.map((p) =>
          p.id === precoId
            ? { ...p, status: novoStatus, justificativa_descarte: justificativa }
            : p,
        ),
      )

      // Recalcula o item associado
      if (itemSelecionado) {
        const precosDoItem = precos
          .filter((p) => p.cotacao_item_id === itemSelecionado.id)
          .map((p) => (p.id === precoId ? { ...p, status: novoStatus } : p))
        const validos = precosDoItem.filter((p) => p.status === 'valido')
        const valores = validos
          .map((p) => p.preco_unitario_normalizado || p.preco_unitario)
          .sort((a, b) => a - b)

        let novaMediana = 0
        if (valores.length > 0) {
          const mid = Math.floor(valores.length / 2)
          novaMediana =
            valores.length % 2 !== 0 ? valores[mid] : (valores[mid - 1] + valores[mid]) / 2
        }

        await atualizarItemCotacao(itemSelecionado.id, {
          total_precos_validos: validos.length,
          preco_referencia: novaMediana,
          status: validos.length > 0 ? 'concluido' : 'pendente',
        })

        // Atualiza itemSelecionado e lista de itens
        setItemSelecionado((prev) =>
          prev
            ? {
                ...prev,
                total_precos_validos: validos.length,
                preco_referencia: novaMediana,
                status: validos.length > 0 ? 'concluido' : 'pendente',
              }
            : null,
        )

        setItens((prev) =>
          prev.map((i) =>
            i.id === itemSelecionado.id
              ? {
                  ...i,
                  total_precos_validos: validos.length,
                  preco_referencia: novaMediana,
                  status: validos.length > 0 ? 'concluido' : 'pendente',
                }
              : i,
          ),
        )
      }

      toast({
        title: 'Preço Atualizado',
        description: `Situação alterada para "${novoStatus.toUpperCase()}".`,
      })
    } catch (error) {
      console.error('Erro ao atualizar preço:', error)
      toast({
        title: 'Erro',
        description: 'Não foi possível atualizar o preço.',
        variant: 'destructive',
      })
    }
  }

  // Atualizar método estatístico do item
  const handleAtualizarMetodoItem = async (
    itemId: string,
    metodo: 'mediana' | 'media' | 'menor_preco' | 'media_saneada' | 'media_ponderada',
    justificativa?: string,
  ) => {
    try {
      const metodoMapeado = metodo === 'menor_preco' ? 'menor' : metodo
      await atualizarItemCotacao(itemId, {
        metodo_adotado: metodoMapeado as any,
        justificativa_amostra_minima: justificativa,
      })

      setItens((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? {
                ...i,
                metodo_adotado: metodoMapeado as any,
                justificativa_amostra_minima: justificativa,
              }
            : i,
        ),
      )

      if (itemSelecionado && itemSelecionado.id === itemId) {
        setItemSelecionado((prev) =>
          prev
            ? {
                ...prev,
                metodo_adotado: metodoMapeado as any,
                justificativa_amostra_minima: justificativa,
              }
            : null,
        )
      }

      toast({
        title: 'Método Atualizado',
        description: `Método ${metodo.toUpperCase()} aplicado com justificativa registrada.`,
      })
    } catch (error) {
      console.error('Erro ao atualizar método:', error)
      toast({
        title: 'Erro',
        description: 'Falha ao salvar alteração de método.',
        variant: 'destructive',
      })
    }
  }

  // Salvar justificativa de amostra mínima
  const handleSalvarJustificativa = async (justificativa: string) => {
    if (!itemSelecionado) return
    try {
      await atualizarItemCotacao(itemSelecionado.id, {
        justificativa_amostra_minima: justificativa,
      })

      setItens((prev) =>
        prev.map((i) =>
          i.id === itemSelecionado.id ? { ...i, justificativa_amostra_minima: justificativa } : i,
        ),
      )

      setItemSelecionado((prev) =>
        prev ? { ...prev, justificativa_amostra_minima: justificativa } : null,
      )

      toast({
        title: 'Justificativa Registrada',
        description: 'A justificativa técnica foi salva no dossiê da cotação.',
      })
    } catch (error) {
      console.error('Erro ao salvar justificativa:', error)
      toast({
        title: 'Erro',
        description: 'Falha ao gravar a justificativa técnica.',
        variant: 'destructive',
      })
    }
  }

  // Excluir item
  const handleExcluirItem = async (item: CotacaoItem) => {
    if (!cotacao) return
    if (!confirm(`Deseja realmente remover o item "${item.descricao_original}" desta cotação?`)) {
      return
    }
    try {
      await excluirItemCotacao(item.id, cotacao.id)
      setItens((prev) => prev.filter((i) => i.id !== item.id))
      toast({
        title: 'Item Removido',
        description: 'O item foi excluído da lista de cotação.',
      })
    } catch (error) {
      console.error('Erro ao excluir item:', error)
      toast({
        title: 'Erro',
        description: 'Não foi possível remover o item.',
        variant: 'destructive',
      })
    }
  }

  // Exportar relatório
  const handleExportar = async () => {
    if (!cotacao) return
    try {
      toast({
        title: 'Gerando Relatório',
        description: 'Consolidando dossiê de preços no padrão da Lei 14.133/2021...',
      })
      const url = await exportarRelatorioCotacao(cotacao.id, 'pdf')
      window.open(url, '_blank')
    } catch (error) {
      console.error('Erro ao exportar:', error)
      toast({
        title: 'Erro na Exportação',
        description: 'Não foi possível gerar o arquivo de relatório.',
        variant: 'destructive',
      })
    }
  }

  if (carregando) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-3">
        <Clock className="w-8 h-8 animate-spin text-[#124268]" />
        <p className="text-xs font-bold uppercase text-[#475569] tracking-wider">
          Carregando Cotação e Cesta de Preços...
        </p>
      </div>
    )
  }

  if (!cotacao) return null

  const precosDoItemSelecionado = itemSelecionado
    ? precos.filter((p) => p.cotacao_item_id === itemSelecionado.id)
    : []

  return (
    <div className="space-y-3 pb-12 font-sans text-xs">
      {/* BARRA SUPERIOR DE CABEÇALHO DA COTAÇÃO — ESTILO CESTA DE PREÇOS */}
      <div className="bg-white border border-[#b8c2cc] shadow-sm">
        <div className="bg-[#124268] text-white px-4 py-2 flex items-center justify-between select-none">
          <div className="flex items-center gap-2">
            <Link
              to="/pesquisas"
              className="text-[#bcd3e6] hover:text-white flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Voltar
            </Link>
            <span className="text-[#84a9c9]">|</span>
            <span className="font-bold text-xs sm:text-sm tracking-wider uppercase">
              COTAÇÃO DE PREÇOS
            </span>
            <span className="text-[#bcd3e6] font-mono text-xs">[{cotacao.numero_processo}]</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={carregarDados}
              className="h-7 text-[10.5px] font-bold uppercase tracking-wider rounded-none bg-white/10 hover:bg-white/20 text-white border-white/20 gap-1"
            >
              <RefreshCw className="h-3 w-3" />
              Sincronizar
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleExportar}
              className="h-7 text-[10.5px] font-bold uppercase tracking-wider rounded-none bg-white text-[#124268] hover:bg-white/90 font-bold gap-1 shadow-none"
            >
              <Download className="h-3 w-3" />
              Emitir Dossiê Oficial
            </Button>
          </div>
        </div>

        {/* IDENTIFICAÇÃO DO PROCESSO / DEMANDA */}
        <div className="p-3 bg-white space-y-2">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-[#e5e7eb] pb-2">
            <div className="space-y-0.5">
              <h1 className="text-sm sm:text-base font-bold text-[#1f2937] uppercase tracking-tight">
                {cotacao.objeto}
              </h1>
              <p className="text-[11px] text-[#4b5563]">
                {cotacao.orgao_nome || 'Órgão Licitante Oficial'} • Processo Administrativo nº{' '}
                <strong className="text-[#124268] font-mono">{cotacao.numero_processo}</strong> •
                Atualizado em {formatarData(cotacao.updated || cotacao.created)}
              </p>
            </div>

            {/* AÇÃO PRINCIPAL: DISPARAR COTAÇÃO COM IA */}
            <Button
              type="button"
              onClick={() => setModalCotacaoIaAberto(true)}
              disabled={executandoCotacao}
              className="bg-[#124268] hover:bg-[#0c314f] text-white text-[11px] font-bold uppercase tracking-wider px-3 h-8 rounded-none gap-1.5 shadow-none flex-shrink-0"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-300 animate-pulse" />
              {executandoCotacao ? 'EXECUTANDO COTAÇÃO COM IA...' : 'COTAÇÃO INTELIGENTE COM IA'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-[#4b5563]">
            <span>
              <strong>ENQUADRAMENTO:</strong> Lei Federal nº 14.133/2021 & IN SEGES/ME
            </span>
            <span>
              <strong>CRITÉRIO REGULATÓRIO:</strong> Mediana de Preços com Juízo Crítico (70% -
              130%)
            </span>
            <span>
              <strong>AMOSTRA MÍNIMA:</strong> 3 Preços Válidos (Justificativa Obrigatória nos Casos
              Críticos)
            </span>
          </div>
        </div>
      </div>

      {/* CARDS DE RESUMO NO ESTILO CESTA DE PREÇOS */}
      <ResumoCotacaoCards
        cotacao={cotacao}
        totalItens={totalItens}
        itensConcluidos={itensConcluidos}
        itensPendentes={itensPendentes}
        itensAtencao={itensAtencao}
        valorTotalEstimado={valorTotalEstimado}
        totalPrecosColetados={totalPrecosColetados}
        totalPrecosValidos={totalPrecosValidos}
        totalPrecosExpurgados={totalPrecosExpurgados}
        economiaIdentificada={economiaIdentificada}
      />

      {/* TABELA DE ITENS DA COTAÇÃO */}
      <TabelaItensCotacao
        itens={itens}
        onAbrirPrecos={(item) => {
          setItemSelecionado(item)
          setModalPrecosAberto(true)
        }}
        onAbrirAnaliseIa={(item) => {
          setItemSelecionado(item)
          setModalAnaliseIaAberto(true)
        }}
        onAbrirJustificativa={(item) => {
          setItemSelecionado(item)
          setModalJustificativaAberto(true)
        }}
        onExcluirItem={handleExcluirItem}
        isExecutando={executandoCotacao}
      />

      {/* MODAL CESTA DE PREÇOS DO ITEM */}
      <ModalPrecosDoItem
        open={modalPrecosAberto}
        onOpenChange={setModalPrecosAberto}
        item={itemSelecionado}
        precos={precosDoItemSelecionado}
        onAtualizarStatusPreco={handleAtualizarStatusPreco}
        onAtualizarMetodoItem={handleAtualizarMetodoItem}
      />

      {/* MODAL ANÁLISE INTELIGENTE COM IA */}
      <ModalAnaliseIa
        open={modalAnaliseIaAberto}
        onOpenChange={setModalAnaliseIaAberto}
        item={itemSelecionado}
      />

      {/* MODAL JUSTIFICATIVA DE AMOSTRA MÍNIMA */}
      <ModalJustificativa
        open={modalJustificativaAberto}
        onOpenChange={setModalJustificativaAberto}
        item={itemSelecionado}
        onSalvar={handleSalvarJustificativa}
      />

      {/* MODAL DISPARO COTAÇÃO INTELIGENTE COM IA */}
      <ModalCotacaoInteligente
        open={modalCotacaoIaAberto}
        onOpenChange={setModalCotacaoIaAberto}
        onIniciarCotacao={handleIniciarCotacaoIa}
        totalItens={totalItens}
        isExecutando={executandoCotacao}
      />
    </div>
  )
}
