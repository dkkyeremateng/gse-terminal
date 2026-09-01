import { useMemo, useState } from 'react'
import { format, formatDistanceToNow, isToday, isYesterday, parseISO, startOfDay } from 'date-fns'
import { ExternalLink, Minus, Newspaper, Search, TrendingDown, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/domain/EmptyState'
import { useMarketNews } from '@/features/markets/queries'
import type { NewsItem } from '@/features/markets/types'
import { cn } from '@/lib/utils/cn'

type Filter = 'all' | 'positive' | 'neutral' | 'negative'

const FILTERS: { value: Filter; label: string; tone?: 'gain' | 'loss' | 'muted' }[] = [
  { value: 'all', label: 'All' },
  { value: 'positive', label: 'Positive', tone: 'gain' },
  { value: 'neutral', label: 'Neutral', tone: 'muted' },
  { value: 'negative', label: 'Negative', tone: 'loss' },
]

interface Props {
  /** Show the 3-up sentiment KPI strip above the headlines card. Default true. */
  showStats?: boolean
  /** Cap visible headlines (after filter). Omit for unbounded. */
  limit?: number
  /** Group by day (Today / Yesterday / DD MMM). Default true. */
  groupByDayEnabled?: boolean
  className?: string
}

/**
 * Reusable news feed — sentiment KPIs (optional) + filterable, day-grouped
 * headlines.
 *
 * Used standalone on `/news` (full feature) and embedded on `/markets`
 * (compact) so the news content lives next to the data the user is already
 * looking at.
 */
export function NewsFeed({ showStats = true, limit, groupByDayEnabled = true, className }: Props) {
  const news = useMarketNews()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const items = useMemo(() => {
    const all = news.data ?? []
    const filtered = all.filter((n) => {
      if (filter !== 'all') {
        const tone = sentimentTone(n.sentiment ?? 0)
        if (tone !== filter) return false
      }
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return n.title.toLowerCase().includes(q) || (n.source ?? '').toLowerCase().includes(q)
    })
    return limit ? filtered.slice(0, limit) : filtered
  }, [news.data, query, filter, limit])

  const groups = useMemo(
    () => (groupByDayEnabled ? groupByDay(items) : [{ key: '__all', label: '', items }]),
    [items, groupByDayEnabled],
  )
  const stats = useMemo(() => computeStats(news.data ?? []), [news.data])
  const isEmpty = !news.isLoading && items.length === 0

  return (
    <div className={cn('space-y-4', className)}>
      {showStats && !news.isLoading && (news.data?.length ?? 0) > 0 && (
        <section className="grid gap-3 sm:grid-cols-3">
          <SentimentCard label="Positive" count={stats.positive} total={stats.total} tone="gain" Icon={TrendingUp} />
          <SentimentCard label="Neutral" count={stats.neutral} total={stats.total} tone="muted" Icon={Minus} />
          <SentimentCard label="Negative" count={stats.negative} total={stats.total} tone="loss" Icon={TrendingDown} />
        </section>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="space-y-3 border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Newspaper className="size-4 text-foreground-muted" />
            Headlines
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border bg-surface px-2.5">
              <Search className="size-4 text-foreground-subtle" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by headline or source…"
                className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                aria-label="Filter headlines"
              />
            </div>
            <FilterPills value={filter} onChange={setFilter} />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {news.error ? (
            <EmptyState title="Couldn't load headlines" description={(news.error as Error).message} className="m-3" />
          ) : news.isLoading ? (
            <SkeletonList />
          ) : isEmpty ? (
            <EmptyState
              icon={Newspaper}
              title={query || filter !== 'all' ? 'No matching headlines' : 'No news yet'}
              description={
                query || filter !== 'all'
                  ? 'Try clearing filters or broadening your search.'
                  : "Today's collector run hasn't surfaced any headlines yet."
              }
              className="m-4"
            />
          ) : (
            <div className="divide-y divide-border">
              {groups.map((group) =>
                group.label ? (
                  <DayGroup key={group.key} label={group.label} items={group.items} />
                ) : (
                  <ul key={group.key} className="divide-y divide-border">
                    {group.items.map((item, i) => (
                      <NewsRow key={`${item.title}-${i}`} item={item} />
                    ))}
                  </ul>
                ),
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SentimentCard({
  label,
  count,
  total,
  tone,
  Icon,
}: {
  label: string
  count: number
  total: number
  tone: 'gain' | 'loss' | 'muted'
  Icon: React.ComponentType<{ className?: string }>
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-[11px] uppercase tracking-wider text-foreground-subtle">{label}</p>
          <p
            className={cn(
              'text-2xl font-semibold tabular',
              tone === 'gain' && 'text-gain',
              tone === 'loss' && 'text-loss',
              tone === 'muted' && 'text-foreground',
            )}
          >
            {count}
          </p>
          <p className="text-xs text-foreground-muted">{pct}% of feed</p>
        </div>
        <span
          aria-hidden
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-md',
            tone === 'gain' && 'bg-gain/10 text-gain',
            tone === 'loss' && 'bg-loss/10 text-loss',
            tone === 'muted' && 'bg-secondary text-foreground-muted',
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
    </Card>
  )
}

function FilterPills({ value, onChange }: { value: Filter; onChange: (v: Filter) => void }) {
  return (
    <div role="tablist" aria-label="Sentiment filter" className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
      {FILTERS.map((f) => {
        const active = value === f.value
        return (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(f.value)}
            className={cn(
              'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
            )}
          >
            {f.tone && (
              <span
                aria-hidden
                className={cn(
                  'mr-1.5 inline-block size-1.5 rounded-full align-middle',
                  f.tone === 'gain' && 'bg-gain',
                  f.tone === 'loss' && 'bg-loss',
                  f.tone === 'muted' && 'bg-foreground-subtle',
                )}
              />
            )}
            {f.label}
          </button>
        )
      })}
    </div>
  )
}

function DayGroup({ label, items }: { label: string; items: NewsItem[] }) {
  return (
    <section>
      <header className="sticky top-0 z-[1] flex items-center justify-between border-b border-border bg-surface/95 px-4 py-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle backdrop-blur">
        <span>{label}</span>
        <span className="tabular text-foreground-subtle">{items.length}</span>
      </header>
      <ul className="divide-y divide-border">
        {items.map((item, i) => (
          <NewsRow key={`${item.title}-${i}`} item={item} />
        ))}
      </ul>
    </section>
  )
}

function NewsRow({ item }: { item: NewsItem }) {
  const tone = sentimentTone(item.sentiment ?? 0)
  return (
    <li>
      <div className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/40">
        <SentimentDot tone={tone} score={item.sentiment} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{item.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-foreground-subtle">
            {item.source && <span className="text-foreground-muted">{item.source}</span>}
            {item.publishedAt && (
              <>
                <span aria-hidden>·</span>
                <span title={safeFormat(item.publishedAt, 'PPpp')}>{safeRelative(item.publishedAt)}</span>
              </>
            )}
            {typeof item.sentiment === 'number' && (
              <>
                <span aria-hidden>·</span>
                <span
                  className={cn(
                    'tabular',
                    tone === 'positive' && 'text-gain',
                    tone === 'negative' && 'text-loss',
                    tone === 'neutral' && 'text-foreground-subtle',
                  )}
                >
                  sentiment {item.sentiment.toFixed(2)}
                </span>
              </>
            )}
          </p>
        </div>
        <ExternalLink className="mt-1 size-3.5 shrink-0 text-foreground-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </div>
    </li>
  )
}

function SentimentDot({ tone, score }: { tone: ReturnType<typeof sentimentTone>; score?: number }) {
  return (
    <span
      aria-label={`${tone} sentiment${score !== undefined ? ` ${score.toFixed(2)}` : ''}`}
      className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full',
        tone === 'positive' && 'bg-gain',
        tone === 'negative' && 'bg-loss',
        tone === 'neutral' && 'bg-foreground-subtle',
      )}
    />
  )
}

function SkeletonList() {
  return (
    <ul className="divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
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

function sentimentTone(score: number): 'positive' | 'negative' | 'neutral' {
  if (score > 0.15) return 'positive'
  if (score < -0.15) return 'negative'
  return 'neutral'
}

function computeStats(items: NewsItem[]) {
  let positive = 0
  let negative = 0
  let neutral = 0
  for (const i of items) {
    const t = sentimentTone(i.sentiment ?? 0)
    if (t === 'positive') positive++
    else if (t === 'negative') negative++
    else neutral++
  }
  return { positive, negative, neutral, total: items.length }
}

interface DayBucket {
  key: string
  label: string
  items: NewsItem[]
}

function groupByDay(items: NewsItem[]): DayBucket[] {
  const map = new Map<string, DayBucket>()
  const undated: NewsItem[] = []
  for (const item of items) {
    if (!item.publishedAt) {
      undated.push(item)
      continue
    }
    let date: Date
    try {
      date = parseISO(item.publishedAt)
    } catch {
      undated.push(item)
      continue
    }
    if (Number.isNaN(date.valueOf())) {
      undated.push(item)
      continue
    }
    const key = startOfDay(date).toISOString()
    const label = isToday(date) ? 'Today' : isYesterday(date) ? 'Yesterday' : safeFormat(item.publishedAt, 'EEE d MMM yyyy')
    const bucket = map.get(key) ?? { key, label, items: [] }
    bucket.items.push(item)
    map.set(key, bucket)
  }
  const sorted = [...map.values()].sort((a, b) => (a.key < b.key ? 1 : -1))
  if (undated.length > 0) sorted.push({ key: '__undated', label: 'Undated', items: undated })
  return sorted
}

function safeFormat(value: string, fmt: string): string {
  try {
    return format(parseISO(value), fmt)
  } catch {
    return value
  }
}

function safeRelative(value: string): string {
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    return value
  }
}
