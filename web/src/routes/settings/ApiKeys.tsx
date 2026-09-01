import { useState } from 'react'
import { Check, Copy, Key, Loader2, Plus, Trash2 } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/domain/EmptyState'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useAPIKeys, useCreateAPIKey, useRevokeAPIKey } from '@/features/account/queries'
import type { APIKey, APIKeyWithSecret } from '@/features/account/types'
import { toast } from '@/lib/utils/toast'
import { ApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils/cn'

export default function ApiKeys() {
  const keys = useAPIKeys()
  const create = useCreateAPIKey()
  const revoke = useRevokeAPIKey()
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [revealed, setRevealed] = useState<APIKeyWithSecret | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState<APIKey | null>(null)

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      const created = await create.mutateAsync(name.trim())
      setRevealed(created)
      setName('')
      setCreateOpen(false)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t create API key')
    }
  }

  const onRevoke = async () => {
    if (!confirming) return
    try {
      await revoke.mutateAsync(confirming.id)
      toast.success('API key revoked')
      setConfirming(null)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t revoke API key')
    }
  }

  const copySecret = async () => {
    if (!revealed?.key) return
    try {
      await navigator.clipboard.writeText(revealed.key)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Copy failed — copy the value manually.')
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Key className="size-4 text-foreground-muted" />
              API keys
            </CardTitle>
            <CardDescription>
              Long-lived bearer tokens for programmatic access. The full secret is shown once at creation — store it
              somewhere safe.
            </CardDescription>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New key
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {keys.error ? (
            <EmptyState title="Couldn't load keys" description={(keys.error as Error).message} className="m-3" />
          ) : keys.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-secondary/40" />
              ))}
            </div>
          ) : !keys.data?.length ? (
            <EmptyState
              icon={Key}
              title="No keys yet"
              description="Create a key to call the API from scripts or third-party tools."
              className="m-4"
            />
          ) : (
            <ul className="divide-y divide-border">
              {keys.data.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{k.name || 'Untitled'}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-foreground-subtle">
                      <span className="tabular">{k.prefix}…</span>
                      {k.createdAt && <span>· created {safeFormat(k.createdAt, 'd MMM yyyy')}</span>}
                      {k.lastUsedAt ? (
                        <span>· last used {safeFormat(k.lastUsedAt, 'd MMM yyyy HH:mm')}</span>
                      ) : (
                        <span>· never used</span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirming(k)}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label="Revoke"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Create */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && setCreateOpen(false)}>
        <DialogContent className="max-w-md">
          <form onSubmit={onCreate} className="space-y-4 p-5">
            <div className="space-y-1.5">
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Give the key a recognizable name — you'll only see it in this list, not the raw secret.
              </DialogDescription>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                autoFocus
                placeholder="e.g. trading-script"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={create.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending && <Loader2 className="size-4 animate-spin" />}
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Reveal once */}
      <Dialog open={Boolean(revealed)} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent className="max-w-md">
          <div className="space-y-4 p-5">
            <div className="space-y-1.5">
              <DialogTitle>Save your key</DialogTitle>
              <DialogDescription>
                This is the <strong className="text-foreground">only time</strong> the full secret is shown. Copy it
                now — you can't recover it later.
              </DialogDescription>
            </div>
            <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] tabular text-foreground">
              {revealed?.key}
            </pre>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={copySecret}>
                {copied ? <Check className="size-4 text-gain" /> : <Copy className="size-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button onClick={() => setRevealed(null)}>I've saved it</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog open={Boolean(confirming)} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="max-w-sm">
          <div className="space-y-4 p-5">
            <div className="space-y-1.5">
              <DialogTitle>Revoke key?</DialogTitle>
              <DialogDescription>
                Subsequent requests presenting this key will return <span className={cn('font-mono')}>401</span>. This
                cannot be undone.
              </DialogDescription>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(null)} disabled={revoke.isPending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={onRevoke} disabled={revoke.isPending}>
                {revoke.isPending && <Loader2 className="size-4 animate-spin" />}
                Revoke
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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
