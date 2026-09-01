import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowRight, ArrowUp, ListChecks, Star } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Sparkline } from '@/components/domain/Sparkline'
import { AsOf } from '@/components/domain/AsOf'
import { useWatchlist } from '@/features/watchlist/queries'
import { useCompareSparklines, useMarketSummary } from '@/features/markets/queries'
import type { MarketSnapshot } from '@/features/markets/types'
import { cn } from '@/lib/utils/cn'
import { percent } from '@/lib/utils/format'

interface Props {
  /**
   * Cap on visible rows. Defaults to 4 to match the `/v1/compare` backend
   * limit so every visible row gets a sparkline. Anything above is shown as
   * "+N more" overflow.
   */
  limit?: number
  className?: string
}

interface Row {
  symbol: string
  snapshot?: MarketSnapshot
  pct: number
}

/**
 * Compact watchlist panel for the dashboard.
 *
 * Rows sort by absolute % change so today's biggest movers float to the top.
 * Each visible row gets a sparkline pulled in a single batch via `/v1/compare`.
 */
export function WatchlistPanel({ limit = 4, className }: Props) {
  const watchlist = useWatchlist()
  const summary = useMarketSummary()
  const symbols = watchlist.data?.symbols ?? []
  const detailMap = useMemo(
    () => new Map((watchlist.data?.details ?? []).map((d) => [d.symbol, d])),
    [watchlist.data?.details],
  )

  // Sort the full list by |%change| desc — biggest movers (in either
  // direction) come first; flat symbols sink to the bottom.
  const sortedRows: Row[] = useMemo(() => {
    return symbols
      .map((symbol) => {
        const snapshot = detailMap.get(symbol)
        return { symbol, snapshot, pct: snapshot?.percentChange ?? 0 }
      })
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  }, [symbols, detailMap])

  const visible = sortedRows.slice(0, limit)
  const overflow = Math.max(0, sortedRows.length - limit)

  const sparklines = useCompareSparklines(visible.map((v) => v.symbol))

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ListChecks className="size-4 text-foreground-muted" />
          Watchlist
          {symbols.length > 0 && (
            <span className="rounded-full border border-border bg-surface px-1.5 py-px text-[10px] tabular text-foreground-muted">
              {symbols.length}
            </span>
          )}
          <AsOf timestamp={summary.data?.lastUpdated} className="whitespace-nowrap" />
        </CardTitle>
        <Button asChild variant="ghost" size="sm" className="-mr-2">
          <Link to="/markets?view=watching">
            View all
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {watchlist.isLoading ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <div className="h-4 w-14 animate-pulse rounded bg-secondary" />
                <div className="ml-auto h-7 w-16 animate-pulse rounded bg-secondary/70" />
                <div className="h-4 w-12 animate-pulse rounded bg-secondary" />
                <div className="h-4 w-12 animate-pulse rounded bg-secondary" />
              </li>
            ))}
          </ul>
        ) : symbols.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Star className="size-5 text-foreground-subtle" aria-hidden />
            <p className="text-sm font-medium">No symbols yet</p>
            <p className="max-w-xs text-xs text-foreground-muted">
              Star a ticker from Markets or any quote page to track its live price here.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-1">
              <Link to="/markets">Browse markets</Link>
            </Button>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {visible.map((row) => (
                <RowItem
                  key={row.symbol}
                  row={row}
                  bars={sparklines.data?.[row.symbol]}
                  loadingSparkline={sparklines.isLoading}
                />
              ))}
            </ul>
            {overflow > 0 && (
              <div className="border-t border-border bg-surface/50 px-4 py-1.5 text-center text-[11px] text-foreground-subtle">
                +{overflow} more · view all on Markets
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function RowItem({
  row,
  bars,
  loadingSparkline,
}: {
  row: Row
  bars?: { close: number }[]
  loadingSparkline: boolean
}) {
  const positive = row.pct > 0
  const negative = row.pct < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null
  const closes = (bars ?? []).map((b) => b.close).filter((n): n is number => typeof n === 'number')
  const sparkColor = positive
    ? 'var(--color-gain)'
    : negative
      ? 'var(--color-loss)'
      : 'var(--color-foreground-subtle)'

  return (
    <li>
      <Link
        to={`/markets/${encodeURIComponent(row.symbol)}`}
        className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-secondary/40"
      >
        <span className="min-w-0 truncate font-medium">{row.symbol}</span>

        {/* Sparkline column — placeholder while batch fetch resolves. */}
        <span className="hidden h-7 w-20 sm:inline-flex sm:items-center sm:justify-end">
          {closes.length >= 2 ? (
            <Sparkline values={closes} width={80} height={28} color={sparkColor} />
          ) : loadingSparkline ? (
            <span className="h-5 w-16 animate-pulse rounded bg-secondary/40" aria-hidden />
          ) : (
            <span className="h-px w-12 bg-border" aria-hidden />
          )}
        </span>

        <span className="tabular text-foreground-muted">
          {row.snapshot?.lastPrice && row.snapshot.lastPrice > 0 ? row.snapshot.lastPrice.toFixed(2) : '—'}
        </span>

        <span
          className={cn(
            'inline-flex w-20 items-center justify-end gap-0.5 tabular text-xs',
            positive && 'text-gain',
            negative && 'text-loss',
            !positive && !negative && 'text-foreground-subtle',
          )}
        >
          {Arrow && <Arrow className="size-3" aria-hidden />}
          {percent(row.pct)}
        </span>
      </Link>
    </li>
  )
}

