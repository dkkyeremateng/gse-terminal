import { useUser } from './store'

/**
 * Single source of truth for feature gating.
 *
 * Pro-only features are HIDDEN ENTIRELY for non-pro users — no upsell modals,
 * no lock icons. Routes return 404, sidebar items disappear.
 */
export const useEntitlements = () => {
  const me = useUser()
  const isAuthenticated = Boolean(me?.isAuthenticated)
  const role = me?.role
  const isAdmin = isAuthenticated && (role === 'admin' || me?.isAdmin === true)
  const isPro = isAuthenticated && (role === 'pro' || isAdmin)
  return { isAuthenticated, isPro, isAdmin }
}
