import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Briefcase,
  Grid3x3,
  ListChecks,
  Minus,
  Newspaper,
  Plus,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/domain/KpiCard'
import { SectorHeatmap } from '@/components/charts/SectorHeatmap'
import { PnLArea } from '@/components/charts/PnLArea'
import { EmptyState } from '@/components/domain/EmptyState'
import { DailyBriefingCard } from '@/components/domain/DailyBriefingCard'
import { MarketMovers } from '@/components/domain/MarketMovers'
import { WatchlistPanel } from '@/components/domain/WatchlistPanel'
import { SessionStatusPill } from '@/components/domain/SessionStatusPill'
import { TodayHero } from '@/components/domain/TodayHero'
import { AsOf } from '@/components/domain/AsOf'
import { useUser } from '@/features/auth/store'
import { useAllSnapshots, useMarketNews } from '@/features/markets/queries'
import { useHasHoldings, usePortfolio, usePortfolioHistory } from '@/features/portfolio/queries'
import { useSectorOverview } from '@/features/sectors/queries'
import { useWatchlist } from '@/features/watchlist/queries'
import { cn } from '@/lib/utils/cn'
import { safeRelativeDate } from '@/lib/format/date'

export default function Dashboard() {
  const user = useUser()
  const portfolio = usePortfolio()
  const market = useAllSnapshots()
  const sectors = useSectorOverview()
  const news = useMarketNews()
  const watchlist = useWatchlist()
  const hasHoldings = useHasHoldings()

  const summary = portfolio.data
  const breadth = computeBreadth(market.data ?? [])
  const watchlistCount = watchlist.data?.symbols?.length ?? 0
  const greeting = greetingFor(new Date())
  const greetingName = user?.username ? `${user.username},` : ''

  const showOnboarding = hasHoldings === false

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-foreground-subtle">{greeting}</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greetingName} {showOnboarding ? "let's set up your terminal." : "here's the floor."}
          </h1>
        </div>
        {market.lastUpdated && <SessionStatusPill lastUpdated={market.lastUpdated} />}
      </header>

      {showOnboarding ? (
        <NewUserDashboard
          breadth={breadth}
          marketLoading={market.isLoading}
          watchlistCount={watchlistCount}
          watchlistLoading={watchlist.isLoading}
          sectors={sectors}
          news={news}
          lastUpdated={market.lastUpdated}
        />
      ) : (
        <ReturningUserDashboard
          summary={summary}
          portfolioLoading={portfolio.isLoading}
          sectors={sectors}
          news={news}
          lastUpdated={market.lastUpdated}
        />
      )}
    </div>
  )
}

// ── Returning user (has portfolio) ────────────────────────────────────────

interface ReturningProps {
  summary: ReturnType<typeof usePortfolio>['data']
  portfolioLoading: boolean
  sectors: ReturnType<typeof useSectorOverview>
  news: ReturnType<typeof useMarketNews>
  lastUpdated?: string
}

function ReturningUserDashboard(props: ReturningProps) {
  const { summary, portfolioLoading, sectors, news, lastUpdated } = props
  const history = usePortfolioHistory('30d')

  return (
    <>
      <section className="grid gap-4 lg:grid-cols-2">
        <TodayHero summary={summary} loading={portfolioLoading} lastUpdated={lastUpdated} />
        <MarketMovers />
      </section>

      <DailyBriefingCard />

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="size-4 text-foreground-muted" />
              Portfolio · last 30 days
            </CardTitle>
            <Button asChild variant="ghost" size="sm" className="-mr-2">
              <Link to="/portfolio">
                View portfolio
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-3 pt-4">
            {history.isLoading ? (
              <div className="h-[260px] animate-pulse rounded bg-secondary/40" />
            ) : !history.data?.points?.length ? (
              <EmptyState icon={Briefcase} title="No equity curve yet" />
            ) : (
              <PnLArea points={history.data.points} costBasis={summary?.totalCost} height={260} />
            )}
          </CardContent>
        </Card>

        <WatchlistPanel />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <SectorHeatmapCard sectors={sectors} lastUpdated={lastUpdated} className="lg:col-span-2" />
        <NewsCard news={news} />
      </section>
    </>
  )
}

// ── New user (no portfolio yet) ────────────────────────────────────────────

interface NewUserProps {
  breadth: ReturnType<typeof computeBreadth>
  marketLoading: boolean
  watchlistCount: number
  watchlistLoading: boolean
  sectors: ReturnType<typeof useSectorOverview>
  news: ReturnType<typeof useMarketNews>
  lastUpdated?: string
}

