import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { SectorOverview, SectorRollup } from './types'

export const sectorKeys = {
  all: ['sectors'] as const,
  overview: () => [...sectorKeys.all, 'overview'] as const,
  detail: () => [...sectorKeys.all, 'detail'] as const,
}

/** Public lite view — breadth + avg %. Always available. */
export function useSectorOverview() {
  return useQuery({
    queryKey: sectorKeys.overview(),
    queryFn: () => api.get<SectorOverview[]>('/v1/market-sectors/overview'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
}

/** Pro/Admin only — returns 401/403 for non-pro callers, so guard at the call site. */
export function useSectorDetail(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: sectorKeys.detail(),
    queryFn: () => api.get<SectorRollup[]>('/v1/market-sectors'),
    staleTime: 60_000,
    enabled: options?.enabled ?? true,
  })
}
