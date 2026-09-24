import React, { createContext, useContext, useEffect, useState } from 'react'
import pb from '@/lib/pocketbase/client'
import type { Usuario, Organizacao } from '@/types'
import { listarOrganizacoes, getActiveOrgId, setActiveOrgId } from '@/services/apiService'

interface AuthContextType {
  user: Usuario | null
  organizacaoAtual: Organizacao | null
  todasOrganizacoes: Organizacao[]
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, pass: string) => Promise<void>
  logout: () => void
  selecionarOrganizacao: (orgId: string) => void
  recarregarDadosOrg: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<Usuario | null>(null)
  const [organizacaoAtual, setOrganizacaoAtual] = useState<Organizacao | null>(null)
  const [todasOrganizacoes, setTodasOrganizacoes] = useState<Organizacao[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const syncAuth = async () => {
    try {
      if (pb.authStore.isValid && pb.authStore.record) {
        const currentUser: Usuario = {
          id: pb.authStore.record.id,
          email: pb.authStore.record.email,
          name: pb.authStore.record.name || 'Usuário',
          avatar: pb.authStore.record.avatar,
          papel: pb.authStore.record.papel || 'admin',
          organizacao_id: pb.authStore.record.organizacao_id,
        }
        setUser(currentUser)

        // Carregar organizações
        try {
          const orgs = await listarOrganizacoes()
          setTodasOrganizacoes(orgs)

          const preferredOrgId =
            getActiveOrgId() || currentUser.organizacao_id || (orgs[0] ? orgs[0].id : '')
          const active = orgs.find((o) => o.id === preferredOrgId) || orgs[0] || null
          setOrganizacaoAtual(active)
          if (active) {
            setActiveOrgId(active.id)
          }
        } catch (orgErr) {
          console.warn('Erro ao carregar organizações:', orgErr)
        }
      } else {
        setUser(null)
        setOrganizacaoAtual(null)
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    syncAuth()

    const unsubscribe = pb.authStore.onChange(() => {
      syncAuth()
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const login = async (email: string, pass: string) => {
    setIsLoading(true)
    try {
      await pb.collection('users').authWithPassword(email, pass)
      await syncAuth()
    } finally {
      setIsLoading(false)
    }
  }

  const logout = () => {
    pb.authStore.clear()
    localStorage.removeItem('active_org_id')
    setUser(null)
    setOrganizacaoAtual(null)
  }

  const selecionarOrganizacao = (orgId: string) => {
    const org = todasOrganizacoes.find((o) => o.id === orgId)
    if (org) {
      setOrganizacaoAtual(org)
      setActiveOrgId(org.id)
      // Dispara evento para telas recarregarem dados da organização isolada
      window.dispatchEvent(new CustomEvent('organizacao_changed', { detail: { orgId } }))
    }
  }

  const recarregarDadosOrg = async () => {
    try {
      const orgs = await listarOrganizacoes()
      setTodasOrganizacoes(orgs)
      const currentId = organizacaoAtual?.id || getActiveOrgId()
      const active = orgs.find((o) => o.id === currentId) || orgs[0] || null
      setOrganizacaoAtual(active)
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        organizacaoAtual,
        todasOrganizacoes,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        selecionarOrganizacao,
        recarregarDadosOrg,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth deve ser usado dentro de um AuthProvider')
  }
  return context
}
