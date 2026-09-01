import { useState } from 'react'
import { FlaskConical, MessageSquareText, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { NLQueryPanel } from './NLQueryPanel'
import { AIInsightTab } from './AIInsightTab'
import { BacktestPanel } from './BacktestPanel'

type Tab = 'query' | 'insight' | 'backtest'

const TABS: { value: Tab; label: string; icon: React.ComponentType<{ className?: string }>; hint: string }[] = [
  { value: 'query', label: 'NL Query', icon: MessageSquareText, hint: 'Ask in plain English, get rows' },
  { value: 'insight', label: 'AI Insight', icon: Sparkles, hint: 'Per-symbol oracle verdict' },
  { value: 'backtest', label: 'Backtest', icon: FlaskConical, hint: 'Deterministic technical replay' },
]

export default function Research() {
  const [tab, setTab] = useState<Tab>('query')

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Research</h1>
        <p className="text-sm text-foreground-muted">
          Pro tools — natural-language screen, AI verdicts, and signal backtests.
        </p>
      </header>

      <div role="tablist" aria-label="Research tools" className="inline-flex rounded-md border border-border bg-surface p-0.5">
        {TABS.map((t) => {
          const active = tab === t.value
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
                active ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
              )}
              title={t.hint}
            >
              <t.icon className="size-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'query' && <NLQueryPanel />}
      {tab === 'insight' && <AIInsightTab />}
      {tab === 'backtest' && <BacktestPanel />}
    </div>
  )
}
