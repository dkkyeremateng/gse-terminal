import { useMemo } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, Briefcase } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { computeSessionStatus, SessionStatusPill } from './SessionStatusPill'
import type { PortfolioSummary } from '@/features/portfolio/types'
import { money, percent, signedMoney } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

interface Props {
  summary: PortfolioSummary | undefined
  loading?: boolean
  lastUpdated?: string
}

/**
 * Lead "what happened today" card for returning users with a portfolio.
 *
 * Sets the narrative for the rest of the dashboard — gives the user a single
 * answer to "is this a good day or not" before they scan the KPI strip or
 * dive into charts. When market data is stale (after a long weekend, say),
 * the label switches to "Last session" so the number isn't misread as
 * intra-day.
 *
 * Layout is designed for a half-width column (paired with Market Pulse on
 * the dashboard). Vertical real estate is spent on three datapoints not
 * surfaced elsewhere on this page — total portfolio value, all-time P/L,
 * and sector exposure — so the card delivers information density that
 * matches its neighbour's row count.
 */
export function TodayHero({ summary, loading, lastUpdated }: Props) {
  const session = computeSessionStatus(lastUpdated)

  if (loading) {
    return (
      <Card className="overflow-hidden p-6">
        <div className="space-y-4">
          <div className="h-3 w-40 animate-pulse rounded bg-secondary/70" />
          <div className="h-10 w-56 animate-pulse rounded bg-secondary" />
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded bg-secondary/40" />
            ))}
          </div>
          <div className="h-3 w-full animate-pulse rounded bg-secondary/40" />
        </div>
      </Card>
    )
  }

  const pnl = summary?.todayPnl ?? 0
  const pct = summary?.todayPnlPct ?? 0
  const positive = pnl > 0
  const negative = pnl < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null

  // Adapt the heading copy when the data is stale — calling a 5-day-old
  // number "today on your portfolio" is misleading.
  const periodLabel = session.stale ? 'Last session on your portfolio' : 'Today on your portfolio'

  const sectorSlices = useSectorSlices(summary?.sectorExposure)

  return (
    <Card
      className={cn(
        'relative flex h-full flex-col overflow-hidden p-6',
        // Subtle directional tint — gain green when up, loss red when down,
        // neutral surface otherwise. Stays well below 5% alpha so text contrast
        // never drops below the dark-theme threshold.
        positive && 'bg-gradient-to-br from-gain/[0.06] via-transparent to-transparent',
        negative && 'bg-gradient-to-br from-loss/[0.06] via-transparent to-transparent',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] uppercase tracking-wider text-foreground-subtle">{periodLabel}</p>
        <SessionStatusPill lastUpdated={lastUpdated} />
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            'text-3xl font-semibold tabular sm:text-4xl',
            positive && 'text-gain',
            negative && 'text-loss',
            !positive && !negative && 'text-foreground',
          )}
        >
          {signedMoney(pnl)}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 text-base tabular',
            positive && 'text-gain',
            negative && 'text-loss',
            !positive && !negative && 'text-foreground-subtle',
          )}
        >
          {Arrow && <Arrow className="size-4" aria-hidden />}
          {percent(pct)}
        </span>
      </div>

      {summary && (
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-md border border-border bg-surface/60 p-3">
          <Stat
            label="Total value"
            value={money(summary.totalValue)}
            hint={`${summary.holdingCount} ${summary.holdingCount === 1 ? 'position' : 'positions'}`}
          />
          <Stat
            label="All-time"
            value={signedMoney(summary.totalPnl)}
            hint={percent(summary.totalPnlPct)}
            tone={summary.totalPnl > 0 ? 'gain' : summary.totalPnl < 0 ? 'loss' : 'neutral'}
          />
          <Stat label="Cost basis" value={money(summary.totalCost)} />
        </div>
      )}

      {sectorSlices && sectorSlices.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-foreground-subtle">
            <span>Sector exposure</span>
            <span className="tabular">{sectorSlices.length} sector{sectorSlices.length === 1 ? '' : 's'}</span>
          </div>
          <SectorBar slices={sectorSlices} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-foreground-muted">
            {sectorSlices.map((s, i) => (
              <span key={s.name} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn('size-1.5 rounded-full', sectorSwatchClass(i))} />
                {s.name} <span className="tabular text-foreground-subtle">{percent(s.pct, false)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex justify-end pt-5">
        <Button asChild variant="outline" size="sm">
          <Link to="/portfolio">
            <Briefcase className="size-3.5" />
            View portfolio
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </div>
    </Card>
  )
}

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'gain' | 'loss' | 'neutral'
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="truncate text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p
        className={cn(
          'truncate text-sm font-semibold tabular',
          tone === 'gain' && 'text-gain',
          tone === 'loss' && 'text-loss',
          tone === 'neutral' && 'text-foreground',
        )}
      >
        {value}
      </p>
      {hint && <p className="truncate text-[10px] tabular text-foreground-subtle">{hint}</p>}
    </div>
  )
}

interface Slice {
  name: string
  pct: number
}

// Backend `sectorExposure` values are already in percent units
// (`Mining & Oil: 82.08` means 82.08% of total value) — see
// internal/server/portfolio_handlers.go around L121 where it rounds
// `val/totalValue*10000/100`. Treat the value as the percent directly;
// do NOT divide by totalValue a second time.
function useSectorSlices(exposure: Record<string, number> | undefined) {
  return useMemo<Slice[] | null>(() => {
    if (!exposure) return null
    const entries = Object.entries(exposure)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
    if (entries.length === 0) return null

    // Show up to 4 top sectors individually; group the rest as Other so the
    // legend stays scannable in the narrow column.
    const TOP_N = 4
    const top = entries.slice(0, TOP_N)
    const rest = entries.slice(TOP_N)
    const result: Slice[] = top.map(([name, pct]) => ({ name, pct }))
    if (rest.length > 0) {
      const sum = rest.reduce((acc, [, v]) => acc + v, 0)
      if (sum > 0) {
        result.push({ name: 'Other', pct: sum })
      }
    }
    return result
  }, [exposure])
}

const SWATCHES = [
  'bg-primary',
  'bg-accent',
  'bg-gain',
  'bg-warning',
  'bg-foreground-subtle',
]

function sectorSwatchClass(i: number): string {
  return SWATCHES[i % SWATCHES.length]
}

function SectorBar({ slices }: { slices: Slice[] }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-secondary/40">
      {slices.map((s, i) => (
        <span
          key={s.name}
          className={cn('h-full', sectorSwatchClass(i))}
          style={{ width: `${Math.max(0.5, s.pct)}%` }}
          aria-label={`${s.name} ${percent(s.pct, false)}`}
          title={`${s.name} · ${percent(s.pct, false)}`}
        />
      ))}
    </div>
  )
}
