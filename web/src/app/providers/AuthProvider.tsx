import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { setOnUnauthorized } from '@/lib/api/client'
import { useAuthStore } from '@/features/auth/store'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const reset = useAuthStore((s) => s.reset)
  const navigate = useNavigate()

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  useEffect(() => {
    setOnUnauthorized(() => {
      reset()
      navigate('/login', { replace: true })
    })
  }, [navigate, reset])

  return <>{children}</>
}
