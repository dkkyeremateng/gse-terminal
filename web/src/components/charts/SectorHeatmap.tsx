import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import { percent } from '@/lib/utils/format'
import type { SectorOverview } from '@/features/sectors/types'

interface SectorHeatmapProps {
  data: SectorOverview[]
  className?: string
  /** Stretch tiles to fill the grid. Default true. */
  fill?: boolean
  /**
   * When provided, tiles render as buttons that call back with the sector
   * name. Without it, tiles are non-interactive informational divs — the
   * default for surfaces that can't drill into a sector (e.g. basic-tier
   * users on Markets, where the sector→constituents endpoint is Pro-gated).
   */
  onSelect?: (sector: string) => void
  /** Currently active sector — gets a strong ring; others get a hover ring. */
  selected?: string | null
}

/**
 * Sector heatmap — color encodes today's avg % change, tile size encodes
 * symbol count (proxy for sector breadth).
 *
 * Uses a CSS-grid pseudo-treemap rather than an actual treemap library:
 *  - GSE has ~10 sectors, layout doesn't need a real squarified treemap
 *  - keeps the bundle lean (Recharts already adds enough)
 *  - tiles stay rectangular, easy to scan, accessible to screen readers
 */
export function SectorHeatmap({ data, className, fill = true, onSelect, selected }: SectorHeatmapProps) {
  const tiles = useMemo(() => {
    return [...data].sort((a, b) => b.avgPctChange - a.avgPctChange)
  }, [data])

  if (tiles.length === 0) {
    return null
  }

  // Tile span: bigger for sectors with more constituents (advance + decline + neutral).
  const sized = tiles.map((t) => ({
    ...t,
    count: t.advanceCount + t.declineCount + t.neutralCount,
  }))
  const maxCount = Math.max(...sized.map((s) => s.count), 1)

  return (
    <div className={cn('space-y-2', className)}>
      <Legend />
      <div
        className={cn(
          'grid auto-rows-[110px] gap-1.5',
          fill ? 'sm:grid-cols-3 lg:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3',
        )}
      >
        {sized.map((tile) => {
        // 1, 2, or 3 column span based on relative size.
        const ratio = tile.count / maxCount
        const colSpan = ratio > 0.66 ? 'sm:col-span-2' : ratio > 0.33 ? '' : ''
          return (
            <Tile
              key={tile.sector}
              tile={tile}
              colSpan={colSpan}
              onSelect={onSelect}
              isSelected={selected === tile.sector}
            />
          )
        })}
      </div>
    </div>
  )
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-foreground-subtle">
      <span className="uppercase tracking-wider">Breadth</span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="size-1.5 rounded-full bg-gain" /> advancing
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="size-1.5 rounded-full bg-loss" /> declining
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="size-1.5 rounded-full bg-foreground-subtle" /> unchanged
      </span>
    </div>
  )
}

function Tile({
  tile,
  colSpan,
  onSelect,
  isSelected,
}: {
  tile: SectorOverview & { count: number }
  colSpan: string
  onSelect?: (sector: string) => void
  isSelected: boolean
}) {
  const tone = toneFor(tile.avgPctChange)
  // Saturate alpha at ±3% — a 0.3% move shouldn't shout, a 3% move should.
  const intensity = Math.min(1, Math.abs(tile.avgPctChange) / 3)
  const alpha = Math.max(0.06, 0.32 * intensity)
  const bg =
    tile.avgPctChange === 0
      ? 'rgba(148, 163, 184, 0.08)' // slate-400 @ 8%
      : tile.avgPctChange > 0
        ? `rgba(16, 185, 129, ${alpha})` // emerald-500 — matches --gain
        : `rgba(239, 68, 68, ${alpha})` // red-500 — matches --loss

  const interactive = Boolean(onSelect)
  const sharedClassName = cn(
    'group relative flex flex-col justify-between overflow-hidden rounded-md border p-3 text-left transition-all duration-150',
    isSelected
      ? 'border-primary ring-2 ring-primary/40'
      : interactive
        ? 'border-border hover:scale-[1.02] hover:border-border-strong cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        : 'border-border',
    colSpan,
  )
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-medium leading-tight text-foreground">{tile.sector}</span>
        <span className="text-[10px] tabular text-foreground-muted">{tile.count}</span>
      </div>
      <div className="space-y-0.5">
        <span className={cn('block tabular text-lg font-semibold leading-none', tone)}>
          {percent(tile.avgPctChange)}
        </span>
        <Breadth advance={tile.advanceCount} decline={tile.declineCount} neutral={tile.neutralCount} />
      </div>
    </>
  )

  if (interactive) {
    return (
      <button
        type="button"
        onClick={() => onSelect?.(tile.sector)}
        aria-pressed={isSelected}
        aria-label={`${tile.sector} ${percent(tile.avgPctChange)} — filter table to this sector`}
        className={sharedClassName}
        style={{ backgroundColor: bg }}
      >
        {inner}
      </button>
    )
  }

  return (
    <div
      role="article"
      aria-label={`${tile.sector} ${percent(tile.avgPctChange)}`}
      className={sharedClassName}
      style={{ backgroundColor: bg }}
    >
      {inner}
    </div>
  )
}

function Breadth({ advance, decline, neutral }: { advance: number; decline: number; neutral: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-foreground-muted">
      <span className="inline-flex items-center gap-1" title={`${advance} advancing`} aria-label={`${advance} advancing`}>
        <span aria-hidden className="size-1.5 rounded-full bg-gain" />
        {advance}
      </span>
      <span className="inline-flex items-center gap-1" title={`${decline} declining`} aria-label={`${decline} declining`}>
        <span aria-hidden className="size-1.5 rounded-full bg-loss" />
        {decline}
      </span>
      <span className="inline-flex items-center gap-1" title={`${neutral} unchanged`} aria-label={`${neutral} unchanged`}>
        <span aria-hidden className="size-1.5 rounded-full bg-foreground-subtle" />
        {neutral}
      </span>
    </div>
  )
}

function toneFor(pct: number): string {
  if (pct > 0) return 'text-gain'
  if (pct < 0) return 'text-loss'
  return 'text-foreground-subtle'
}
