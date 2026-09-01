import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BellRing, CheckCheck, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/domain/EmptyState'
import {
  useAlertEvents,
  useAlertRules,
  useDeleteAlertRule,
  useMarkAllAlertsRead,
  useUpdateAlertRule,
} from '@/features/alerts/queries'
import { METRICS, OPS, type AlertEvent, type AlertRule } from '@/features/alerts/types'
import { useSymbols } from '@/features/markets/queries'
import { toast } from '@/lib/utils/toast'
import { cn } from '@/lib/utils/cn'
import { number } from '@/lib/utils/format'
import { AlertRuleDialog } from './AlertRuleDialog'

type Tab = 'rules' | 'events'

export default function Alerts() {
  const [tab, setTab] = useState<Tab>('rules')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)

  const rules = useAlertRules()
  const events = useAlertEvents()
  const symbols = useSymbols()
  const update = useUpdateAlertRule()
  const remove = useDeleteAlertRule()
  const markAllRead = useMarkAllAlertsRead()

  const onToggleRule = async (rule: AlertRule) => {
    try {
      await update.mutateAsync({ id: rule.id, enabled: !rule.enabled })
      toast.success(rule.enabled ? 'Rule paused' : 'Rule armed')
    } catch (err) {
      toast.fromError(err, 'Couldn’t update rule')
    }
  }

  const onDeleteRule = async (rule: AlertRule) => {
    try {
      await remove.mutateAsync(rule.id)
      toast.success('Rule removed')
    } catch (err) {
      toast.fromError(err, 'Couldn’t remove rule')
    }
  }

  const onMarkAllRead = async () => {
    try {
      await markAllRead.mutateAsync()
      toast.success('All alerts marked as read')
    } catch (err) {
      toast.fromError(err, 'Couldn’t mark all read')
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
          <p className="text-sm text-foreground-muted">
            Up to 20 rules. Each fires once when its condition is met, then auto-pauses.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'events' && (events.data?.unreadCount ?? 0) > 0 && (
            <Button variant="outline" onClick={onMarkAllRead} disabled={markAllRead.isPending}>
              <CheckCheck className="size-4" />
              Mark all read
            </Button>
          )}
          {tab === 'rules' && (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              New alert
            </Button>
          )}
        </div>
      </header>

      <div role="tablist" aria-label="Alerts view" className="inline-flex rounded-md border border-border bg-surface p-0.5">
        <TabButton active={tab === 'rules'} onClick={() => setTab('rules')}>
          Rules
          {rules.data && (
            <span className="ml-1.5 rounded bg-secondary px-1 text-[10px] tabular text-foreground-muted">
              {rules.data.length}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === 'events'} onClick={() => setTab('events')}>
          Events
          {(events.data?.unreadCount ?? 0) > 0 && (
            <span className="ml-1.5 rounded bg-primary px-1 text-[10px] tabular text-primary-foreground">
              {events.data!.unreadCount}
            </span>
          )}
        </TabButton>
      </div>

      {tab === 'rules' ? (
        <RulesPanel
          rules={rules.data}
          loading={rules.isLoading}
          error={rules.error as Error | null}
          onAdd={() => setDialogOpen(true)}
          onEdit={(r) => setEditing(r)}
          onToggle={onToggleRule}
          onDelete={onDeleteRule}
        />
      ) : (
        <EventsPanel events={events.data?.events} loading={events.isLoading} error={events.error as Error | null} />
      )}

      <AlertRuleDialog
        open={dialogOpen || Boolean(editing)}
        onOpenChange={(o) => {
          if (!o) {
            setDialogOpen(false)
            setEditing(null)
          }
        }}
        rule={editing}
        symbols={symbols.data}
      />
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function RulesPanel({
  rules,
  loading,
  error,
  onAdd,
  onEdit,
  onToggle,
  onDelete,
}: {
  rules?: AlertRule[]
  loading: boolean
  error: Error | null
  onAdd: () => void
  onEdit: (r: AlertRule) => void
  onToggle: (r: AlertRule) => void
  onDelete: (r: AlertRule) => void
}) {
  return (
    <Card className="overflow-hidden">
      {error ? (
        <EmptyState title="Couldn't load rules" description={error.message} className="m-3" />
      ) : loading ? (
        <SkeletonRows />
      ) : !rules?.length ? (
        <EmptyState
          icon={BellRing}
          title="No alert rules yet"
          description="Set a threshold on price, RSI, or % change and we'll ping you the moment it's hit."
          action={
            <Button onClick={onAdd}>
              <Plus className="size-4" />
              New alert
            </Button>
          }
          className="m-4"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Symbol</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead className="text-right">Fired</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="font-medium">
                  <Link to={`/markets/${encodeURIComponent(rule.symbol)}`} className="hover:text-primary">
                    {rule.symbol}
                  </Link>
                </TableCell>
                <TableCell className="text-foreground-muted">
                  <ConditionLabel rule={rule} />
                </TableCell>
                <TableCell className="text-right tabular text-foreground-muted">
                  {rule.fireCount}
                  {rule.lastFiredAt && (
                    <span className="ml-1.5 text-[11px] text-foreground-subtle">
                      · {safeRelative(rule.lastFiredAt)}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusPill enabled={rule.enabled} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onToggle(rule)} aria-label={rule.enabled ? 'Pause' : 'Arm'}>
                      {rule.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(rule)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(rule)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Delete"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}

function EventsPanel({ events, loading, error }: { events?: AlertEvent[]; loading: boolean; error: Error | null }) {
  return (
    <Card className="overflow-hidden">
      {error ? (
        <EmptyState title="Couldn't load events" description={error.message} className="m-3" />
      ) : loading ? (
        <SkeletonRows />
      ) : !events?.length ? (
        <EmptyState
          icon={BellRing}
          title="No fires yet"
          description="When one of your rules trips, it'll show up here with the observed value."
          className="m-4"
        />
      ) : (
        <ul className="divide-y divide-border">
          {events.map((ev) => (
            <li key={ev.id} className="flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  ev.readAt ? 'bg-foreground-subtle' : 'bg-primary',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <Link to={`/markets/${encodeURIComponent(ev.symbol)}`} className="font-medium hover:text-primary">
                    {ev.symbol}
                  </Link>{' '}
                  <span className="text-foreground-muted">
                    {METRICS.find((m) => m.value === ev.metric)?.label ?? ev.metric}{' '}
                    {OPS.find((o) => o.value === ev.op)?.label ?? ev.op}{' '}
                  </span>
                  <span className="tabular text-foreground">{number(ev.threshold)}</span>
                  <span className="text-foreground-muted"> · observed </span>
                  <span className="tabular text-foreground">{number(ev.observedValue)}</span>
                </p>
                <p className="mt-1 text-[11px] text-foreground-subtle">
                  {safeRelative(ev.firedAt)} · {safeFormat(ev.firedAt, 'PPpp')}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ConditionLabel({ rule }: { rule: AlertRule }) {
  const metric = METRICS.find((m) => m.value === rule.metric)?.label ?? rule.metric
  const op = OPS.find((o) => o.value === rule.op)?.label ?? rule.op
  return (
    <span className="text-sm">
      {metric} <span className="text-foreground-subtle">{op}</span>{' '}
      <span className="tabular text-foreground">{number(rule.threshold)}</span>
      {rule.metric === 'pct_change' ? '%' : ''}
    </span>
  )
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
        enabled
          ? 'border-gain/30 bg-gain/10 text-gain'
          : 'border-border bg-surface text-foreground-subtle',
      )}
    >
      <span className={cn('size-1.5 rounded-full', enabled ? 'bg-gain' : 'bg-foreground-subtle')} />
      {enabled ? 'Armed' : 'Paused'}
    </span>
  )
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-3 py-3">
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-40 animate-pulse rounded bg-secondary/70" />
          <div className="ml-auto h-4 w-12 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  )
}

function safeFormat(iso: string, fmt: string): string {
  try {
    return format(parseISO(iso), fmt)
  } catch {
    return iso
  }
}
function safeRelative(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true })
  } catch {
    return iso
  }
}
