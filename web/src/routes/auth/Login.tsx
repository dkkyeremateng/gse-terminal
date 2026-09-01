import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Github, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api/client'
import { useAuthStore } from '@/features/auth/store'

const schema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
})

type FormValues = z.infer<typeof schema>

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const login = useAuthStore((s) => s.login)
  const [topError, setTopError] = useState<string | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setTopError(null)
    try {
      await login({ username: values.username.trim().toLowerCase(), password: values.password })
      const redirectTo = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/dashboard'
      navigate(redirectTo, { replace: true })
    } catch (err) {
      setTopError(err instanceof ApiError ? err.message || 'Sign in failed' : 'Network error. Please try again.')
    }
  }

  const isSubmitting = form.formState.isSubmitting

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-foreground-muted">Welcome back. Enter your credentials to continue.</p>
      </div>

      {topError && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {topError}
        </div>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            autoFocus
            placeholder="lowercase letters, numbers, _ -"
            spellCheck={false}
            aria-invalid={Boolean(form.formState.errors.username) || undefined}
            {...form.register('username')}
          />
          {form.formState.errors.username && (
            <p className="text-xs text-destructive">{form.formState.errors.username.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            aria-invalid={Boolean(form.formState.errors.password) || undefined}
            {...form.register('password')}
          />
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting && <Loader2 className="size-4 animate-spin" />}
          Sign in
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-foreground-subtle">
        <span className="h-px flex-1 bg-border" />
        <span>OR</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="grid gap-2">
        <Button asChild variant="outline" className="w-full">
          <a href="/auth/google/login">
            <GoogleIcon className="size-4" />
            Continue with Google
          </a>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <a href="/auth/github/login">
            <Github className="size-4" />
            Continue with GitHub
          </a>
        </Button>
      </div>

      <p className="text-center text-sm text-foreground-muted">
        New to GES Pro?{' '}
        <Link to="/signup" className="font-medium text-foreground hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  )
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.66 4.1-5.35 4.1-3.22 0-5.85-2.66-5.85-5.95 0-3.3 2.63-5.95 5.85-5.95 1.83 0 3.06.78 3.76 1.45l2.57-2.47C16.74 4.06 14.6 3 12 3 6.97 3 2.9 7.06 2.9 12.1c0 5.04 4.07 9.1 9.1 9.1 5.26 0 8.74-3.7 8.74-8.9 0-.6-.06-1.05-.14-1.5z"
      />
    </svg>
  )
}
