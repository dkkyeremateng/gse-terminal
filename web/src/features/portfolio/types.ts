/**
 * Portfolio API contract — derived from the Go handlers in
 * internal/server/portfolio_handlers.go (the OpenAPI spec doesn't expose
 * these endpoints yet).
 */

export interface PortfolioHolding {
  id: number
  userId: number
  symbol: string
  quantity: number
  costBasis: number
  purchaseDate: string // YYYY-MM-DD
  notes: string
  /** Live-enriched fields populated by the backend on read */
  currentPrice: number
  marketValue: number
  costValue: number
  pnl: number
  pnlPct: number
  sector: string
}

export interface PortfolioSummary {
  holdings: PortfolioHolding[]
  totalValue: number
  totalCost: number
  totalPnl: number
  totalPnlPct: number
  todayPnl: number
  todayPnlPct: number
  sectorExposure: Record<string, number>
  holdingCount: number
}

export interface PortfolioHistoryPoint {
  date: string // YYYY-MM-DD
  value: number
  cashflow: number
}

export interface PortfolioHistoryResponse {
  window: HistoryWindow
  points: PortfolioHistoryPoint[]
}

export type HistoryWindow = '30d' | '90d' | '1y' | 'all'

export const WINDOWS: { value: HistoryWindow; label: string }[] = [
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
]

export interface CreateHoldingInput {
  symbol: string
  quantity: number
  costBasis: number
  purchaseDate: string // YYYY-MM-DD
  notes?: string
}

export interface UpdateHoldingInput {
  quantity: number
  costBasis: number
  notes?: string
}
