import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts'
import { format, parseISO } from 'date-fns'
import type { PortfolioHistoryPoint } from '@/features/portfolio/types'
import { compact, money } from '@/lib/utils/format'

interface PnLAreaProps {
  points: PortfolioHistoryPoint[]
  height?: number
  /** Cost basis baseline; rendered as a dashed reference line. */
  costBasis?: number
}

/**
 * Portfolio equity curve with a cost-basis baseline.
 *
 * The fill color tracks whether the latest value is above or below cost
 * basis — green when up, red when down. Use the value series, not cumulative
 * cashflow — the backend's reconstruction already separates market return
 * from contributions.
 */
export function PnLArea({ points, height = 280, costBasis }: PnLAreaProps) {
  const ups = (points[points.length - 1]?.value ?? 0) >= (costBasis ?? points[0]?.value ?? 0)
  const stroke = ups ? 'var(--color-gain)' : 'var(--color-loss)'

  const data = useMemo(
    () =>
      points.map((p) => ({
        date: p.date,
        value: p.value,
      })),
    [points],
  )

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="pnl-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.32} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="hsl(var(--border) / 0.5)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(v: string) => safeFormat(v, 'MMM d')}
          stroke="hsl(var(--foreground-muted))"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
        />
        <YAxis
          stroke="hsl(var(--foreground-muted))"
          fontSize={11}
          tickFormatter={(v: number) => compact(v)}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          cursor={{ stroke: 'hsl(var(--foreground-muted))', strokeDasharray: '3 3' }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            const value = Number(payload[0]?.value ?? 0)
            return (
              <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-[var(--shadow-lg)]">
                <p className="text-foreground-muted">{safeFormat(String(label), 'EEE d MMM yyyy')}</p>
                <p className="mt-0.5 font-medium tabular text-foreground">{money(value)}</p>
                {typeof costBasis === 'number' && (
                  <p
                    className="mt-1 tabular text-[11px]"
                    style={{ color: value >= costBasis ? 'var(--color-gain)' : 'var(--color-loss)' }}
                  >
                    {value >= costBasis ? 'Above' : 'Below'} cost · {money(value - costBasis)}
                  </p>
                )}
              </div>
            )
          }}
        />
        {typeof costBasis === 'number' && costBasis > 0 && (
          <ReferenceLine
            y={costBasis}
            stroke="hsl(var(--foreground-subtle))"
            strokeDasharray="4 4"
            label={{
              value: `Cost ${money(costBasis)}`,
              position: 'right',
              fill: 'hsl(var(--foreground-subtle))',
              fontSize: 11,
            }}
          />
        )}
        <Area
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={1.75}
          fill="url(#pnl-fill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function safeFormat(value: string, fmt: string): string {
  try {
    return format(parseISO(value), fmt)
  } catch {
    return value
  }
}
