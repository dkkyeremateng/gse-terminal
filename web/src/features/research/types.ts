import type { components } from '@/lib/api/types-generated'

/** Pro/Admin: AI Market Oracle verdict for a single ticker. */
export type AIInsight = components['schemas']['AIInsight']
export type AISignal = AIInsight['signal']

/** Pro/Admin: NL→SQL response with columns, rows, generated SQL. */
export type QueryResponse = components['schemas']['QueryResponse']

/**
 * Backtest endpoint response — not in the OpenAPI spec, derived from the
 * `analysis.BacktestResult` Go struct.
 */
export interface SignalSnapshot {
  date: string
  close: number
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  rsi: number
  sma20: number
  sma50: number
  forwardReturn: Record<string, number>
}

export interface BacktestResult {
  symbol: string
  startDate: string
  endDate: string
  totalSignals: number
  bullish: number
  bearish: number
  neutral: number
  winRate1d: number
  winRate5d: number
  winRate20d: number
  avgReturn5d: number
  sharpeRatio: number
  maxDrawdown: number
  note: string
  signals: SignalSnapshot[]
}
