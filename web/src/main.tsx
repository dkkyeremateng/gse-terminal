import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

async function enableMocking() {
  // MSW is opt-in — only when explicitly enabled. Phase 0 talks to the real
  // backend via Vite's proxy. Set VITE_USE_MSW=true to drive the UI from fixtures.
  if (import.meta.env.VITE_USE_MSW !== 'true') return
  const { worker } = await import('./mocks/browser')
  return worker.start({ onUnhandledRequest: 'bypass' })
}

enableMocking().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
