import { Bell, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { usePushSubscription } from '@/features/push/usePushSubscription'

export default function Notifications() {
  const push = usePushSubscription()

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Bell className="size-4 text-foreground-muted" />
            Push notifications
          </CardTitle>
          <CardDescription>
            Browser-level push for alert fires and the daily watchlist digest. Requires a verified email for alert
            deliveries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!push.supported ? (
            <p className="text-foreground-muted">
              Push isn't available in this browser. Try Chrome, Edge, or Firefox on desktop.
            </p>
          ) : push.permission === 'denied' ? (
            <p className="text-foreground-muted">
              Notifications are blocked at the browser level. Re-allow them in your site settings, then refresh.
            </p>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{push.subscribed ? 'Enabled' : 'Disabled'}</p>
                <p className="text-xs text-foreground-muted">
                  {push.subscribed
                    ? 'You will receive alerts and daily digests on this device.'
                    : 'You will only see in-app and email notifications until enabled.'}
                </p>
              </div>
              <Button
                variant={push.subscribed ? 'outline' : 'default'}
                disabled={push.busy}
                onClick={push.subscribed ? push.unsubscribe : push.subscribe}
              >
                {push.busy && <Loader2 className="size-4 animate-spin" />}
                {push.subscribed ? 'Disable' : 'Enable'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
