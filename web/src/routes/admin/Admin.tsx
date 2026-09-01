import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useSearchParams } from 'react-router-dom'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  BellRing,
  CheckCircle2,
  ClipboardList,
  Database,
  ExternalLink,
  Loader2,
  RefreshCcw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  UserCog,
  XCircle,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/domain/EmptyState'
import {
  useAdminAlertEvents,
  useAdminAlertRules,
  useAdminAlertStats,
  useAdminDeleteAlertRule,
  useAdminProRequests,
  useDecideProRequest,
} from '@/features/admin/queries'
import type {
  AdminAlertEventRow,
  AdminAlertRuleRow,
  AdminProRequest,
  AlertMetric,
  DecideProRequestInput,
} from '@/features/admin/types'
import { UsersTab } from '@/components/admin/UsersTab'
import { AuditLogTab } from '@/components/admin/AuditLogTab'
import { IngestionTab } from '@/components/admin/IngestionTab'
import { ApiError } from '@/lib/api/client'
import { toast } from '@/lib/utils/toast'
import { cn } from '@/lib/utils/cn'

type Tab = 'pro-requests' | 'alerts' | 'users' | 'audit' | 'ingestion'

const TAB_VALUES: Tab[] = ['pro-requests', 'alerts', 'users', 'audit', 'ingestion']

const TABS: { value: Tab; label: string; icon: typeof Sparkles }[] = [
  { value: 'ingestion', label: 'Ingestion', icon: Database },
  { value: 'users', label: 'Users', icon: UserCog },
  { value: 'audit', label: 'Audit log', icon: ClipboardList },
  { value: 'alerts', label: 'Watchlist alerts', icon: BellRing },
  { value: 'pro-requests', label: 'Pro requests', icon: Sparkles },
]

/**
 * Admin landing page — focuses on the JSON-clean admin surfaces:
 *   • Pro upgrade approval queue
 *   • Watchlist alerts (stats + rules + recent fires)
 *
 * The legacy /ui/admin keeps Users, Audit Log, CSV Ingestion, and
 * Sectors — those endpoints (`/v1/admin/users`, `/v1/admin/audit`,
 * `/v1/admin/sectors`) return HTML for HTMX, not JSON, so they live
 * outside the SPA. The "Legacy admin" link in the header reaches them.
 */
export default function Admin() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab') as Tab | null
  const tab: Tab = raw && TAB_VALUES.includes(raw) ? raw : 'pro-requests'
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params)
    if (next === 'pro-requests') p.delete('tab')
    else p.set('tab', next)
    setParams(p, { replace: true })
  }

  const proRequests = useAdminProRequests()
  const pendingCount = (proRequests.data ?? []).filter((r) => r.status === 'pending').length

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Shield className="size-5 text-accent" />
            Admin
          </h1>
          <p className="text-sm text-foreground-muted">
            Pro queue, identity, audit, alerts, and CSV ingestion. Sector taxonomy edits still live in the legacy portal.
          </p>
        </div>
        <Button asChild variant="outline">
          <a href="/admin" target="_blank" rel="noopener">
            <ExternalLink className="size-4" />
            Legacy admin
          </a>
        </Button>
      </header>

      <SectionNav tab={tab} onChange={setTab} pendingCount={pendingCount} />

      {tab === 'pro-requests' && <ProRequestsTab requests={proRequests} />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'audit' && <AuditLogTab />}
      {tab === 'ingestion' && <IngestionTab />}
    </div>
  )
}

