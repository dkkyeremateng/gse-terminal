import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  KeyRound,
  Loader2,
  Lock,
  RefreshCcw,
  Search,
  Trash2,
  Unlock,
  UserCog,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/domain/EmptyState'
import {
  useAdminDeleteUser,
  useAdminResetUserPassword,
  useAdminToggleUserLock,
  useAdminUpdateUserRole,
  useAdminUsers,
} from '@/features/admin/queries'
import { ADMIN_ROLES, type AdminUser } from '@/features/admin/types'
import { useUser } from '@/features/auth/store'
import { ApiError } from '@/lib/api/client'
import { toast } from '@/lib/utils/toast'
import { cn } from '@/lib/utils/cn'

export function UsersTab() {
  const users = useAdminUsers()
  const me = useUser()
  const updateRole = useAdminUpdateUserRole()
  const toggleLock = useAdminToggleUserLock()
  const deleteUser = useAdminDeleteUser()
  const [resetting, setResetting] = useState<AdminUser | null>(null)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    const list = users.data ?? []
    if (!q) return list
    return list.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q) ||
        String(u.id).includes(q),
    )
  }, [users.data, q])

  const handleRoleChange = async (user: AdminUser, role: string) => {
    if (role === user.role) return
    try {
      await updateRole.mutateAsync({ id: user.id, role })
      toast.success(`${user.username} → ${role}`)
    } catch (err) {
      toast.fromError(err, 'Couldn’t change role')
    }
  }

  const handleLock = async (user: AdminUser) => {
    try {
      await toggleLock.mutateAsync({ id: user.id, locked: !user.is_locked })
      toast.success(user.is_locked ? `Unlocked ${user.username}` : `Locked ${user.username}`)
    } catch (err) {
      toast.fromError(err, 'Couldn’t change lock state')
    }
  }

  const handleDelete = async (user: AdminUser) => {
    if (!window.confirm(`Permanently delete ${user.username}? This cannot be undone.`)) return
    try {
      await deleteUser.mutateAsync(user.id)
      toast.success(`Deleted ${user.username}`)
    } catch (err) {
      toast.fromError(err, 'Couldn’t delete user')
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm">
          <UserCog className="size-4 text-foreground-muted" />
          Identity Manager
        </CardTitle>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex min-w-50 items-center gap-1.5 rounded-md border border-border bg-surface px-2">
            <Search className="size-3.5 text-foreground-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by username, role, id…"
              className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
              aria-label="Filter users"
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => users.refetch()} disabled={users.isFetching}>
            <RefreshCcw className={cn('size-3.5', users.isFetching && 'animate-spin')} />
            Refresh
          </Button>
          <span className="text-[11px] tabular text-foreground-subtle">
            {filtered.length}
            {q && users.data ? ` / ${users.data.length}` : ''}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {users.error ? (
          <EmptyState title="Couldn't load users" description={(users.error as Error).message} className="m-3" />
        ) : users.isLoading ? (
          <SkeletonRows rows={6} />
        ) : filtered.length === 0 ? (
          <EmptyState title={q ? 'No matching users' : 'No users yet'} className="m-4" />
        ) : (
          <Table wrapperClassName="max-h-[560px]">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-12">ID</TableHead>
                <TableHead>Username</TableHead>
                <TableHead className="w-36">Role</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-28 text-right" aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((user) => {
                const isMe = !!me?.username && me.username === user.username
                return (
                  <TableRow key={user.id}>
                    <TableCell className="tabular text-foreground-subtle">{user.id}</TableCell>
                    <TableCell className="font-medium">
                      {user.username}
                      {isMe && (
                        <span className="ml-1.5 rounded-full border border-border bg-surface px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-foreground-subtle">
                          you
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <RoleSelect
                        value={user.role}
                        disabled={updateRole.isPending}
                        onChange={(role) => handleRoleChange(user, role)}
                      />
                    </TableCell>
                    <TableCell>
                      {user.role === 'admin' ? (
                        <span className="inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground-subtle">
                          Immune
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleLock(user)}
                          disabled={toggleLock.isPending}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
                            user.is_locked
                              ? 'border-loss/30 bg-loss/10 text-loss hover:bg-loss/15'
                              : 'border-gain/30 bg-gain/10 text-gain hover:bg-gain/15',
                          )}
                          aria-label={user.is_locked ? `Unlock ${user.username}` : `Lock ${user.username}`}
                        >
                          {user.is_locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                          {user.is_locked ? 'Locked' : 'Active'}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-[11px] text-foreground-subtle">
                      {safeRelative(user.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setResetting(user)}
                        className="text-foreground-subtle hover:text-foreground"
                        aria-label={`Reset password for ${user.username}`}
                      >
                        <KeyRound className="size-4" />
                      </Button>
                      {user.role !== 'admin' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(user)}
                          disabled={deleteUser.isPending}
                          className="text-foreground-subtle hover:text-loss"
                          aria-label={`Delete ${user.username}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {resetting && (
        <PasswordResetDialog user={resetting} onClose={() => setResetting(null)} />
      )}
    </Card>
  )
}

function RoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled?: boolean
  onChange: (role: string) => void
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-8 w-full rounded-md border border-input bg-surface px-2 text-xs font-medium uppercase tracking-wider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      aria-label="Role"
    >
      {ADMIN_ROLES.includes(value) ? null : <option value={value}>{value}</option>}
      {ADMIN_ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  )
}

function PasswordResetDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const reset = useAdminResetUserPassword()
  const form = useForm<{ password: string }>({ defaultValues: { password: '' } })

  const onSubmit = async ({ password }: { password: string }) => {
    try {
      await reset.mutateAsync({ id: user.id, password })
      toast.success(`Reset password for ${user.username}`)
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t reset password')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 p-5">
          <div className="space-y-1.5">
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for <span className="font-medium text-foreground">{user.username}</span>. They’ll need
              to use it on next sign-in.
            </DialogDescription>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              {...form.register('password', { required: true, minLength: 8 })}
              placeholder="At least 8 characters"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={reset.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={reset.isPending}>
              {reset.isPending && <Loader2 className="size-4 animate-spin" />}
              Update password
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-4 w-8 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-24 animate-pulse rounded bg-secondary" />
          <div className="ml-auto h-7 w-28 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-20 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  )
}

function safeRelative(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true })
  } catch {
    return iso
  }
}
