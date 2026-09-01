import { useEffect } from 'react'
import { useAuthStatus } from '@/features/auth/store'
import { getWsClient } from '@/lib/ws/client'

/**
 * Owns the WebSocket lifecycle.
 *
 * Connects only when the user is authenticated; closes on sign-out. The
 * client itself is a singleton — subscribers via `useWsEvent` are managed
 * independently of this component's mount status.
 */
export function WsProvider({ children }: { children: React.ReactNode }) {
  const status = useAuthStatus()

  useEffect(() => {
    if (status !== 'authenticated') return
    const client = getWsClient()
    client.connect()
    return () => {
      client.close()
    }
  }, [status])

  return <>{children}</>
}
