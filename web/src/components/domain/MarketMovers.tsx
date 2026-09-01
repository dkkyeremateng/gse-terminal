import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, ArrowRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AsOf } from '@/components/domain/AsOf'
import { useMarketSummary } from '@/features/markets/queries'
import { useSectorOverview } from '@/features/sectors/queries'
import type { MarketSnapshot } from '@/features/markets/types'
import type { SectorOverview } from '@/features/sectors/types'
import { cn } from '@/lib/utils/cn'
import { compact, percent } from '@/lib/utils/format'

type Tab = 'movers' | 'gainers' | 'losers' | 'active' | 'sectors'

const TABS: { value: Tab; label: string }[] = [
  { value: 'movers', label: 'Movers' },
  { value: 'gainers', label: 'Gainers' },
  { value: 'losers', label: 'Losers' },
  { value: 'active', label: 'Active' },
  { value: 'sectors', label: 'Sectors' },
]

// Cap each stock-list tab at the same row count so the card height stays
// stable across tab switches.
const ROW_LIMIT = 5

interface Props {
  className?: string
  /** When provided, the Sectors tab becomes click-to-filter. */
  onSelectSector?: (sector: string | null) => void
  /** Currently filter-active sector — visually highlighted in the Sectors tab. */
  selectedSector?: string | null
}

/**
 * Compact market-movers panel. Five tabs:
 *   • Movers   — combined gainers + losers, sorted by |%change|
 *   • Gainers  — `topGainers`
 *   • Losers   — `topLosers`
 *   • Active   — `active` (volume leaders)
 *   • Sectors  — top 5 sectors by |avg %|; click-to-filter when wired up
 *
 * Pulls from `/v1/market-summary` (and `/v1/market-sectors/overview` for the
 * Sectors tab). The Sectors tab is universal — sector membership stays Pro,
 * but the rollup overview itself is public.
 */
export function MarketMovers({ className, onSelectSector, selectedSector }: Props) {
  const summary = useMarketSummary()
  const sectorsQuery = useSectorOverview()
  const [tab, setTab] = useState<Tab>('movers')

  // Combined movers: dedupe by symbol, sort by absolute % change, top ROW_LIMIT.
  // Mirrors /ui/src/panels/index.js renderPulse default branch.
  const moversRows = useMemo(() => {
    const all = [...(summary.data?.topGainers ?? []), ...(summary.data?.topLosers ?? [])]
    const seen = new Set<string>()
    const out: MarketSnapshot[] = []
    for (const m of all.sort(
      (a, b) => Math.abs(b.percentChange ?? 0) - Math.abs(a.percentChange ?? 0),
    )) {
      if (m.symbol && !seen.has(m.symbol) && (m.lastPrice ?? 0) > 0) {
        seen.add(m.symbol)
        out.push(m)
        if (out.length >= ROW_LIMIT) break
      }
    }
    return out
  }, [summary.data?.topGainers, summary.data?.topLosers])

  const stockRows: MarketSnapshot[] = useMemo(() => {
    if (tab === 'movers') return moversRows
    if (tab === 'gainers') return summary.data?.topGainers?.slice(0, ROW_LIMIT) ?? []
    if (tab === 'losers') return summary.data?.topLosers?.slice(0, ROW_LIMIT) ?? []
    if (tab === 'active') return summary.data?.active?.slice(0, ROW_LIMIT) ?? []
    return []
  }, [tab, summary.data, moversRows])

  // Sectors: top 5 by absolute avg %.
  const sectorRows = useMemo(() => {
    const list = sectorsQuery.data ?? []
    return [...list]
      .sort((a, b) => Math.abs(b.avgPctChange ?? 0) - Math.abs(a.avgPctChange ?? 0))
      .slice(0, 5)
  }, [sectorsQuery.data])

  const isStockTab = tab !== 'sectors'
  const loading = isStockTab ? summary.isLoading : sectorsQuery.isLoading
  const isEmpty = isStockTab ? stockRows.length === 0 : sectorRows.length === 0
  const emptyCopy = tab === 'sectors' ? 'No sector data yet.' : 'No movers yet today.'

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          Market pulse
          <AsOf timestamp={summary.data?.lastUpdated} />
        </CardTitle>
        <div
          role="tablist"
          aria-label="Market pulse"
          className="flex items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-surface p-0.5"
        >
          {TABS.map((t) => {
            const active = tab === t.value
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.value)}
                className={cn(
                  'rounded-sm px-2 py-1 text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-secondary text-foreground'
                    : 'text-foreground-muted hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
                <div className="ml-auto h-4 w-12 animate-pulse rounded bg-secondary" />
                <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
              </li>
            ))}
          </ul>
        ) : isEmpty ? (
          <p className="px-4 py-6 text-center text-sm text-foreground-muted">{emptyCopy}</p>
        ) : isStockTab ? (
          <ul className="divide-y divide-border">
            {stockRows.map((row) => (
              <MoverRow key={row.symbol} row={row} />
            ))}
          </ul>
        ) : (
          <ul className="divide-y divide-border">
            {sectorRows.map((row) => (
              <SectorRow
                key={row.sector}
                row={row}
                onSelect={onSelectSector}
                selected={selectedSector === row.sector}
              />
            ))}
          </ul>
        )}
      </CardContent>
      {tab === 'movers' && summary.data?.moversMinVolume ? (
        <p className="border-t border-border px-4 py-1 text-[10px] uppercase tracking-wider text-foreground-subtle">
          Min volume {compact(summary.data.moversMinVolume)}
        </p>
      ) : null}
      <div className="flex justify-end border-t border-border px-2 py-1.5">
        <Button asChild variant="ghost" size="sm">
          <Link to="/markets">
            View all markets
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </div>
    </Card>
  )
}

