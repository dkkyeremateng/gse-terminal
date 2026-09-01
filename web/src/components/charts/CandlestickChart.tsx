import { useEffect, useRef } from 'react'
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type { OHLCBar } from '@/features/markets/types'
import { useTheme } from '@/app/providers/ThemeProvider'

interface CandlestickChartProps {
  bars: OHLCBar[]
  height?: number
  /** Optional volume histogram below the candles. */
  withVolume?: boolean
}

/**
 * Wrapper around TradingView's lightweight-charts.
 *
 * Reads CSS color tokens at mount and re-applies them when the theme flips so
 * the chart always matches the surrounding UI.
 */
export function CandlestickChart({ bars, height = 360, withVolume = true }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const { resolved } = useTheme()

  // Mount the chart once; data + theme updates handled below.
  useEffect(() => {
    if (!containerRef.current) return
    const colors = readChartColors()
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: colors.foregroundMuted,
        fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: colors.gridline, style: LineStyle.Solid },
        horzLines: { color: colors.gridline, style: LineStyle.Solid },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: false, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed },
        horzLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: false },
    })

    candleRef.current = chart.addCandlestickSeries({
      upColor: colors.gain,
      borderUpColor: colors.gain,
      wickUpColor: colors.gain,
      downColor: colors.loss,
      borderDownColor: colors.loss,
      wickDownColor: colors.loss,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })

    if (withVolume) {
      volumeRef.current = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        color: colors.muted,
      })
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      })
    }

    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withVolume])

  // Re-apply theme on toggle without recreating the chart.
  useEffect(() => {
    if (!chartRef.current) return
    const c = readChartColors()
    chartRef.current.applyOptions({
      layout: { textColor: c.foregroundMuted, background: { type: ColorType.Solid, color: 'transparent' } },
      grid: { vertLines: { color: c.gridline }, horzLines: { color: c.gridline } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
      crosshair: { vertLine: { color: c.crosshair }, horzLine: { color: c.crosshair } },
    })
    candleRef.current?.applyOptions({
      upColor: c.gain,
      borderUpColor: c.gain,
      wickUpColor: c.gain,
      downColor: c.loss,
      borderDownColor: c.loss,
      wickDownColor: c.loss,
    })
    volumeRef.current?.applyOptions({ color: c.muted })
  }, [resolved])

  // Push data when bars change.
  useEffect(() => {
    if (!candleRef.current) return
    const candles = bars
      .filter((b) => typeof b.timestamp === 'string' && typeof b.close === 'number')
      .map((b) => ({
        time: toLwTime(b.timestamp),
        open: b.open ?? b.close,
        high: b.high ?? Math.max(b.open ?? b.close, b.close),
        low: b.low ?? Math.min(b.open ?? b.close, b.close),
        close: b.close,
      }))
    candleRef.current.setData(candles)

    if (volumeRef.current) {
      const root = document.documentElement
      const css = getComputedStyle(root)
      const upColor = hslTripleToRgba(css.getPropertyValue('--gain').trim(), 0.35)
      const downColor = hslTripleToRgba(css.getPropertyValue('--loss').trim(), 0.35)
      const vol = bars
        .filter((b) => typeof b.volume === 'number')
        .map((b) => {
          const up = (b.close ?? 0) >= (b.open ?? b.close ?? 0)
          return {
            time: toLwTime(b.timestamp),
            value: b.volume ?? 0,
            color: up ? upColor : downColor,
          }
        })
      volumeRef.current.setData(vol)
    }
    chartRef.current?.timeScale().fitContent()
  }, [bars])

  return <div ref={containerRef} style={{ height }} className="w-full" />
}

/**
 * Read theme-derived chart colors from CSS variables and convert to rgba().
 *
 * lightweight-charts' bundled color parser only accepts hex / rgb / rgba /
 * named CSS colors — not hsl(). The token system stores `H S% L%` triples,
 * so we resolve them to rgba() at read time.
 */
function readChartColors() {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const rgba = (name: string, alpha = 1) => hslTripleToRgba(css.getPropertyValue(name).trim(), alpha)
  return {
    foreground: rgba('--foreground'),
    foregroundMuted: rgba('--foreground-muted'),
    border: rgba('--border'),
    gridline: rgba('--border', 0.5),
    crosshair: rgba('--foreground-muted'),
    gain: rgba('--gain'),
    loss: rgba('--loss'),
    muted: rgba('--muted-foreground'),
  }
}

function hslTripleToRgba(triple: string, alpha = 1): string {
  // Accepts "H S% L%" (with spaces or commas); H in degrees, S/L in percent.
  const match = triple.match(/(-?\d+(?:\.\d+)?)[, ]+(-?\d+(?:\.\d+)?)%[, ]+(-?\d+(?:\.\d+)?)%/)
  if (!match) return `rgba(255, 255, 255, ${alpha})`
  const h = Number(match[1])
  const s = Number(match[2]) / 100
  const l = Number(match[3]) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const ri = Math.round((r + m) * 255)
  const gi = Math.round((g + m) * 255)
  const bi = Math.round((b + m) * 255)
  return alpha < 1 ? `rgba(${ri}, ${gi}, ${bi}, ${alpha})` : `rgb(${ri}, ${gi}, ${bi})`
}

function toLwTime(ts: string): Time {
  // YYYY-MM-DD lightweight-charts business-day format works best for daily/weekly.
  return ts.slice(0, 10) as Time
}
