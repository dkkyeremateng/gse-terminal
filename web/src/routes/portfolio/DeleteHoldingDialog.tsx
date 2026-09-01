import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDeleteHolding } from '@/features/portfolio/queries'
import { toast } from '@/lib/utils/toast'
import { ApiError } from '@/lib/api/client'
import type { PortfolioHolding } from '@/features/portfolio/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  holding: PortfolioHolding | null
}

export function DeleteHoldingDialog({ open, onOpenChange, holding }: Props) {
  const del = useDeleteHolding()

  const onConfirm = async () => {
    if (!holding) return
    try {
      await del.mutateAsync(holding.id)
      toast.success(`Removed ${holding.symbol}`)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t remove the position')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <DialogTitle>Remove position?</DialogTitle>
            <DialogDescription>
              {holding ? (
                <>
                  This permanently removes <span className="font-medium text-foreground">{holding.symbol}</span> from your
                  portfolio. The transaction history is also forgotten.
                </>
              ) : (
                'This permanently removes the position from your portfolio.'
              )}
            </DialogDescription>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={del.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={del.isPending}>
              {del.isPending && <Loader2 className="size-4 animate-spin" />}
              Remove
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
