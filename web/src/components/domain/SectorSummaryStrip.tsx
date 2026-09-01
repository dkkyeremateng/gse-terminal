import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import type { SectorRollup } from '@/features/sectors/types'
import { cn } from '@/lib/utils/cn'
import { compact, percent } from '@/lib/utils/format'

interface Props {
  rollup: SectorRollup
  /** Called when the user clears the sector filter. */
  onClear: () => void
}

/**
 * Inline rollup summary that surfaces above the Markets table when a sector
 * is filter-active. Pro-gated upstream — the parent only fetches and renders
 * this when `useSectorDetail` returns data.
 *
 * Designed to fit on a single line at desktop widths and wrap gracefully on
 * mobile. Replaces the dedicated `/sectors` Detail card by surfacing the
 * same stats in-context with the filtered table.
 */
export function SectorSummaryStrip({ rollup, onClear }: Props) {
  const avg = rollup.avgPctChange ?? 0
  const tone = avg > 0 ? 'text-gain' : avg < 0 ? 'text-loss' : 'text-foreground-subtle'
  const advances = rollup.advanceCount ?? 0
  const declines = rollup.declineCount ?? 0
  const neutral = rollup.neutralCount ?? 0

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-surface px-4 py-2.5 text-sm">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">Sector</p>
        <p className="font-medium">{rollup.sector}</p>
      </div>
      <Stat label="Avg %" value={percent(avg)} className={tone} />
      <Stat
        label="Breadth"
        value={
          <span className="inline-flex items-center gap-2 text-xs">
            <BreadthDot tone="gain" count={advances} />
            <BreadthDot tone="loss" count={declines} />
            <BreadthDot tone="muted" count={neutral} />
          </span>
        }
      />
      <Stat label="Volume" value={rollup.totalVolume ? compact(rollup.totalVolume) : '—'} />
      <Stat label="Turnover" value={rollup.totalTurnover ? compact(rollup.totalTurnover) : '—'} />

      <div className="flex flex-wrap items-center gap-1.5">
        <MoverChip label="Leader" mover={rollup.topGainer} positive />
        <MoverChip label="Laggard" mover={rollup.worstLoser} positive={false} />
      </div>

      <Button variant="ghost" size="sm" onClick={onClear} className="ml-auto -mr-2 text-foreground-muted">
        <X className="size-3.5" />
        Clear
      </Button>
    </div>
  )
}

function Stat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className={cn('text-sm font-medium tabular text-foreground', className)}>{value}</p>
    </div>
  )
}

function BreadthDot({ tone, count }: { tone: 'gain' | 'loss' | 'muted'; count: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-foreground">
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          tone === 'gain' && 'bg-gain',
          tone === 'loss' && 'bg-loss',
          tone === 'muted' && 'bg-foreground-subtle',
        )}
      />
      {count}
    </span>
  )
}

function MoverChip({
  label,
  mover,
  positive,
}: {
  label: string
  mover?: { symbol?: string; percentChange?: number }
  positive: boolean
}) {
  if (!mover?.symbol) return null
  const Arrow = positive ? ArrowUp : ArrowDown
  const tone = positive ? 'text-gain' : 'text-loss'
  return (
    <Link
      to={`/markets/${encodeURIComponent(mover.symbol)}`}
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2 py-1 text-[11px] transition-colors hover:border-border-strong"
    >
      <span className="text-[9px] uppercase tracking-wider text-foreground-subtle">{label}</span>
      <span className="font-medium">{mover.symbol}</span>
      <span className={cn('inline-flex items-center gap-0.5 tabular', tone)}>
        <Arrow className="size-3" aria-hidden />
        {percent(mover.percentChange ?? 0)}
      </span>
    </Link>
  )
}
