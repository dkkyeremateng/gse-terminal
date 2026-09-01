import { Search, Sun, Moon, LogOut, User as UserIcon } from 'lucide-react'
import { AlertsDrawer } from './AlertsDrawer'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Avatar from '@radix-ui/react-avatar'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useTheme } from '@/app/providers/ThemeProvider'
import { useAuthStore, useUser } from '@/features/auth/store'
import { useWsConnectionState } from '@/lib/ws/hooks'
import { useMarketSession } from '@/features/session/useMarketSession'
import { cn } from '@/lib/utils/cn'

interface TopBarProps {
  onOpenPalette: () => void
}

export function TopBar({ onOpenPalette }: TopBarProps) {
  const { resolved, setTheme } = useTheme()
  const navigate = useNavigate()
  const user = useUser()
  const logout = useAuthStore((s) => s.logout)
  const wsState = useWsConnectionState()
  const session = useMarketSession()
  const initials = user?.username?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase() ?? '?'

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-6">
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        aria-keyshortcuts="Meta+K"
        className="flex max-w-md flex-1 items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground-subtle transition-colors hover:border-border-strong hover:bg-surface-elevated"
      >
        <Search className="size-4" />
        <span>Search symbols, navigate, run actions…</span>
        <Kbd className="ml-auto">⌘K</Kbd>
      </button>

      <div className="ml-auto flex items-center gap-1 lg:ml-0">
        <ConnectionDot wsState={wsState} sessionState={session.state} />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
        >
          {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <AlertsDrawer />

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="ml-1 inline-flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Open user menu"
            >
              <Avatar.Root className="inline-flex size-8 select-none items-center justify-center overflow-hidden rounded-full bg-secondary text-xs font-medium text-foreground">
                <Avatar.Fallback>{initials}</Avatar.Fallback>
              </Avatar.Root>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              data-menu-content=""
              className={cn(
                'z-50 min-w-[220px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-lg)]',
              )}
            >
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{user?.username ?? 'Trader'}</p>
                <p className="truncate text-xs text-foreground-muted">{user?.email}</p>
              </div>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <MenuItem onSelect={() => navigate('/settings/profile')} icon={<UserIcon className="size-4" />}>
                Settings
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <MenuItem onSelect={handleLogout} icon={<LogOut className="size-4" />} destructive>
                Sign out
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  )
}

type WsState = ReturnType<typeof useWsConnectionState>
type SessionState = ReturnType<typeof useMarketSession>['state']

/**
 * Status pill that fuses transport state (WS) and market state (session).
 *
 * Connection problems always win — a disconnected stream gets the loud red
 * pill regardless of whether the market is open. Only when the transport is
 * healthy do we surface the market session label, so "Live" never appears
 * outside trading hours.
 */
function ConnectionDot({ wsState, sessionState }: { wsState: WsState; sessionState: SessionState }) {
  // Transport problems always take precedence — a disconnected stream is the
  // more actionable signal than market session state.
  if (wsState === 'connecting') return <Pill color="bg-warning animate-pulse" label="Connecting…" />
  if (wsState === 'error') return <Pill color="bg-loss" label="Connection error" />
  if (wsState === 'closed') return <Pill color="bg-loss" label="Reconnecting…" />

  // Transport is healthy (open) or idle — surface market session state.
  if (sessionState === 'live') return <Pill color="bg-gain animate-pulse" label="Live" />
  if (sessionState === 'closed') return <Pill color="bg-foreground-subtle" label="Closed" />
  return <Pill color="bg-foreground-subtle" label="Idle" />
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground-muted md:inline-flex"
      title={label}
      aria-label={label}
    >
      <span className={cn('size-1.5 rounded-full', color)} />
      <span>{label}</span>
    </span>
  )
}

function MenuItem({
  children,
  onSelect,
  icon,
  destructive,
}: {
  children: React.ReactNode
  onSelect: () => void
  icon: React.ReactNode
  destructive?: boolean
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none transition-colors',
        'data-[highlighted]:bg-secondary',
        destructive && 'text-destructive data-[highlighted]:bg-destructive/10',
      )}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  )
}
