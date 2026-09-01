import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SymbolCombobox } from '@/components/ui/symbol-combobox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ApiError } from '@/lib/api/client'
import { toast } from '@/lib/utils/toast'
import {
  METRICS,
  OPS,
  type AlertMetric,
  type AlertOp,
  type AlertRule,
} from '@/features/alerts/types'
import { useCreateAlertRule, useUpdateAlertRule } from '@/features/alerts/queries'
import { cn } from '@/lib/utils/cn'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, dialog is in edit mode (symbol immutable). */
  rule?: AlertRule | null
  /** Pre-fill the symbol from the calling context. */
  defaultSymbol?: string
  symbols?: string[]
}

const schema = z.object({
  symbol: z
    .string()
    .min(1, 'Symbol is required')
    .max(16)
    .regex(/^[A-Za-z0-9.\-_*]+$/, 'Letters, numbers, . - _ *')
    .transform((s) => s.toUpperCase().trim()),
  metric: z.enum(['price', 'rsi', 'pct_change']),
  op: z.enum(['>', '<', '>=', '<=']),
  threshold: z.coerce.number(),
})

type FormValues = z.infer<typeof schema>

export function AlertRuleDialog({ open, onOpenChange, rule, defaultSymbol, symbols }: Props) {
  const isEdit = Boolean(rule)
  const [topError, setTopError] = useState<string | null>(null)

  const create = useCreateAlertRule()
  const update = useUpdateAlertRule()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      symbol: defaultSymbol ?? '',
      metric: 'price',
      op: '>',
      threshold: 0,
    },
  })

  useEffect(() => {
    if (!open) return
    setTopError(null)
    if (rule) {
      form.reset({ symbol: rule.symbol, metric: rule.metric, op: rule.op, threshold: rule.threshold })
    } else {
      form.reset({
        symbol: defaultSymbol ?? '',
        metric: 'price',
        op: '>',
        threshold: 0,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.id, defaultSymbol])

  const submitting = form.formState.isSubmitting || create.isPending || update.isPending
  const metric = form.watch('metric')
  const metricMeta = METRICS.find((m) => m.value === metric)

  const onSubmit = async (values: FormValues) => {
    setTopError(null)
    try {
      if (isEdit && rule) {
        await update.mutateAsync({
          id: rule.id,
          metric: values.metric,
          op: values.op,
          threshold: values.threshold,
        })
        toast.success('Alert updated')
      } else {
        await create.mutateAsync({
          symbol: values.symbol,
          metric: values.metric,
          op: values.op,
          threshold: values.threshold,
        })
        toast.success(`Alert armed for ${values.symbol}`)
      }
      onOpenChange(false)
    } catch (err) {
      setTopError(err instanceof ApiError ? err.message : 'Couldn’t save the alert')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <DialogTitle>{isEdit ? 'Edit alert' : 'New alert'}</DialogTitle>
            <DialogDescription>
              Fires once when the condition is met, then auto-pauses to prevent spam. Up to 20 rules per account.
            </DialogDescription>
          </div>

          {topError && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              {topError}
            </div>
          )}

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="symbol">Symbol</Label>
              {isEdit ? (
                // Symbol is immutable in edit mode — show as a static disabled
                // value rather than a combobox.
                <Input id="symbol" disabled value={form.watch('symbol')} />
              ) : (
                <Controller
                  control={form.control}
                  name="symbol"
                  render={({ field }) => (
                    <SymbolCombobox
                      id="symbol"
                      placeholder="e.g. MTNGH"
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      symbols={symbols ?? []}
                      aria-invalid={Boolean(form.formState.errors.symbol) || undefined}
                    />
                  )}
                />
              )}
              {form.formState.errors.symbol && (
                <p className="text-xs text-destructive">{form.formState.errors.symbol.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Metric</Label>
              <SegmentedGroup
                value={metric}
                onChange={(v) => form.setValue('metric', v as AlertMetric, { shouldDirty: true })}
                options={METRICS.map((m) => ({ value: m.value, label: m.label }))}
              />
              {metricMeta && <p className="text-[11px] text-foreground-subtle">{metricMeta.hint}</p>}
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="op">Condition</Label>
                <select
                  id="op"
                  {...form.register('op')}
                  className="flex h-10 w-full rounded-md border border-input bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="threshold">Threshold</Label>
                <Input
                  id="threshold"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  className="text-right"
                  {...form.register('threshold')}
                />
              </div>
            </div>

            <PreviewRow
              symbol={form.watch('symbol')}
              metric={form.watch('metric') as AlertMetric}
              op={form.watch('op') as AlertOp}
              threshold={Number(form.watch('threshold'))}
            />

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {isEdit ? 'Save changes' : 'Arm alert'}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SegmentedGroup({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div role="tablist" className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex-1 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors',
              active ? 'bg-secondary text-foreground' : 'text-foreground-muted hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function PreviewRow({
  symbol,
  metric,
  op,
  threshold,
}: {
  symbol: string
  metric: AlertMetric
  op: AlertOp
  threshold: number
}) {
  if (!symbol || isNaN(threshold)) return null
  const opLabel = OPS.find((o) => o.value === op)?.label ?? op
  const metricLabel = METRICS.find((m) => m.value === metric)?.label ?? metric
  return (
    <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-foreground-muted">
      <span className="font-medium text-foreground">{symbol}</span> notifies me when{' '}
      <span className="text-foreground">{metricLabel}</span> {opLabel}{' '}
      <span className="tabular text-foreground">{threshold}</span>
      {metric === 'pct_change' ? '%' : ''}.
    </p>
  )
}
