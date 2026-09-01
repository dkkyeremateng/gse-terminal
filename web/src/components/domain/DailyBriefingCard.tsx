import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AsOf } from '@/components/domain/AsOf'
import { useBriefing, type BriefingInsight } from '@/features/briefing/queries'
import { cn } from '@/lib/utils/cn'
import { safeFormatDate } from '@/lib/format/date'

/**
 * Daily market briefing — LLM-generated summary + per-symbol insights.
 *
 * Shown on the dashboard. Sentiment is paired with a verdict label and a
 * status dot, never color alone.
 */
export function DailyBriefingCard() {
  const { data, isLoading, error } = useBriefing()

  // Hide the card entirely when there's nothing to show — no point taking
  // up dashboard real estate with an empty-state message. Loading and
  // error states still render so users see either a skeleton during the
  // initial fetch or a real diagnostic if the briefing endpoint breaks.
  const isEmpty = !data || (!data.summary && (!data.insights || data.insights.length === 0))
  if (!isLoading && !error && isEmpty) return null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4 text-accent" />
          Daily briefing
        </CardTitle>
        {data?.tradingDate && (
          <span className="flex items-center gap-2 text-[11px] text-foreground-subtle">
            <span>{safeFormatDate(data.tradingDate, 'EEE d MMM')}</span>
            <AsOf timestamp={data.tradingDate} />
          </span>
        )}
      </CardHeader>
      <CardContent className="p-5">
        {error ? (
          <p className="text-sm text-foreground-muted">
            Couldn't load today's briefing. {(error as Error).message}
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            <div className="h-4 w-full animate-pulse rounded bg-secondary" />
            <div className="h-4 w-11/12 animate-pulse rounded bg-secondary/80" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-secondary/60" />
          </div>
        ) : (
          <div className="space-y-4">
            {data.summary && <p className="text-sm leading-relaxed text-foreground">{data.summary}</p>}
            {data.insights && data.insights.length > 0 && (
              <ul className="grid gap-1.5 pt-1 sm:grid-cols-2">
                {data.insights.slice(0, 6).map((ins) => (
                  <InsightRow key={ins.symbol} insight={ins} />
                ))}
              </ul>
            )}
            {typeof data.averageSentiment === 'number' && !isInsufficientDataSummary(data.summary) && (
              <p className="border-t border-border pt-3 text-[11px] text-foreground-subtle">
                Avg sentiment <span className="tabular text-foreground">{data.averageSentiment.toFixed(2)}</span>{' '}
                across covered symbols.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function InsightRow({ insight }: { insight: BriefingInsight }) {
  const label = insightVerdictLabel(insight)
  const tone = verdictTone(label)
  return (
    <li>
      <Link
        to={insight.symbol ? `/markets/${encodeURIComponent(insight.symbol)}` : '#'}
        className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden className={cn('size-1.5 rounded-full', tone.dot)} />
          <span className="font-medium">{insight.symbol ?? '—'}</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-foreground-muted">
          {typeof insight.rsi === 'number' && (
            <span className="tabular" title="RSI(14)">
              RSI {insight.rsi.toFixed(0)}
            </span>
          )}
          <span className={cn('rounded-sm px-1.5 py-0.5 text-[10px] font-medium', tone.pill)}>{label}</span>
        </span>
      </Link>
    </li>
  )
}

function verdictTone(v: string) {
  switch (v) {
    case 'Constructive':
    case 'Bullish':
    case 'Oversold':
      return { dot: 'bg-gain', pill: 'bg-gain/10 text-gain' }
    case 'Cautious':
    case 'Bearish':
    case 'Overbought':
    case 'Extreme overbought':
      return { dot: 'bg-loss', pill: 'bg-loss/10 text-loss' }
    default:
      return { dot: 'bg-foreground-subtle', pill: 'bg-secondary text-foreground-muted' }
  }
}

function insightVerdictLabel(insight: BriefingInsight): string {
  if (insight.verdict) return insight.verdict
  if (typeof insight.rsi !== 'number') return 'Neutral'

  if (insight.rsi >= 90) return 'Extreme overbought'
  if (insight.rsi > 70) return 'Overbought'
  if (insight.rsi >= 55) return 'Bullish'
  if (insight.rsi >= 45) return 'Neutral'
  if (insight.rsi >= 30) return 'Bearish'
  return 'Oversold'
}

function isInsufficientDataSummary(summary?: string): boolean {
  return summary?.trim() === 'Not enough signals to summarise — check back after close.'
}

