import { useMemo, useState } from 'react'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { ClipboardList, RefreshCcw, Search } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/domain/EmptyState'
import { useAdminAuditLog } from '@/features/admin/queries'
import type { AdminAuditEntry } from '@/features/admin/types'
import { cn } from '@/lib/utils/cn'

type Category = 'user' | 'data' | 'auth' | 'key' | 'fail' | 'other'

export function AuditLogTab() {
  const audit = useAdminAuditLog(200)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    const list = audit.data ?? []
    if (!q) return list
    return list.filter((e) =>
      [e.action, e.actorUsername, e.targetType, e.targetId, e.metadata]
        .some((v) => (v ?? '').toLowerCase().includes(q)),
    )
  }, [audit.data, q])

  const stats = useMemo(() => computeStats(audit.data ?? []), [audit.data])

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total entries" value={stats.total} loading={audit.isLoading} />
        <StatCard label="User actions" value={stats.userActions} loading={audit.isLoading} tone="accent" />
        <StatCard label="Auth events" value={stats.authEvents} loading={audit.isLoading} tone="gain" />
        <StatCard label="Latest activity" value={stats.latest} loading={audit.isLoading} small />
      </section>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClipboardList className="size-4 text-foreground-muted" />
            Audit log
          </CardTitle>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex min-w-50 items-center gap-1.5 rounded-md border border-border bg-surface px-2">
              <Search className="size-3.5 text-foreground-subtle" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by actor, action, target…"
                className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                aria-label="Filter audit log"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => audit.refetch()} disabled={audit.isFetching}>
              <RefreshCcw className={cn('size-3.5', audit.isFetching && 'animate-spin')} />
              Refresh
            </Button>
            <span className="text-[11px] tabular text-foreground-subtle">
              {filtered.length}
              {q && audit.data ? ` / ${audit.data.length}` : ''}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {audit.error ? (
            <EmptyState title="Couldn't load audit log" description={(audit.error as Error).message} className="m-3" />
          ) : audit.isLoading ? (
            <SkeletonRows rows={6} />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={q ? 'No matching entries' : 'No audit entries yet'}
              description={q ? 'Try a different filter.' : 'Administrative actions will appear here.'}
              className="m-4"
            />
          ) : (
            <Table wrapperClassName="max-h-[640px]">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-44">When</TableHead>
                  <TableHead className="w-40">Actor</TableHead>
                  <TableHead className="w-44">Action</TableHead>
                  <TableHead>Target / Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AuditRow({ entry }: { entry: AdminAuditEntry }) {
  const cat = auditCategory(entry.action)
  const initial = entry.actorUsername ? entry.actorUsername.slice(0, 1).toUpperCase() : ''
  return (
    <TableRow>
      <TableCell className="tabular text-[11px] text-foreground-subtle">
        <div title={safeFmt(entry.createdAt, 'yyyy-MM-dd HH:mm:ss')}>
          {safeRelative(entry.createdAt)}
        </div>
      </TableCell>
      <TableCell>
        {entry.actorUsername ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex size-5 items-center justify-center rounded bg-accent/15 text-[10px] font-bold text-accent">
              {initial}
            </span>
            <span className="text-sm font-medium">{entry.actorUsername}</span>
          </span>
        ) : (
          <span className="italic text-foreground-subtle">system</span>
        )}
      </TableCell>
      <TableCell>
        <span
          className={cn(
            'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
            cat === 'user' && 'border-accent/30 bg-accent/10 text-accent',
            cat === 'data' && 'border-primary/30 bg-primary/10 text-primary',
            cat === 'auth' && 'border-gain/30 bg-gain/10 text-gain',
            cat === 'key' && 'border-border bg-surface text-foreground-muted',
            cat === 'fail' && 'border-loss/30 bg-loss/10 text-loss',
            cat === 'other' && 'border-border bg-surface text-foreground-muted',
          )}
        >
          {entry.action}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
          {(entry.targetType || entry.targetId) && (
            <span className="font-mono">
              {entry.targetType && (
                <span className="mr-1 text-[9px] font-bold uppercase tracking-wider text-foreground-subtle">
                  {entry.targetType}
                </span>
              )}
              <span className="text-foreground-muted">{entry.targetId || '—'}</span>
            </span>
          )}
          {entry.metadata && (
            <span
              className="max-w-full truncate rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-foreground-muted"
              title={entry.metadata}
            >
              {entry.metadata}
            </span>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function StatCard({
  label,
  value,
  loading,
  tone = 'default',
  small,
}: {
  label: string
  value: string | number
  loading: boolean
  tone?: 'default' | 'gain' | 'loss' | 'accent'
  small?: boolean
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p
        className={cn(
          'mt-1 font-semibold tabular',
          small ? 'text-sm' : 'text-xl',
          tone === 'gain' && 'text-gain',
          tone === 'loss' && 'text-loss',
          tone === 'accent' && 'text-accent',
        )}
      >
        {loading ? <span className="inline-block h-5 w-12 animate-pulse rounded bg-secondary/60" /> : value || '—'}
      </p>
    </div>
  )
}

function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-4 w-24 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-32 animate-pulse rounded bg-secondary" />
          <div className="ml-auto h-4 w-40 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  )
}

function auditCategory(action: string): Category {
  if (action.startsWith('user.')) return action === 'user.delete' ? 'fail' : 'user'
  if (action.startsWith('data.')) return 'data'
  if (action.startsWith('auth.')) return action.endsWith('failure') ? 'fail' : 'auth'
  if (action.startsWith('api_key.')) return 'key'
  if (action.startsWith('alert.')) return 'data'
  return 'other'
}

function computeStats(entries: AdminAuditEntry[]) {
  let userActions = 0
  let authEvents = 0
  for (const e of entries) {
    if (e.action.startsWith('user.')) userActions++
    if (e.action.startsWith('auth.')) authEvents++
  }
  const latest = entries[0]?.createdAt ? safeRelative(entries[0].createdAt) : '—'
  return { total: entries.length, userActions, authEvents, latest }
}

function safeRelative(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true })
  } catch {
    return iso
  }
}

function safeFmt(iso: string, pattern: string): string {
  try {
    return format(parseISO(iso), pattern)
  } catch {
    return iso
  }
}
