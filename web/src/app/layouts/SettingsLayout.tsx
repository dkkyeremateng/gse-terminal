import { NavLink, Outlet } from 'react-router-dom'
import { Bell, Key, Shield, Sparkles, User as UserIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface NavEntry {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const ENTRIES: NavEntry[] = [
  { to: '/settings/profile', label: 'Profile', icon: UserIcon },
  { to: '/settings/security', label: 'Security', icon: Shield },
  { to: '/settings/api-keys', label: 'API keys', icon: Key },
  { to: '/settings/notifications', label: 'Notifications', icon: Bell },
  { to: '/settings/pro', label: 'Pro access', icon: Sparkles },
]

export function SettingsLayout() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-foreground-muted">Account, notifications, and preferences.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <aside>
          <nav aria-label="Settings sections">
            <ul className="space-y-0.5">
              {ENTRIES.map((entry) => (
                <li key={entry.to}>
                  <NavLink
                    to={entry.to}
                    end
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                        'text-foreground-muted hover:bg-secondary hover:text-foreground',
                        isActive && 'bg-secondary text-foreground',
                      )
                    }
                  >
                    <entry.icon className="size-4" />
                    {entry.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <section className="min-w-0">
          <Outlet />
        </section>
      </div>
    </div>
  )
}
