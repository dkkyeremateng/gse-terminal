import { toast as sonnerToast } from 'sonner'
import { ApiError } from '@/lib/api/client'

interface ToastOptions {
  description?: string
  duration?: number
  /** Show the request ID for debuggability when present. */
  requestId?: string
}

const withRequestId = (description: string | undefined, requestId: string | undefined) => {
  if (!requestId) return description
  return description ? `${description}\n\nRef: ${requestId}` : `Ref: ${requestId}`
}

export const toast = {
  success: (message: string, opts: ToastOptions = {}) =>
    sonnerToast.success(message, {
      description: withRequestId(opts.description, opts.requestId),
      duration: opts.duration ?? 3500,
    }),

  error: (message: string, opts: ToastOptions = {}) =>
    sonnerToast.error(message, {
      description: withRequestId(opts.description, opts.requestId),
      duration: opts.duration ?? 6000,
    }),

  info: (message: string, opts: ToastOptions = {}) =>
    sonnerToast(message, {
      description: withRequestId(opts.description, opts.requestId),
      duration: opts.duration ?? 4000,
    }),

  /** Surface an unknown error as a toast with sensible fallbacks + request ID. */
  fromError: (err: unknown, fallback = 'Something went wrong') => {
    if (err instanceof ApiError) {
      return sonnerToast.error(err.message || fallback, {
        description: withRequestId(undefined, err.requestId),
        duration: 6000,
      })
    }
    if (err instanceof Error) {
      return sonnerToast.error(fallback, { description: err.message, duration: 5000 })
    }
    return sonnerToast.error(fallback, { duration: 5000 })
  },

  promise: sonnerToast.promise,
  dismiss: sonnerToast.dismiss,
}
