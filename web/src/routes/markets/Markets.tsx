import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronUp, Grid3x3, Search, Activity, Star, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/domain/EmptyState'
import { SectorHeatmap } from '@/components/charts/SectorHeatmap'
import { NewsFeed } from '@/components/domain/NewsFeed'
import { useAllSnapshots } from '@/features/markets/queries'
import { useToggleWatchlist, useWatchlist } from '@/features/watchlist/queries'
import { useSectorOverview, useSectorDetail } from '@/features/sectors/queries'
import { useEntitlements } from '@/features/auth/entitlements'
import type { MarketSnapshot } from '@/features/markets/types'
import { useLocalStorage } from '@/lib/hooks/useLocalStorage'
import { cn } from '@/lib/utils/cn'
import { compact, percent } from '@/lib/utils/format'
import { toast } from '@/lib/utils/toast'

type SortKey = 'symbol' | 'lastPrice' | 'percentChange' | 'volume'
type SortDir = 'asc' | 'desc'
type View = 'all' | 'watching'

export default function Markets() {
  const { data, isLoading, error, lastUpdated } = useAllSnapshots()
  const watchlist = useWatchlist()
  const toggle = useToggleWatchlist()
  const [params, setParams] = useSearchParams()
  const view: View = params.get('view') === 'watching' ? 'watching' : 'all'
  const sectorParam = params.get('sector') ?? null
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'percentChange', dir: 'desc' })

  const { isPro } = useEntitlements()
  const sectorOverview = useSectorOverview()
  // Pro-gated detail — gives us the symbol → sector membership we need to
  // filter the table when a sector is picked. Basic users never reach this
  // code path because the heatmap renders without an onSelect callback.
  const sectorDetail = useSectorDetail({ enabled: isPro })
  const [heatmapOpen, setHeatmapOpen] = useLocalStorage('markets:heatmap-open', true)

  // Active sector → set of constituent symbols. Backed by the Pro detail
  // endpoint; until that resolves we keep the table unfiltered so the user
  // doesn't see a flash-empty state.
  const sectorSymbols = useMemo(() => {
    if (!sectorParam || !sectorDetail.data) return null
    const match = sectorDetail.data.find((r) => r.sector === sectorParam)
    if (!match?.constituents?.length) return null
    return new Set(match.constituents.map((c) => c.symbol))
  }, [sectorParam, sectorDetail.data])

  // Symbol → watching membership lookup. Backed by the watchlist query, which
  // is shared with WatchlistPanel and the MarketDetail star — TanStack dedupes.
  const watching = useMemo(
    () => new Set(watchlist.data?.symbols ?? []),
    [watchlist.data?.symbols],
  )

  const rows = useMemo(() => {
    const list = data ?? []
    const byView = view === 'watching' ? list.filter((s) => watching.has(s.symbol)) : list
    const bySector = sectorSymbols ? byView.filter((s) => sectorSymbols.has(s.symbol)) : byView
    const filtered = query
      ? bySector.filter((s) => s.symbol.toLowerCase().includes(query.toLowerCase()))
      : bySector
    return [...filtered].sort((a, b) => {
      const av = (a[sort.key] ?? 0) as number | string
      const bv = (b[sort.key] ?? 0) as number | string
      if (typeof av === 'string' && typeof bv === 'string') {
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sort.dir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av)
    })
  }, [data, query, sort, view, watching, sectorSymbols])

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  const setView = (next: View) => {
    const p = new URLSearchParams(params)
    if (next === 'all') p.delete('view')
    else p.set('view', 'watching')
    setParams(p, { replace: true })
  }

  const setSector = (sector: string | null) => {
    const p = new URLSearchParams(params)
    if (sector) p.set('sector', sector)
    else p.delete('sector')
    setParams(p, { replace: true })
  }

  const handleStar = async (symbol: string) => {
    const wasWatching = watching.has(symbol)
    try {
      await toggle.mutateAsync(symbol)
      toast.success(wasWatching ? `Removed ${symbol}` : `Added ${symbol} to watchlist`)
    } catch (err) {
      toast.fromError(err, 'Couldn’t update watchlist')
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
          <p className="text-sm text-foreground-muted">
            All listings on the Ghana Stock Exchange — sectors, watchlist, search.
            {lastUpdated && (
              <span className="ml-1.5 text-foreground-subtle">
                · Updated {new Date(lastUpdated).toLocaleString()}
              </span>
            )}
          </p>
        </div>
        <Breadth rows={data} />
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card className="overflow-hidden">
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Grid3x3 className="size-4 text-foreground-muted" />
            <span className="font-medium">Sector heatmap</span>
            <span className="text-[11px] text-foreground-subtle">
              {isPro ? 'Click a tile to filter the table' : 'Tile size = constituent count'}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setHeatmapOpen((v) => !v)}
            aria-expanded={heatmapOpen}
            aria-label={heatmapOpen ? 'Hide heatmap' : 'Show heatmap'}
          >
            {heatmapOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            {heatmapOpen ? 'Hide' : 'Show'}
          </Button>
        </header>
        {heatmapOpen && (
          <div className="p-4">
            {sectorOverview.error ? (
              <EmptyState
                title="Couldn't load sectors"
                description={(sectorOverview.error as Error).message}
              />
            ) : sectorOverview.isLoading ? (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="h-[110px] animate-pulse rounded bg-secondary/40" />
                ))}
              </div>
            ) : !sectorOverview.data?.length ? (
              <EmptyState title="No sectors yet" />
            ) : (
              <SectorHeatmap
                data={sectorOverview.data}
                fill={false}
                onSelect={isPro ? (s) => setSector(s === sectorParam ? null : s) : undefined}
                selected={sectorParam}
              />
            )}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <ViewToggle value={view} watchingCount={watching.size} onChange={setView} />
          {sectorParam && (
            <button
              type="button"
              onClick={() => setSector(null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15"
              aria-label={`Clear sector filter (${sectorParam})`}
            >
              <Grid3x3 className="size-3" aria-hidden />
              <span>{sectorParam}</span>
              <X className="size-3" aria-hidden />
            </button>
          )}
          <div className="ml-auto flex min-w-[180px] flex-1 items-center gap-2 sm:max-w-xs">
            <Search className="size-4 text-foreground-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by symbol…"
              className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              aria-label="Filter by symbol"
            />
          </div>
          <span className="text-xs text-foreground-subtle">
            {rows.length} {rows.length === 1 ? 'symbol' : 'symbols'}
          </span>
        </div>

        {error ? (
          <EmptyState title="Couldn't load markets" description={(error as Error).message} className="m-3" />
        ) : isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          view === 'watching' ? (
            <EmptyState
              icon={Star}
              title={query ? 'No matching tracked symbols' : 'You aren’t watching any symbols yet'}
              description={
                query
                  ? 'Try clearing the filter or switch back to All.'
                  : 'Star a row below or on any quote page to track its live price.'
              }
              action={
                <Button onClick={() => setView('all')} variant="outline">
                  Browse all symbols
                </Button>
              }
              className="m-3"
            />
          ) : (
            <EmptyState
              icon={Activity}
              title={query ? 'No matching symbols' : 'No data yet'}
              description={query ? 'Try a shorter ticker.' : 'Market data will appear after the next collector run.'}
              className="m-3"
            />
          )
        ) : (
          // ~10 rows visible at once (each row ≈ 45px); the wrapper scrolls
          // for the rest. Sticky header keeps the column labels and sort
          // affordances visible during scroll.
          <Table wrapperClassName="max-h-[460px]">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-9 px-2" aria-label="Watch" />
                <SortHeader label="Symbol" k="symbol" sort={sort} onToggle={toggleSort} />
                <SortHeader label="Last" k="lastPrice" sort={sort} onToggle={toggleSort} align="right" />
                <SortHeader label="Change" k="percentChange" sort={sort} onToggle={toggleSort} align="right" />
                <SortHeader label="Volume" k="volume" sort={sort} onToggle={toggleSort} align="right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isWatching = watching.has(row.symbol)
                return (
                  <TableRow key={row.symbol} className="cursor-pointer">
                    <TableCell className="w-9 px-2">
                      <button
                        type="button"
                        aria-label={isWatching ? `Remove ${row.symbol} from watchlist` : `Add ${row.symbol} to watchlist`}
                        aria-pressed={isWatching}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          handleStar(row.symbol)
                        }}
                        className={cn(
                          'inline-flex size-7 items-center justify-center rounded-md transition-colors',
                          isWatching
                            ? 'text-accent hover:bg-accent/10'
                            : 'text-foreground-subtle hover:bg-secondary hover:text-foreground',
                        )}
                      >
                        <Star className={cn('size-4', isWatching && 'fill-accent')} />
                      </button>
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link
                        to={`/markets/${encodeURIComponent(row.symbol)}`}
                        className="block w-full hover:text-primary"
                      >
                        {row.symbol}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular">{row.lastPrice?.toFixed(2) ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <ChangeBadge value={row.percentChange ?? 0} />
                    </TableCell>
                    <TableCell className="text-right tabular text-foreground-muted">
                      {row.volume ? compact(row.volume) : '—'}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      </section>

      {/* News content moved here from /news so the headlines live alongside
          the symbols and sectors data. The full filterable, day-grouped
          feed is rendered inline. */}
      <NewsFeed />
    </div>
  )
}

function ViewToggle({
  value,
  watchingCount,
  onChange,
}: {
  value: View
  watchingCount: number
  onChange: (v: View) => void
}) {
  return (
    <div role="tablist" aria-label="Markets view" className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'all'}
        onClick={() => onChange('all')}
        className={cn(
          'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
          value === 'all' ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
        )}
      >
        All
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'watching'}
        onClick={() => onChange('watching')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
          value === 'watching' ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
        )}
      >
        <Star className={cn('size-3', value === 'watching' && 'fill-accent text-accent')} />
        Watching
        {watchingCount > 0 && (
          <span className="rounded-full bg-secondary px-1 text-[10px] tabular text-foreground-muted">
            {watchingCount}
          </span>
        )}
      </button>
    </div>
  )
}

