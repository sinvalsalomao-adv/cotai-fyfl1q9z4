import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from '@/context/AuthContext'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import Layout from '@/components/Layout'

// Páginas de Autenticação
import Login from '@/pages/auth/Login'
import ForgotPassword from '@/pages/auth/ForgotPassword'
import ResetPassword from '@/pages/auth/ResetPassword'
import VerifyEmail from '@/pages/auth/VerifyEmail'

// Páginas Protegidas
import Dashboard from '@/pages/Dashboard'
import OrganizacoesLista from '@/pages/organizacoes/OrganizacoesLista'
import OrganizacaoDetalhe from '@/pages/organizacoes/OrganizacaoDetalhe'
import DemandasLista from '@/pages/demandas/DemandasLista'
import DemandaCriar from '@/pages/demandas/DemandaCriar'
import DemandaDetalhe from '@/pages/demandas/DemandaDetalhe'
import PesquisasLista from '@/pages/pesquisas/PesquisasLista'
import PesquisaCriar from '@/pages/pesquisas/PesquisaCriar'
import PesquisaDetalhe from '@/pages/pesquisas/PesquisaDetalhe'
import PesquisaCalculo from '@/pages/pesquisas/PesquisaCalculo'
import DocumentosLista from '@/pages/documentos/DocumentosLista'
import DocumentoDetalhe from '@/pages/documentos/DocumentoDetalhe'
import ProcessosLista from '@/pages/processos/ProcessosLista'
import ProcessoDetalhe from '@/pages/processos/ProcessoDetalhe'
import Planejamento from '@/pages/Planejamento'
import Contratos from '@/pages/Contratos'
import Integracoes from '@/pages/Integracoes'
import SaasAdmin from '@/pages/saas/SaasAdmin'
import RegulamentosOrgao from '@/pages/organizacoes/RegulamentosOrgao'
import OrcamentosLista from '@/pages/orcamentos/OrcamentosLista'
import OrcamentoCriar from '@/pages/orcamentos/OrcamentoCriar'
import OrcamentoMetodologia from '@/pages/orcamentos/OrcamentoMetodologia'
import OrcamentoItens from '@/pages/orcamentos/OrcamentoItens'
import OrcamentoMapa from '@/pages/orcamentos/OrcamentoMapa'
import NotFound from '@/pages/NotFound'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Rotas Públicas */}
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />

          {/* Redirecionamento da raiz para /app */}
          <Route path="/" element={<Navigate to="/app" replace />} />

          {/* Rotas Protegidas dentro do Layout Global */}
          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            {/* 1. Início / Dashboard */}
            <Route index element={<Dashboard />} />

            {/* 2. Organizações */}
            <Route path="organizacoes" element={<OrganizacoesLista />} />
            <Route path="organizacoes/:id" element={<OrganizacaoDetalhe />} />

            {/* 3. Demandas */}
            <Route path="demandas" element={<DemandasLista />} />
            <Route path="demandas/nova" element={<DemandaCriar />} />
            <Route path="demandas/:id" element={<DemandaDetalhe />} />

            {/* 4. Módulo de Orçamentos e Pesquisa de Preços (Fluxo Operacional Rápido) */}
            <Route path="orcamentos" element={<OrcamentosLista />} />
            <Route path="orcamentos/novo" element={<OrcamentoCriar />} />
            <Route path="orcamentos/:id/metodologia" element={<OrcamentoMetodologia />} />
            <Route path="orcamentos/:id/itens" element={<OrcamentoItens />} />
            <Route path="orcamentos/:id/mapa" element={<OrcamentoMapa />} />

            {/* 5. Pesquisas de Preços e Cálculo */}
            <Route path="pesquisas" element={<PesquisasLista />} />
            <Route path="pesquisas/nova" element={<PesquisaCriar />} />
            <Route path="pesquisas/:id" element={<PesquisaDetalhe />} />
            <Route path="pesquisas/:id/calculo" element={<PesquisaCalculo />} />
            {/* Redirecionamento de rotas legadas de cotação para o fluxo de orçamentos */}
            <Route path="cotacoes/*" element={<Navigate to="/app/orcamentos" replace />} />
            {/* Rotas SaaS & Regulamentos */}
            <Route path="saas-admin" element={<SaasAdmin />} />
            <Route path="regulamentos" element={<RegulamentosOrgao />} />

            {/* 5. Documentos e Versões */}
            <Route path="documentos" element={<DocumentosLista />} />
            <Route path="documentos/:id" element={<DocumentoDetalhe />} />

            {/* 6. Processos */}
            <Route path="processos" element={<ProcessosLista />} />
            <Route path="processos/:id" element={<ProcessoDetalhe />} />

            {/* 7. Planejamento (DFDs e PCA) */}
            <Route path="planejamento" element={<Planejamento />} />

            {/* 8. Contratos (Modelo Previsto) */}
            <Route path="contratos" element={<Contratos />} />

            {/* 9. Integrações */}
            <Route path="integracoes" element={<Integracoes />} />
          </Route>

          {/* Redirecionamento direto da rota legada /cotacoes/:id para /app/orcamentos */}
          <Route path="/cotacoes/*" element={<Navigate to="/app/orcamentos" replace />} />

          {/* Rota 404 */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
