import React from 'react'
import { FileSignature, Info, Clock, ShieldCheck, Database } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export default function Contratos() {
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          Contratos e Atas de Registro de Preços
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Gestão de vigência, saldos de atas de registro de preços e execuções contratuais
        </p>
      </div>

      <Alert className="border-amber-300 bg-amber-50 text-amber-950 text-xs">
        <Info className="h-4 w-4 text-amber-700" />
        <AlertTitle className="text-xs font-semibold">
          Modelo de Dados Previsto (Seção 3 e 8 da Especificação)
        </AlertTitle>
        <AlertDescription className="text-xs text-amber-900 leading-relaxed mt-1">
          Nesta primeira entrega, a entidade <code>contratos</code> possui modelo de dados
          estruturado no banco de dados para futura gestão de aditivos, empenhos e liquidações, sem
          CRUD funcional aberto nesta fase.
        </AlertDescription>
      </Alert>

      {/* Modelo Estruturado Visual */}
      <Card className="border-gray-200">
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Database className="h-4 w-4 text-[#1B4B8A]" />
            Estrutura da Entidade de Contratos / Atas
          </CardTitle>
          <CardDescription className="text-xs">
            Campos canônicos e relacionamentos previstos no esquema do banco de dados
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4 space-y-4 text-xs text-gray-700">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 bg-gray-50 rounded border border-gray-200 space-y-1">
              <strong className="text-gray-900">Campos Principais:</strong>
              <p className="font-mono text-[11px] text-gray-600">
                • organizacao_id (relação com Órgão)
                <br />• processo_id (relação com Processo de Origem)
                <br />• numero (Número do Instrumento Contratual)
                <br />• status (vigente / encerrado / rescindido)
                <br />• created / updated (autodatas com auditoria)
              </p>
            </div>
            <div className="p-3 bg-gray-50 rounded border border-gray-200 space-y-1">
              <strong className="text-gray-900">Integração Futura:</strong>
              <p className="text-gray-600 text-[11px] leading-relaxed">
                As pesquisas de preços homologadas alimentarão diretamente as minutas de contrato e
                atas de registro de preços, preservando a rastreabilidade total do valor unitário de
                adjudicação.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
