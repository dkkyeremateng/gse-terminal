import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'

export const pushKeys = {
  all: ['push'] as const,
  vapid: () => [...pushKeys.all, 'vapid'] as const,
  subscription: () => [...pushKeys.all, 'subscription'] as const,
}

interface VapidResponse {
  key: string
}

export function useVapidKey() {
  return useQuery({
    queryKey: pushKeys.vapid(),
    queryFn: async () => {
      const res = await api.get<VapidResponse | string>('/v1/push/vapid-key')
      // Backend may return either { key: '...' } or a raw base64 string.
      return typeof res === 'string' ? res : res.key
    },
    staleTime: 24 * 60 * 60_000,
  })
}

export function useSubscribePush() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sub: PushSubscriptionJSON) =>
      api.post<{ status: string }>('/v1/push/subscribe', sub),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pushKeys.subscription() })
    },
  })
}

export function useUnsubscribePush() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (endpoint: string) =>
      api.post<{ status: string }>('/v1/push/unsubscribe', { endpoint }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pushKeys.subscription() })
    },
  })
}
