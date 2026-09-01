import { useMemo, useState } from 'react'
import { Pause, Play, ArrowDown, ArrowUp } from 'lucide-react'
import { useMarketSummary } from '@/features/markets/queries'
import { useMarketSession } from '@/features/session/useMarketSession'
import { cn } from '@/lib/utils/cn'
import { number, percent } from '@/lib/utils/format'

/**
 * Live ticker tape — horizontal marquee.
 *
 * Phase 1 ships with a static seed so the visual identity exists during
 * design review. Phase 2 swaps in WS-driven live quotes via `useTickerQuotes`.
 */

interface Quote {
  symbol: string
  price: number
  changePct: number
}

const CURATED_SYMBOLS = [
  'GCB',
  'MTNGH',
  'EGH',
  'GGBL',
  'TOTAL',
  'CAL',
  'SCB',
  'UNIL',
  'FML',
  'GOIL',
  'SOGEGH',
  'TBL',
  'ETI',
  'AYRTN',
]

export function TickerTape({ quotes }: { quotes?: Quote[] }) {
  const summary = useMarketSummary()
  const session = useMarketSession()
  const [paused, setPaused] = useState(false)
  const marketQuotes = useMemo<Quote[]>(() => {
    const all = summary.data?.all ?? []
    if (all.length === 0) return []

    const bySymbol = new Map(all.map((row) => [row.symbol, row]))
    const curated = CURATED_SYMBOLS.map((symbol) => bySymbol.get(symbol))
      .filter((row): row is NonNullable<(typeof all)[number]> => Boolean(row))
      .map((row) => ({
        symbol: row.symbol,
        price: row.lastPrice,
        changePct: row.percentChange ?? 0,
      }))

    if (curated.length > 0) return curated

    return all.slice(0, CURATED_SYMBOLS.length).map((row) => ({
      symbol: row.symbol,
      price: row.lastPrice,
      changePct: row.percentChange ?? 0,
    }))
  }, [summary.data?.all])

  const visibleQuotes = quotes ?? marketQuotes
  const stream = [...visibleQuotes, ...visibleQuotes]

  return (
    <div
      className="marquee group relative flex h-9 w-full items-center overflow-hidden border-b border-border bg-surface"
      data-paused={paused || undefined}
      aria-label="Live ticker tape"
    >
      <div className="marquee-track flex shrink-0 items-center gap-6 pr-6 pl-4 text-xs">
        {stream.map((q, idx) => (
          <TickerItem key={`${q.symbol}-${idx}`} quote={q} />
        ))}
      </div>

      {/* edge fades */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-surface to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-12 w-12 bg-gradient-to-l from-surface to-transparent"
      />

      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-label={paused ? 'Resume ticker' : 'Pause ticker'}
        className="relative z-10 ml-auto flex h-full items-center gap-1.5 border-l border-border bg-surface px-3 text-[11px] text-foreground-muted transition-colors hover:bg-surface-elevated hover:text-foreground"
      >
        {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        <span className="hidden sm:inline">{tickerLabel(paused, session.state)}</span>
      </button>
    </div>
  )
}

// Pause-button label tracks both the paused state and the underlying market
// session. "Live" only makes sense when the session is open — outside hours
// the marquee is replaying the last close, not streaming.
function tickerLabel(paused: boolean, state: ReturnType<typeof useMarketSession>['state']): string {
  if (paused) return 'Paused'
  if (state === 'live') return 'Live'
  if (state === 'closed') return 'Replay'
  return 'Idle'
}

function TickerItem({ quote }: { quote: Quote }) {
  const positive = quote.changePct > 0
  const negative = quote.changePct < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null
  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <span className="font-medium tracking-tight">{quote.symbol}</span>
      <span className="tabular text-foreground-muted">{number(quote.price)}</span>
      <span
        className={cn(
          'tabular flex items-center gap-0.5 text-[11px]',
          positive && 'text-gain',
          negative && 'text-loss',
          !positive && !negative && 'text-foreground-subtle',
        )}
      >
        {Arrow && <Arrow className="size-3" aria-hidden />}
        {percent(quote.changePct)}
      </span>
    </div>
  )
}