function NewUserDashboard(props: NewUserProps) {
  const { breadth, marketLoading, watchlistCount, watchlistLoading, sectors, news, lastUpdated } = props

  return (
    <>
      <GetStartedHero watchlistCount={watchlistCount} />

      <section className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Market breadth"
          value={breadth ? `${breadth.advances}/${breadth.total}` : '—'}
          loading={marketLoading}
          hint={breadth ? `${breadth.advances} up · ${breadth.declines} down · ${breadth.flat} flat` : undefined}
        />
        <KpiCard
          label="Sectors covered"
          value={sectors.data?.length ?? '—'}
          loading={sectors.isLoading}
          hint="Across the GSE"
        />
        <KpiCard
          label="Your watchlist"
          value={watchlistCount}
          loading={watchlistLoading}
          hint={watchlistCount ? 'Tracked symbols' : 'Track symbols to see live prices'}
        />
      </section>

      <DailyBriefingCard />

      <section className="grid gap-4 lg:grid-cols-3">
        <MarketMovers className="lg:col-span-2" />
        <WatchlistPanel />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <SectorHeatmapCard sectors={sectors} lastUpdated={lastUpdated} className="lg:col-span-2" />
        <NewsCard news={news} />
      </section>
    </>
  )
}

function GetStartedHero({ watchlistCount }: { watchlistCount: number }) {
  return (
    <Card className="overflow-hidden border-border-strong">
      <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:gap-8">
        <div className="space-y-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-accent">
            <Sparkles className="size-3" />
            Welcome
          </span>
          <h2 className="text-xl font-semibold tracking-tight">Track your first position to unlock the full picture.</h2>
          <p className="max-w-xl text-sm text-foreground-muted">
            Your portfolio dashboard, P&L curve, allocation breakdown, and live valuation appear the moment you record a
            holding. Until then, GES Pro is fully usable for browsing the market.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <Link to="/portfolio">
              <Plus className="size-4" />
              Add a position
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/markets?view=watching">
              <ListChecks className="size-4" />
              {watchlistCount ? 'Your watchlist' : 'Build a watchlist'}
            </Link>
          </Button>
        </div>
      </div>
      <div className="grid border-t border-border bg-surface/50 sm:grid-cols-3">
        <Step n={1} label="Pick a ticker" hint="Browse Markets, search ⌘K, or add from a quote page" />
        <Step n={2} label="Record your buy" hint="Quantity + cost basis + purchase date" />
        <Step n={3} label="Watch it move" hint="P&L, sector exposure, and a 30-day equity curve appear here" />
      </div>
    </Card>
  )
}

function Step({ n, label, hint }: { n: number; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-3 px-5 py-3">
      <span className="mt-0.5 inline-flex size-6 items-center justify-center rounded-full border border-border bg-surface-elevated text-xs font-medium text-foreground tabular">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-foreground-muted">{hint}</p>
      </div>
    </div>
  )
}

// ── Shared ─────────────────────────────────────────────────────────────────

function SectorHeatmapCard({
  sectors,
  lastUpdated,
  className,
}: {
  sectors: ReturnType<typeof useSectorOverview>
  lastUpdated?: string
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Grid3x3 className="size-4 text-foreground-muted" />
          Sector heatmap
          <AsOf timestamp={lastUpdated} />
        </CardTitle>
        <Button asChild variant="ghost" size="sm" className="-mr-2">
          <Link to="/markets">
            Open markets
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-4">
        {sectors.isLoading ? (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-[110px] animate-pulse rounded bg-secondary/40" />
            ))}
          </div>
        ) : !sectors.data?.length ? (
          <EmptyState title="No sectors yet" />
        ) : (
          <SectorHeatmap data={sectors.data} />
        )}
      </CardContent>
    </Card>
  )
}

