import { format, parseISO } from 'date-fns'
import { AlertTriangle, FlaskConical } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/domain/EmptyState'
import { useBacktest } from '@/features/research/queries'
import type { BacktestResult, SignalSnapshot } from '@/features/research/types'
import { useEntitlements } from '@/features/auth/entitlements'
import { ApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils/cn'
import { percent, signed } from '@/lib/utils/format'

interface Props {
  symbol: string | undefined
}

/**
 * Compact, symbol-locked technical backtest summary. Pro-only — silently
 * renders nothing for non-pro users to match the AI Oracle panel's
 * inline behavior on the symbol detail page.
 *
 * The recent-signals visualization is a barcode-style strip of the last
 * 30 signals (green/red/grey by direction). Same pattern as the legacy
 * /ui terminal. Native tooltips on each bar give per-signal detail; no
 * toggle, no internal scroll, no horizontal-table cramming required.
 */
export function SignalBacktestPanel({ symbol }: Props) {
  const { isPro } = useEntitlements()
  const result = useBacktest(symbol, { enabled: isPro && Boolean(symbol) })

  if (!isPro) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical className="size-4 text-accent" />
          Signal backtest
        </CardTitle>
        {result.data && <SignalChips data={result.data} />}
      </CardHeader>
      <CardContent className="p-5">
        {result.error ? (
          <p className="text-sm text-foreground-muted">
            {result.error instanceof ApiError ? result.error.message : 'Backtest unavailable.'}
          </p>
        ) : result.isLoading || !result.data ? (
          <SkeletonStats />
        ) : result.data.totalSignals === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title="No signals in window"
            description="The technical pipeline didn't produce a triggered signal for this ticker yet."
          />
        ) : (
          <BacktestBody data={result.data} />
        )}
      </CardContent>
    </Card>
  )
}

function BacktestBody({ data }: { data: BacktestResult }) {
  const recent = data.signals.slice(-30)
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-foreground-subtle">
        {safeFormat(data.startDate, 'd MMM yyyy')} → {safeFormat(data.endDate, 'd MMM yyyy')} · {data.totalSignals} signal
        {data.totalSignals === 1 ? '' : 's'}
      </p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="Win rate · 5d" value={percent(data.winRate5d * 100, false)} />
        <Stat label="Avg return · 5d" value={signed(data.avgReturn5d * 100)} tone={toneFromValue(data.avgReturn5d)} />
        <Stat label="Sharpe" value={data.sharpeRatio.toFixed(2)} />
        <Stat label="Max drawdown" value={percent(data.maxDrawdown * 100, false)} tone="loss" />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-foreground-muted sm:grid-cols-3">
        <KeyValue label="Win 1d" value={percent(data.winRate1d * 100, false)} />
        <KeyValue label="Win 20d" value={percent(data.winRate20d * 100, false)} />
        <KeyValue label="Window" value={`${safeFormat(data.startDate, 'MMM yy')}–${safeFormat(data.endDate, 'MMM yy')}`} />
      </div>

      {recent.length > 0 && <RecentSignalsStrip signals={recent} />}

      {data.note && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-foreground-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{data.note}</span>
        </div>
      )}
    </div>
  )
}

function RecentSignalsStrip({ signals }: { signals: SignalSnapshot[] }) {
  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-foreground-subtle">
        <span>Last {signals.length} signals</span>
        <Legend />
      </div>
      <div
        role="img"
        aria-label={`Last ${signals.length} signals visualization`}
        className="flex w-full items-center gap-[3px]"
      >
        {signals.map((s, i) => (
          <span
            key={`${s.date}-${i}`}
            title={`${safeFormat(s.date, 'd MMM yyyy')} · ${s.signal} (${s.confidence}% confidence) · close ${s.close.toFixed(2)}`}
            className={cn(
              'h-4 min-w-0 flex-1 rounded-[1px] transition-opacity hover:opacity-70',
              s.signal === 'BULLISH' && 'bg-gain',
              s.signal === 'BEARISH' && 'bg-loss',
              s.signal === 'NEUTRAL' && 'bg-foreground-subtle/60',
            )}
          />
        ))}
      </div>
      <p className="flex items-center justify-between text-[10px] tabular text-foreground-subtle">
        <span>{safeFormat(signals[0].date, 'd MMM')}</span>
        <span>{safeFormat(signals[signals.length - 1].date, 'd MMM')}</span>
      </p>
    </div>
  )
}

function Legend() {
  return (
    <span className="flex items-center gap-2 normal-case tracking-normal">
      <LegendDot tone="gain" label="Bull" />
      <LegendDot tone="loss" label="Bear" />
      <LegendDot tone="muted" label="Neutral" />
    </span>
  )
}

function LegendDot({ tone, label }: { tone: 'gain' | 'loss' | 'muted'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-[1px]',
          tone === 'gain' && 'bg-gain',
          tone === 'loss' && 'bg-loss',
          tone === 'muted' && 'bg-foreground-subtle/60',
        )}
      />
      {label}
    </span>
  )
}

function SignalChips({ data }: { data: BacktestResult }) {
  return (
    <div className="flex items-center gap-1.5">
      <Chip count={data.bullish} tone="gain" label="Bull" />
      <Chip count={data.bearish} tone="loss" label="Bear" />
      <Chip count={data.neutral} tone="muted" label="Neutral" />
    </div>
  )
}

function Chip({ count, tone, label }: { count: number; tone: 'gain' | 'loss' | 'muted'; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        tone === 'gain' && 'border-gain/30 bg-gain/10 text-gain',
        tone === 'loss' && 'border-loss/30 bg-loss/10 text-loss',
        tone === 'muted' && 'border-border bg-surface text-foreground-muted',
      )}
    >
      <span className="font-medium tabular">{count}</span>
      {label}
    </span>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'gain' | 'loss' }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-base font-semibold tabular',
          tone === 'gain' && 'text-gain',
          tone === 'loss' && 'text-loss',
          !tone && 'text-foreground',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="whitespace-nowrap">
      <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</span>
      <span className="ml-1.5 font-medium tabular text-foreground">{value}</span>
    </div>
  )
}

function SkeletonStats() {
  return (
    <div className="space-y-3">
      <div className="h-3 w-2/3 animate-pulse rounded bg-secondary/60" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2.5 w-16 animate-pulse rounded bg-secondary/60" />
            <div className="h-5 w-20 animate-pulse rounded bg-secondary" />
          </div>
        ))}
      </div>
    </div>
  )
}

function toneFromValue(v: number): 'gain' | 'loss' | undefined {
  if (v > 0) return 'gain'
  if (v < 0) return 'loss'
  return undefined
}

function safeFormat(value: string, fmt: string): string {
  try {
    return format(parseISO(value), fmt)
  } catch {
    return value
  }
}
