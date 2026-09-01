import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { SectorRollup } from '@/features/sectors/types'
import { cn } from '@/lib/utils/cn'
import { compact, percent } from '@/lib/utils/format'

interface Props {
  data: SectorRollup[]
  /** Current selection — gets a primary-tinted highlight. */
  selected?: string | null
  /** Click handler for a sector row. When omitted, rows render as static items. */
  onSelect?: (sector: string) => void
  /** Cap on row height to keep the list pace beside the heatmap. */
  maxHeight?: number
  className?: string
}

/**
 * Vertical, scannable detail list — paired with the heatmap on the Markets
 * page so Pro users can see the macro view (heatmap colors) and the
 * per-sector breakdown (rollup stats) at the same time.
 *
 * Each row stacks compactly: name + avg %, breadth dots, volume + turnover,
 * leader / laggard chips. Built for narrow columns (works at 1/2 width on
 * desktop and full-width on mobile).
 */
export function SectorDetailList({ data, selected, onSelect, maxHeight = 480, className }: Props) {
  if (data.length === 0) return null
  return (
    <ul
      className={cn('divide-y divide-border overflow-y-auto rounded-md border border-border', className)}
      style={{ maxHeight }}
    >
      {data.map((row) => (
        <SectorDetailRow
          key={row.sector}
          row={row}
          selected={selected === row.sector}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

function SectorDetailRow({
  row,
  selected,
  onSelect,
}: {
  row: SectorRollup
  selected: boolean
  onSelect?: (sector: string) => void
}) {
  const avg = row.avgPctChange ?? 0
  const tone = avg > 0 ? 'text-gain' : avg < 0 ? 'text-loss' : 'text-foreground-subtle'
  const advances = row.advanceCount ?? 0
  const declines = row.declineCount ?? 0
  const neutral = row.neutralCount ?? 0

  const interactive = Boolean(onSelect)
  const inner = (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium">{row.sector}</p>
        <p className={cn('tabular text-sm font-semibold', tone)}>{percent(avg)}</p>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-foreground-subtle">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-gain" />
          {advances}
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-loss" />
          {declines}
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-foreground-subtle" />
          {neutral} flat
        </span>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Volume" value={row.totalVolume ? compact(row.totalVolume) : '—'} />
        <Stat label="Turnover" value={row.totalTurnover ? compact(row.totalTurnover) : '—'} />
      </div>
      {(row.topGainer?.symbol || row.worstLoser?.symbol) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <MoverChip label="Leader" mover={row.topGainer} positive />
          <MoverChip label="Laggard" mover={row.worstLoser} positive={false} />
        </div>
      )}
    </div>
  )

  const baseClassName = cn(
    'block w-full px-4 py-3 text-left transition-colors',
    selected && 'bg-secondary/40',
    interactive && !selected && 'hover:bg-secondary/40',
  )

  if (interactive) {
    // The row contains nested <a> elements (mover chips) so we can't use a
    // <button> wrapper — that's invalid HTML. role="button" + tabIndex
    // gives us the same a11y semantics with Enter/Space activation.
    return (
      <li
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect?.(row.sector)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect?.(row.sector)
          }
        }}
        className={cn(baseClassName, 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
      >
        {inner}
      </li>
    )
  }

  return <li className={baseClassName}>{inner}</li>
}

function Stat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className={cn('text-sm font-medium tabular text-foreground', className)}>{value}</p>
    </div>
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
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px] transition-colors hover:border-border-strong"
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
