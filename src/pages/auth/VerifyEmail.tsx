import React, { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CheckCircle2, AlertCircle } from 'lucide-react'
import pb from '@/lib/pocketbase/client'

export default function VerifyEmail() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const navigate = useNavigate()

  useEffect(() => {
    if (!token) {
      setStatus('error')
      return
    }
    pb.collection('users')
      .confirmVerification(token)
      .then(() => setStatus('success'))
      .catch(() => setStatus('error'))
  }, [token])

  return (
    <div className="min-h-screen bg-[#F6F7F9] flex flex-col justify-center items-center p-4">
      <Card className="w-full max-w-md border-gray-200 shadow-md text-center p-6 space-y-4">
        <CardHeader>
          <CardTitle className="text-lg">Confirmação de E-mail</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'loading' && (
            <p className="text-sm text-gray-600">Verificando conta institucional...</p>
          )}
          {status === 'success' && (
            <div className="space-y-3">
              <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
              <p className="text-sm font-medium text-gray-800">E-mail verificado com sucesso!</p>
              <Button
                className="w-full bg-[#1B4B8A] hover:bg-[#15406F] text-white"
                onClick={() => navigate('/login')}
              >
                Acessar Sistema
              </Button>
            </div>
          )}
          {status === 'error' && (
            <div className="space-y-3">
              <AlertCircle className="h-12 w-12 text-red-600 mx-auto" />
              <p className="text-sm font-medium text-gray-800">Token inválido ou expirado.</p>
              <Button variant="outline" className="w-full" onClick={() => navigate('/login')}>
                Voltar para o Login
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
