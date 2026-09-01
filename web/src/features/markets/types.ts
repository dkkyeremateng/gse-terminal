import type { components } from '@/lib/api/types-generated'

/**
 * Per-symbol snapshot row from /v1/market-summary.
 *
 * The OpenAPI schema is conservative; the real response includes additional
 * fields (`bidPrice`, `offerPrice`, `spread`, `spreadPct`). Extend the type
 * here so consumers can read them without casting.
 */
export type MarketSnapshot = components['schemas']['MarketSnapshot'] & {
  bidPrice?: number
  offerPrice?: number
  spread?: number
  spreadPct?: number
}

/**
 * Real /v1/market-summary envelope. The published OpenAPI spec lists this
 * endpoint as returning `MarketSnapshot[]` directly — actual responses wrap
 * the per-symbol rows under `all` and surface curated rollups alongside.
 */
export interface MarketSummary {
  topGainers: MarketSnapshot[]
  topLosers: MarketSnapshot[]
  active: MarketSnapshot[]
  all: MarketSnapshot[]
  lastUpdated?: string
  /** Volume floor applied to TopGainers/TopLosers — surfaced as a footnote. */
  moversMinVolume?: number
}

export type OHLCBar = components['schemas']['OHLCBar']
export type NewsItem = components['schemas']['NewsItem']

export type Interval = '1d' | '1w' | '1M'

export interface IntervalOption {
  value: Interval
  label: string
  bars: number
}

export const INTERVALS: IntervalOption[] = [
  { value: '1d', label: '1D', bars: 60 },
  { value: '1w', label: '1W', bars: 60 },
  { value: '1M', label: '1M', bars: 36 },
]
