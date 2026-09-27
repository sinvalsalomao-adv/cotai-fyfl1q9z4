import React, { useState } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  Building2,
  ClipboardList,
  Search,
  FileText,
  CalendarRange,
  GitBranch,
  FileSignature,
  Plug,
  Home,
  Menu,
  X,
  LogOut,
  ChevronDown,
  ShieldCheck,
  AlertCircle,
  Settings,
  Calculator,
} from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'

const navItems = [
  { name: 'Início', path: '/app', icon: Home },
  { name: 'Orçamentos', path: '/app/orcamentos', icon: Calculator },
  { name: 'Demandas', path: '/app/demandas', icon: ClipboardList },
  { name: 'Pesquisas', path: '/app/pesquisas', icon: Search },
  { name: 'Documentos', path: '/app/documentos', icon: FileText },
  { name: 'Planejamento', path: '/app/planejamento', icon: CalendarRange },
  { name: 'Processos', path: '/app/processos', icon: GitBranch },
  { name: 'Contratos', path: '/app/contratos', icon: FileSignature },
  { name: 'Integrações', path: '/app/integracoes', icon: Plug },
  { name: 'Regulamentos', path: '/app/regulamentos', icon: ShieldCheck },
  { name: 'Super Admin SaaS', path: '/app/saas-admin', icon: Settings },
]

