import { MemoryRouter } from 'react-router-dom'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Markets from './Markets'

vi.mock('@/features/markets/queries', () => ({
  useAllSnapshots: () => ({ data: [], isLoading: false, error: null, lastUpdated: '2026-05-20T15:30:00' }),
}))

vi.mock('@/features/watchlist/queries', () => ({
  useWatchlist: () => ({ data: { symbols: [] } }),
  useToggleWatchlist: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@/features/sectors/queries', () => ({
  useSectorOverview: () => ({
    data: [
      {
        sector: 'Banking',
        avgPctChange: 1.2,
        totalVolume: 1000,
        totalTurnover: 5000,
        advanceCount: 2,
        declineCount: 1,
        neutralCount: 0,
        topGainer: { symbol: 'GCB', percentChange: 2.1 },
        worstLoser: { symbol: 'SCB', percentChange: -1.1 },
      },
    ],
    isLoading: false,
    error: null,
  }),
  useSectorDetail: () => ({ data: [] }),
}))

vi.mock('@/features/auth/entitlements', () => ({
  useEntitlements: () => ({ isPro: true }),
}))

vi.mock('@/lib/hooks/useLocalStorage', () => ({
  useLocalStorage: () => [true, vi.fn()],
}))

vi.mock('@/components/domain/NewsFeed', () => ({
  NewsFeed: () => <div>NewsFeed</div>,
}))

vi.mock('@/lib/utils/toast', () => ({
  toast: { success: vi.fn(), fromError: vi.fn() },
}))

describe('Markets', () => {
  it('renders the stock table in the same top section as the sector heatmap', () => {
    const { container } = render(
      <MemoryRouter>
        <Markets />
      </MemoryRouter>,
    )

    const topSection = container.querySelector('section.grid')
    expect(topSection?.children.length).toBe(2)
  })
})
