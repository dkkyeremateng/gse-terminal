import type { WsConnectionState, WsEnvelope, WsEventMap, WsEventName } from './events'

type Handler<K extends WsEventName> = (data: WsEventMap[K]) => void
type AnyHandler = (envelope: WsEnvelope) => void
type StateHandler = (state: WsConnectionState) => void

interface Options {
  url: string
  /** Reconnect base delay in ms; backs off exponentially up to maxDelay. */
  baseDelay?: number
  maxDelay?: number
  /** Max consecutive failed reconnect attempts before giving up. 0 = infinite. */
  maxRetries?: number
}

/**
 * Resilient WebSocket singleton.
 *
 * - Auto-reconnects with exponential backoff and jitter.
 * - Pauses reconnect when the tab is hidden, resumes on visibility/focus.
 * - Single hub keyed by URL — multiple consumers share one socket.
 * - Listeners can subscribe to typed events or to the raw envelope stream.
 */
export class WsClient {
  private socket: WebSocket | null = null
  private state: WsConnectionState = 'idle'
  private retries = 0
  private reconnectTimer: number | null = null
  private pendingOpen: number | null = null
  private explicitlyClosed = false

  private typedListeners = new Map<WsEventName, Set<Handler<WsEventName>>>()
  private rawListeners = new Set<AnyHandler>()
  private stateListeners = new Set<StateHandler>()

  constructor(private opts: Options) {}

  connect() {
    if (this.socket && (this.state === 'open' || this.state === 'connecting')) return
    this.explicitlyClosed = false
    // Defer the actual `new WebSocket()` to the next macrotask. React's
    // StrictMode mounts effects twice in development (mount → cleanup →
    // mount). Without this gate a real socket would open on the first
    // mount and get torn down before the upgrade completes, which the
    // browser surfaces as "WebSocket is closed before the connection
    // is established". Deferring lets a fast cleanup cancel the open.
    if (this.pendingOpen !== null) return
    this.pendingOpen = window.setTimeout(() => {
      this.pendingOpen = null
      this.openSocket()
      this.attachLifecycle()
    }, 0)
  }

  close() {
    this.explicitlyClosed = true
    if (this.pendingOpen !== null) {
      window.clearTimeout(this.pendingOpen)
      this.pendingOpen = null
    }
    this.clearReconnect()
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        /* noop */
      }
      this.socket = null
    }
    this.setState('closed')
    this.detachLifecycle()
  }

  send<K extends WsEventName>(type: K, data: WsEventMap[K]): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ type, data }))
    return true
  }

  on<K extends WsEventName>(type: K, handler: Handler<K>): () => void {
    if (!this.typedListeners.has(type)) this.typedListeners.set(type, new Set())
    const set = this.typedListeners.get(type) as Set<Handler<WsEventName>>
    set.add(handler as Handler<WsEventName>)
    return () => set.delete(handler as Handler<WsEventName>)
  }

  onAny(handler: AnyHandler): () => void {
    this.rawListeners.add(handler)
    return () => this.rawListeners.delete(handler)
  }

  onState(handler: StateHandler): () => void {
    this.stateListeners.add(handler)
    handler(this.state)
    return () => this.stateListeners.delete(handler)
  }

  getState() {
    return this.state
  }

  // --- internals -----------------------------------------------------------

  private openSocket() {
    this.setState('connecting')
    try {
      this.socket = new WebSocket(this.opts.url)
    } catch {
      this.setState('error')
      this.scheduleReconnect()
      return
    }

    this.socket.addEventListener('open', () => {
      this.retries = 0
      this.setState('open')
    })

    this.socket.addEventListener('message', (e) => {
      let envelope: WsEnvelope | null = null
      try {
        envelope = JSON.parse(typeof e.data === 'string' ? e.data : '') as WsEnvelope
      } catch {
        return
      }
      if (!envelope || typeof envelope.type !== 'string') return
      this.rawListeners.forEach((fn) => fn(envelope))
      const typed = this.typedListeners.get(envelope.type as WsEventName)
      typed?.forEach((fn) => fn(envelope.data as WsEventMap[WsEventName]))
    })

    this.socket.addEventListener('error', () => {
      this.setState('error')
    })

    this.socket.addEventListener('close', () => {
      this.socket = null
      if (this.explicitlyClosed) {
        this.setState('closed')
        return
      }
      this.setState('closed')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect() {
    const { baseDelay = 600, maxDelay = 30_000, maxRetries = 8 } = this.opts
    if (maxRetries > 0 && this.retries >= maxRetries) {
      // Give up — surface as error so UI can show a "Reconnect" affordance.
      this.setState('error')
      return
    }
    this.retries += 1
    const delay = Math.min(maxDelay, baseDelay * 2 ** (this.retries - 1))
    const jitter = Math.random() * 250
    this.clearReconnect()
    this.reconnectTimer = window.setTimeout(() => {
      // Don't reconnect while hidden — saves battery, avoids hammering on wakeup.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }
      this.openSocket()
    }, delay + jitter)
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setState(next: WsConnectionState) {
    this.state = next
    this.stateListeners.forEach((fn) => fn(next))
  }

  // Visibility-aware reconnect
  private onVisibility = () => {
    if (
      document.visibilityState === 'visible' &&
      this.state !== 'open' &&
      this.state !== 'connecting' &&
      !this.explicitlyClosed
    ) {
      this.openSocket()
    }
  }

  private attachLifecycle() {
    if (typeof document === 'undefined') return
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('online', this.onVisibility)
  }
  private detachLifecycle() {
    if (typeof document === 'undefined') return
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('online', this.onVisibility)
  }
}

let singleton: WsClient | null = null

export function getWsClient(): WsClient {
  if (singleton) return singleton
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}/ws`
  singleton = new WsClient({ url })
  return singleton
}
