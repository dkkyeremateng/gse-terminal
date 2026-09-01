import type { components } from '@/lib/api/types-generated'

/**
 * Alert rule (Pro/Admin only).
 *
 * `metric` × `op` × `threshold` defines the trigger; the rule fires once,
 * then `enabled` flips to false (anti-spam). `fireCount` and `lastFiredAt`
 * are server-managed observability metadata.
 */
export type AlertRule = components['schemas']['AlertRule']
export type AlertRuleInput = components['schemas']['AlertRuleInput']
export type AlertMetric = AlertRuleInput['metric']
export type AlertOp = AlertRuleInput['op']

export const METRICS: { value: AlertMetric; label: string; hint: string }[] = [
  { value: 'price', label: 'Price', hint: 'Last traded price' },
  { value: 'rsi', label: 'RSI (14)', hint: '0–100, oversold ≤30, overbought ≥70' },
  { value: 'pct_change', label: '% change', hint: 'Today vs prior close' },
]

export const OPS: { value: AlertOp; label: string }[] = [
  { value: '>', label: 'is greater than' },
  { value: '>=', label: 'is at or above' },
  { value: '<', label: 'is less than' },
  { value: '<=', label: 'is at or below' },
]

/** Repository.AlertEvent — observed fire of a rule. */
export interface AlertEvent {
  id: number
  ruleId: number
  userId: number
  symbol: string
  metric: AlertMetric
  op: AlertOp
  threshold: number
  observedValue: number
  firedAt: string // ISO
  readAt?: string | null
}

export interface AlertEventsResponse {
  events: AlertEvent[]
  unreadCount: number
}

export type UpdateRulePatch = Partial<Pick<AlertRuleInput, 'metric' | 'op' | 'threshold'>> & {
  enabled?: boolean
}
