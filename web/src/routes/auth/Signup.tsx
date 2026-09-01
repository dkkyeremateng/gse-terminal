import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api/client'
import { useAuthStore } from '@/features/auth/store'

const schema = z.object({
  username: z
    .string()
    .min(3, 'At least 3 characters')
    .max(32, 'At most 32 characters')
    .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, numbers, _ and - only'),
  password: z.string().min(8, 'At least 8 characters'),
})

type FormValues = z.infer<typeof schema>

export default function Signup() {
  const navigate = useNavigate()
  const signup = useAuthStore((s) => s.signup)
  const [topError, setTopError] = useState<string | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setTopError(null)
    try {
      await signup({ username: values.username.trim().toLowerCase(), password: values.password })
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setTopError(err instanceof ApiError ? err.message : 'Network error. Please try again.')
    }
  }

  const isSubmitting = form.formState.isSubmitting

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-foreground-muted">Start tracking the GSE in seconds.</p>
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
            placeholder="3–32 chars, lowercase, _ -"
            spellCheck={false}
            {...form.register('username')}
          />
          {form.formState.errors.username && (
            <p className="text-xs text-destructive">{form.formState.errors.username.message}</p>
          )}
          <p className="text-[11px] text-foreground-subtle">You can add an email later under Settings.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting && <Loader2 className="size-4 animate-spin" />}
          Create account
        </Button>
      </form>

      <p className="text-center text-sm text-foreground-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-foreground hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