function NewsCard({ news }: { news: ReturnType<typeof useMarketNews> }) {
  const items = news.data ?? []
  const mood = items.length > 0 ? aggregateMood(items) : null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Newspaper className="size-4 text-foreground-muted" />
          Top headlines
        </CardTitle>
        <div className="flex items-center gap-1">
          {mood && mood.scored > 0 && <MoodPill mood={mood} />}
          <Button asChild variant="ghost" size="sm" className="-mr-2">
            <Link to="/news">
              More
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {news.isLoading ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-secondary/40" />
            ))}
          </div>
        ) : !items.length ? (
          <EmptyState title="No headlines yet" className="m-3" />
        ) : (
          <ul className="divide-y divide-border">
            {items.slice(0, 6).map((n, i) => {
              const tone = sentimentTone(n.sentiment ?? 0)
              return (
                <li
                  key={`${n.title}-${i}`}
                  className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      tone === 'positive' && 'bg-gain',
                      tone === 'negative' && 'bg-loss',
                      tone === 'neutral' && 'bg-foreground-subtle',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm leading-snug">{n.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground-subtle">
                      <SentimentChip score={n.sentiment} tone={tone} />
                      {n.source && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{n.source}</span>
                        </>
                      )}
                      {n.publishedAt && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{safeRelative(n.publishedAt)}</span>
                        </>
                      )}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

type SentimentTone = 'positive' | 'negative' | 'neutral'

function sentimentTone(score: number): SentimentTone {
  if (score > 0.15) return 'positive'
  if (score < -0.15) return 'negative'
  return 'neutral'
}

function SentimentChip({ score, tone }: { score?: number; tone: SentimentTone }) {
  // Unscored items have no defensible label — rendering a default "Neutral"
  // badge reads as a real result and misleads. Drop the chip entirely when
  // sentiment is null.
  if (typeof score !== 'number') return null

  const label = tone === 'positive' ? 'Positive' : tone === 'negative' ? 'Negative' : 'Neutral'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1 py-px text-[10px] font-medium uppercase tracking-wider',
        tone === 'positive' && 'border-gain/30 bg-gain/10 text-gain',
        tone === 'negative' && 'border-loss/30 bg-loss/10 text-loss',
        tone === 'neutral' && 'border-border bg-surface text-foreground-muted',
      )}
      title={`Sentiment ${score.toFixed(2)}`}
    >
      {label}
      <span className="tabular text-foreground-subtle">{score.toFixed(2)}</span>
    </span>
  )
}

interface Mood {
  tone: SentimentTone
  label: string
  positive: number
  negative: number
  neutral: number
  total: number
  avg: number
  /** Count of items with a numeric sentiment score. 0 means no average. */
  scored: number
}

function aggregateMood(items: { sentiment?: number }[]): Mood {
  // Only count items that actually have a sentiment score. Treating unscored
  // headlines as "neutral" inflates the neutral bucket and produces a fake
  // average of 0.00, which is exactly the bug we're fixing here.
  let pos = 0
  let neg = 0
  let neu = 0
  let sum = 0
  let scored = 0
  for (const i of items) {
    if (typeof i.sentiment !== 'number') continue
    const t = sentimentTone(i.sentiment)
    if (t === 'positive') pos++
    else if (t === 'negative') neg++
    else neu++
    sum += i.sentiment
    scored++
  }
  const avg = scored > 0 ? sum / scored : 0
  const tone: SentimentTone = pos > neg && pos > neu ? 'positive' : neg > pos && neg > neu ? 'negative' : 'neutral'
  const label =
    tone === 'positive'
      ? 'Bullish'
      : tone === 'negative'
        ? 'Bearish'
        : pos === 0 && neg === 0
          ? 'Neutral'
          : 'Mixed'
  return { tone, label, positive: pos, negative: neg, neutral: neu, total: items.length, avg, scored }
}

function MoodPill({ mood }: { mood: Mood }) {
  const Icon = mood.tone === 'positive' ? TrendingUp : mood.tone === 'negative' ? TrendingDown : Minus
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        mood.tone === 'positive' && 'border-gain/30 bg-gain/10 text-gain',
        mood.tone === 'negative' && 'border-loss/30 bg-loss/10 text-loss',
        mood.tone === 'neutral' && 'border-border bg-surface text-foreground-muted',
      )}
      title={`Avg sentiment ${mood.avg.toFixed(2)} · ${mood.positive}+ / ${mood.neutral}= / ${mood.negative}−`}
    >
      <Icon className="size-3" aria-hidden />
      {mood.label}
    </span>
  )
}

function computeBreadth(rows: { percentChange?: number }[]) {
  if (!rows.length) return null
  const advances = rows.filter((r) => (r.percentChange ?? 0) > 0).length
  const declines = rows.filter((r) => (r.percentChange ?? 0) < 0).length
  return {
    total: rows.length,
    advances,
    declines,
    flat: rows.length - advances - declines,
  }
}

function greetingFor(d: Date): string {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function safeRelative(iso: string): string {
  return safeRelativeDate(iso)
}
