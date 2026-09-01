import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Link } from 'react-router-dom'
import { Bell, BellOff, CheckCheck, X } from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Button } from '@/components/ui/button'
import { useAlertEvents, useMarkAlertEventRead, useMarkAllAlertsRead } from '@/features/alerts/queries'
import { useEntitlements } from '@/features/auth/entitlements'
import { useWsEvent } from '@/lib/ws/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { alertKeys } from '@/features/alerts/queries'
import { METRICS, OPS } from '@/features/alerts/types'
import type { AlertEvent } from '@/features/alerts/types'
import { toast } from '@/lib/utils/toast'
import { cn } from '@/lib/utils/cn'
import { number } from '@/lib/utils/format'

/**
 * Alerts drawer mounted off the topbar bell.
 *
 * Visible only to Pro/Admin (alert events are pro-gated). Non-pro users
 * see a non-interactive bell with no badge — keeping the topbar consistent
 * across roles.
 */
export function AlertsDrawer() {
  const { isPro } = useEntitlements()
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()

  const events = useAlertEvents({ enabled: isPro })
  const markRead = useMarkAlertEventRead()
  const markAll = useMarkAllAlertsRead()

  // Live cache invalidation when a new alert fires over the WebSocket.
  useWsEvent('alert:fire', () => {
    qc.invalidateQueries({ queryKey: alertKeys.all })
  })

  const unread = events.data?.unreadCount ?? 0
  const items = events.data?.events ?? []

  if (!isPro) {
    return (
      <Button variant="ghost" size="icon" disabled aria-label="Alerts (Pro feature)">
        <BellOff className="size-4 opacity-50" />
      </Button>
    )
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Alerts ${unread ? `(${unread} unread)` : ''}`}>
          <span className="relative inline-flex">
            <Bell className="size-4" />
            {unread > 0 && (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border-2 border-background bg-loss text-[8px] font-bold text-loss-foreground"
              >
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </span>
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-overlay=""
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        />
        <DialogPrimitive.Content
          data-dialog-content=""
          className={cn(
            'fixed right-0 top-0 z-50 flex h-dvh w-full max-w-md flex-col border-l border-border bg-surface shadow-[var(--shadow-lg)]',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
          )}
          style={{ animationDuration: '180ms' }}
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold tracking-tight">Alerts</DialogPrimitive.Title>
            <div className="flex items-center gap-1">
              {unread > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await markAll.mutateAsync()
                      toast.success('All marked as read')
                    } catch (err) {
                      toast.fromError(err)
                    }
                  }}
                  disabled={markAll.isPending}
                >
                  <CheckCheck className="size-4" />
                  Mark all
                </Button>
              )}
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close">
                  <X className="size-4" />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            {events.error ? (
              <div className="p-6 text-sm text-foreground-muted">
                Couldn't load alerts. {(events.error as Error).message}
              </div>
            ) : events.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded bg-secondary" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                <Bell className="size-6 text-foreground-subtle" />
                <p className="text-sm font-medium">No alerts yet</p>
                <p className="max-w-xs text-xs text-foreground-muted">
                  Create a rule on the Alerts page and we'll show every fire here.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-2" onClick={() => setOpen(false)}>
                  <Link to="/alerts">Manage rules</Link>
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((ev) => (
                  <EventRow
                    key={ev.id}
                    event={ev}
                    onMarkRead={async () => {
                      if (ev.readAt) return
                      try {
                        await markRead.mutateAsync(ev.id)
                      } catch {
                        /* silent — the cache is invalidated either way */
                      }
                    }}
                    onNavigate={() => setOpen(false)}
                  />
                ))}
              </ul>
            )}
          </div>

          <footer className="border-t border-border px-4 py-3 text-right">
            <Button asChild variant="ghost" size="sm" onClick={() => setOpen(false)}>
              <Link to="/alerts">Manage rules →</Link>
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function EventRow({
  event,
  onMarkRead,
  onNavigate,
}: {
  event: AlertEvent
  onMarkRead: () => void
  onNavigate: () => void
}) {
  const isUnread = !event.readAt
  return (
    <li className={cn('px-4 py-3 transition-colors', isUnread && 'bg-primary/5')}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            isUnread ? 'bg-primary' : 'bg-foreground-subtle',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <Link
              to={`/markets/${encodeURIComponent(event.symbol)}`}
              onClick={onNavigate}
              className="font-medium hover:text-primary"
            >
              {event.symbol}
            </Link>{' '}
            <span className="text-foreground-muted">
              {METRICS.find((m) => m.value === event.metric)?.label ?? event.metric}{' '}
              {OPS.find((o) => o.value === event.op)?.label ?? event.op}{' '}
            </span>
            <span className="tabular text-foreground">{number(event.threshold)}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-foreground-subtle tabular">
            Observed {number(event.observedValue)} · {safeRelative(event.firedAt)}
          </p>
        </div>
        {isUnread && (
          <button
            type="button"
            onClick={onMarkRead}
            className="text-[11px] text-foreground-muted hover:text-foreground"
          >
            Mark read
          </button>
        )}
      </div>
    </li>
  )
}

function safeRelative(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true })
  } catch {
    return iso
  }
}
