import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils/cn'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { percent } from '@/lib/utils/format'
import { Sparkline } from './Sparkline'

interface KpiCardProps {
  label: string
  value: React.ReactNode
  /** Optional change pct, paired with arrow + color. */
  changePct?: number | null
  /** Optional sparkline data (last N points). */
  sparkline?: number[]
  /** Optional supporting label below the value. */
  hint?: React.ReactNode
  loading?: boolean
  className?: string
}

export function KpiCard({ label, value, changePct, sparkline, hint, loading, className }: KpiCardProps) {
  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-foreground-subtle">{label}</p>
          <div className="mt-1 flex items-baseline gap-2">
            {loading ? (
              <span className="inline-block h-7 w-24 animate-pulse rounded bg-secondary" />
            ) : (
              <span className="text-2xl font-semibold tracking-tight tabular">{value}</span>
            )}
            {!loading && typeof changePct === 'number' && <ChangeBadge value={changePct} />}
          </div>
          {hint && <p className="mt-1 text-xs text-foreground-muted">{hint}</p>}
        </div>
        {sparkline && sparkline.length > 1 && (
          <Sparkline values={sparkline} className="self-center" />
        )}
      </div>
    </Card>
  )
}

function ChangeBadge({ value }: { value: number }) {
  const positive = value > 0
  const negative = value < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs tabular',
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