function SectionNav({
  tab,
  onChange,
  pendingCount,
}: {
  tab: Tab
  onChange: (t: Tab) => void
  pendingCount: number
}) {
  return (
    <nav role="tablist" aria-label="Admin sections" className="inline-flex flex-wrap gap-0.5 rounded-md border border-border bg-surface p-0.5">
      {TABS.map((t) => {
        const active = tab === t.value
        const showBadge = t.value === 'pro-requests' && pendingCount > 0
        const Icon = t.icon
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors',
              active ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {t.label}
            {showBadge && (
              <span className="rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-semibold tabular text-accent">
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}

// ── Pro Requests tab ──────────────────────────────────────────────────────

function ProRequestsTab({ requests }: { requests: ReturnType<typeof useAdminProRequests> }) {
  const [reviewing, setReviewing] = useState<{ request: AdminProRequest; decision: 'approve' | 'deny' } | null>(null)
  const pending = (requests.data ?? []).filter((r) => r.status === 'pending')
  const decided = (requests.data ?? []).filter((r) => r.status !== 'pending')

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="size-4 text-accent" />
            Pending Pro requests
          </CardTitle>
          <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] tabular text-foreground-muted">
            {pending.length} pending
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {requests.error ? (
            <EmptyState title="Couldn't load queue" description={(requests.error as Error).message} className="m-3" />
          ) : requests.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded bg-secondary/40" />
              ))}
            </div>
          ) : pending.length === 0 ? (
            <EmptyState title="Inbox zero" description="No pending Pro requests right now." className="m-4" />
          ) : (
            <ul className="divide-y divide-border">
              {pending.map((req) => (
                <RequestRow
                  key={req.id}
                  request={req}
                  onApprove={() => setReviewing({ request: req, decision: 'approve' })}
                  onDeny={() => setReviewing({ request: req, decision: 'deny' })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {decided.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-sm">Recently decided</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {decided.slice(0, 10).map((req) => (
                <DecidedRow key={req.id} request={req} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {reviewing && (
        <DecideDialog
          request={reviewing.request}
          decision={reviewing.decision}
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  )
}

function RequestRow({
  request,
  onApprove,
  onDeny,
}: {
  request: AdminProRequest
  onApprove: () => void
  onDeny: () => void
}) {
  return (
    <li className="flex flex-wrap items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{request.username}</p>
        <p className="mt-0.5 text-[11px] text-foreground-subtle">
          Submitted {safeRelative(request.createdAt)} · #{request.id}
        </p>
        {request.reason && (
          <blockquote className="mt-2 border-l-2 border-border bg-surface px-3 py-1.5 text-sm leading-relaxed text-foreground">
            {request.reason}
          </blockquote>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onDeny}>
          <XCircle className="size-4" />
          Deny
        </Button>
        <Button size="sm" onClick={onApprove}>
          <CheckCircle2 className="size-4" />
          Approve
        </Button>
      </div>
    </li>
  )
}

function DecidedRow({ request }: { request: AdminProRequest }) {
  const isApproved = request.status === 'approved'
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
          isApproved ? 'border-gain/30 bg-gain/10 text-gain' : 'border-loss/30 bg-loss/10 text-loss',
        )}
      >
        {isApproved ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
        {isApproved ? 'Approved' : 'Denied'}
      </span>
      <span className="font-medium">{request.username}</span>
      <span className="text-foreground-muted">
        {request.decidedAt ? safeRelative(request.decidedAt) : ''}
        {request.decidedByUsername ? ` · by ${request.decidedByUsername}` : ''}
      </span>
      {request.adminNote && <span className="ml-auto text-xs text-foreground-subtle">“{request.adminNote}”</span>}
    </li>
  )
}

function DecideDialog({
  request,
  decision,
  onClose,
}: {
  request: AdminProRequest
  decision: 'approve' | 'deny'
  onClose: () => void
}) {
  const decide = useDecideProRequest()
  const form = useForm<DecideProRequestInput>({ defaultValues: { decision, note: '' } })

  const onSubmit = async (values: DecideProRequestInput) => {
    try {
      await decide.mutateAsync({ id: request.id, decision, note: values.note?.trim() || undefined })
      toast.success(decision === 'approve' ? `${request.username} promoted to Pro` : `Denied ${request.username}`)
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t complete decision')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 p-5">
          <div className="space-y-1.5">
            <DialogTitle>{decision === 'approve' ? 'Approve Pro request' : 'Deny Pro request'}</DialogTitle>
            <DialogDescription>
              {decision === 'approve'
                ? `${request.username} will be promoted to Pro and unlocked across the app.`
                : `${request.username} stays on the basic tier. They'll see your note and can resubmit.`}
            </DialogDescription>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note">
              Note {decision === 'deny' && <span className="text-foreground-subtle">(recommended)</span>}
            </Label>
            <textarea
              id="note"
              rows={3}
              {...form.register('note')}
              placeholder={decision === 'approve' ? 'Optional — visible to the user' : 'Brief reason — visible to the user'}
              className="block w-full resize-y rounded-md border border-input bg-surface px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              maxLength={500}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={decide.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant={decision === 'deny' ? 'destructive' : 'default'} disabled={decide.isPending}>
              {decide.isPending && <Loader2 className="size-4 animate-spin" />}
              {decision === 'approve' ? 'Approve' : 'Deny'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Watchlist Alerts tab ─────────────────────────────────────────────────

function AlertsTab() {
  const stats = useAdminAlertStats()
  const rules = useAdminAlertRules()
  const events = useAdminAlertEvents()
  const deleteRule = useAdminDeleteAlertRule()
  const [query, setQuery] = useState('')

  const refresh = () => {
    stats.refetch()
    rules.refetch()
    events.refetch()
  }

  const refreshing = stats.isFetching || rules.isFetching || events.isFetching

  // Single shared filter — same UX as the /ui legacy panel where one input
  // narrows both the rules table and the recent fires below it.
  const q = query.trim().toLowerCase()
  const filteredRules = useMemo(() => {
    if (!q) return rules.data ?? []
    return (rules.data ?? []).filter((r) => matchesRule(r, q))
  }, [rules.data, q])
  const filteredEvents = useMemo(() => {
    if (!q) return events.data ?? []
    return (events.data ?? []).filter((e) => matchesEvent(e, q))
  }, [events.data, q])

  const handleDelete = async (rule: AdminAlertRuleRow) => {
    const owner = rule.username || `user #${rule.userId}`
    if (!window.confirm(`Delete alert rule for ${rule.symbol} (owner: ${owner})?\nThis cannot be undone.`)) return
    try {
      await deleteRule.mutateAsync(rule.id)
      toast.success(`Deleted rule for ${rule.symbol}`)
    } catch (err) {
      toast.fromError(err, 'Couldn’t delete rule')
    }
  }

  return (
    <div className="space-y-5">
      {/* Stat strip — mirrors the /ui admin's 5-card layout. */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total rules" value={stats.data?.totalRules} loading={stats.isLoading} />
        <StatCard
          label="Armed"
          value={stats.data?.activeRules}
          loading={stats.isLoading}
          tone="gain"
        />
        <StatCard label="Unique users" value={stats.data?.usersWithRule} loading={stats.isLoading} tone="accent" />
        <StatCard label="Fires today" value={stats.data?.firesToday} loading={stats.isLoading} tone="loss" />
        <StatCard label="Fires last 7d" value={stats.data?.firesThisWeek} loading={stats.isLoading} />
      </section>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 border-b border-border">
          <CardTitle className="text-sm">Rules</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex min-w-50 items-center gap-1.5 rounded-md border border-border bg-surface px-2">
              <Search className="size-3.5 text-foreground-subtle" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by symbol, user, metric…"
                className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                aria-label="Filter alerts"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCcw className={cn('size-3.5', refreshing && 'animate-spin')} />
              Refresh
            </Button>
            <span className="text-[11px] tabular text-foreground-subtle">
              {filteredRules.length}
              {q && rules.data ? ` / ${rules.data.length}` : ''}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {rules.error ? (
            <EmptyState title="Couldn't load rules" description={(rules.error as Error).message} className="m-3" />
          ) : rules.isLoading ? (
            <SkeletonRows rows={6} />
          ) : filteredRules.length === 0 ? (
            <EmptyState
              title={q ? 'No matching rules' : 'No alert rules yet'}
              description={q ? 'Try a different filter.' : 'Users haven’t armed any alerts.'}
              className="m-4"
            />
          ) : (
            <Table wrapperClassName="max-h-[480px]">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Symbol</TableHead>
                  <TableHead>Metric</TableHead>
                  <TableHead>Predicate</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Last fired</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="w-9 text-right" aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">{rule.symbol}</TableCell>
                    <TableCell className="text-foreground-muted">{metricLabel(rule.metric)}</TableCell>
                    <TableCell className="tabular text-foreground-muted">
                      {rule.op} {fmtAlertValue(rule.metric, rule.threshold)}
                    </TableCell>
                    <TableCell className="text-foreground-muted">
                      {rule.username || (
                        <span className="italic text-foreground-subtle">user #{rule.userId}</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-[11px] text-foreground-subtle">
                      {rule.lastFiredAt ? safeRelative(rule.lastFiredAt) : '—'}
                      {rule.fireCount > 0 && (
                        <span className="ml-1 text-foreground-muted">· {rule.fireCount}×</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StateBadge enabled={rule.enabled} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(rule)}
                        disabled={deleteRule.isPending}
                        className="text-foreground-subtle hover:text-loss"
                        aria-label={`Delete rule for ${rule.symbol}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
          <CardTitle className="text-sm">Recent fires</CardTitle>
          <span className="text-[11px] tabular text-foreground-subtle">
            {filteredEvents.length}
            {q && events.data ? ` / ${events.data.length}` : ''}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {events.error ? (
            <EmptyState title="Couldn't load events" description={(events.error as Error).message} className="m-3" />
          ) : events.isLoading ? (
            <SkeletonRows rows={5} />
          ) : filteredEvents.length === 0 ? (
            <EmptyState
              title={q ? 'No matching fires' : 'No alerts have fired yet'}
              className="m-4"
            />
          ) : (
            <Table wrapperClassName="max-h-[420px]">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead>When</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Metric</TableHead>
                  <TableHead>Observed</TableHead>
                  <TableHead>Predicate</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEvents.slice(0, 100).map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="tabular text-[11px] text-foreground-subtle">
                      {safeRelative(ev.firedAt)}
                    </TableCell>
                    <TableCell className="font-medium">{ev.symbol}</TableCell>
                    <TableCell className="text-foreground-muted">{metricLabel(ev.metric)}</TableCell>
                    <TableCell className="tabular text-accent">
                      {fmtAlertValue(ev.metric, ev.observedValue)}
                    </TableCell>
                    <TableCell className="tabular text-foreground-muted">
                      {ev.op} {fmtAlertValue(ev.metric, ev.threshold)}
                    </TableCell>
                    <TableCell className="text-foreground-muted">
                      {ev.username || (
                        <span className="italic text-foreground-subtle">user #{ev.userId}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  label,
  value,
  loading,
  tone = 'default',
}: {
  label: string
  value?: number
  loading: boolean
  tone?: 'default' | 'gain' | 'loss' | 'accent'
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p
        className={cn(
          'mt-1 text-xl font-semibold tabular',
          tone === 'gain' && 'text-gain',
          tone === 'loss' && 'text-loss',
          tone === 'accent' && 'text-accent',
        )}
      >
        {loading ? <span className="inline-block h-5 w-12 animate-pulse rounded bg-secondary/60" /> : value?.toLocaleString() ?? '—'}
      </p>
    </div>
  )
}

function StateBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        enabled
          ? 'border-gain/30 bg-gain/10 text-gain'
          : 'border-border bg-surface text-foreground-subtle',
      )}
    >
      {enabled ? 'Armed' : 'Paused'}
    </span>
  )
}

function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-12 animate-pulse rounded bg-secondary" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-24 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  )
}

// ── Format / filter helpers ──────────────────────────────────────────────

function metricLabel(metric: AlertMetric | string): string {
  switch (metric) {
    case 'pct_change':
      return '% Chg'
    case 'rsi':
      return 'RSI 14'
    case 'price':
      return 'Price'
    default:
      return String(metric).toUpperCase()
  }
}

function fmtAlertValue(metric: AlertMetric | string, v: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  switch (metric) {
    case 'price':
      return `GH¢${v.toFixed(2)}`
    case 'pct_change':
      return `${v.toFixed(2)}%`
    case 'rsi':
      return v.toFixed(1)
    default:
      return v.toFixed(4)
  }
}

function matchesRule(r: AdminAlertRuleRow, q: string): boolean {
  return (
    r.symbol.toLowerCase().includes(q) ||
    (r.username ?? '').toLowerCase().includes(q) ||
    r.metric.toLowerCase().includes(q) ||
    `user #${r.userId}`.includes(q)
  )
}

function matchesEvent(e: AdminAlertEventRow, q: string): boolean {
  return (
    e.symbol.toLowerCase().includes(q) ||
    (e.username ?? '').toLowerCase().includes(q) ||
    e.metric.toLowerCase().includes(q) ||
    `user #${e.userId}`.includes(q)
  )
}

function safeRelative(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true })
  } catch {
    return iso
  }
}
