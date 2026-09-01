import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider } from './providers/AuthProvider'
import { AuthLayout } from './layouts/AuthLayout'
import { AppShell } from './layouts/AppShell'
import { SettingsLayout } from './layouts/SettingsLayout'
import { RequireAdmin, RequireAuth, RequirePro } from './RequireAuth'
import NotFound from '@/routes/NotFound'

/**
 * Route-level code splitting.
 *
 * Each route is dynamically imported, so the initial JS bundle holds only
 * the auth shell + dashboard chrome. Heavy deps like `lightweight-charts`
 * (chart route), `recharts` (portfolio + dashboard), and the research panels
 * load on demand when the user navigates to those screens.
 *
 * The two routes that are critical for first paint when authenticated —
 * Login and Dashboard — are kept in their own chunks but warmed via
 * `prefetch` priority where possible (browsers prefetch dynamic imports
 * after main parse).
 */
const Login = lazy(() => import('@/routes/auth/Login'))
const Signup = lazy(() => import('@/routes/auth/Signup'))
const Dashboard = lazy(() => import('@/routes/dashboard/Dashboard'))
const Markets = lazy(() => import('@/routes/markets/Markets'))
const MarketDetail = lazy(() => import('@/routes/markets/MarketDetail'))
const Portfolio = lazy(() => import('@/routes/portfolio/Portfolio'))
const Alerts = lazy(() => import('@/routes/alerts/Alerts'))
const Research = lazy(() => import('@/routes/research/Research'))
const Profile = lazy(() => import('@/routes/settings/Profile'))
const Security = lazy(() => import('@/routes/settings/Security'))
const ApiKeys = lazy(() => import('@/routes/settings/ApiKeys'))
const Notifications = lazy(() => import('@/routes/settings/Notifications'))
const ProAccess = lazy(() => import('@/routes/settings/ProAccess'))
const Admin = lazy(() => import('@/routes/admin/Admin'))

function Root() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}

function PageFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-foreground-muted">
      <div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  )
}

function lazyRoute(Element: React.ComponentType) {
  return (
    <Suspense fallback={<PageFallback />}>
      <Element />
    </Suspense>
  )
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      {
        element: <AuthLayout />,
        children: [
          { path: '/login', element: lazyRoute(Login) },
          { path: '/signup', element: lazyRoute(Signup) },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: '/dashboard', element: lazyRoute(Dashboard) },
              { path: '/markets', element: lazyRoute(Markets) },
              { path: '/markets/:symbol', element: lazyRoute(MarketDetail) },
              { path: '/portfolio', element: lazyRoute(Portfolio) },
              { path: '/watchlist', element: <Navigate to="/markets?view=watching" replace /> },
              { path: '/sectors', element: <Navigate to="/markets" replace /> },
              { path: '/news', element: <Navigate to="/markets" replace /> },
              { path: '/settings', element: <Navigate to="/settings/profile" replace /> },
              {
                element: <SettingsLayout />,
                children: [
                  { path: '/settings/profile', element: lazyRoute(Profile) },
                  { path: '/settings/security', element: lazyRoute(Security) },
                  { path: '/settings/api-keys', element: lazyRoute(ApiKeys) },
                  { path: '/settings/notifications', element: lazyRoute(Notifications) },
                  { path: '/settings/pro', element: lazyRoute(ProAccess) },
                ],
              },
              {
                element: <RequirePro />,
                children: [
                  { path: '/alerts', element: lazyRoute(Alerts) },
                  { path: '/research', element: lazyRoute(Research) },
                ],
              },
              {
                element: <RequireAdmin />,
                children: [{ path: '/admin', element: lazyRoute(Admin) }],
              },
            ],
          },
        ],
      },
      { path: '/404', element: <NotFound /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])
