import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { WatchlistResponse, WatchlistToggleResponse } from './types'

export const watchlistKeys = {
  all: ['watchlist'] as const,
  list: () => [...watchlistKeys.all, 'list'] as const,
}

export function useWatchlist() {
  return useQuery({
    queryKey: watchlistKeys.list(),
    queryFn: () => api.get<WatchlistResponse>('/v1/watchlist'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

/** Idempotent toggle. Optimistically updates the membership list. */
export function useToggleWatchlist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (symbol: string) =>
      api.post<WatchlistToggleResponse>('/v1/watchlist', undefined, { query: { symbol } }),
    onMutate: async (symbol) => {
      await qc.cancelQueries({ queryKey: watchlistKeys.list() })
      const prev = qc.getQueryData<WatchlistResponse>(watchlistKeys.list())
      // Backend serializes empty Postgres arrays as `null`, not `[]` — guard.
      const symbols = prev?.symbols ?? []
      const details = prev?.details ?? []
      const has = symbols.includes(symbol)
      qc.setQueryData<WatchlistResponse>(watchlistKeys.list(), {
        ...(prev ?? {}),
        symbols: has ? symbols.filter((s) => s !== symbol) : [...symbols, symbol],
        details: has ? details.filter((d) => d.symbol !== symbol) : details,
      })
      return { prev }
    },
    onError: (_err, _symbol, ctx) => {
      if (ctx?.prev) qc.setQueryData(watchlistKeys.list(), ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: watchlistKeys.list() })
    },
  })
}
