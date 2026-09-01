import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiFetch } from '@/lib/api/client'
import type {
  AdminAlertEventRow,
  AdminAlertRuleRow,
  AdminAlertStats,
  AdminAuditEntry,
  AdminProRequest,
  AdminUser,
  DecideProRequestInput,
  IngestResult,
} from './types'

export const adminKeys = {
  all: ['admin'] as const,
  proRequests: () => [...adminKeys.all, 'pro-requests'] as const,
  proRequestCount: () => [...adminKeys.all, 'pro-requests', 'count'] as const,
  alertRules: () => [...adminKeys.all, 'alert-rules'] as const,
  alertEvents: () => [...adminKeys.all, 'alert-events'] as const,
  alertStats: () => [...adminKeys.all, 'alert-stats'] as const,
  users: () => [...adminKeys.all, 'users'] as const,
  audit: (limit?: number) => [...adminKeys.all, 'audit', limit ?? 200] as const,
}

export function useAdminProRequests() {
  return useQuery({
    queryKey: adminKeys.proRequests(),
    queryFn: () => api.get<AdminProRequest[]>('/v1/admin/pro-requests'),
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
}

export function useAdminProRequestCount() {
  return useQuery({
    queryKey: adminKeys.proRequestCount(),
    queryFn: () => api.get<{ count: number }>('/v1/admin/pro-requests/count'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useDecideProRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: DecideProRequestInput & { id: number }) =>
      api.post<{ status: string }>(`/v1/admin/pro-requests/${id}/decide`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminKeys.all })
    },
  })
}

export function useAdminAlertRules(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminKeys.alertRules(),
    queryFn: () => api.get<AdminAlertRuleRow[]>('/v1/admin/alert-rules', { query: { limit: 500 } }),
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  })
}

export function useAdminAlertEvents(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminKeys.alertEvents(),
    queryFn: () => api.get<AdminAlertEventRow[]>('/v1/admin/alert-events', { query: { limit: 200 } }),
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  })
}

export function useAdminAlertStats(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminKeys.alertStats(),
    queryFn: () => api.get<AdminAlertStats>('/v1/admin/alert-stats'),
    staleTime: 60_000,
    enabled: options?.enabled ?? true,
  })
}

export function useAdminDeleteAlertRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/v1/admin/alert-rules/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminKeys.alertRules() })
      qc.invalidateQueries({ queryKey: adminKeys.alertStats() })
    },
  })
}

// ── Identity Manager (users) ────────────────────────────────────────────

export function useAdminUsers() {
  return useQuery({
    queryKey: adminKeys.users(),
    queryFn: () => api.get<AdminUser[]>('/v1/admin/users'),
    staleTime: 30_000,
  })
}

export function useAdminUpdateUserRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      apiFetch<void>(`/v1/admin/users/${id}/role`, { method: 'POST', form: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users() }),
  })
}

export function useAdminToggleUserLock() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, locked }: { id: number; locked: boolean }) =>
      apiFetch<void>(`/v1/admin/users/${id}/lock`, {
        method: 'POST',
        query: { locked: String(locked) },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users() }),
  })
}

export function useAdminResetUserPassword() {
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      apiFetch<void>(`/v1/admin/users/${id}/password`, {
        method: 'POST',
        form: { password },
      }),
  })
}

export function useAdminDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/v1/admin/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users() }),
  })
}

// ── Audit log ───────────────────────────────────────────────────────────

export function useAdminAuditLog(limit = 200) {
  return useQuery({
    queryKey: adminKeys.audit(limit),
    queryFn: () => api.get<AdminAuditEntry[]>('/v1/admin/audit', { query: { limit } }),
    staleTime: 15_000,
  })
}

// ── CSV ingestion ───────────────────────────────────────────────────────

/**
 * Multipart file upload to `POST /upload`. Doesn't use the typed `apiFetch`
 * wrapper because it needs `FormData` (not URL-encoded) and the route lives
 * outside `/v1` so it isn't typed in the OpenAPI spec.
 */
export function useAdminUpload() {
  return useMutation({
    mutationFn: async (file: File): Promise<IngestResult> => {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/upload', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
        body: fd,
      })
      const ct = res.headers.get('content-type') ?? ''
      const payload = ct.includes('application/json') ? await res.json() : await res.text()
      if (!res.ok) {
        const msg =
          typeof payload === 'object' && payload && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : typeof payload === 'string' && payload
              ? payload
              : `Upload failed (${res.status})`
        throw new Error(msg)
      }
      return payload as IngestResult
    },
  })
}
