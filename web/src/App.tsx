import { RouterProvider } from 'react-router-dom'
import { Toaster } from 'sonner'
import { ThemeProvider } from './app/providers/ThemeProvider'
import { QueryProvider } from './app/providers/QueryProvider'
import { ErrorBoundary } from './app/ErrorBoundary'
import { router } from './app/router'

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryProvider>
          <RouterProvider router={router} />
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              classNames: {
                toast: 'bg-popover border border-border text-popover-foreground',
              },
            }}
          />
        </QueryProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
