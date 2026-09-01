import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SymbolCombobox } from '@/components/ui/symbol-combobox'
import { EmptyState } from '@/components/domain/EmptyState'
import { AIInsightPanel } from '@/components/domain/AIInsightPanel'
import { useSymbols } from '@/features/markets/queries'

export function AIInsightTab() {
  const symbols = useSymbols()
  const [pending, setPending] = useState('')
  const [submitted, setSubmitted] = useState<string | undefined>(undefined)
  const submitting = pending.trim() && pending.trim().toUpperCase() !== submitted

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!pending.trim()) return
    setSubmitted(pending.trim().toUpperCase())
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="size-4 text-accent" />
            Per-symbol oracle
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5">
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <Label htmlFor="insight-symbol">Symbol</Label>
              <SymbolCombobox
                id="insight-symbol"
                placeholder="e.g. MTNGH"
                value={pending}
                onChange={setPending}
                symbols={symbols.data ?? []}
              />
            </div>
            <Button type="submit" disabled={!pending.trim()}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Generate
            </Button>
          </form>
          <p className="mt-3 text-[11px] text-foreground-subtle">
            Combines technical indicators (RSI, ATR, SMA) with news sentiment for a single verdict. Pro · 10 rpm.
          </p>
        </CardContent>
      </Card>

      {submitted ? (
        <AIInsightPanel symbol={submitted} />
      ) : (
        <EmptyState
          icon={Sparkles}
          title="Pick a ticker"
          description="The oracle reads the latest indicators and headlines, then writes a short consensus."
          className="rounded-md border border-dashed border-border-strong"
        />
      )}
    </div>
  )
}
