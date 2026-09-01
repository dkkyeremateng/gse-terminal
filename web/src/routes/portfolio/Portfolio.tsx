import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  TrendingUp,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/domain/EmptyState'
import { KpiCard } from '@/components/domain/KpiCard'
import { AllocationDonut, type AllocationSlice } from '@/components/charts/AllocationDonut'
import { PnLArea } from '@/components/charts/PnLArea'
import { usePortfolio, usePortfolioHistory } from '@/features/portfolio/queries'
import { WINDOWS, type HistoryWindow, type PortfolioHolding } from '@/features/portfolio/types'
import { useSymbols } from '@/features/markets/queries'
import { compact, money, percent, signed } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { HoldingDialog } from './HoldingDialog'
import { DeleteHoldingDialog } from './DeleteHoldingDialog'

export default function Portfolio() {
  const portfolio = usePortfolio()
  const symbols = useSymbols()
  const [window, setWindow] = useState<HistoryWindow>('30d')
  const history = usePortfolioHistory(window)
  const [groupBy, setGroupBy] = useState<'sector' | 'symbol'>('sector')

  const [editing, setEditing] = useState<PortfolioHolding | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleting, setDeleting] = useState<PortfolioHolding | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const toggleExpanded = (symbol: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })
  }

  const summary = portfolio.data
  const holdings = summary?.holdings ?? []

  // Aggregate purchase lots into one row per symbol. The backend returns
  // a row per transaction (e.g. two MTNGH buys = two rows); the table
  // should reflect positions, not trade history. Weighted-average cost
  // basis uses summed costValue / summed qty so partial fills and dollar
  // averaging stay correct. Stable order: first-seen lot wins.
  const aggregatedHoldings = useMemo(() => aggregateLots(holdings), [holdings])

  const allocation: AllocationSlice[] = useMemo(() => {
    if (!summary) return []
    if (groupBy === 'sector') {
      return Object.entries(summary.sectorExposure ?? {})
        .map(([label, pct]) => ({ label, value: (summary.totalValue * pct) / 100 }))
        .filter((s) => s.value > 0)
    }
    // Aggregate by symbol — multiple holdings of the same ticker (separate
    // tranches, dollar-cost-averaging, etc.) collapse into a single slice
    // so the donut shows portfolio composition, not transaction history.
    const totals = new Map<string, number>()
    for (const h of holdings) {
      totals.set(h.symbol, (totals.get(h.symbol) ?? 0) + h.marketValue)
    }
    return Array.from(totals, ([label, value]) => ({ label, value })).filter((s) => s.value > 0)
  }, [summary, holdings, groupBy])

  const isEmpty = !portfolio.isLoading && holdings.length === 0

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
          <p className="text-sm text-foreground-muted">
            Live valuation, cumulative P&L, and exposure across {summary?.holdingCount ?? 0}{' '}
            {summary?.holdingCount === 1 ? 'position' : 'positions'}.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          Add position
        </Button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Market value"
          value={summary ? money(summary.totalValue) : '—'}
          loading={portfolio.isLoading}
          hint={summary && `Cost ${money(summary.totalCost)}`}
        />
        <KpiCard
          label="Total P&L"
          value={summary ? money(summary.totalPnl) : '—'}
          changePct={summary?.totalPnlPct}
          loading={portfolio.isLoading}
          hint={summary && summary.totalCost > 0 ? `vs ${money(summary.totalCost)} cost` : undefined}
        />
        <KpiCard
          label="Today's P&L"
          value={summary ? signed(summary.todayPnl) : '—'}
          changePct={summary?.todayPnlPct}
          loading={portfolio.isLoading}
          hint="vs prior close"
        />
        <KpiCard
          label="Positions"
          value={summary?.holdingCount ?? '—'}
          loading={portfolio.isLoading}
          hint={summary && `${Object.keys(summary.sectorExposure ?? {}).length} sectors`}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="size-4 text-foreground-muted" />
              Equity curve
            </CardTitle>
            <WindowPicker value={window} onChange={setWindow} />
          </CardHeader>
          <CardContent className="p-3 pt-4">
            {history.error ? (
              <EmptyState title="Couldn't load history" description={(history.error as Error).message} />
            ) : history.isLoading ? (
              <div className="h-[280px] animate-pulse rounded bg-secondary/40" />
            ) : !history.data?.points?.length || isEmpty ? (
              <EmptyState
                title="No history yet"
                description={
                  isEmpty
                    ? 'Add your first position to start tracking its equity curve.'
                    : 'Reconstructing — try again in a moment.'
                }
              />
            ) : (
              <PnLArea points={history.data.points} costBasis={summary?.totalCost} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
            <CardTitle className="text-sm">Allocation</CardTitle>
            <GroupPicker value={groupBy} onChange={setGroupBy} />
          </CardHeader>
          <CardContent className="p-5">
            {isEmpty || allocation.length === 0 ? (
              <EmptyState title="No positions yet" />
            ) : (
              <AllocationDonut
                data={allocation}
                total={summary?.totalValue}
                totalLabel="Market value"
              />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Briefcase className="size-4 text-foreground-muted" />
            Holdings
          </CardTitle>
          <span className="text-xs text-foreground-subtle">
            {aggregatedHoldings.length} {aggregatedHoldings.length === 1 ? 'position' : 'positions'}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {portfolio.error ? (
            <EmptyState title="Couldn't load holdings" description={(portfolio.error as Error).message} className="m-3" />
          ) : portfolio.isLoading ? (
            <SkeletonRows />
          ) : isEmpty ? (
            <EmptyState
              icon={Briefcase}
              title="No positions yet"
              description="Track your first holding to see it here with live P&L."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" />
                  Add position
                </Button>
              }
              className="m-4"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Symbol</TableHead>
                  <TableHead>Sector</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Cost / share</TableHead>
                  <TableHead className="text-right">Last</TableHead>
                  <TableHead className="text-right">Market value</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead className="w-10" aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {aggregatedHoldings.map((row) => {
                  const isExpanded = expanded.has(row.symbol)
                  const isAggregated = row.lotCount > 1
                  return (
                    <Fragment key={row.symbol}>
                      <TableRow>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-1.5">
                            {isAggregated ? (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(row.symbol)}
                                aria-expanded={isExpanded}
                                aria-controls={`lots-${row.symbol}`}
                                aria-label={`${isExpanded ? 'Hide' : 'Show'} ${row.lotCount} lots`}
                                className="inline-flex size-5 items-center justify-center rounded text-foreground-subtle transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="size-3.5" aria-hidden />
                                ) : (
                                  <ChevronRight className="size-3.5" aria-hidden />
                                )}
                              </button>
                            ) : (
                              <span aria-hidden className="inline-block size-5" />
                            )}
                            <Link
                              to={`/markets/${encodeURIComponent(row.symbol)}`}
                              className="hover:text-primary"
                            >
                              {row.symbol}
                            </Link>
                            {isAggregated && (
                              <span
                                className="rounded-sm border border-border bg-surface px-1 py-px text-[10px] tabular text-foreground-subtle"
                                title={`${row.lotCount} purchase lots`}
                              >
                                ×{row.lotCount}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-foreground-muted">{row.sector || 'Other'}</TableCell>
                        <TableCell className="text-right tabular">{compact(row.quantity)}</TableCell>
                        <TableCell className="text-right tabular text-foreground-muted">
                          {row.avgCostBasis.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {row.currentPrice > 0 ? row.currentPrice.toFixed(2) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular">{money(row.marketValue)}</TableCell>
                        <TableCell className="text-right">
                          <PnLPair value={row.pnl} pct={row.pnlPct} />
                        </TableCell>
                        <TableCell className="w-10 p-0 pr-2 text-right">
                          {!isAggregated ? (
                            <RowMenu
                              onEdit={() => setEditing(row.lots[0])}
                              onDelete={() => setDeleting(row.lots[0])}
                            />
                          ) : (
                            // Per-lot editing happens in the expanded sub-rows.
                            <span className="inline-block size-8" aria-hidden />
                          )}
                        </TableCell>
                      </TableRow>
                      {isAggregated && isExpanded &&
                        row.lots.map((lot) => (
                          <TableRow
                            key={lot.id}
                            id={`lots-${row.symbol}-${lot.id}`}
                            className="bg-secondary/20 hover:bg-secondary/30"
                          >
                            <TableCell className="pl-10 text-xs text-foreground-muted">
                              <span className="tabular">{lot.purchaseDate}</span>
                              {lot.notes && (
                                <span className="ml-2 text-foreground-subtle">· {lot.notes}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-foreground-subtle">Lot</TableCell>
                            <TableCell className="text-right text-xs tabular">{compact(lot.quantity)}</TableCell>
                            <TableCell className="text-right text-xs tabular text-foreground-muted">
                              {lot.costBasis.toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular text-foreground-subtle">—</TableCell>
                            <TableCell className="text-right text-xs tabular">{money(lot.marketValue)}</TableCell>
                            <TableCell className="text-right text-xs">
                              <PnLPair value={lot.pnl} pct={lot.pnlPct} />
                            </TableCell>
                            <TableCell className="w-10 p-0 pr-2 text-right">
                              <RowMenu
                                onEdit={() => setEditing(lot)}
                                onDelete={() => setDeleting(lot)}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <HoldingDialog
        open={createOpen || Boolean(editing)}
        onOpenChange={(o) => {
          if (!o) {
            setCreateOpen(false)
            setEditing(null)
          }
        }}
        holding={editing}
        symbols={symbols.data}
      />
      <DeleteHoldingDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        holding={deleting}
      />
    </div>
  )
}

function WindowPicker({ value, onChange }: { value: HistoryWindow; onChange: (w: HistoryWindow) => void }) {
  return (
    <div role="tablist" aria-label="History window" className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
      {WINDOWS.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function GroupPicker({ value, onChange }: { value: 'sector' | 'symbol'; onChange: (v: 'sector' | 'symbol') => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 text-xs">
      {(['sector', 'symbol'] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          onClick={() => onChange(opt)}
          className={cn(
            'rounded-sm px-2 py-1 capitalize transition-colors',
            value === opt ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

interface AggregatedRow {
  symbol: string
  sector: string
  quantity: number
  avgCostBasis: number
  currentPrice: number
  marketValue: number
  pnl: number
  pnlPct: number
  lotCount: number
  /** Full lot list, in oldest-first order. Single-lot rows reuse this
   * for the inline edit/delete menu; aggregated rows surface it under
   * an expandable disclosure for per-lot review. */
  lots: PortfolioHolding[]
}

/**
 * Group purchase lots into one row per symbol.
 *
 * Cost basis uses weighted average: total cost / total qty. P&L and
 * market value sum across lots. Order of appearance is preserved so the
 * table feels stable when a new lot is added.
 */
function aggregateLots(lots: PortfolioHolding[]): AggregatedRow[] {
  const map = new Map<string, AggregatedRow>()
  const order: string[] = []

  for (const lot of lots) {
    const existing = map.get(lot.symbol)
    if (!existing) {
      order.push(lot.symbol)
      map.set(lot.symbol, {
        symbol: lot.symbol,
        sector: lot.sector,
        quantity: lot.quantity,
        avgCostBasis: lot.costBasis,
        currentPrice: lot.currentPrice,
        marketValue: lot.marketValue,
        pnl: lot.pnl,
        pnlPct: lot.pnlPct,
        lotCount: 1,
        lots: [lot],
      })
      continue
    }

    existing.quantity += lot.quantity
    existing.marketValue += lot.marketValue
    existing.pnl += lot.pnl
    existing.lotCount += 1
    existing.lots.push(lot)
    // Live price is a per-share quote — same for every lot of a symbol.
    // Use the most recently iterated non-zero price as a safe default.
    if (lot.currentPrice > 0) existing.currentPrice = lot.currentPrice
  }

  // Compute weighted-average cost basis, recompute P&L%, and sort lots
  // oldest-first so the lot-expansion view reads as a trade history.
  for (const symbol of order) {
    const row = map.get(symbol)!
    const totalCost = row.marketValue - row.pnl
    row.avgCostBasis = row.quantity > 0 ? totalCost / row.quantity : 0
    row.pnlPct = totalCost > 0 ? (row.pnl / totalCost) * 100 : 0
    row.lots.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate))
  }

  return order.map((s) => map.get(s)!)
}

function PnLPair({ value, pct }: { value: number; pct: number }) {
  const positive = value > 0
  const negative = value < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null
  return (
    <span
      className={cn(
        'inline-flex flex-col items-end gap-0.5 tabular',
        positive && 'text-gain',
        negative && 'text-loss',
        !positive && !negative && 'text-foreground-subtle',
      )}
    >
      <span className="font-medium">{signed(value)}</span>
      <span className="inline-flex items-center gap-0.5 text-[11px]">
        {Arrow && <Arrow className="size-3" aria-hidden />}
        {percent(pct)}
      </span>
    </span>
  )
}

function RowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md text-foreground-muted hover:bg-secondary hover:text-foreground"
          aria-label="Position actions"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          data-menu-content=""
          className="z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 text-sm shadow-[var(--shadow-lg)]"
        >
          <DropdownMenu.Item
            onSelect={onEdit}
            className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-secondary"
          >
            <Pencil className="size-4" />
            Edit
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onDelete}
            className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-destructive outline-none data-[highlighted]:bg-destructive/10"
          >
            <Trash2 className="size-4" />
            Remove
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-3 py-3">
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-20 animate-pulse rounded bg-secondary/70" />
          <div className="ml-auto h-4 w-12 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-20 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  )
}