export default function Layout() {
  const { user, organizacaoAtual, todasOrganizacoes, selecionarOrganizacao, logout } = useAuth()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <div className="flex h-screen bg-[#F6F7F9] text-[#111827] overflow-hidden font-sans">
      {/* Sidebar Desktop */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-[#1B4B8A] text-white flex-shrink-0 select-none shadow-md">
        {/* Brand Header */}
        <div className="h-16 flex items-center px-6 border-b border-white/10 gap-3">
          <div className="h-9 w-9 rounded-lg bg-white/15 flex items-center justify-center font-bold text-lg tracking-wider text-amber-400">
            NP
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-base leading-tight">Núcleo de Preços</span>
            <span className="text-[11px] text-white/70">Pesquisa Pública • Lei 14.133</span>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive =
              item.path === '/app'
                ? location.pathname === '/app'
                : location.pathname.startsWith(item.path)
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                  isActive
                    ? 'bg-white/20 text-white font-semibold shadow-sm border-l-4 border-amber-400 pl-2.5'
                    : 'text-white/80 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-amber-300' : 'text-white/70'}`} />
                <span>{item.name}</span>
              </NavLink>
            )
          })}
        </nav>

        {/* Órgãos Admin link */}
        <div className="p-3 border-t border-white/10">
          <NavLink
            to="/app/organizacoes"
            className="flex items-center gap-3 px-3.5 py-2 rounded-lg text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Building2 className="h-4 w-4 text-white/60" />
            <span>Gerenciar Órgãos</span>
          </NavLink>
        </div>

        {/* Org Banner info */}
        <div className="p-4 border-t border-white/10 bg-black/10">
          <div className="text-[11px] text-white/60 mb-1 flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
            <span>Órgão Ativo (Isolamento Rígido)</span>
          </div>
          <p className="text-xs font-semibold text-white truncate" title={organizacaoAtual?.nome}>
            {organizacaoAtual?.nome || 'Nenhum órgão selecionado'}
          </p>
          <p className="text-[10px] text-white/60 mt-0.5 truncate">
            CNPJ: {organizacaoAtual?.cnpj || 'Sem CNPJ'}
          </p>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Topbar */}
        <header className="h-16 bg-white border-b border-gray-200 px-4 sm:px-6 flex items-center justify-between shadow-sm z-10 flex-shrink-0">
          {/* Left: Mobile hamburger & Organization Selector */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-md hover:bg-gray-100 text-gray-700"
              aria-label="Abrir menu"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* Organization Dropdown Selector */}
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-[#1B4B8A] hidden sm:block" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 max-w-[280px] sm:max-w-md font-medium text-xs sm:text-sm truncate justify-between border-gray-300 bg-gray-50/50 hover:bg-gray-100"
                  >
                    <span className="truncate">
                      {organizacaoAtual ? organizacaoAtual.nome : 'Selecionar Órgão'}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 ml-2 text-gray-500 flex-shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-80">
                  <DropdownMenuLabel className="text-xs text-gray-500">
                    Alternar Órgão Contratante (Isolamento Rígido)
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {todasOrganizacoes.map((org) => (
                    <DropdownMenuItem
                      key={org.id}
                      onClick={() => selecionarOrganizacao(org.id)}
                      className={`cursor-pointer flex flex-col items-start py-2 ${
                        organizacaoAtual?.id === org.id ? 'bg-blue-50 font-semibold' : ''
                      }`}
                    >
                      <div className="text-sm text-gray-900">{org.nome}</div>
                      <div className="text-[11px] text-gray-500 font-normal">
                        CNPJ: {org.cnpj} •{' '}
                        {org.municipio_ibge?.split('-')[1]?.trim() || org.municipio_ibge}
                      </div>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => navigate('/app/organizacoes')}
                    className="text-xs text-[#1B4B8A] font-medium cursor-pointer"
                  >
                    + Cadastrar ou gerenciar órgãos
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Right: User Menu & Security Badge */}
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className="hidden md:flex border-amber-300 bg-amber-50 text-amber-800 text-[11px] gap-1 py-1"
            >
              <AlertCircle className="h-3 w-3 text-amber-600" />
              <span>Conectores: Homologação Ativa</span>
            </Badge>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="flex items-center gap-2 p-1.5 rounded-full hover:bg-gray-100"
                >
                  <div className="h-8 w-8 rounded-full bg-[#1B4B8A] text-white flex items-center justify-center font-semibold text-xs shadow-inner">
                    {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
                  </div>
                  <div className="hidden md:flex flex-col text-left">
                    <span className="text-xs font-semibold text-gray-900 leading-tight">
                      {user?.name || 'Usuário'}
                    </span>
                    <span className="text-[10px] text-gray-500 capitalize">
                      {user?.papel || 'Servidor'}
                    </span>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-sm font-semibold text-gray-900">{user?.name}</p>
                  <p className="text-xs text-gray-500">{user?.email}</p>
                  <p className="text-[11px] text-[#1B4B8A] font-medium mt-1">
                    Papel: {user?.papel || 'admin'}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => navigate('/app/organizacoes')}
                  className="cursor-pointer"
                >
                  <Building2 className="h-4 w-4 mr-2" />
                  <span>Configuração do Órgão</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => navigate('/app/integracoes')}
                  className="cursor-pointer"
                >
                  <Plug className="h-4 w-4 mr-2" />
                  <span>Painel de Integrações</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={logout}
                  className="text-red-600 cursor-pointer focus:bg-red-50"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  <span>Sair do Sistema</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page Content Scrollable */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>

        {/* Global Institutional Footer */}
        <footer className="h-9 bg-white border-t border-gray-200 px-6 flex items-center justify-between text-[11px] text-gray-500 flex-shrink-0">
          <div>
            Plataforma de Pesquisa de Preços Públicos v0.0.43 • PNCP + Compras.gov.br + Fontes
            Referenciais Homologadas •{' '}
            <span className="font-medium text-gray-700">
              Lei 14.133/2021 & IN 65 (Cesta de Preços)
            </span>
          </div>
          <div className="hidden sm:block text-emerald-700 font-medium">
            Fontes Oficiais Ativas em tempo real • Homologação Concluída
          </div>
        </footer>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/50 transition-opacity"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative flex flex-col w-72 bg-[#1B4B8A] text-white shadow-xl z-50">
            <div className="h-16 flex items-center justify-between px-6 border-b border-white/10">
              <span className="font-bold text-lg text-white">Núcleo de Preços</span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-1 rounded-md text-white/80 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
              {navItems.map((item) => {
                const Icon = item.icon
                const isActive =
                  item.path === '/app'
                    ? location.pathname === '/app'
                    : location.pathname.startsWith(item.path)
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium ${
                      isActive
                        ? 'bg-white/20 text-white font-semibold'
                        : 'text-white/80 hover:bg-white/10'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.name}</span>
                  </NavLink>
                )
              })}
            </nav>
            <div className="p-4 border-t border-white/10">
              <Button
                variant="destructive"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setMobileMenuOpen(false)
                  logout()
                }}
              >
                <LogOut className="h-4 w-4 mr-2" />
                <span>Sair</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
