import { type LucideIcon, Inbox } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong px-6 py-12 text-center',
        className,
      )}
    >
      <Icon className="size-6 text-foreground-subtle" aria-hidden />
      <h3 className="mt-1 text-sm font-medium text-foreground">{title}</h3>
      {description && <p className="max-w-sm text-xs text-foreground-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
