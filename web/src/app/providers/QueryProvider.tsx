import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/lib/api/client'

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              if (error instanceof ApiError) {
                if (error.status === 401 || error.status === 403 || error.status === 404) return false
              }
              return failureCount < 2
            },
          },
          mutations: {
            retry: false,
          },
        },
      }),
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
