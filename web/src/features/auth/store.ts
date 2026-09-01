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

  // Login goes through the dev-server JSON bridge (`vite.config.ts`'s
  // `loginJsonBridge`) because the legacy backend `/login` replies with
  // a 302 or plain text — neither is JSON, so the typed client rejects
  // it. The bridge forwards form-encoded credentials upstream, relays
  // Set-Cookie, and returns `{ ok: true }` on success. On the canonical
  // identity envelope we still re-fetch `/v1/me`.
  login: async ({ username, password }) => {
    await api.post('/api/v1/auth/login', { username, password })
    const me = await api.get<Me>('/v1/me')
    set({ me, status: me.isAuthenticated ? 'authenticated' : 'unauthenticated' })
  },

  signup: async ({ username, password }) => {
    await api.post('/signup', undefined, { form: { username, password } })
    const me = await api.get<Me>('/v1/me')
    set({ me, status: me.isAuthenticated ? 'authenticated' : 'unauthenticated' })
  },

  logout: async () => {
    try {
      await api.post('/logout')
    } catch {
      /* ignore — local state still resets */
    }
    set({ me: null, status: 'unauthenticated' })
  },

  reset: () => set({ me: null, status: 'unauthenticated' }),
}))

export const useUser = () => useAuthStore((s) => s.me)
export const useAuthStatus = () => useAuthStore((s) => s.status)
