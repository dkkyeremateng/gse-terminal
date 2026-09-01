import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { components } from '@/lib/api/types-generated'

export type Briefing = components['schemas']['Briefing']
export type BriefingInsight = NonNullable<Briefing['insights']>[number]

export const briefingKeys = {
  all: ['briefing'] as const,
  daily: () => [...briefingKeys.all, 'daily'] as const,
}

export function useBriefing() {
  return useQuery({
    queryKey: briefingKeys.daily(),
    queryFn: () => api.get<Briefing>('/v1/briefing'),
    staleTime: 5 * 60_000,
  })
}
