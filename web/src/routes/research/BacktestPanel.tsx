import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { FlaskConical, Loader2, Play, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SymbolCombobox } from '@/components/ui/symbol-combobox'
import { EmptyState } from '@/components/domain/EmptyState'
import { KpiCard } from '@/components/domain/KpiCard'
import { useBacktest } from '@/features/research/queries'
import { useSymbols } from '@/features/markets/queries'
import { ApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils/cn'
import { percent, signed } from '@/lib/utils/format'

export function BacktestPanel() {
  const symbols = useSymbols()
  const [pending, setPending] = useState('')
  const [submitted, setSubmitted] = useState<string | undefined>(undefined)
  const result = useBacktest(submitted, { enabled: Boolean(submitted) })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!pending.trim()) return
    setSubmitted(pending.trim().toUpperCase())
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FlaskConical className="size-4 text-accent" />
            Deterministic technical backtest
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5">
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <Label htmlFor="backtest-symbol">Symbol</Label>
              <SymbolCombobox
                id="backtest-symbol"
                placeholder="e.g. MTNGH"
                value={pending}
                onChange={setPending}
                symbols={symbols.data ?? []}
              />
            </div>
            <Button type="submit" disabled={result.isFetching || !pending.trim()}>
              {result.isFetching ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Run backtest
            </Button>
          </form>
          <p className="mt-3 text-[11px] text-foreground-subtle">
            Uses SMA20/SMA50/RSI14/ATR14/volume only. Sentiment is zeroed for reproducibility.
          </p>
        </CardContent>
      </Card>

      {result.error && (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-destructive">
              {result.error instanceof ApiError ? result.error.message : 'Backtest failed'}
            </p>
          </CardContent>
        </Card>
      )}

      {!submitted && !result.isFetching && (
        <EmptyState
          icon={FlaskConical}
          title="Ready to backtest"
          description="Enter a ticker above to walk its full history through the technical signal pipeline."
          className="rounded-md border border-dashed border-border-strong"
        />
      )}

      {result.data && <ResultBlock data={result.data} />}
    </div>
  )
}

function ResultBlock({ data }: { data: NonNullable<ReturnType<typeof useBacktest>['data']> }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{data.symbol}</h2>
          <p className="text-xs text-foreground-muted">
            {safeFormat(data.startDate, 'd MMM yyyy')} → {safeFormat(data.endDate, 'd MMM yyyy')} ·{' '}
            {data.totalSignals} signal{data.totalSignals === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <SignalChip count={data.bullish} label="Bullish" tone="gain" />
          <SignalChip count={data.bearish} label="Bearish" tone="loss" />
          <SignalChip count={data.neutral} label="Neutral" tone="muted" />
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Win rate · 5d"
          value={percent(data.winRate5d * 100, false)}
          hint={`1d ${percent(data.winRate1d * 100, false)} · 20d ${percent(data.winRate20d * 100, false)}`}
        />
        <KpiCard label="Avg return · 5d" value={signed(data.avgReturn5d * 100)} hint="Per-signal mean" />
        <KpiCard
          label="Sharpe ratio"
          value={data.sharpeRatio.toFixed(2)}
          hint="Risk-adjusted excess return"
        />
        <KpiCard
          label="Max drawdown"
          value={percent(data.maxDrawdown * 100, false)}
          hint="Worst peak-to-trough"
        />
      </section>

      {data.note && (
        <Card>
          <CardContent className="flex items-start gap-2 p-3 text-xs text-foreground-muted">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>{data.note}</span>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border">
          <CardTitle className="text-sm">
            Signal log <span className="font-normal text-foreground-muted">· last {Math.min(data.signals.length, 25)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-border bg-surface">
                <tr className="text-[11px] uppercase tracking-wider text-foreground-subtle">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Signal</th>
                  <th className="px-3 py-2 text-right">Close</th>
                  <th className="px-3 py-2 text-right">RSI</th>
                  <th className="px-3 py-2 text-right">+1d</th>
                  <th className="px-3 py-2 text-right">+5d</th>
                  <th className="px-3 py-2 text-right">+20d</th>
                </tr>
              </thead>
              <tbody>
                {data.signals.slice(-25).reverse().map((s, i) => (
                  <tr key={`${s.date}-${i}`} className="border-b border-border last:border-0 hover:bg-secondary/40">
                    <td className="px-3 py-2 tabular text-foreground-muted">{safeFormat(s.date, 'd MMM yyyy')}</td>
                    <td className="px-3 py-2"><SignalLabel signal={s.signal} /></td>
                    <td className="px-3 py-2 text-right tabular">{s.close.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular text-foreground-muted">{s.rsi.toFixed(1)}</td>
                    <ForwardCell value={s.forwardReturn?.['1d']} />
                    <ForwardCell value={s.forwardReturn?.['5d']} />
                    <ForwardCell value={s.forwardReturn?.['20d']} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function SignalChip({ count, label, tone }: { count: number; label: string; tone: 'gain' | 'loss' | 'muted' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
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

function SignalLabel({ signal }: { signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }) {
  const map = {
    BULLISH: 'text-gain',
    BEARISH: 'text-loss',
    NEUTRAL: 'text-foreground-muted',
  } as const
  return <span className={cn('text-xs font-medium', map[signal])}>{signal[0] + signal.slice(1).toLowerCase()}</span>
}

function ForwardCell({ value }: { value?: number }) {
  if (value == null) return <td className="px-3 py-2 text-right text-foreground-subtle">—</td>
  const tone = value > 0 ? 'text-gain' : value < 0 ? 'text-loss' : 'text-foreground-subtle'
  return <td className={cn('px-3 py-2 text-right tabular', tone)}>{signed(value * 100)}</td>
}

function safeFormat(value: string, fmt: string): string {
  try {
    return format(parseISO(value), fmt)
  } catch {
    return value
  }
}
