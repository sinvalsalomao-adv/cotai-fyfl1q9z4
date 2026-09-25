import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FileText,
  Building2,
  Calendar,
  ArrowRight,
  X,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/context/AuthContext'
import { BudgetService } from '@/services/budgetService'

export default function OrcamentoCriar() {
  const navigate = useNavigate()
  const { user, organizacaoAtual, todasOrganizacoes } = useAuth()

  const [nome, setNome] = useState('')
  const [referenciaExterna, setReferenciaExterna] = useState('')
  const [objeto, setObjeto] = useState('')
  const [orgaoId, setOrgaoId] = useState(organizacaoAtual?.id || '')
  const [erros, setErros] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  // Ao carregar, garantir que orgaoId esteja preenchido
  React.useEffect(() => {
    if (!orgaoId && organizacaoAtual?.id) {
      setOrgaoId(organizacaoAtual.id)
    } else if (!orgaoId && todasOrganizacoes.length > 0) {
      setOrgaoId(todasOrganizacoes[0].id)
    }
  }, [organizacaoAtual, todasOrganizacoes])

  const validarFormulario = () => {
    const novosErros: Record<string, string> = {}
    if (!nome.trim()) {
      novosErros.nome = 'O nome do orçamento é obrigatório.'
    }
    if (!objeto.trim() || objeto.trim().length < 10) {
      novosErros.objeto = 'O objeto da contratação é obrigatório (mínimo 10 caracteres).'
    }
    if (!orgaoId) {
      novosErros.orgaoId = 'Selecione o órgão interessado.'
    }

    setErros(novosErros)
    return Object.keys(novosErros).length === 0
  }

  const handleContinuar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validarFormulario()) return

    setLoading(true)
    try {
      const budget = await BudgetService.criarOrcamento({
        tenant_id: orgaoId,
        name: nome,
        external_reference: referenciaExterna,
        object: objeto,
        organization_id: orgaoId,
        created_by: user?.id,
      })

      // Redirecionar para a Etapa 2: Metodologias e Padrões
      navigate(`/app/orcamentos/${budget.id}/metodologia`)
    } catch (err: any) {
      console.error('Erro ao criar orçamento:', err)
      alert('Erro ao criar orçamento: ' + (err.message || 'Verifique a conexão.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Topo do Módulo Cesta de Preços */}
      <div className="bg-white border border-[#b8c2cc] shadow-xs">
        {/* Barra Superior Azul-Escura #124268 */}
        <div className="bg-[#124268] text-white px-4 py-3 flex items-center justify-between select-none">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              NOVO ORÇAMENTO — DADOS GERAIS DO PROCESSO
            </span>
          </div>
          <span className="text-[11px] font-mono bg-white/10 px-2 py-0.5 text-amber-300">
            ETAPA 1 DE 3
          </span>
        </div>

        {/* Banner Amarelo-Claro Orientativo com borda esquerda marcada */}
        <div className="bg-[#fffbeb] border-l-4 border-amber-500 p-3.5 m-4 text-xs text-amber-950 flex items-start gap-2.5">
          <HelpCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <strong className="block text-amber-900 uppercase font-bold text-[11px]">
              Orientações de Preenchimento:
            </strong>
            <p>
              O número de controle interno do orçamento é gerado automaticamente pelo sistema. A{' '}
              <strong>Referência Externa</strong> (Processo Administrativo, Contrato ou Pregão) é
              opcional e, quando informada, constará nos relatórios, mapas comparativos e memórias
              de cálculo emitidos.
            </p>
          </div>
        </div>

        {/* Formulário Principal */}
        <form onSubmit={handleContinuar} className="p-4 sm:p-6 space-y-5">
          {/* Seção empilhada em barra cinza #828892 */}
          <div className="bg-[#828892] text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider select-none">
            IDENTIFICAÇÃO DA CONTRATAÇÃO
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Nome do Orçamento */}
            <div className="space-y-1">
              <label className="block text-gray-700 font-bold uppercase text-[10px]">
                NOME DO ORÇAMENTO *
              </label>
              <Input
                value={nome}
                onChange={(e) => {
                  setNome(e.target.value)
                  if (erros.nome) setErros({ ...erros, nome: '' })
                }}
                placeholder="Ex: Prorrogação de preços — Medicamentos Farmácia Básica"
                className={`h-9 text-xs sm:text-sm rounded-none border-gray-400 bg-white ${
                  erros.nome ? 'border-red-500 focus-visible:ring-red-400' : ''
                }`}
              />
              {erros.nome && <p className="text-red-600 text-[11px] font-bold">{erros.nome}</p>}
            </div>

            {/* Referência Externa */}
            <div className="space-y-1">
              <label className="block text-gray-700 font-bold uppercase text-[10px]">
                REFERÊNCIA EXTERNA (Nº PROCESSO / CONTRATO / LICITAÇÃO)
                <span className="text-gray-400 font-normal lowercase ml-1">(opcional)</span>
              </label>
              <Input
                value={referenciaExterna}
                onChange={(e) => {
                  setReferenciaExterna(e.target.value)
                  if (erros.referenciaExterna) setErros({ ...erros, referenciaExterna: '' })
                }}
                placeholder="Ex: Processo Administrativo nº 123/2026 (opcional)"
                className="h-9 text-xs sm:text-sm rounded-none border-gray-400 bg-white"
              />
              <span className="text-[10px] text-gray-500 block">
                Opcional. Se preenchida, constará nos relatórios e memórias de cálculo.
              </span>
            </div>
          </div>

          {/* Órgão Interessado */}
          <div className="space-y-1">
            <label className="block text-gray-700 font-bold uppercase text-[10px]">
              ÓRGÃO INTERESSADO *
            </label>
            <select
              value={orgaoId}
              onChange={(e) => {
                setOrgaoId(e.target.value)
                if (erros.orgaoId) setErros({ ...erros, orgaoId: '' })
              }}
              className={`h-9 w-full text-xs sm:text-sm rounded-none border border-gray-400 bg-white px-3 font-medium text-gray-800 ${
                erros.orgaoId ? 'border-red-500' : ''
              }`}
            >
              <option value="">Selecione o órgão contratante...</option>
              {todasOrganizacoes.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.nome} — CNPJ: {org.cnpj}
                </option>
              ))}
            </select>
            {erros.orgaoId && <p className="text-red-600 text-[11px] font-bold">{erros.orgaoId}</p>}
          </div>

          {/* Objeto */}
          <div className="space-y-1">
            <label className="block text-gray-700 font-bold uppercase text-[10px]">
              OBJETO DA CONTRATAÇÃO *
            </label>
            <Textarea
              rows={4}
              value={objeto}
              onChange={(e) => {
                setObjeto(e.target.value)
                if (erros.objeto) setErros({ ...erros, objeto: '' })
              }}
              placeholder="Ex: Prorrogação de aquisição de medicamentos para atendimento da Farmácia Básica Municipal, visando manter o abastecimento contínuo da rede municipal de saúde conforme especificações e quantitativos constantes do termo de referência."
              className={`text-xs sm:text-sm rounded-none border-gray-400 bg-white resize-y ${
                erros.objeto ? 'border-red-500 focus-visible:ring-red-400' : ''
              }`}
            />
            {erros.objeto && <p className="text-red-600 text-[11px] font-bold">{erros.objeto}</p>}
          </div>

          {/* Botões do Rodapé: CANCELAR e CONTINUAR */}
          <div className="pt-4 border-t border-gray-300 flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate('/app/orcamentos')}
              className="h-10 px-5 text-xs font-bold uppercase rounded-none border-gray-400 text-gray-700 bg-white hover:bg-gray-100"
            >
              CANCELAR
            </Button>
            <Button
              type="submit"
              disabled={loading}
              className="h-10 px-6 text-xs font-bold uppercase rounded-none bg-[#124268] hover:bg-[#0c314f] text-white shadow-none flex items-center gap-2"
            >
              <span>{loading ? 'CRIANDO...' : 'CONTINUAR'}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
