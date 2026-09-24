import React, { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { AlertCircle, Lock, Mail, ShieldCheck } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'

export default function Login() {
  const [email, setEmail] = useState('matheusflotencio137482@gmail.com')
  const [password, setPassword] = useState('Skip@Pass')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as any)?.from?.pathname || '/app'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
      navigate(from, { replace: true })
    } catch (err: any) {
      setError(err?.message || 'Falha ao autenticar. Verifique e-mail e senha.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F6F7F9] flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Header Institucional */}
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#1B4B8A] text-white shadow-md">
            <ShieldCheck className="h-7 w-7 text-amber-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Plataforma de Pesquisa de Preços
          </h1>
          <p className="text-xs text-gray-600">
            Sistema Oficial de Pesquisa e Contratações Públicas • Lei nº 14.133/2021
          </p>
        </div>

        {/* Card de Login */}
        <Card className="border-gray-200 shadow-md">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg">Acesso do Servidor</CardTitle>
            <CardDescription className="text-xs">
              Entre com suas credenciais institucionais para acessar o órgão
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {error && (
                <Alert variant="destructive" className="py-2 text-xs">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-medium text-gray-700">
                  E-mail institucional
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="servidor@orgao.gov.br"
                    className="pl-9 text-sm"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-xs font-medium text-gray-700">
                    Senha de acesso
                  </Label>
                  <button
                    type="button"
                    onClick={() => navigate('/forgot-password')}
                    className="text-[11px] text-[#1B4B8A] hover:underline"
                  >
                    Esqueci minha senha
                  </button>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <Input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pl-9 text-sm"
                  />
                </div>
              </div>

              <div className="bg-blue-50/70 border border-blue-200/60 rounded-md p-2.5 text-[11px] text-blue-900 space-y-1">
                <p className="font-semibold text-blue-950">
                  Acesso de Demonstração (Seed Oficial):
                </p>
                <p>
                  E-mail:{' '}
                  <code className="bg-white px-1 py-0.5 rounded text-blue-900 font-mono">
                    matheusflotencio137482@gmail.com
                  </code>
                </p>
                <p>
                  Senha:{' '}
                  <code className="bg-white px-1 py-0.5 rounded text-blue-900 font-mono">
                    Skip@Pass
                  </code>
                </p>
              </div>
            </CardContent>

            <CardFooter className="pt-2">
              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-[#1B4B8A] hover:bg-[#15406F] text-white font-medium"
              >
                {loading ? 'Autenticando...' : 'Entrar no Sistema'}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Informação Regulamentar */}
        <p className="text-center text-[11px] text-gray-500">
          Acesso restrito a servidores autorizados. Todas as consultas e alterações são registradas
          em trilha de auditoria para fins de controle externo.
        </p>
      </div>
    </div>
  )
}
