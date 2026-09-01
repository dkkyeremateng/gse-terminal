import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import type { AIInsight, BacktestResult, QueryResponse } from './types'

export const researchKeys = {
  all: ['research'] as const,
  insight: (symbol: string) => [...researchKeys.all, 'insight', symbol] as const,
  backtest: (symbol: string) => [...researchKeys.all, 'backtest', symbol] as const,
}

/**
 * AI Insight — Pro/Admin only. Returns 401/403 for non-pro callers.
 * Rate limited to 10 rpm per user (LLM-backed). Caller controls fetch via
 * `enabled` to keep cost predictable.
 */
export function useAIInsight(symbol: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: symbol ? researchKeys.insight(symbol) : ['research', 'insight-disabled'],
    queryFn: () => api.get<AIInsight>('/v1/ai-insight', { query: { symbol: symbol! } }),
    enabled: Boolean(symbol) && (options?.enabled ?? true),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Deterministic technical backtest — Pro/Admin only. */
export function useBacktest(symbol: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: symbol ? researchKeys.backtest(symbol) : ['research', 'backtest-disabled'],
    queryFn: () => api.get<BacktestResult>('/v1/backtest', { query: { symbol: symbol! } }),
    enabled: Boolean(symbol) && (options?.enabled ?? true),
    staleTime: 60 * 60_000,
    retry: false,
  })
}

/**
 * NL → SQL screen — Pro/Admin only, 10 rpm. Returns the resolved SQL alongside
 * the rows for transparency. Use as a mutation since each call is a fresh
 * computation (no caching).
 */
export function useRunQuery() {
  return useMutation({
    mutationFn: (question: string) =>
      api.post<QueryResponse>('/v1/query', { question }),
  })
}
