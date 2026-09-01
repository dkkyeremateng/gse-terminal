import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { AlertEventsResponse, AlertRule, AlertRuleInput, UpdateRulePatch } from './types'

export const alertKeys = {
  all: ['alerts'] as const,
  rules: () => [...alertKeys.all, 'rules'] as const,
  events: (unreadOnly?: boolean) => [...alertKeys.all, 'events', { unreadOnly: Boolean(unreadOnly) }] as const,
}

export function useAlertRules(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: alertKeys.rules(),
    queryFn: () => api.get<AlertRule[]>('/v1/me/alerts'),
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  })
}

export function useAlertEvents(params: { unreadOnly?: boolean; limit?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: alertKeys.events(params.unreadOnly),
    queryFn: () =>
      api.get<AlertEventsResponse>('/v1/me/alerts/events', {
        query: { unread: params.unreadOnly ? 1 : undefined, limit: params.limit ?? 50 },
      }),
    staleTime: 15_000,
    refetchInterval: 60_000,
    enabled: params.enabled ?? true,
  })
}

export function useCreateAlertRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AlertRuleInput) => api.post<AlertRule>('/v1/me/alerts', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertKeys.rules() })
    },
  })
}

export function useUpdateAlertRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateRulePatch & { id: number }) =>
      api.patch<AlertRule>(`/v1/me/alerts/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertKeys.rules() })
    },
  })
}

export function useDeleteAlertRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/v1/me/alerts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertKeys.rules() })
    },
  })
}

export function useMarkAlertEventRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.post<{ status: string }>(`/v1/me/alerts/events/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertKeys.all })
    },
  })
}

export function useMarkAllAlertsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ status: string }>('/v1/me/alerts/events/read-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertKeys.all })
    },
  })
}
