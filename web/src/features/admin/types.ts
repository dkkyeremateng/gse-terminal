/**
 * Admin endpoint shapes.
 *
 * Note: most admin endpoints (`/v1/admin/users`, `/v1/admin/audit`,
 * `/v1/admin/sectors`) return HTML for the legacy /ui's HTMX consumer,
 * not JSON. This file only types the JSON-clean ones the SPA can use:
 *  - /v1/admin/pro-requests (list)
 *  - /v1/admin/pro-requests/count
 *  - /v1/admin/pro-requests/{id}/decide
 *  - /v1/admin/alert-rules (list — JSON)
 *  - /v1/admin/alert-events (list — JSON)
 *  - /v1/admin/alert-stats (JSON)
 */
import type { ProRoleRequest } from '@/features/account/types'

export type AdminProRequest = ProRoleRequest

export type AlertMetric = 'price' | 'rsi' | 'pct_change'
export type AlertOp = '>' | '<' | '>=' | '<='

export interface AdminAlertRuleRow {
  id: number
  userId: number
  username: string
  symbol: string
  metric: AlertMetric
  op: AlertOp
  threshold: number
  enabled: boolean
  fireCount: number
  lastFiredAt?: string | null
  createdAt: string
}

export interface AdminAlertEventRow {
  id: number
  ruleId: number
  userId: number
  username: string
  symbol: string
  metric: AlertMetric
  op: AlertOp
  threshold: number
  observedValue: number
  firedAt: string
  readAt?: string | null
}

/** Matches the AlertStats shape returned by /v1/admin/alert-stats. */
export interface AdminAlertStats {
  totalRules: number
  activeRules: number
  usersWithRule: number
  firesToday: number
  firesThisWeek: number
}

export interface DecideProRequestInput {
  decision: 'approve' | 'deny'
  note?: string
}

/** Mirrors the Go `repository.User` JSON tags (snake_case for is_locked/created_at). */
export interface AdminUser {
  id: number
  username: string
  role: 'user' | 'pro' | 'analyst' | 'bot' | 'admin' | string
  is_locked: boolean
  created_at: string
}

export const ADMIN_ROLES: AdminUser['role'][] = ['user', 'pro', 'analyst', 'bot', 'admin']

export interface AdminAuditEntry {
  id: number
  actorId?: number | null
  actorUsername: string
  action: string
  targetType: string
  targetId: string
  metadata?: string
  createdAt: string
}

export interface IngestResult {
  inserted: number
  skipped: number
}
