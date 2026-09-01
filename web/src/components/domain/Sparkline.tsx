import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'

interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  /** Override color; otherwise inferred from first vs last value (gain/loss). */
  color?: string
  className?: string
  /** Render an area fill below the line. */
  area?: boolean
}

/**
 * Lightweight inline SVG sparkline. Use for table-row trend cells. For full
 * candlestick charts, use CandlestickChart instead.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  color,
  className,
  area = true,
}: SparklineProps) {
  const path = useMemo(() => {
    if (values.length < 2) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || 1
    const stepX = width / (values.length - 1)
    const points = values.map((v, i) => {
      const x = i * stepX
      const y = height - ((v - min) / range) * height
      return [x, y] as const
    })
    const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    const areaD = `${d} L${width.toFixed(1)},${height.toFixed(1)} L0,${height.toFixed(1)} Z`
    return { d, areaD }
  }, [values, width, height])

  if (!path) {
    return <div className={cn('h-7 w-24 rounded bg-secondary/40', className)} aria-hidden />
  }

  const inferred = values[values.length - 1] >= values[0] ? 'var(--color-gain)' : 'var(--color-loss)'
  const stroke = color ?? inferred

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden
    >
      {area && <path d={path.areaD} fill={stroke} fillOpacity={0.12} />}
      <path d={path.d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
