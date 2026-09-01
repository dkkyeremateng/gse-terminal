import type { components } from '@/lib/api/types-generated'

/**
 * GET /v1/watchlist response.
 *
 * `symbols` is the canonical membership list; `details` is the same list
 * joined with the latest market snapshot (sometimes absent if the symbol
 * has no recent print). Always trust `symbols.length` for the count.
 */
export type WatchlistResponse = components['schemas']['WatchlistResponse']
export type MarketSnapshot = components['schemas']['MarketSnapshot']

/** Toggle endpoint reply — returned by POST /v1/watchlist?symbol=X. */
export interface WatchlistToggleResponse {
  symbol: string
  inWatchlist: boolean
}
