import { formatAsOfText, formatDateTimeTitle } from '@/lib/format/date'

interface Props {
  /** ISO timestamp from the source query — not `Date.now()`. */
  timestamp?: string
  className?: string
}

/**
 * `as of HH:mm · D MMM` line for data cards.
 *
 * A financial dashboard with no as-of times invites confusion when data is
 * stale — every data block should expose the timestamp tied to its actual
 * payload so a "now" tooltip can never silently outrun the upstream source.
 * Renders nothing when no timestamp is available.
 */
export function AsOf({ timestamp, className }: Props) {
  const text = formatAsOfText(timestamp)
  if (!text) return null

  return (
    <span
      title={formatDateTimeTitle(timestamp)}
      className={`text-[10px] uppercase tracking-wider text-foreground-subtle ${className ?? ''}`}
    >
      {text}
    </span>
  )
}
