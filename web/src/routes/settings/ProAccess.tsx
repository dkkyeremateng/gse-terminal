import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { CheckCircle2, Clock, Loader2, Sparkles, XCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useProRequest, useSubmitProRequest } from '@/features/account/queries'
import type { ProRoleRequest } from '@/features/account/types'
import { useEntitlements } from '@/features/auth/entitlements'
import { ApiError } from '@/lib/api/client'
import { toast } from '@/lib/utils/toast'
import { cn } from '@/lib/utils/cn'

export default function ProAccess() {
  const { isPro, isAdmin } = useEntitlements()
  const proReq = useProRequest()
  const submit = useSubmitProRequest()
  const [reason, setReason] = useState('')

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) return
    try {
      await submit.mutateAsync(reason.trim())
      toast.success('Request submitted')
      setReason('')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t submit request')
    }
  }

  if (isAdmin) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-foreground-muted">
          You're an admin — full access already enabled.
        </CardContent>
      </Card>
    )
  }

  if (isPro) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-6 text-sm">
          <CheckCircle2 className="size-5 text-gain" />
          <div>
            <p className="font-medium text-foreground">Pro access active</p>
            <p className="text-foreground-muted">
              Research, alerts, AI Insights, and detail sector data are available across the app.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const existing = proReq.data?.request

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="size-4 text-accent" />
            Request Pro access
          </CardTitle>
          <CardDescription>
            Pro unlocks the AI Market Oracle, alert rules, the NL→SQL playground, full sector breakdowns, and
            backtesting. An admin reviews each request manually.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {existing && <ExistingRequest request={existing} />}

          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reason">
                {existing?.status === 'denied'
                  ? 'Update your reason and resubmit'
                  : existing?.status === 'pending'
                    ? 'Add to your request'
                    : 'Why do you want Pro access?'}
              </Label>
              <textarea
                id="reason"
                rows={4}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Tell us a bit about how you'll use it — research workflow, alerts, etc."
                className="block w-full resize-y rounded-md border border-input bg-surface px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={1000}
              />
            </div>
            <div className="flex items-center justify-end">
              <Button type="submit" disabled={submit.isPending || !reason.trim()}>
                {submit.isPending && <Loader2 className="size-4 animate-spin" />}
                Submit request
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function ExistingRequest({ request }: { request: ProRoleRequest }) {
  const meta = STATUS_META[request.status] ?? STATUS_META.pending
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3',
        request.status === 'approved' && 'border-gain/30 bg-gain/5',
        request.status === 'denied' && 'border-loss/30 bg-loss/5',
        request.status === 'pending' && 'border-border bg-surface',
      )}
    >
      <meta.icon className={cn('mt-0.5 size-4', meta.tone)} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn('text-sm font-medium', meta.tone)}>{meta.label}</p>
        <p className="text-xs text-foreground-muted">
          Submitted {safeFormat(request.createdAt, 'd MMM yyyy HH:mm')}
          {request.decidedAt && ` · decided ${safeFormat(request.decidedAt, 'd MMM yyyy HH:mm')}`}
        </p>
        {request.reason && (
          <p className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground">
            <span className="text-foreground-subtle">You wrote:</span> “{request.reason}”
          </p>
        )}
        {request.adminNote && (
          <p className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground">
            <span className="text-foreground-subtle">Admin note:</span> {request.adminNote}
          </p>
        )}
      </div>
    </div>
  )
}

const STATUS_META = {
  pending: { icon: Clock, tone: 'text-warning', label: 'Pending review' },
  approved: { icon: CheckCircle2, tone: 'text-gain', label: 'Approved' },
  denied: { icon: XCircle, tone: 'text-loss', label: 'Denied' },
} as const

function safeFormat(iso: string, fmt: string): string {
  try {
    return format(parseISO(iso), fmt)
  } catch {
    return iso
  }
}
