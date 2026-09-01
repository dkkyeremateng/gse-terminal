import type { components } from '@/lib/api/types-generated'

/**
 * Identity envelope returned by GET /v1/me.
 *
 * `isAuthenticated` is the only required field — the rest are present only
 * for signed-in callers. Note that the OpenAPI schema lists role as
 * `'basic' | 'pro' | 'admin'` but signups created by the legacy /ui flow
 * land with role 'user' due to backend spec drift.
 */
export type Me = components['schemas']['MeResponse']
export type UserRole = NonNullable<Me['role']>

export interface CredentialsRequest {
  username: string
  password: string
}
