import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { APIKey, APIKeyWithSecret, ChangePasswordInput, ProRequestEnvelope } from './types'

export const accountKeys = {
  all: ['account'] as const,
  apiKeys: () => [...accountKeys.all, 'api-keys'] as const,
  proRequest: () => [...accountKeys.all, 'pro-request'] as const,
}

export function useAPIKeys() {
  return useQuery({
    queryKey: accountKeys.apiKeys(),
    queryFn: () => api.get<APIKey[]>('/v1/me/api-keys'),
    staleTime: 30_000,
  })
}

export function useCreateAPIKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.post<APIKeyWithSecret>('/v1/me/api-keys', { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountKeys.apiKeys() })
    },
  })
}

export function useRevokeAPIKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/v1/me/api-keys/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountKeys.apiKeys() })
    },
  })
}

export function useProRequest() {
  return useQuery({
    queryKey: accountKeys.proRequest(),
    queryFn: () => api.get<ProRequestEnvelope>('/v1/me/pro-request'),
    staleTime: 60_000,
  })
}

export function useSubmitProRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<{ request: ProRequestEnvelope['request'] }>('/v1/me/pro-request', { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountKeys.proRequest() })
    },
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => api.post<{ status: string }>('/v1/me/password', input),
  })
}