function MoverRow({ row }: { row: MarketSnapshot }) {
  const positive = (row.percentChange ?? 0) > 0
  const negative = (row.percentChange ?? 0) < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null
  return (
    <li>
      <Link
        to={`/markets/${encodeURIComponent(row.symbol)}`}
        className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-secondary/40"
      >
        <span className="min-w-0 flex-1 font-medium">{row.symbol}</span>
        <span className="tabular text-foreground-muted">{row.lastPrice?.toFixed(2) ?? '—'}</span>
        <span
          className={cn(
            'inline-flex w-20 items-center justify-end gap-0.5 tabular text-xs',
            positive && 'text-gain',
            negative && 'text-loss',
            !positive && !negative && 'text-foreground-subtle',
          )}
        >
          {Arrow && <Arrow className="size-3" aria-hidden />}
          {percent(row.percentChange ?? 0)}
        </span>
        <span className="hidden w-16 text-right text-[11px] tabular text-foreground-subtle sm:inline">
          {row.volume ? compact(row.volume) : '—'}
        </span>
      </Link>
    </li>
  )
}

function SectorRow({
  row,
  onSelect,
  selected,
}: {
  row: SectorOverview
  onSelect?: (sector: string | null) => void
  selected: boolean
}) {
  const positive = (row.avgPctChange ?? 0) > 0
  const negative = (row.avgPctChange ?? 0) < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null
  const total = row.advanceCount + row.declineCount + row.neutralCount

  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{row.sector}</p>
        <p className="mt-0.5 text-[10px] uppercase tracking-wider text-foreground-subtle">
          <span className="text-gain">{row.advanceCount}↑</span>
          <span className="mx-1 text-foreground-subtle">·</span>
          <span className="text-loss">{row.declineCount}↓</span>
          <span className="mx-1 text-foreground-subtle">·</span>
          <span>{total} stocks</span>
        </p>
      </div>
      <span
        className={cn(
          'inline-flex w-20 items-center justify-end gap-0.5 tabular text-xs',
          positive && 'text-gain',
          negative && 'text-loss',
          !positive && !negative && 'text-foreground-subtle',
        )}
      >
        {Arrow && <Arrow className="size-3" aria-hidden />}
        {percent(row.avgPctChange ?? 0)}
      </span>
    </>
  )

  if (!onSelect) {
    return (
      <li className="flex items-center gap-3 px-4 py-2.5 text-sm">{inner}</li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(selected ? null : row.sector)}
        aria-pressed={selected}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-secondary/40',
          selected && 'bg-primary/10',
        )}
      >
        {inner}
      </button>
    </li>
  )
}
