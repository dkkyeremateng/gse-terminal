import type { components } from '@/lib/api/types-generated'

export type APIKey = components['schemas']['APIKey']
export type APIKeyWithSecret = components['schemas']['APIKeyWithSecret']

/** Pro role request shape — derived from Go's ProRoleRequest struct. */
export interface ProRoleRequest {
  id: number
  userId: number
  username: string
  reason: string
  status: 'pending' | 'approved' | 'denied'
  createdAt: string
  decidedAt?: string | null
  decidedBy?: number | null
  decidedByUsername?: string
  adminNote?: string
}

export interface ProRequestEnvelope {
  request: ProRoleRequest | null
  role?: string
}

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}
