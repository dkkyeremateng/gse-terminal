import { useEffect, useRef, useState } from 'react'
import { getWsClient } from './client'
import type { WsConnectionState, WsEventMap, WsEventName } from './events'

/**
 * Subscribe to a typed WebSocket event for the lifetime of the component.
 *
 * The handler is stored in a ref so consumers can pass inline closures without
 * triggering re-subscription on every render.
 */
export function useWsEvent<K extends WsEventName>(type: K, handler: (data: WsEventMap[K]) => void) {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    const client = getWsClient()
    const off = client.on(type, (d) => ref.current(d))
    return off
  }, [type])
}

export function useWsConnectionState(): WsConnectionState {
  const [state, setState] = useState<WsConnectionState>(() => getWsClient().getState())

  useEffect(() => {
    const client = getWsClient()
    const off = client.onState(setState)
    return off
  }, [])

  return state
}
