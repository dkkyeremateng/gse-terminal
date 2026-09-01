import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type {
  CreateHoldingInput,
  HistoryWindow,
  PortfolioHistoryResponse,
  PortfolioSummary,
  UpdateHoldingInput,
} from './types'

export const portfolioKeys = {
  all: ['portfolio'] as const,
  summary: () => [...portfolioKeys.all, 'summary'] as const,
  history: (window: HistoryWindow) => [...portfolioKeys.all, 'history', window] as const,
}

export function usePortfolio() {
  return useQuery({
    queryKey: portfolioKeys.summary(),
    queryFn: () => api.get<PortfolioSummary>('/v1/me/portfolio'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

/**
 * Boolean: does the user have at least one holding?
 *
 * Used by navigation surfaces (Sidebar, BottomNav) to hide the Portfolio
 * entry until there's something to show. `undefined` while the query is in
 * flight so consumers can decide whether to show a placeholder or wait.
 *
 * Backed by the same `usePortfolio` query — TanStack Query dedupes the
 * request, so calling this from multiple components is free.
 */
export function useHasHoldings(): boolean | undefined {
  const q = usePortfolio()
  if (!q.isSuccess) return undefined
  return (q.data?.holdingCount ?? 0) > 0
}

export function usePortfolioHistory(window: HistoryWindow = '30d') {
  return useQuery({
    queryKey: portfolioKeys.history(window),
    queryFn: () =>
      api.get<PortfolioHistoryResponse>('/v1/me/portfolio/history', { query: { window } }),
    staleTime: 5 * 60_000,
  })
}

export function useCreateHolding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateHoldingInput) =>
      api.post<{ id: number; status: string }>('/v1/me/portfolio', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: portfolioKeys.all })
    },
  })
}

export function useUpdateHolding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateHoldingInput & { id: number }) =>
      api.patch<{ status: string }>(`/v1/me/portfolio/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: portfolioKeys.all })
    },
  })
}

export function useDeleteHolding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<{ status: string }>(`/v1/me/portfolio/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: portfolioKeys.all })
    },
  })
}
