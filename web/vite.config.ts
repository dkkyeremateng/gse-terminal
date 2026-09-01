import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const BACKEND = process.env.VITE_API_PROXY ?? 'http://localhost:8080'

/**
 * For paths that the Go backend serves both as HTML pages (GET) AND as API
 * endpoints (POST/etc) — /login, /signup, /logout — we only want to proxy
 * non-GET requests so that the React SPA can own the GET routes. The bypass
 * function returns the original URL (causing Vite to handle it as an SPA
 * fallback) for GET requests, and undefined for everything else (proxy).
 */
const bypassGetForSpa = (req: { method?: string; url?: string }) =>
  req.method === 'GET' ? req.url : undefined

/**
 * Dev-only JSON login bridge. The backend's `/login` handler returns a
 * 302 redirect on success and plain-text on failure — neither is JSON,
 * so the typed API client rejects the response. This middleware accepts
 * `POST /api/v1/auth/login` with a JSON body, forwards to the backend as
 * form-encoded, forwards any Set-Cookie headers back to the browser, and
 * replies with `{ ok: true }` (or `{ message }` on failure).
 *
 * Dev-only: a production build replaces this with a real backend handler.
 */
function loginJsonBridge(backend: string): Plugin {
  return {
    name: 'gse-login-json-bridge',
    configureServer(server) {
      server.middlewares.use('/api/v1/auth/login', async (req, res, next) => {
        if (req.method !== 'POST') return next()

        try {
          const chunks: Buffer[] = []
          for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf-8')

          let payload: { username?: unknown; password?: unknown } = {}
          try {
            payload = raw ? JSON.parse(raw) : {}
          } catch {
            return writeJson(res, 400, { message: 'Invalid JSON body' })
          }

          const username = typeof payload.username === 'string' ? payload.username.trim() : ''
          const password = typeof payload.password === 'string' ? payload.password : ''
          if (!username || !password) {
            return writeJson(res, 400, { message: 'Username and password are required' })
          }

          const upstream = await fetch(`${backend}/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username, password }).toString(),
            redirect: 'manual',
          })

          const setCookies =
            typeof upstream.headers.getSetCookie === 'function'
              ? upstream.headers.getSetCookie()
              : []
          for (const cookie of setCookies) res.appendHeader('set-cookie', cookie)

          // Backend uses 302 -> /terminal on success.
          if (upstream.status === 302 || upstream.status === 303) {
            return writeJson(res, 200, { ok: true })
          }

          const text = (await upstream.text()).trim()
          const status = upstream.status >= 400 ? upstream.status : 401
          return writeJson(res, status, { message: text || 'Sign in failed' })
        } catch (err) {
          return writeJson(res, 502, {
            message: err instanceof Error ? err.message : 'Upstream login bridge failed',
          })
        }
      })
    },
  }
}

function writeJson(
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void },
  status: number,
  body: Record<string, unknown>,
) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

export default defineConfig({
  plugins: [react(), tailwindcss(), loginJsonBridge(BACKEND)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Pure API & infra — always proxy
      '/v1': { target: BACKEND, changeOrigin: true },
      '/upload': { target: BACKEND, changeOrigin: true },
      '/healthz': { target: BACKEND, changeOrigin: true },
      '/readyz': { target: BACKEND, changeOrigin: true },
      '/ws': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
        // Backend ALLOWED_ORIGINS likely lists only the backend's own host; the
        // dev origin is :5173 which fails the WS Origin check. Rewrite it to
        // match the upstream during dev so the handshake passes.
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            try {
              proxyReq.setHeader('origin', BACKEND)
            } catch {
              /* noop */
            }
          })
        },
      },

      // OAuth — always proxy (GET redirects to provider, callback returns to backend)
      '/auth': { target: BACKEND, changeOrigin: true },

      // Auth endpoints shared with the legacy /ui — only proxy non-GET so the SPA owns the page
      '/login': { target: BACKEND, changeOrigin: true, bypass: bypassGetForSpa },
      '/signup': { target: BACKEND, changeOrigin: true, bypass: bypassGetForSpa },
      '/logout': { target: BACKEND, changeOrigin: true, bypass: bypassGetForSpa },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
} as never)
