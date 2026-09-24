import React from 'react'
import {
  Sparkles,
  Eye,
  Edit2,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  TrendingDown,
  Layers,
  FileText,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CotacaoItem } from '@/types'
import { formatarMoeda } from '@/lib/calculoEngine'

interface TabelaItensCotacaoProps {
  itens: CotacaoItem[]
  onAbrirPrecos: (item: CotacaoItem) => void
  onAbrirAnaliseIa: (item: CotacaoItem) => void
  onAbrirJustificativa: (item: CotacaoItem) => void
  onExcluirItem?: (item: CotacaoItem) => void
  isExecutando?: boolean
}

export const TabelaItensCotacao: React.FC<TabelaItensCotacaoProps> = ({
  itens,
  onAbrirPrecos,
  onAbrirAnaliseIa,
  onAbrirJustificativa,
  onExcluirItem,
  isExecutando = false,
}) => {
  if (itens.length === 0) {
    return (
      <div className="bg-white border border-[#b8c2cc] p-8 text-center text-xs text-[#6b7280]">
        <p className="font-bold uppercase tracking-wider">
          VOCÊ NÃO POSSUI ITENS CADASTRADOS PARA ESTA COTAÇÃO
        </p>
        <p className="text-[11px] text-[#9ca3af] mt-1">
          Utilize o botão "Adicionar Item" ou importe a planilha da demanda para iniciar a cotação.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white border border-[#b8c2cc] shadow-sm">
      <div className="bg-[#828892] text-white px-3 py-1 text-[11px] font-bold uppercase tracking-wide flex items-center justify-between select-none">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 bg-white/90 border border-[#4a5059] flex-shrink-0" />
          <span>RELAÇÃO DE ITENS DO ORÇAMENTO ESTIMATIVO ({itens.length})</span>
        </span>
        <span className="text-[10px] text-white/90 font-mono">
          PADRÃO CESTA DE PREÇOS / ART. 23 LEI 14.133
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px] border-collapse bg-white">
          <thead className="bg-[#e2e8f0] text-[#334155] font-bold text-[10px] uppercase border-b border-[#cbd5e1]">
            <tr>
              <th className="p-1.5 border-r border-[#cbd5e1] text-center w-10">ITEM</th>
              <th className="p-1.5 border-r border-[#cbd5e1] min-w-[280px]">
                DESCRIÇÃO TÉCNICA DO ITEM A SER COTADO
              </th>
              <th className="p-1.5 border-r border-[#cbd5e1] text-center w-20">CATMAT</th>
              <th className="p-1.5 border-r border-[#cbd5e1] text-center w-16">QNT</th>
              <th className="p-1.5 border-r border-[#cbd5e1] text-center w-14">UNID</th>
              <th className="p-1.5 border-r border-[#cbd5e1] text-center w-24">AMOSTRAS</th>
              <th className="p-1.5 border-r border-[#cbd5e1] text-center w-24">SITUAÇÃO</th>
              <th className="p-1.5 border-r border-[#cbd5e1] text-right w-28">PREÇO UNIT. REF.</th>
              <th className="p-1.5 border-r border-[#cbd5e1] text-right w-28">VALOR TOTAL</th>
              <th className="p-1.5 text-center w-48">AÇÕES DE COTAÇÃO</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#cbd5e1]">
            {itens.map((item, index) => {
              const totalValidos = item.total_precos_validos || 0
              const totalColetados = item.total_precos_coletados || 0
              const temCriticaAmostra = totalValidos < 3
              const justificativaPendente =
                temCriticaAmostra &&
                (!item.justificativa_amostra_minima ||
                  item.justificativa_amostra_minima.trim().length < 10)
              const valorUnit = item.preco_referencia || 0
              const valorTotal = valorUnit * item.quantidade

              return (
                <tr
                  key={item.id}
                  className={`hover:bg-[#f8fafc] transition-colors ${
                    justificativaPendente
                      ? 'bg-[#fffbeb]/50'
                      : item.status === 'concluido'
                        ? 'bg-white'
                        : 'bg-[#fafafa]'
                  }`}
                >
                  {/* NÚMERO DO ITEM */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-center font-bold font-mono text-[11px] text-[#124268]">
                    #{item.numero_item || index + 1}
                  </td>

                  {/* DESCRIÇÃO E METADADOS */}
                  <td className="p-1.5 border-r border-[#cbd5e1]">
                    <div className="space-y-0.5">
                      <p className="font-bold text-[#1f2937] text-[11px] leading-snug">
                        {item.descricao_normalizada || item.descricao_original}
                      </p>
                      {item.descricao_normalizada &&
                        item.descricao_normalizada !== item.descricao_original && (
                          <p className="text-[10px] text-[#6b7280] italic truncate">
                            Orig: {item.descricao_original}
                          </p>
                        )}
                      <div className="flex items-center gap-2 text-[9.5px] text-[#4b5563]">
                        {item.principio_ativo && (
                          <span>
                            <strong>P.A.:</strong> {item.principio_ativo}
                          </span>
                        )}
                        {item.concentracao && <span>{item.concentracao}</span>}
                        {item.apresentacao && <span>{item.apresentacao}</span>}
                        {item.analise_inteligente?.justificativa_ia && (
                          <span className="text-[#0284c7] font-semibold flex items-center gap-0.5">
                            <Sparkles className="w-2.5 h-2.5" /> Normalizado IA (
                            {item.confidence_score || 95}%)
                          </span>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* CATMAT */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-center font-mono text-[10px]">
                    {item.codigo_catalogo ? (
                      <span className="font-bold text-[#334155]">{item.codigo_catalogo}</span>
                    ) : (
                      <span className="text-[#9ca3af] italic">PENDENTE</span>
                    )}
                  </td>

                  {/* QUANTIDADE */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-center font-mono font-bold text-[#111827]">
                    {item.quantidade}
                  </td>

                  {/* UNIDADE */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-center font-mono text-[#475569] uppercase">
                    {item.unidade || 'un'}
                  </td>

                  {/* AMOSTRAS COLETADAS / VÁLIDAS */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-center font-mono">
                    <div className="space-y-0.5">
                      <span
                        className={`font-bold text-xs ${
                          temCriticaAmostra ? 'text-[#dc2626]' : 'text-[#065f46]'
                        }`}
                      >
                        {totalValidos} válidas
                      </span>
                      <span className="text-[9px] text-[#6b7280] block">
                        ({totalColetados} coletadas)
                      </span>
                    </div>
                  </td>

                  {/* SITUAÇÃO / JUÍZO CRÍTICO */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-center">
                    {justificativaPendente ? (
                      <span className="inline-block px-1.5 py-0.5 bg-[#dc2626] text-white font-bold text-[9.5px] uppercase">
                        CRÍTICA (&lt; 3)
                      </span>
                    ) : temCriticaAmostra ? (
                      <span className="inline-block px-1.5 py-0.5 bg-[#fef3c7] text-[#92400e] border border-[#fde68a] font-bold text-[9px] uppercase">
                        JUSTIFICADO
                      </span>
                    ) : item.status === 'concluido' ? (
                      <span className="inline-block px-1.5 py-0.5 bg-[#d1fae5] text-[#065f46] border border-[#a7f3d0] font-bold text-[9px] uppercase">
                        SANEADO
                      </span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 bg-[#e2e8f0] text-[#475569] font-bold text-[9px] uppercase">
                        EM COTAÇÃO
                      </span>
                    )}
                  </td>

                  {/* PREÇO UNITÁRIO DE REFERÊNCIA */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-right font-mono">
                    {valorUnit > 0 ? (
                      <div>
                        <span className="font-bold text-[12px] text-[#111827]">
                          {formatarMoeda(valorUnit)}
                        </span>
                        <span className="text-[9px] text-[#6b7280] block uppercase font-sans">
                          {item.metodo_adotado || 'mediana'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[#9ca3af] italic text-[10px]">Aguardando</span>
                    )}
                  </td>

                  {/* VALOR TOTAL ESTIMADO */}
                  <td className="p-1.5 border-r border-[#cbd5e1] text-right font-mono font-bold text-[#124268]">
                    {valorTotal > 0 ? (
                      formatarMoeda(valorTotal)
                    ) : (
                      <span className="text-[#9ca3af] italic font-normal text-[10px]">-</span>
                    )}
                  </td>

                  {/* AÇÕES NO ESTILO CESTA DE PREÇOS */}
                  <td className="p-1.5 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {/* BOTÃO PRINCIPAL: ABRIR MODAL CESTA DE PREÇOS */}
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onAbrirPrecos(item)}
                        className="bg-[#124268] hover:bg-[#0c314f] text-white text-[10px] font-bold uppercase tracking-wider h-6 px-2 rounded-none gap-1 shadow-none"
                        title="Abrir Painel Cesta de Preços do Item"
                      >
                        <Search className="h-3 w-3" />
                        COTAR / PREÇOS
                      </Button>

                      {/* ANÁLISE IA */}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onAbrirAnaliseIa(item)}
                        className="border-[#94a3b8] text-[#124268] hover:bg-[#f1f5f9] text-[10px] font-bold h-6 px-1.5 rounded-none"
                        title="Ver Análise da IA e Rastreabilidade"
                      >
                        <Sparkles className="h-3 w-3 text-amber-500" />
                      </Button>

                      {/* JUSTIFICATIVA */}
                      {temCriticaAmostra && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onAbrirJustificativa(item)}
                          className={`text-[10px] font-bold h-6 px-1.5 rounded-none ${
                            justificativaPendente
                              ? 'border-[#dc2626] bg-[#fee2e2] text-[#991b1b]'
                              : 'border-[#94a3b8] text-[#124268]'
                          }`}
                          title={
                            justificativaPendente
                              ? 'Justificativa Obrigatória Pendente'
                              : 'Ver/Editar Justificativa'
                          }
                        >
                          <FileText className="h-3 w-3" />
                        </Button>
                      )}

                      {/* EXCLUIR */}
                      {onExcluirItem && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isExecutando}
                          onClick={() => onExcluirItem(item)}
                          className="text-[#9ca3af] hover:text-[#dc2626] h-6 w-6 p-0"
                          title="Remover Item"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="p-2 bg-[#f8fafc] border-t border-[#cbd5e1] text-[10.5px] text-[#4b5563] flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>Juízo Crítico Integrado:</strong> A exclusão de amostras segue os limites
          regulamentares (70% - 130% da mediana). Cada exclusão exige motivo motivado pelo servidor.
        </span>
        <span className="font-mono text-[#124268] font-bold">TOTAL DE ITENS: {itens.length}</span>
      </div>
    </div>
  )
}
