import { ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUser } from '@/features/auth/store'
import { useEntitlements } from '@/features/auth/entitlements'

export default function Profile() {
  const me = useUser()
  const { isPro, isAdmin } = useEntitlements()
  const role = isAdmin ? 'Admin' : isPro ? 'Pro' : 'Basic'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Account</CardTitle>
          <CardDescription>Identity used for sign-in and audit logs.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Username" value={me?.username ?? '—'} />
          <Row label="Email" value={me?.email || 'Not linked'} mono={Boolean(me?.email)} />
          <Row label="Email verified" value={me?.emailVerified ? 'Yes' : 'No'} />
          <Row label="Role" value={role} icon={isAdmin ? <ShieldCheck className="size-3.5 text-accent" /> : null} />
          <Row label="Provider" value={me?.provider || 'password'} />
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, value, icon, mono }: { label: string; value: string; icon?: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-0">
      <span className="text-foreground-muted">{label}</span>
      <span className={`flex items-center gap-1.5 ${mono ? 'tabular' : ''}`}>
        {icon}
        {value}
      </span>
    </div>
  )
}
