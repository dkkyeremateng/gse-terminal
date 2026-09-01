import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { Interval, MarketSummary, NewsItem, OHLCBar } from './types'

export const marketKeys = {
  all: ['markets'] as const,
  quotes: {
    all: () => ['quotes'] as const,
    summary: () => [...marketKeys.quotes.all(), 'summary'] as const,
    bySymbol: (symbol: string) => [...marketKeys.quotes.all(), symbol] as const,
  },
  session: () => ['session'] as const,
  symbols: () => [...marketKeys.all, 'symbols'] as const,
  history: (symbol: string, interval: Interval) =>
    [...marketKeys.all, 'history', symbol, interval] as const,
  news: (symbol: string) => [...marketKeys.all, 'news', symbol] as const,
  marketNews: () => [...marketKeys.all, 'market-news'] as const,
}

export function useSymbols(options?: UseQueryOptions<string[]>) {
  return useQuery({
    queryKey: marketKeys.symbols(),
    queryFn: () => api.get<string[]>('/v1/symbols'),
    staleTime: 60 * 60_000,
    ...options,
  })
}

/**
 * Full market-summary envelope. Use this when the consumer needs `topGainers`,
 * `topLosers`, `active`, or `lastUpdated` — for the flat per-symbol list,
 * prefer `useAllSnapshots` which derives `data.all` so memoization stays
 * stable when the rollups change.
 */
export function useMarketSummary(options?: UseQueryOptions<MarketSummary>) {
  return useQuery({
    queryKey: marketKeys.quotes.summary(),
    queryFn: () => api.get<MarketSummary>('/v1/market-summary'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    ...options,
  })
}

export function useAllSnapshots() {
  const q = useMarketSummary()
  return {
    ...q,
    data: q.data?.all,
    lastUpdated: q.data?.lastUpdated,
  }
}

export function useQuote(symbol: string | undefined) {
  return useQuery({
    queryKey: symbol ? marketKeys.quotes.bySymbol(symbol!) : marketKeys.quotes.summary(),
    queryFn: async () => {
      const summary = await api.get<MarketSummary>('/v1/market-summary')
      return summary.all.find((s) => s.symbol === symbol) ?? null
    },
    enabled: Boolean(symbol),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useHistory(symbol: string | undefined, interval: Interval = '1d') {
  return useQuery({
    queryKey: symbol ? marketKeys.history(symbol, interval) : ['markets', 'history-disabled'],
    queryFn: () =>
      api.get<OHLCBar[]>('/v1/history', { query: { symbol: symbol!, interval } }),
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
  })
}

export function useTickerNews(symbol: string | undefined) {
  return useQuery({
    queryKey: symbol ? marketKeys.news(symbol) : ['markets', 'news-disabled'],
    queryFn: () => api.get<NewsItem[]>('/v1/news', { query: { symbol: symbol! } }),
    enabled: Boolean(symbol),
    staleTime: 60_000,
  })
}

export function useMarketNews() {
  return useQuery({
    queryKey: marketKeys.marketNews(),
    queryFn: () => api.get<NewsItem[]>('/v1/market-news'),
    staleTime: 60_000,
  })
}

/**
 * Batch sparkline series for up to 4 symbols.
 *
 * Backed by `/v1/compare`, which the backend caps at 4 symbols per call.
 * Callers are responsible for slicing to that limit (we do it here too as a
 * safety net). Returns a map of symbol → OHLCBar[]; missing symbols are
 * omitted rather than null so consumers can `data?.[symbol]` cleanly.
 */
export function useCompareSparklines(symbols: string[], interval: Interval = '1d') {
  const slice = symbols.slice(0, 4)
  const key = slice.join(',')
  return useQuery({
    queryKey: [...marketKeys.all, 'compare', key, interval],
    queryFn: () =>
      api.get<Record<string, OHLCBar[]>>('/v1/compare', {
        query: { symbols: key, interval },
      }),
    enabled: slice.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

// Re-export so consumers don't need a separate types import.
export type { MarketSnapshot, MarketSummary, OHLCBar, NewsItem, Interval } from './types'
