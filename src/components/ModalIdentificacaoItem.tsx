import React, { useState, useEffect } from 'react'
import {
  Search,
  Sparkles,
  Pill,
  Package,
  Layers,
  ArrowRight,
  CheckCircle,
  FileText,
  AlertCircle,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ItemIdentificationEngine,
  CatalogoSugestao,
  MedicamentoFluxoInput,
} from '@/lib/itemIdentificationEngine'
import { formatarMoeda } from '@/lib/calculoEngine'

interface ModalIdentificacaoItemProps {
  termoInicial?: string
  aberto: boolean
  onClose: () => void
  onSelecionarItem: (item: {
    descricao: string
    codigoCatalogo: string
    unidadeSugerida: string
    categoria: string
    referenciaCmed?: any
  }) => void
}

export default function ModalIdentificacaoItem({
  termoInicial = '',
  aberto,
  onClose,
  onSelecionarItem,
}: ModalIdentificacaoItemProps) {
  const [busca, setBusca] = useState(termoInicial)
  const [sugestoes, setSugestoes] = useState<CatalogoSugestao[]>([])
  const [abaAtiva, setAbaAtiva] = useState<'busca' | 'medicamentos'>('busca')

  // Fluxo especializado de medicamentos
  const [medInput, setMedInput] = useState<MedicamentoFluxoInput>({
    principio_ativo: 'Dipirona Sódica',
    concentracao: '500 mg',
    apresentacao: '500 mg comprimido simples',
    forma_farmaceutica: 'Comprimido',
    unidade: 'comprimido',
    quantidade: 10000,
  })

  useEffect(() => {
    if (busca && busca.trim().length >= 2) {
      const res = ItemIdentificationEngine.identificarItem(busca)
      setSugestoes(res)
    } else {
      setSugestoes([])
    }
  }, [busca])

  useEffect(() => {
    if (termoInicial) {
      setBusca(termoInicial)
    }
  }, [termoInicial])

  if (!aberto) return null

  const handleAplicarMedicamento = () => {
    const constr = ItemIdentificationEngine.construirItemMedicamento(medInput)
    onSelecionarItem({
      descricao: constr.descricao_completa,
      codigoCatalogo: `${constr.codigo_catmat_sugerido} | ${constr.codigo_bps_sugerido}`,
      unidadeSugerida: constr.unidade_padrao,
      categoria: 'medicamentos',
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-gray-200 animate-in fade-in zoom-in-95">
        {/* Header Modal */}
        <div className="p-4 bg-[#1B4B8A] text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-300" />
            <div>
              <h2 className="text-base font-bold">Motor de Identificação do Item</h2>
              <p className="text-[11px] text-white/80">
                Padronização com CATMAT / CATSER / BPS • Similaridade textual com score percentual
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-white hover:bg-white/10"
          >
            ✕ Fechar
          </Button>
        </div>

        {/* Corpo com Abas */}
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          <Tabs value={abaAtiva} onValueChange={(v) => setAbaAtiva(v as any)}>
            <TabsList className="grid grid-cols-2 max-w-md bg-gray-100 p-1">
              <TabsTrigger value="busca" className="text-xs font-semibold">
                <Search className="h-3.5 w-3.5 mr-1.5" />
                Busca Estruturada & Fuzzy
              </TabsTrigger>
              <TabsTrigger value="medicamentos" className="text-xs font-semibold">
                <Pill className="h-3.5 w-3.5 mr-1.5 text-rose-600" />
                Fluxo Especializado Medicamentos
              </TabsTrigger>
            </TabsList>

            {/* ABA 1: Busca Estruturada */}
            <TabsContent value="busca" className="space-y-4 pt-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-700">
                  Digite a descrição do item (ex: "Dipirona", "Paracetamol", "Papel A4", "Desktop"):
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <Input
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    placeholder="Ex: Dipirona 500mg, Papel sulfite A4, Veículo hatch..."
                    className="pl-9 text-sm"
                  />
                </div>
              </div>

              {/* Sugestões do Catálogo */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-500 font-medium">
                  <span>Itens Padronizados Encontrados ({sugestoes.length})</span>
                  <span>Similaridade Token/Levenshtein</span>
                </div>

                {sugestoes.length === 0 ? (
                  <div className="p-8 text-center border-2 border-dashed border-gray-200 rounded-lg text-xs text-gray-400">
                    {busca.length < 2
                      ? 'Digite ao menos 2 caracteres para consultar a base de catálogo oficial.'
                      : 'Nenhuma correspondência exata. Você pode cadastrar como novo item.'}
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
                    {sugestoes.map((sug) => (
                      <div
                        key={sug.id}
                        onClick={() => {
                          onSelecionarItem({
                            descricao: sug.descricao_padronizada,
                            codigoCatalogo: sug.codigo,
                            unidadeSugerida: sug.unidades_compativeis[0] || 'un',
                            categoria: sug.categoria,
                            referenciaCmed: sug.referencia_regulatoria_cmed,
                          })
                          onClose()
                        }}
                        className="p-3.5 border border-gray-200 hover:border-[#1B4B8A] bg-white hover:bg-blue-50/40 rounded-lg cursor-pointer transition-all space-y-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge className="bg-[#1B4B8A] text-white text-[10px] font-mono">
                                {sug.codigo}
                              </Badge>
                              <Badge variant="outline" className="text-[10px] uppercase">
                                {sug.categoria}
                              </Badge>
                              {sug.principio_ativo && (
                                <Badge className="bg-rose-100 text-rose-800 text-[10px]">
                                  Princípio Ativo: {sug.principio_ativo}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs font-semibold text-gray-900 leading-snug">
                              {sug.descricao_padronizada}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <span
                              className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                                sug.score_similaridade >= 90
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : sug.score_similaridade >= 70
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              Correspondência: {sug.score_similaridade}%
                            </span>
                          </div>
                        </div>

                        {/* Unidades compatíveis */}
                        <div className="flex items-center gap-2 text-[11px] text-gray-500 pt-1 border-t border-gray-100">
                          <Package className="h-3.5 w-3.5 text-gray-400" />
                          <span>Unidades compatíveis:</span>
                          <span className="font-medium text-gray-700">
                            {sug.unidades_compativeis.join(', ')}
                          </span>
                        </div>

                        {/* Teto Regulatório CMED quando houver */}
                        {sug.referencia_regulatoria_cmed && (
                          <div className="p-2 bg-amber-50 rounded border border-amber-200 text-[11px] text-amber-900 flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
                              <span>
                                <strong>Referência Regulatória CMED (Teto):</strong> Preço Fábrica
                                (PF):{' '}
                                {formatarMoeda(sug.referencia_regulatoria_cmed.teto_preco_fabrica)}{' '}
                                • PMC: {formatarMoeda(sug.referencia_regulatoria_cmed.teto_pmc)}
                              </span>
                            </div>
                            <Badge className="bg-amber-200 text-amber-900 text-[9px] uppercase">
                              Teto Regulatório
                            </Badge>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ABA 2: Fluxo Especializado de Medicamentos */}
            <TabsContent value="medicamentos" className="space-y-4 pt-3">
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 space-y-1">
                <p className="font-semibold flex items-center gap-1.5">
                  <Pill className="h-4 w-4 text-rose-600" />
                  Fluxo Especializado da Saúde Pública (RENAME / ANVISA / BPS)
                </p>
                <p className="text-[11px] text-rose-800">
                  Desagrega o medicamento em Princípio Ativo → Concentração → Apresentação → Forma →
                  Unidade para cruzamento exato no BPS e tabela CMED.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">
                    1. Princípio Ativo (Substância):
                  </label>
                  <Input
                    value={medInput.principio_ativo}
                    onChange={(e) => setMedInput({ ...medInput, principio_ativo: e.target.value })}
                    placeholder="Ex: Dipirona Sódica, Paracetamol, Amoxicilina..."
                    className="text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">2. Concentração:</label>
                  <Input
                    value={medInput.concentracao}
                    onChange={(e) => setMedInput({ ...medInput, concentracao: e.target.value })}
                    placeholder="Ex: 500 mg, 500 mg/ml, 1 g, 250 mg/5ml..."
                    className="text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">
                    3. Forma Farmacêutica:
                  </label>
                  <Input
                    value={medInput.forma_farmaceutica}
                    onChange={(e) =>
                      setMedInput({ ...medInput, forma_farmaceutica: e.target.value })
                    }
                    placeholder="Ex: Comprimido, Gotas, Solução Injetável, Cápsula..."
                    className="text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">4. Apresentação:</label>
                  <Input
                    value={medInput.apresentacao}
                    onChange={(e) => setMedInput({ ...medInput, apresentacao: e.target.value })}
                    placeholder="Ex: 500 mg comprimido simples, frasco 20ml..."
                    className="text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">
                    5. Unidade de Medida:
                  </label>
                  <Input
                    value={medInput.unidade}
                    onChange={(e) => setMedInput({ ...medInput, unidade: e.target.value })}
                    placeholder="Ex: comprimido, frasco, ampola..."
                    className="text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">
                    6. Quantidade Demandada:
                  </label>
                  <Input
                    type="number"
                    value={medInput.quantidade}
                    onChange={(e) =>
                      setMedInput({ ...medInput, quantidade: Number(e.target.value) })
                    }
                    className="text-xs"
                  />
                </div>
              </div>

              {/* Prévia Estruturada */}
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-1.5">
                <span className="text-[11px] font-bold text-gray-600 uppercase">
                  Descrição Padronizada Resultante:
                </span>
                <p className="text-xs font-semibold text-[#1B4B8A]">
                  {medInput.principio_ativo.toUpperCase()} {medInput.concentracao.toUpperCase()},{' '}
                  {medInput.forma_farmaceutica.toUpperCase()} ({medInput.apresentacao.toUpperCase()}
                  )
                </p>
                <div className="flex gap-2 text-[11px] text-gray-500 pt-1">
                  <span>
                    Quantidade:{' '}
                    <strong>
                      {medInput.quantidade} {medInput.unidade}
                    </strong>
                  </span>
                  <span>•</span>
                  <span>Bases consultadas: BPS + PNCP + Compras.gov + Teto CMED</span>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  onClick={handleAplicarMedicamento}
                  className="bg-[#1B4B8A] hover:bg-[#15406F] text-white text-xs font-semibold"
                >
                  <CheckCircle className="h-4 w-4 mr-1.5" />
                  Confirmar e Pesquisar Preços
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
