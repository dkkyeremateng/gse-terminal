import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Briefcase,
  Activity,
  BellRing,
  FlaskConical,
  Shield,
  LineChart,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useEntitlements } from '@/features/auth/entitlements'
import { useHasHoldings } from '@/features/portfolio/queries'

interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  pro?: boolean
  admin?: boolean
  /** Hide unless the user has at least one holding. */
  needsHoldings?: boolean
}

const ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase, needsHoldings: true },
  { to: '/markets', label: 'Markets', icon: Activity },
  { to: '/alerts', label: 'Alerts', icon: BellRing, pro: true },
  { to: '/research', label: 'Research', icon: FlaskConical, pro: true },
  { to: '/admin', label: 'Admin', icon: Shield, admin: true },
]

export function Sidebar() {
  const { isPro, isAdmin } = useEntitlements()
  const hasHoldings = useHasHoldings()

  // While the holdings query is still loading we don't know the answer yet.
  // Default to showing the Portfolio item then — it's the safer choice for
  // the first paint of returning users (avoids a flash where Portfolio
  // disappears then reappears once the query resolves).
  const showHoldingsItems = hasHoldings ?? true

  const visible = ITEMS.filter((item) => {
    if (item.admin) return isAdmin
    if (item.pro) return isPro
    if (item.needsHoldings) return showHoldingsItems
    return true
  })

  return (
    <aside className="hidden border-r border-border bg-surface lg:flex lg:w-60 lg:flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-5">
        <LineChart className="size-5 text-primary" />
        <span className="font-semibold tracking-tight">GES Pro</span>
      </div>
      <nav className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-0.5">
          {visible.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/dashboard'}
                className={({ isActive }) =>
                  cn(
                    'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors duration-[var(--duration-fast)]',
                    'text-foreground-muted hover:bg-secondary hover:text-foreground',
                    isActive && 'bg-secondary text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        'absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary transition-opacity',
                        isActive ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  )
}
