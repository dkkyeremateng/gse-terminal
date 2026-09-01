import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { number, percent } from '@/lib/utils/format'

interface PriceCellProps {
  price: number
  changePct?: number | null
  /** Layout: 'inline' (price + delta side-by-side) or 'stack' (price above delta) */
  layout?: 'inline' | 'stack'
  showArrow?: boolean
  /** When true, briefly flash background on price changes. */
  flashOnChange?: boolean
  className?: string
}

/**
 * Tabular monospace price cell with paired delta and color+arrow status.
 *
 * Status is conveyed by both color and an arrow — never color alone (a11y).
 * Optional flash animation on price change for live data.
 */
export function PriceCell({
  price,
  changePct,
  layout = 'inline',
  showArrow = true,
  flashOnChange = false,
  className,
}: PriceCellProps) {
  const positive = (changePct ?? 0) > 0
  const negative = (changePct ?? 0) < 0
  const Arrow = positive ? ArrowUp : negative ? ArrowDown : null

  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(price)
  const [flashKey, setFlashKey] = useState(0)

  useEffect(() => {
    if (!flashOnChange) return
    if (prev.current !== price) {
      setFlashKey((k) => k + 1)
      prev.current = price
    }
  }, [price, flashOnChange])

  return (
    <span
      ref={ref}
      key={flashKey}
      className={cn(
        'inline-flex items-baseline gap-2 tabular',
        layout === 'stack' && 'flex-col items-start gap-0.5',
        flashOnChange && positive && 'flash-gain',
        flashOnChange && negative && 'flash-loss',
        className,
      )}
    >
      <span className="font-medium">{number(price)}</span>
      {changePct !== undefined && changePct !== null && (
        <span
          className={cn(
            'inline-flex items-center gap-0.5 text-xs',
            positive && 'text-gain',
            negative && 'text-loss',
            !positive && !negative && 'text-foreground-subtle',
          )}
          aria-label={`${positive ? 'up' : negative ? 'down' : 'unchanged'} ${Math.abs(changePct).toFixed(2)} percent`}
        >
          {showArrow && Arrow && <Arrow className="size-3" aria-hidden />}
          {percent(changePct)}
        </span>
      )}
    </span>
  )
}
