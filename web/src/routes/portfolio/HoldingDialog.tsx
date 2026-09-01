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
import type { PortfolioHolding } from '@/features/portfolio/types'
import { useCreateHolding, useUpdateHolding } from '@/features/portfolio/queries'

interface HoldingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When provided, the dialog renders in edit mode. */
  holding?: PortfolioHolding | null
  symbols?: string[]
}

// Edit-mode schema only allows quantity / costBasis / notes (matches backend PATCH).
const editSchema = z.object({
  quantity: z.coerce.number().positive('Must be > 0'),
  costBasis: z.coerce.number().min(0, 'Must be ≥ 0'),
  notes: z.string().max(500).optional().default(''),
})

const createSchema = editSchema.extend({
  symbol: z
    .string()
    .min(1, 'Symbol is required')
    .max(16)
    .regex(/^[A-Za-z0-9.\-_*]+$/, 'Letters, numbers, . - _ *')
    .transform((s) => s.toUpperCase().trim()),
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
})

type CreateValues = z.infer<typeof createSchema>
type EditValues = z.infer<typeof editSchema>

export function HoldingDialog({ open, onOpenChange, holding, symbols }: HoldingDialogProps) {
  const isEdit = Boolean(holding)
  const [topError, setTopError] = useState<string | null>(null)

  const create = useCreateHolding()
  const update = useUpdateHolding()

  const form = useForm<CreateValues>({
    resolver: zodResolver(isEdit ? editSchema : createSchema) as never,
    defaultValues: {
      symbol: '',
      quantity: 0,
      costBasis: 0,
      purchaseDate: new Date().toISOString().slice(0, 10),
      notes: '',
    },
  })

  // Reset form whenever dialog opens or target holding changes.
  useEffect(() => {
    if (!open) return
    setTopError(null)
    if (holding) {
      form.reset({
        symbol: holding.symbol,
        quantity: holding.quantity,
        costBasis: holding.costBasis,
        purchaseDate: holding.purchaseDate,
        notes: holding.notes ?? '',
      })
    } else {
      form.reset({
        symbol: '',
        quantity: 0,
        costBasis: 0,
        purchaseDate: new Date().toISOString().slice(0, 10),
        notes: '',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, holding?.id])

  const submitting = form.formState.isSubmitting || create.isPending || update.isPending

  const onSubmit = async (values: CreateValues) => {
    setTopError(null)
    try {
      if (isEdit && holding) {
        const patch = values as EditValues
        await update.mutateAsync({
          id: holding.id,
          quantity: patch.quantity,
          costBasis: patch.costBasis,
          notes: patch.notes,
        })
        toast.success('Position updated')
      } else {
        await create.mutateAsync({
          symbol: values.symbol,
          quantity: values.quantity,
          costBasis: values.costBasis,
          purchaseDate: values.purchaseDate,
          notes: values.notes,
        })
        toast.success('Position added')
      }
      onOpenChange(false)
    } catch (err) {
      setTopError(err instanceof ApiError ? err.message : 'Couldn’t save the position')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <DialogTitle>{isEdit ? 'Edit position' : 'Add position'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Update quantity, cost basis, or notes. Symbol and purchase date are immutable.'
                : 'Track a new holding. Cost basis is per share — the average price you paid.'}
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
                // Symbol is immutable in edit mode — render a plain disabled
                // Input rather than a combobox so users don't see a dropdown
                // they can't act on.
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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="quantity">Quantity</Label>
                <Input
                  id="quantity"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  {...form.register('quantity')}
                />
                {form.formState.errors.quantity && (
                  <p className="text-xs text-destructive">{form.formState.errors.quantity.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="costBasis">Cost / share</Label>
                <Input
                  id="costBasis"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  {...form.register('costBasis')}
                />
                {form.formState.errors.costBasis && (
                  <p className="text-xs text-destructive">{form.formState.errors.costBasis.message}</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="purchaseDate">Purchase date</Label>
              <Input
                id="purchaseDate"
                type="date"
                disabled={isEdit}
                {...form.register('purchaseDate')}
              />
              {form.formState.errors.purchaseDate && (
                <p className="text-xs text-destructive">{form.formState.errors.purchaseDate.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                placeholder="Optional"
                {...form.register('notes')}
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {isEdit ? 'Save changes' : 'Add position'}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
