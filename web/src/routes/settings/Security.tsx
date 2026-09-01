import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useChangePassword } from '@/features/account/queries'
import { ApiError } from '@/lib/api/client'
import { toast } from '@/lib/utils/toast'

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Required'),
    newPassword: z.string().min(8, 'At least 8 characters'),
    confirmPassword: z.string().min(1, 'Required'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords don’t match',
  })

type FormValues = z.infer<typeof schema>

export default function Security() {
  const [topError, setTopError] = useState<string | null>(null)
  const change = useChangePassword()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setTopError(null)
    try {
      await change.mutateAsync({ currentPassword: values.currentPassword, newPassword: values.newPassword })
      toast.success('Password updated')
      form.reset({ currentPassword: '', newPassword: '', confirmPassword: '' })
    } catch (err) {
      setTopError(err instanceof ApiError ? err.message : 'Couldn’t change password')
    }
  }

  const submitting = form.formState.isSubmitting || change.isPending

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4 text-foreground-muted" />
            Change password
          </CardTitle>
          <CardDescription>
            Use a strong password unique to this account. Sessions on other devices stay signed in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {topError && (
            <div role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              {topError}
            </div>
          )}
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="currentPassword">Current password</Label>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                {...form.register('currentPassword')}
              />
              {form.formState.errors.currentPassword && (
                <p className="text-xs text-destructive">{form.formState.errors.currentPassword.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                {...form.register('newPassword')}
              />
              {form.formState.errors.newPassword && (
                <p className="text-xs text-destructive">{form.formState.errors.newPassword.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmPassword">Confirm new password</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                {...form.register('confirmPassword')}
              />
              {form.formState.errors.confirmPassword && (
                <p className="text-xs text-destructive">{form.formState.errors.confirmPassword.message}</p>
              )}
            </div>
            <div className="flex items-center justify-end pt-1">
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                Update password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
