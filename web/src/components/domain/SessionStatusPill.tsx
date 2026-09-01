import { cn } from '@/lib/utils/cn'
import { formatDateTimeTitle, formatSessionCloseLabel, relativeSessionAge } from '@/lib/format/date'

interface Props {
  /** ISO timestamp from the market-summary `lastUpdated` field. */
  lastUpdated?: string
  /** Number of minutes after which the session is considered stale. Default 60. */
  freshWindowMin?: number
  className?: string
}

/**
 * Live / Closed session status pill.
 *
 * Anchors the dashboard's "today" framing — answers "is this number from
 * today or last session?" before the user has to reason about the date.
 *
 * State is derived from the market-summary envelope's `lastUpdated`; when
 * fresh (< freshWindowMin), the dot is gain-tinted and the pill reads "Live ·
 * 12 minutes ago". When stale, the dot goes muted and the pill reads "Closed
 * · last session 30 Apr".
 */
export function SessionStatusPill({ lastUpdated, freshWindowMin = 60, className }: Props) {
  const status = computeStatus(lastUpdated, freshWindowMin)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        status.state === 'live' && 'border-gain/30 bg-gain/10 text-gain',
        status.state === 'closed' && 'border-border bg-surface text-foreground-muted',
        status.state === 'unknown' && 'border-border bg-surface text-foreground-subtle',
        className,
      )}
      title={status.title}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          status.state === 'live' && 'bg-gain animate-pulse',
          status.state === 'closed' && 'bg-foreground-subtle',
          status.state === 'unknown' && 'bg-foreground-subtle',
        )}
      />
      {status.label}
    </span>
  )
}

interface Status {
  state: 'live' | 'closed' | 'unknown'
  label: string
  title: string
  /** Stale flag — true when data is more than ~1 day old. */
  stale: boolean
}

export function computeSessionStatus(lastUpdated?: string, freshWindowMin = 60): Status {
  return computeStatus(lastUpdated, freshWindowMin)
}

function computeStatus(lastUpdated?: string, freshWindowMin = 60): Status {
  if (!lastUpdated) {
    return { state: 'unknown', label: 'No session data', title: '', stale: true }
  }

  const title = formatDateTimeTitle(lastUpdated)
  if (!title) {
    return { state: 'unknown', label: 'No session data', title: '', stale: true }
  }

  const ts = new Date(lastUpdated)
  if (Number.isNaN(ts.valueOf())) {
    return { state: 'unknown', label: 'No session data', title: '', stale: true }
  }

  const minutesAgo = (Date.now() - ts.getTime()) / 60_000
  const stale = minutesAgo > 24 * 60
  if (minutesAgo < freshWindowMin) {
    const rel = relativeSessionAge(lastUpdated)
    return {
      state: 'live',
      label: rel ? `Live · ${rel} ago` : 'Live',
      title,
      stale: false,
    }
  }

  return {
    state: 'closed',
    label: formatSessionCloseLabel(lastUpdated) ?? 'Closed',
    title,
    stale,
  }
}
