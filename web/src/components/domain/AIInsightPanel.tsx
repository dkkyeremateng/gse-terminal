import { Sparkles, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAIInsight } from '@/features/research/queries'
import type { AIInsight, AISignal } from '@/features/research/types'
import { useEntitlements } from '@/features/auth/entitlements'
import { cn } from '@/lib/utils/cn'
import { number } from '@/lib/utils/format'

interface AIInsightPanelProps {
  symbol: string | undefined
  /** Hide the wrapper Card chrome (used inside a host page that owns the card). */
  bare?: boolean
}

/**
 * AI Market Oracle panel. Pro-only — silently renders nothing for non-pro
 * users (entitlement gating is enforced at the route level for the dedicated
 * page; on shared pages like MarketDetail we just hide the panel here).
 */
export function AIInsightPanel({ symbol, bare }: AIInsightPanelProps) {
  const { isPro } = useEntitlements()
  const { data, isLoading, error } = useAIInsight(symbol, { enabled: isPro && Boolean(symbol) })

  if (!isPro) return null

  const Body = () => {
    if (error) {
      return (
        <p className="text-sm text-foreground-muted">
          Couldn’t load insight. {(error as Error).message}
        </p>
      )
    }
    if (isLoading || !data) {
      return (
        <div className="space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-full animate-pulse rounded bg-secondary/80" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-secondary/60" />
        </div>
      )
    }
    return <InsightBody data={data} />
  }

  if (bare) {
    return (
      <div className="space-y-3">
        <Header symbol={symbol} />
        <Body />
      </div>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4 text-accent" />
          AI Market Oracle
        </CardTitle>
        {data?.signal && <SignalPill signal={data.signal} />}
      </CardHeader>
      <CardContent className="p-5">
        <Body />
      </CardContent>
    </Card>
  )
}

function Header({ symbol }: { symbol?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4 text-accent" />
        AI Market Oracle
      </h3>
      {symbol && <span className="text-[11px] text-foreground-subtle">{symbol}</span>}
    </div>
  )
}

function InsightBody({ data }: { data: AIInsight }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SignalPill signal={data.signal} />
        {typeof data.confidence === 'number' && (
          <span className="text-xs text-foreground-muted">
            {data.confidence}% confidence
          </span>
        )}
      </div>

      {data.analysis && (
        <p className="text-sm leading-relaxed text-foreground">{data.analysis}</p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 sm:grid-cols-3">
        {typeof data.rsi === 'number' && <Stat label="RSI(14)" value={data.rsi.toFixed(1)} />}
        {typeof data.atr === 'number' && <Stat label="ATR" value={data.atr.toFixed(3)} />}
        {typeof data.fairValue === 'number' && <Stat label="Fair value" value={number(data.fairValue)} />}
        {typeof data.suggestedPrice === 'number' && (
          <Stat label="Suggested" value={number(data.suggestedPrice)} />
        )}
        {typeof data.sentiment === 'number' && (
          <Stat label="Sentiment" value={`${data.sentiment.toFixed(2)}${data.sentimentLabel ? ` · ${data.sentimentLabel}` : ''}`} />
        )}
        {typeof data.sampleSize === 'number' && <Stat label="Samples" value={String(data.sampleSize)} />}
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {data.aboveSMA20 !== undefined && (
          <SmaChip label="SMA20" above={data.aboveSMA20} />
        )}
        {data.aboveSMA50 !== undefined && (
          <SmaChip label="SMA50" above={data.aboveSMA50} />
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p className="text-sm font-medium tabular text-foreground">{value}</p>
    </div>
  )
}

function SmaChip({ label, above }: { label: string; above: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
        above ? 'border-gain/30 bg-gain/10 text-gain' : 'border-loss/30 bg-loss/10 text-loss',
      )}
    >
      {above ? '↑' : '↓'} {label}
    </span>
  )
}

function SignalPill({ signal }: { signal: AISignal }) {
  const map = {
    BULLISH: { tone: 'border-gain/30 bg-gain/10 text-gain', Icon: TrendingUp, label: 'Bullish' },
    BEARISH: { tone: 'border-loss/30 bg-loss/10 text-loss', Icon: TrendingDown, label: 'Bearish' },
    NEUTRAL: { tone: 'border-border bg-surface text-foreground-muted', Icon: Minus, label: 'Neutral' },
  } as const
  const { tone, Icon, label } = map[signal] ?? map.NEUTRAL
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', tone)}>
      <Icon className="size-3" />
      {label}
    </span>
  )
}
