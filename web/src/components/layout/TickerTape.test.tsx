import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TickerTape } from './TickerTape'

vi.mock('@/features/markets/queries', () => ({
  useMarketSummary: () => ({
    data: {
      all: [
        { symbol: 'GCB', lastPrice: 36.99, percentChange: 2.75 },
        { symbol: 'ETI', lastPrice: 1.47, percentChange: -5.16 },
      ],
    },
  }),
}))

describe('TickerTape', () => {
  it('uses market-summary quotes instead of static seed prices', () => {
    render(<TickerTape />)

    expect(screen.getAllByText('36.99').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-5.16%').length).toBeGreaterThan(0)
    expect(screen.queryByText('8.45')).not.toBeInTheDocument()
  })
})
