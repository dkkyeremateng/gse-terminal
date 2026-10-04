import { create } from 'zustand'
import { api } from '@/lib/api/client'
import type { CredentialsRequest, Me } from './types'

interface AuthState {
  me: Me | null
  status: 'idle' | 'loading' | 'authenticated' | 'unauthenticated'
  bootstrap: () => Promise<void>
  login: (req: CredentialsRequest) => Promise<void>
  signup: (req: CredentialsRequest) => Promise<void>
  logout: () => Promise<void>
  reset: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  me: null,
  status: 'idle',

  bootstrap: async () => {
    set({ status: 'loading' })
    try {
      const me = await api.get<Me>('/v1/me')
      set({
        me,
        status: me.isAuthenticated ? 'authenticated' : 'unauthenticated',
      })
    } catch {
      set({ me: null, status: 'unauthenticated' })
    }
  },

  // The /v1/auth/* endpoints are the JSON counterparts to the legacy
  // /login, /signup and /logout, which answer with a 302 or plain text —
  // neither of which the typed client can read. They set the same session
  // and refresh cookies, so the follow-up /v1/me returns the full identity
  // envelope (provider, email verification, available OAuth providers)
  // that the login response's summary deliberately omits.
  login: async ({ username, password }) => {
    await api.post('/v1/auth/login', { username, password })
    const me = await api.get<Me>('/v1/me')
    set({ me, status: me.isAuthenticated ? 'authenticated' : 'unauthenticated' })
  },

  signup: async ({ username, password }) => {
    await api.post('/v1/auth/signup', { username, password })
    const me = await api.get<Me>('/v1/me')
    set({ me, status: me.isAuthenticated ? 'authenticated' : 'unauthenticated' })
  },

  logout: async () => {
    try {
      await api.post('/v1/auth/logout')
    } catch {
      /* ignore — local state still resets */
    }
    set({ me: null, status: 'unauthenticated' })
  },

  reset: () => set({ me: null, status: 'unauthenticated' }),
}))

export const useUser = () => useAuthStore((s) => s.me)
export const useAuthStatus = () => useAuthStore((s) => s.status)
