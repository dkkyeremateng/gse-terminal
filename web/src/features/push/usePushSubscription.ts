import { useCallback, useEffect, useState } from 'react'
import { useSubscribePush, useUnsubscribePush, useVapidKey } from './queries'
import { toast } from '@/lib/utils/toast'

type Permission = NotificationPermission | 'unsupported'

const SW_PATH = '/sw.js'

/**
 * Browser-side push subscription manager.
 *
 * Handles three responsibilities so consumers can reduce them to a toggle:
 *  1. Detect platform support (HTTPS or localhost, secure context, push API)
 *  2. Read/track the OS-level permission state and the browser's
 *     PushSubscription record
 *  3. Subscribe/unsubscribe via the service worker, mirroring the result
 *     to the backend so server-side fan-out reaches the right endpoints.
 *
 * The sw.js file is served by the existing /ui PWA at the same origin —
 * we register it here so this app can sit behind that worker too.
 */
export function usePushSubscription() {
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
  const [permission, setPermission] = useState<Permission>(
    supported && 'Notification' in window ? Notification.permission : 'unsupported',
  )
  const [subscription, setSubscription] = useState<PushSubscription | null>(null)
  const [busy, setBusy] = useState(false)

  const vapid = useVapidKey()
  const subscribeMut = useSubscribePush()
  const unsubscribeMut = useUnsubscribePush()

  // Read the existing subscription on mount.
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    const read = async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        const existing = await reg.pushManager.getSubscription()
        if (!cancelled) setSubscription(existing)
      } catch {
        /* ignore — no SW yet means no subscription */
      }
    }
    read()
    return () => {
      cancelled = true
    }
  }, [supported])

  const subscribe = useCallback(async () => {
    if (!supported) {
      toast.error('Push notifications are not supported in this browser')
      return
    }
    if (!vapid.data) {
      toast.error('Push key unavailable. Refresh and try again.')
      return
    }
    setBusy(true)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        toast.info('Notifications permission was not granted')
        return
      }
      const reg = await navigator.serviceWorker.register(SW_PATH).catch(async () => {
        // Fall back to a previously-registered worker (the legacy /ui's PWA).
        return navigator.serviceWorker.ready
      })
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.data),
      })
      await subscribeMut.mutateAsync(sub.toJSON())
      setSubscription(sub)
      toast.success('Push notifications enabled')
    } catch (err) {
      toast.fromError(err, 'Couldn’t enable push notifications')
    } finally {
      setBusy(false)
    }
  }, [supported, vapid.data, subscribeMut])

  const unsubscribe = useCallback(async () => {
    if (!subscription) return
    setBusy(true)
    try {
      const endpoint = subscription.endpoint
      await subscription.unsubscribe()
      await unsubscribeMut.mutateAsync(endpoint).catch(() => {
        /* server may already have cleaned up — non-fatal */
      })
      setSubscription(null)
      toast.success('Push notifications disabled')
    } catch (err) {
      toast.fromError(err, 'Couldn’t disable push notifications')
    } finally {
      setBusy(false)
    }
  }, [subscription, unsubscribeMut])

  return {
    supported,
    permission,
    subscribed: Boolean(subscription),
    busy: busy || vapid.isLoading,
    subscribe,
    unsubscribe,
  }
}

// VAPID public keys are URL-safe base64 — convert to the binary form
// PushManager.subscribe expects.
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4)
  const normalized = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
