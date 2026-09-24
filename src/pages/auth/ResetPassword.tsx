import React, { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
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
import { Lock, CheckCircle2, AlertCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import pb from '@/lib/pocketbase/client'

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('As senhas digitadas não coincidem.')
      return
    }
    if (password.length < 8) {
      setError('A senha deve possuir pelo menos 8 caracteres.')
      return
    }

    setLoading(true)
    try {
      await pb.collection('users').confirmPasswordReset(token, password, confirmPassword)
      setSuccess(true)
    } catch (err: any) {
      setError(err?.message || 'Token expirado ou inválido. Solicite uma nova recuperação.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F6F7F9] flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md space-y-4">
        <Card className="border-gray-200 shadow-md">
          <CardHeader>
            <CardTitle className="text-lg">Definir Nova Senha</CardTitle>
            <CardDescription className="text-xs">
              Digite e confirme a nova senha para seu usuário institucional
            </CardDescription>
          </CardHeader>
          {success ? (
            <CardContent className="space-y-4 text-center py-6">
              <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
              <p className="text-sm font-medium text-gray-800">Senha redefinida com sucesso!</p>
              <Button
                className="w-full bg-[#1B4B8A] hover:bg-[#15406F] text-white"
                onClick={() => navigate('/login')}
              >
                Ir para o Login
              </Button>
            </CardContent>
          ) : (
            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-4">
                {error && (
                  <Alert variant="destructive" className="py-2 text-xs">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="pass" className="text-xs font-medium text-gray-700">
                    Nova Senha (mín. 8 caracteres)
                  </Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <Input
                      id="pass"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pl-9 text-sm"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="conf-pass" className="text-xs font-medium text-gray-700">
                    Confirme a Nova Senha
                  </Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                    <Input
                      id="conf-pass"
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="pl-9 text-sm"
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-2">
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-[#1B4B8A] hover:bg-[#15406F] text-white"
                >
                  {loading ? 'Redefinindo...' : 'Definir Nova Senha'}
                </Button>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </div>
  )
}
