/**
 * WebSocket event contract with the Go backend's /ws hub.
 *
 * The server broadcasts JSON envelopes shaped as { type, data }. Subscribe
 * via `useWsEvent(type, handler)` — the hook will only fire on matching events.
 */

export interface WsEnvelope<T = unknown> {
  type: string
  data: T
  ts?: string
}

export interface PriceUpdate {
  symbol: string
  price: number
  changePct?: number
  volume?: number
  ts: string
}

export interface AlertFire {
  ruleId: string
  userId: string
  symbol: string
  message: string
  ts: string
}

export interface AuditEvent {
  actor: string
  action: string
  target?: string
  ts: string
  metadata?: Record<string, unknown>
}

export interface BriefingReady {
  date: string
  url?: string
}

export type WsEventMap = {
  'price:update': PriceUpdate
  'alert:fire': AlertFire
  'audit:event': AuditEvent
  'briefing:ready': BriefingReady
}

export type WsEventName = keyof WsEventMap

export type WsConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'
