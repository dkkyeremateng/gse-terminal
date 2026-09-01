import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Activity, BellRing, User, Briefcase } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useEntitlements } from '@/features/auth/entitlements'
import { useHasHoldings } from '@/features/portfolio/queries'

/**
 * Mobile bottom navigation — visible below `lg`.
 *
 * Capped at 5 items per Material Design. Pro/Admin items live in the topbar
 * user menu / command palette instead. Settings is reachable via the avatar.
 */

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  end?: boolean
  pro?: boolean
  needsHoldings?: boolean
}

const ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/markets', label: 'Markets', icon: Activity },
  { to: '/portfolio', label: 'Folio', icon: Briefcase, needsHoldings: true },
  { to: '/alerts', label: 'Alerts', icon: BellRing, pro: true },
  { to: '/settings/profile', label: 'Me', icon: User },
]

export function BottomNav() {
  const { isPro } = useEntitlements()
  const hasHoldings = useHasHoldings()
  const showHoldingsItems = hasHoldings ?? true
  const visible = ITEMS.filter((item) => {
    if (item.pro) return isPro
    if (item.needsHoldings) return showHoldingsItems
    return true
  }).slice(0, 5)
  return (
    <nav
      aria-label="Primary"
      className="sticky bottom-0 z-30 flex items-stretch border-t border-border bg-background/90 backdrop-blur lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
    >
      {visible.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
              isActive ? 'text-foreground' : 'text-foreground-muted',
            )
          }
        >
          {({ isActive }) => (
            <>
              <span
                aria-hidden
                className={cn(
                  'absolute top-0 h-0.5 w-8 rounded-full bg-primary transition-opacity',
                  isActive ? 'opacity-100' : 'opacity-0',
                )}
              />
              <item.icon className="size-5" />
              <span>{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
