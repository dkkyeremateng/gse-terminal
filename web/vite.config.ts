import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const BACKEND = process.env.VITE_API_PROXY ?? 'http://localhost:8080'

export default defineConfig({
  // The Go server mounts this app at /v2 (see internal/server/spa_handlers.go),
  // so every emitted asset URL has to carry that prefix. Keep in sync with the
  // router basename in src/app/router.tsx and SPABasePath on the Go side.
  base: '/v2/',
  plugins: [react(), tailwindcss()],
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

      // The legacy HTMX auth pages. They used to need a GET bypass so the
      // SPA could own /login at the root; now that it lives under /v2 the
      // paths no longer collide and these proxy straight through.
      '/login': { target: BACKEND, changeOrigin: true },
      '/signup': { target: BACKEND, changeOrigin: true },
      '/logout': { target: BACKEND, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
} as never)
