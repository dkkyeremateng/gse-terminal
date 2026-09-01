/**
 * Typed fetch wrapper for the ges-data-engine Go API.
 *
 * Behavior:
 *  - Same-origin in dev (Vite proxies /v1, /auth, /login etc → :8080)
 *  - Sends credentials so the JWT cookie / session cookie is included
 *  - Surfaces request IDs and structured ApiError on non-2xx
 *  - Auto-refreshes once on 401 via /auth/refresh, then replays the original request
 *  - Single-flights concurrent refreshes
 */

export interface ApiErrorShape {
  status: number
  code?: string
  message: string
  requestId?: string
  details?: unknown
}

export class ApiError extends Error implements ApiErrorShape {
  status: number
  code?: string
  requestId?: string
  details?: unknown

  constructor(shape: ApiErrorShape) {
    super(shape.message)
    this.name = 'ApiError'
    this.status = shape.status
    this.code = shape.code
    this.requestId = shape.requestId
    this.details = shape.details
  }
}

type FetchInit = Omit<RequestInit, 'body'> & {
  body?: unknown
  /** When set, body is encoded as application/x-www-form-urlencoded. */
  form?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined | null>
  raw?: boolean
}

let refreshInFlight: Promise<boolean> | null = null
let onUnauthorizedHandler: (() => void) | null = null

export const setOnUnauthorized = (handler: () => void) => {
  onUnauthorizedHandler = handler
}

const buildUrl = (path: string, query?: FetchInit['query']) => {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

const refreshToken = async (): Promise<boolean> => {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })
      return res.ok
    } catch {
      return false
    } finally {
      // allow next refresh after this one settles
      setTimeout(() => {
        refreshInFlight = null
      }, 0)
    }
  })()
  return refreshInFlight
}

export async function apiFetch<T = unknown>(path: string, init: FetchInit = {}): Promise<T> {
  const { body, form, query, raw, headers, ...rest } = init

  const isForm = form !== undefined
  const encodedBody = isForm
    ? new URLSearchParams(form).toString()
    : body !== undefined
      ? JSON.stringify(body)
      : undefined

  const doFetch = () =>
    fetch(buildUrl(path, query), {
      ...rest,
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        ...(isForm ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(!isForm && body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      body: encodedBody,
    })

  let res = await doFetch()

  if (res.status === 401 && !path.startsWith('/auth/')) {
    const ok = await refreshToken()
    if (ok) {
      res = await doFetch()
    } else {
      onUnauthorizedHandler?.()
    }
  }

  if (raw) return res as unknown as T

  const requestId = res.headers.get('x-request-id') ?? undefined

  if (res.status === 204) return undefined as T

  const contentType = res.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json') ? await res.json() : await res.text()

  if (!res.ok) {
    const message =
      typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : typeof payload === 'string' && payload
          ? payload
          : `Request failed with status ${res.status}`
    const code =
      typeof payload === 'object' && payload && 'code' in payload
        ? String((payload as { code: unknown }).code)
        : undefined
    throw new ApiError({ status: res.status, message, code, requestId, details: payload })
  }

  // Caller asked for JSON (typed `api.*` helpers all do) but the server
  // returned text — likely a stale binary still serving the legacy HTMX
  // HTML payload, or an error page slipped past the !ok branch above.
  // Surface it as a structured ApiError instead of letting the caller
  // try to iterate an HTML string as if it were `T`.
  if (!contentType.includes('application/json')) {
    throw new ApiError({
      status: res.status,
      message: 'Expected JSON response but received non-JSON payload',
      requestId,
      details: payload,
    })
  }

  return payload as T
}

export const api = {
  get: <T>(path: string, init?: Omit<FetchInit, 'body' | 'method'>) =>
    apiFetch<T>(path, { ...init, method: 'GET' }),
  post: <T>(path: string, body?: unknown, init?: Omit<FetchInit, 'body' | 'method'>) =>
    apiFetch<T>(path, { ...init, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, init?: Omit<FetchInit, 'body' | 'method'>) =>
    apiFetch<T>(path, { ...init, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, init?: Omit<FetchInit, 'body' | 'method'>) =>
    apiFetch<T>(path, { ...init, method: 'PATCH', body }),
  delete: <T>(path: string, init?: Omit<FetchInit, 'body' | 'method'>) =>
    apiFetch<T>(path, { ...init, method: 'DELETE' }),
}