function ChangeBadge({ value }: { value: number }) {
  const positive = value > 0
  const negative = value < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end gap-0.5 tabular text-xs',
        positive && 'text-gain',
        negative && 'text-loss',
        !positive && !negative && 'text-foreground-subtle',
      )}
    >
      {Arrow && <Arrow className="size-3" aria-hidden />}
      {percent(value)}
    </span>
  )
}

function SortHeader({
  label,
  k,
  sort,
  onToggle,
  align = 'left',
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; dir: SortDir }
  onToggle: (k: SortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sort.key === k
  const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <TableHead
      className={cn(align === 'right' && 'text-right')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onToggle(k)}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
          active && 'text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        <span>{label}</span>
        <Icon className="size-3" />
      </button>
    </TableHead>
  )
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-3 py-3">
          <div className="size-5 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="ml-auto h-4 w-12 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-20 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  )
}

function Breadth({ rows }: { rows?: MarketSnapshot[] }) {
  if (!rows?.length) return null
  const advances = rows.filter((r) => (r.percentChange ?? 0) > 0).length
  const declines = rows.filter((r) => (r.percentChange ?? 0) < 0).length
  const flat = rows.length - advances - declines
  return (
    <div className="hidden items-center gap-3 text-xs text-foreground-muted md:flex">
      <BreadthChip label="Advancing" count={advances} tone="gain" />
      <BreadthChip label="Declining" count={declines} tone="loss" />
      <BreadthChip label="Unchanged" count={flat} tone="muted" />
    </div>
  )
}

function BreadthChip({ label, count, tone }: { label: string; count: number; tone: 'gain' | 'loss' | 'muted' }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 tabular">
      <span
        className={cn(
          'size-1.5 rounded-full',
          tone === 'gain' && 'bg-gain',
          tone === 'loss' && 'bg-loss',
          tone === 'muted' && 'bg-foreground-subtle',
        )}
      />
      <span>{label}</span>
      <span className="font-medium text-foreground">{count}</span>
    </span>
  )
}
