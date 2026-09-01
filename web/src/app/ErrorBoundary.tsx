import { Component, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/client'

interface Props {
  children: ReactNode
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * Top-level boundary for unexpected runtime errors.
 *
 * Renders a recoverable empty state with the request ID surfaced when the
 * crash originated from an API call.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error, info.componentStack)
    }
    // Future: forward to /v1/client-error
  }

  reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset)
    return <DefaultFallback error={this.state.error} reset={this.reset} />
  }
}

function DefaultFallback({ error, reset }: { error: Error; reset: () => void }) {
  const requestId = error instanceof ApiError ? error.requestId : undefined
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-6 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <AlertTriangle className="size-5" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">Something went wrong</h2>
          <p className="text-sm text-foreground-muted">
            {error.message || 'An unexpected error occurred. Try refreshing.'}
          </p>
          {requestId && (
            <p className="font-mono text-[11px] text-foreground-subtle">Ref: {requestId}</p>
          )}
        </div>
        <div className="flex justify-center gap-2 pt-1">
          <Button onClick={reset} variant="outline">
            <RefreshCw className="size-4" />
            Try again
          </Button>
          <Button onClick={() => window.location.reload()}>Reload page</Button>
        </div>
      </div>
    </div>
  )
}
