import * as React from 'react'
import { cn } from '@/lib/utils/cn'

export const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, children, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        'inline-flex h-5 min-w-5 select-none items-center justify-center rounded border border-border bg-surface-elevated px-1.5 font-mono text-[10px] font-medium text-foreground-muted',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  ),
)
Kbd.displayName = 'Kbd'
