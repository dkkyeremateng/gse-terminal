import { useMemo } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import { cn } from '@/lib/utils/cn'
import { compact, percent } from '@/lib/utils/format'

export interface AllocationSlice {
  label: string
  value: number
}

interface AllocationDonutProps {
  data: AllocationSlice[]
  /** Total value displayed in the center; auto-summed when omitted. */
  total?: number
  /** Currency or label to render under the total. */
  totalLabel?: string
  size?: number
  className?: string
}

/**
 * Donut chart with center value and a colored legend.
 *
 * Status colors are paired with the label's color swatch so legend ↔ slice
 * mapping is preserved when the user is colorblind. Use for sector exposure,
 * symbol allocation, or any proportional breakdown.
 */
export function AllocationDonut({
  data,
  total,
  totalLabel = 'Total',
  size = 200,
  className,
}: AllocationDonutProps) {
  const sum = useMemo(() => total ?? data.reduce((acc, d) => acc + d.value, 0), [data, total])
  const slices = useMemo(() => data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value), [data])

  if (slices.length === 0) {
    return <div className="flex h-[200px] items-center justify-center text-sm text-foreground-muted">No allocation</div>
  }

  return (
    <div className={cn('flex flex-col items-center gap-4 lg:flex-row lg:items-start lg:gap-6', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={size * 0.32}
              outerRadius={size * 0.46}
              paddingAngle={2}
              stroke="hsl(var(--background))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((slice, idx) => (
                <Cell key={slice.label} fill={SLICE_COLORS[idx % SLICE_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center">
          <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">{totalLabel}</span>
          <span className="text-lg font-semibold tracking-tight tabular">{compact(sum)}</span>
        </div>
      </div>
      <ul className="grid w-full grid-cols-1 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-1 lg:gap-y-1.5">
        {slices.map((slice, idx) => (
          <li key={slice.label} className="flex items-center gap-2 leading-none">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: SLICE_COLORS[idx % SLICE_COLORS.length] }}
            />
            <span className="min-w-0 flex-1 truncate text-foreground-muted" title={slice.label}>
              {slice.label}
            </span>
            <span className="tabular text-foreground">{percent((slice.value / sum) * 100, false)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Hand-tuned palette: distinct hues with similar luminance, accessible in
 * both dark + light themes. Order is stable so legend ↔ slice mapping
 * doesn't shift between renders.
 */
const SLICE_COLORS = [
  '#3B82F6', // blue (primary)
  '#F59E0B', // amber (accent)
  '#10B981', // emerald
  '#8B5CF6', // violet
  '#EF4444', // red
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#F97316', // orange
  '#84CC16', // lime
  '#A855F7', // purple
  '#14B8A6', // teal
  '#FBBF24', // yellow
] as const
