import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthStatus } from '@/features/auth/store'
import { useEntitlements } from '@/features/auth/entitlements'

export function RequireAuth() {
  const status = useAuthStatus()
  const location = useLocation()

  if (status === 'idle' || status === 'loading') {
    return <BootSplash />
  }
  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  return <Outlet />
}

export function RequireAdmin() {
  const { isAdmin } = useEntitlements()
  return isAdmin ? <Outlet /> : <Navigate to="/dashboard" replace />
}

export function RequirePro() {
  const { isPro } = useEntitlements()
  // Pro features are HIDDEN ENTIRELY — non-pro users get a 404, not a paywall.
  return isPro ? <Outlet /> : <Navigate to="/404" replace />
}

function BootSplash() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-foreground-muted">
        <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
        <p className="text-sm">Loading…</p>
      </div>
    </div>
  )
}
