import { format, formatDistanceToNow, formatDistanceToNowStrict, parseISO } from 'date-fns'

function parseTimestamp(value?: string): Date | null {
  if (!value) return null
  try {
    const ts = parseISO(value)
    return Number.isNaN(ts.valueOf()) ? null : ts
  } catch {
    return null
  }
}

function isMidnightMarker(ts: Date): boolean {
  return ts.getHours() === 0 && ts.getMinutes() === 0 && ts.getSeconds() === 0
}

export function formatAsOfText(value?: string): string | null {
  const ts = parseTimestamp(value)
  if (!ts) return null
  return isMidnightMarker(ts) ? `as of ${format(ts, 'd MMM')}` : `as of ${format(ts, 'HH:mm · d MMM')}`
}

export function formatDateTimeTitle(value?: string): string {
  const ts = parseTimestamp(value)
  if (!ts) return value ?? ''
  return isMidnightMarker(ts) ? format(ts, 'd MMM yyyy') : format(ts, 'PPpp')
}

export function formatSessionCloseLabel(value?: string): string | null {
  const ts = parseTimestamp(value)
  if (!ts) return null
  return `Closed · last session ${format(ts, 'd MMM')}`
}

export function safeFormatDate(value: string, fmt: string): string {
  const ts = parseTimestamp(value)
  return ts ? format(ts, fmt) : value
}

export function safeRelativeDate(value: string): string {
  const ts = parseTimestamp(value)
  return ts ? formatDistanceToNow(ts, { addSuffix: true }) : value
}

export function relativeSessionAge(value?: string): string | null {
  const ts = parseTimestamp(value)
  return ts ? formatDistanceToNowStrict(ts, { addSuffix: false }) : null
}
