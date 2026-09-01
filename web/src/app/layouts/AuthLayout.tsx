import { Outlet } from 'react-router-dom'
import { LineChart } from 'lucide-react'

export function AuthLayout() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* Form side */}
      <div className="flex flex-col justify-center px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 flex items-center gap-2">
            <LineChart className="size-5 text-primary" />
            <span className="font-semibold tracking-tight">GES Pro Terminal</span>
          </div>
          <Outlet />
        </div>
      </div>

      {/* Brand / preview side */}
      <div className="relative hidden overflow-hidden border-l border-border bg-surface lg:block">
        <BrandPanel />
      </div>
    </div>
  )
}

function BrandPanel() {
  return (
    <div className="absolute inset-0 flex flex-col justify-end p-12">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 0% 0%, hsl(var(--primary)) 0, transparent 45%), radial-gradient(circle at 100% 100%, hsl(var(--accent)) 0, transparent 50%)',
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />
      <div className="relative max-w-md space-y-3">
        <span className="inline-flex items-center rounded-full border border-border-strong bg-surface-elevated px-2.5 py-1 text-[11px] uppercase tracking-wider text-foreground-muted">
          Ghana Stock Exchange
        </span>
        <h2 className="text-3xl font-semibold leading-tight tracking-tight">
          The terminal traders use to track every move on the GSE.
        </h2>
        <p className="text-sm text-foreground-muted">
          Real-time quotes, watchlists, alerts, and AI-driven insights — built for serious investors.
        </p>
      </div>
    </div>
  )
}
