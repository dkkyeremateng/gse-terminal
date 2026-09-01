import { Command } from 'cmdk'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  BellRing,
  Briefcase,
  FlaskConical,
  Grid3x3,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Moon,
  Newspaper,
  Search,
  Sun,
  Activity,
  Shield,
} from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useTheme } from '@/app/providers/ThemeProvider'
import { useAuthStore } from '@/features/auth/store'
import { useEntitlements } from '@/features/auth/entitlements'
import { cn } from '@/lib/utils/cn'

interface PaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface PaletteItem {
  icon: React.ComponentType<{ className?: string }>
  label: string
  keywords?: string[]
  onSelect: () => void
  shortcut?: string
}

export function CommandPalette({ open, onOpenChange }: PaletteProps) {
  const navigate = useNavigate()
  const { resolved, setTheme } = useTheme()
  const { isPro, isAdmin } = useEntitlements()
  const logout = useAuthStore((s) => s.logout)

  const close = () => onOpenChange(false)
  const go = (path: string) => {
    close()
    navigate(path)
  }

  const navigation: PaletteItem[] = [
    { icon: LayoutDashboard, label: 'Dashboard', onSelect: () => go('/dashboard'), keywords: ['home', 'overview'] },
    { icon: Briefcase, label: 'Portfolio', onSelect: () => go('/portfolio'), keywords: ['holdings', 'positions', 'pnl'] },
    { icon: ListChecks, label: 'Watchlist', onSelect: () => go('/watchlist'), keywords: ['follow', 'tracked'] },
    { icon: Activity, label: 'Markets', onSelect: () => go('/markets'), keywords: ['stocks', 'symbols', 'quotes'] },
    { icon: Grid3x3, label: 'Sectors', onSelect: () => go('/sectors'), keywords: ['heatmap', 'breadth'] },
    { icon: BellRing, label: 'Alerts', onSelect: () => go('/alerts'), keywords: ['rules', 'notifications'] },
    { icon: Newspaper, label: 'News', onSelect: () => go('/news') },
    ...(isPro
      ? [{ icon: FlaskConical, label: 'Research', onSelect: () => go('/research'), keywords: ['query', 'backtest', 'sql', 'ai'] }]
      : []),
    ...(isAdmin ? [{ icon: Shield, label: 'Admin', onSelect: () => go('/admin') }] : []),
  ]

  const actions: PaletteItem[] = [
    {
      icon: resolved === 'dark' ? Sun : Moon,
      label: resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      keywords: ['theme', 'mode', 'dark', 'light'],
      onSelect: () => {
        setTheme(resolved === 'dark' ? 'light' : 'dark')
        close()
      },
    },
    {
      icon: LogOut,
      label: 'Sign out',
      keywords: ['logout', 'exit'],
      onSelect: async () => {
        close()
        await logout()
        navigate('/login', { replace: true })
      },
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12%] max-w-xl overflow-hidden p-0" hideClose>
        <Command
          loop
          className="bg-popover"
          filter={(value, search, keywords) => {
            const haystack = `${value} ${(keywords ?? []).join(' ')}`.toLowerCase()
            const needle = search.toLowerCase()
            if (!needle) return 1
            // simple subsequence-friendly match
            return haystack.includes(needle) ? 1 : 0
          }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-foreground-subtle" />
            <Command.Input
              autoFocus
              placeholder="Search symbols, navigate, run actions…"
              className="h-11 flex-1 bg-transparent text-sm placeholder:text-foreground-subtle focus:outline-none"
            />
            <Kbd>esc</Kbd>
          </div>

          <Command.List className="max-h-[420px] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-8 text-center text-sm text-foreground-muted">
              No results.
            </Command.Empty>

            <PaletteGroup heading="Navigate" items={navigation} />
            <PaletteGroup heading="Actions" items={actions} />
          </Command.List>

          <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-foreground-subtle">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>
              <span>open</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              <span>close</span>
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function PaletteGroup({ heading, items }: { heading: string; items: PaletteItem[] }) {
  if (items.length === 0) return null
  return (
    <Command.Group heading={heading} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-foreground-subtle">
      {items.map((item) => (
        <Command.Item
          key={item.label}
          value={item.label}
          keywords={item.keywords}
          onSelect={item.onSelect}
          className={cn(
            'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors',
            'data-[selected=true]:bg-secondary',
          )}
        >
          <item.icon className="size-4 text-foreground-muted" />
          <span className="flex-1">{item.label}</span>
          <ArrowRight className="size-3.5 text-foreground-subtle opacity-0 transition-opacity group-data-[selected=true]:opacity-100 data-[selected=true]:opacity-100" />
        </Command.Item>
      ))}
    </Command.Group>
  )
}
