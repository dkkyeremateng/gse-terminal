import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, BarChart3, Newspaper, Star } from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { PriceCell } from '@/components/domain/PriceCell'
import { EmptyState } from '@/components/domain/EmptyState'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { AIInsightPanel } from '@/components/domain/AIInsightPanel'
import { SignalBacktestPanel } from '@/components/domain/SignalBacktestPanel'
import { useHistory, useQuote, useTickerNews } from '@/features/markets/queries'
import { INTERVALS, type Interval, type NewsItem } from '@/features/markets/types'
import { useToggleWatchlist, useWatchlist } from '@/features/watchlist/queries'
import { useEntitlements } from '@/features/auth/entitlements'
import { useState } from 'react'
import { cn } from '@/lib/utils/cn'
import { compact, number } from '@/lib/utils/format'
import { toast } from '@/lib/utils/toast'

export default function MarketDetail() {
  const { symbol = '' } = useParams<{ symbol: string }>()
  const decoded = decodeURIComponent(symbol)
  const [interval, setInterval] = useState<Interval>('1d')

  const quote = useQuote(decoded)
  const history = useHistory(decoded, interval)
  const news = useTickerNews(decoded)
  const watchlist = useWatchlist()
  const toggleWatch = useToggleWatchlist()
  const { isPro } = useEntitlements()

  const q = quote.data
  const inWatchlist = watchlist.data?.symbols.includes(decoded) ?? false

  const handleToggleWatch = async () => {
    try {
      const added = !inWatchlist
      await toggleWatch.mutateAsync(decoded)
      toast.success(added ? `Added ${decoded} to watchlist` : `Removed ${decoded} from watchlist`)
    } catch (err) {
      toast.fromError(err, 'Couldn’t update watchlist')
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-foreground-muted">
          <Link to="/markets">
            <ArrowLeft className="size-4" />
            All markets
          </Link>
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-foreground-subtle">{decoded}</p>
            <h1 className="text-3xl font-semibold tracking-tight">
              {q?.lastPrice !== undefined ? (
                <PriceCell price={q.lastPrice} changePct={q.percentChange ?? 0} layout="inline" className="text-3xl" />
              ) : quote.isLoading ? (
                <span className="inline-block h-9 w-40 animate-pulse rounded bg-secondary align-middle" />
              ) : (
                <span className="text-foreground-muted">—</span>
              )}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-muted">
            <Stat label="Open" value={q?.openPrice !== undefined ? number(q.openPrice) : '—'} />
            <Stat
              label="Day P/L"
              value={q?.priceChange !== undefined ? signed(q.priceChange) : '—'}
              tone={(q?.priceChange ?? 0) > 0 ? 'gain' : (q?.priceChange ?? 0) < 0 ? 'loss' : 'muted'}
            />
            <Stat label="Volume" value={q?.volume !== undefined ? compact(q.volume) : '—'} />
            <Button
              variant={inWatchlist ? 'secondary' : 'outline'}
              size="sm"
              onClick={handleToggleWatch}
              disabled={toggleWatch.isPending}
              aria-pressed={inWatchlist}
            >
              <Star className={cn('size-4', inWatchlist && 'fill-accent text-accent')} />
              {inWatchlist ? 'Watching' : 'Watch'}
            </Button>
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="size-4 text-foreground-muted" />
            Price history
          </CardTitle>
          <IntervalSelector value={interval} onChange={setInterval} />
        </CardHeader>
        <CardContent className="p-0">
          {history.error ? (
            <EmptyState
              title="Chart unavailable"
              description={(history.error as Error).message}
              className="m-4"
            />
          ) : history.isLoading || !history.data ? (
            <div className="h-[360px] animate-pulse bg-secondary/30" />
          ) : history.data.length === 0 ? (
            <EmptyState
              title="No bars in this window"
              description="Try a wider interval or check back after the next collector run."
              className="m-4"
            />
          ) : (
            <div className="px-2 pt-3">
              <CandlestickChart bars={history.data} height={380} />
            </div>
          )}
        </CardContent>
      </Card>

      {/*
        Pro users see AI Oracle, Signal Backtest, and News side-by-side in
        a 3-col row on lg+ so the LLM verdict, technical history, and
        sentiment context can be scanned together. The grid stacks on
        smaller breakpoints. Non-pro users skip both pro panels and see
        News full-width.
      */}
      {isPro ? (
        <section className="grid gap-4 lg:grid-cols-3">
          <AIInsightPanel symbol={decoded} />
          <SignalBacktestPanel symbol={decoded} />
          <NewsCard news={news} />
        </section>
      ) : (
        <NewsCard news={news} />
      )}
    </div>
  )
}

function NewsCard({ news }: { news: ReturnType<typeof useTickerNews> }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Newspaper className="size-4 text-foreground-muted" />
          News
        </CardTitle>
        {news.data && (
          <span className="text-xs text-foreground-subtle">
            {news.data.length} {news.data.length === 1 ? 'item' : 'items'}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {news.error ? (
          <EmptyState title="Couldn't load news" description={(news.error as Error).message} className="m-4" />
        ) : news.isLoading ? (
          <NewsSkeleton />
        ) : !news.data?.length ? (
          <EmptyState title="No headlines yet" className="m-4" />
        ) : (
          <ul className="divide-y divide-border">
            {news.data.map((n, i) => (
              <NewsRow key={`${n.title}-${i}`} item={n} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function IntervalSelector({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  return (
    <div role="tablist" aria-label="Interval" className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
      {INTERVALS.map((opt) => {
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

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'gain' | 'loss' | 'muted' }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</span>
      <span
        className={cn(
          'tabular text-sm font-medium',
          tone === 'gain' && 'text-gain',
          tone === 'loss' && 'text-loss',
          (!tone || tone === 'muted') && 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function NewsRow({ item }: { item: NewsItem }) {
  const tone = (item.sentiment ?? 0) > 0.15 ? 'gain' : (item.sentiment ?? 0) < -0.15 ? 'loss' : 'muted'
  const when = item.publishedAt ? safeRelativeTime(item.publishedAt) : null
  return (
    <li className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/40">
      <SentimentDot tone={tone} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-foreground">{item.title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-foreground-subtle">
          {item.source && <span>{item.source}</span>}
          {item.source && when && <span aria-hidden>·</span>}
          {when && <span>{when}</span>}
          {typeof item.sentiment === 'number' && (
            <>
              <span aria-hidden>·</span>
              <span
                className={cn(
                  'tabular',
                  tone === 'gain' && 'text-gain',
                  tone === 'loss' && 'text-loss',
                  tone === 'muted' && 'text-foreground-subtle',
                )}
              >
                sentiment {item.sentiment.toFixed(2)}
              </span>
            </>
          )}
        </p>
      </div>
    </li>
  )
}

function SentimentDot({ tone }: { tone: 'gain' | 'loss' | 'muted' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full',
        tone === 'gain' && 'bg-gain',
        tone === 'loss' && 'bg-loss',
        tone === 'muted' && 'bg-foreground-subtle',
      )}
    />
  )
}

function NewsSkeleton() {
  return (
    <ul className="divide-y divide-border">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-secondary" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-secondary" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-secondary/70" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function safeRelativeTime(iso: string): string | null {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true })
  } catch {
    return null
  }
}

function signed(value: number) {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}`
}
