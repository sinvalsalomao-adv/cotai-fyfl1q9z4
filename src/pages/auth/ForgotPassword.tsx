import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { Mail, ArrowLeft, CheckCircle2 } from 'lucide-react'
import pb from '@/lib/pocketbase/client'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await pb.collection('users').requestPasswordReset(email)
    } catch {
      // Ignora erro por segurança de enumeração
    } finally {
      setLoading(false)
      setSubmitted(true)
    }
  }

  return (
    <div className="min-h-screen bg-[#F6F7F9] flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md space-y-4">
        <Card className="border-gray-200 shadow-md">
          <CardHeader>
            <CardTitle className="text-lg">Recuperação de Senha</CardTitle>
            <CardDescription className="text-xs">
              Informe seu e-mail funcional para receber o link de redefinição
            </CardDescription>
          </CardHeader>
          {submitted ? (
            <CardContent className="space-y-4 text-center py-6">
              <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
              <p className="text-sm font-medium text-gray-800">
                Se o e-mail estiver cadastrado, um link de recuperação foi enviado.
              </p>
              <p className="text-xs text-gray-500">
                Verifique sua caixa de entrada e pasta de spam.
              </p>
              <Button variant="outline" className="w-full mt-4" onClick={() => navigate('/login')}>
                Voltar para o Login
              </Button>
            </CardContent>
          ) : (
            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-4">
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
              </CardContent>
              <CardFooter className="flex flex-col gap-2 pt-2">
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-[#1B4B8A] hover:bg-[#15406F] text-white"
                >
                  {loading ? 'Enviando...' : 'Enviar Link de Recuperação'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-xs text-gray-600"
                  onClick={() => navigate('/login')}
                >
                  <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                  Voltar ao Login
                </Button>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </div>
  )
}
