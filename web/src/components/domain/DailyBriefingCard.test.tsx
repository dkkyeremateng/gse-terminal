import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DailyBriefingCard } from './DailyBriefingCard'

const useBriefingMock = vi.fn()

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/features/briefing/queries', () => ({
  useBriefing: () => useBriefingMock(),
}))

describe('DailyBriefingCard', () => {
  it('shows insufficient-data empty copy for low-signal summary text', () => {
    useBriefingMock.mockReturnValue({
      data: {
        tradingDate: '2026-05-20',
        summary: 'Not enough signals to summarise — check back after close.',
        averageSentiment: 0,
        insights: [{ symbol: 'AADS', rsi: 100, verdict: 'Neutral' }],
      },
      isLoading: false,
      error: null,
    })

    render(<DailyBriefingCard />)

    expect(screen.getByText('Not enough signals to summarise — check back after close.')).toBeInTheDocument()
    expect(screen.getByText('AADS')).toBeInTheDocument()
    expect(screen.queryByText(/Avg sentiment/i)).not.toBeInTheDocument()
  })

  it('shows the no-briefing state when the API returns an empty payload', () => {
    useBriefingMock.mockReturnValue({
      data: {
        summary: null,
        insights: [],
      },
      isLoading: false,
      error: null,
    })

    render(<DailyBriefingCard />)

    expect(screen.getByText('No briefing yet today.')).toBeInTheDocument()
  })

  it('shows an as-of timestamp tied to the briefing date', () => {
    useBriefingMock.mockReturnValue({
      data: {
        tradingDate: '2026-05-20',
        summary: 'Market breadth improved through the close.',
        insights: [{ symbol: 'GCB', rsi: 55, verdict: 'Bullish' }],
      },
      isLoading: false,
      error: null,
    })

    render(<DailyBriefingCard />)

    expect(screen.getByText(/as of/i)).toBeInTheDocument()
  })
})
