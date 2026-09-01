import { useMemo } from 'react'
import { useMarketSummary } from '@/features/markets/queries'
import { computeSessionStatus } from '@/components/domain/SessionStatusPill'

export const sessionKeys = {
  all: () => ['session'] as const,
}

/**
 * Single source of truth for whether the market is currently live or closed.
 *
 * Derives state from the freshest backend timestamp we have — the
 * market-summary envelope's `lastUpdated`. Components that previously rendered
 * a static "Live" string (TopBar status pill, TickerTape pause toggle) now
 * branch on this hook so the UI stops claiming "Live" outside of session
 * hours.
 */
export function useMarketSession() {
  const summary = useMarketSummary()
  const lastUpdated = summary.data?.lastUpdated
  return useMemo(() => {
    const status = computeSessionStatus(lastUpdated)
    return {
      ...status,
      lastUpdated,
      isLive: status.state === 'live',
      isClosed: status.state === 'closed',
    }
  }, [lastUpdated])
}
