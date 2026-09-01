import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'dark' | 'light' | 'system'
const STORAGE_KEY = 'ges-pro-theme'

interface ThemeContextValue {
  theme: Theme
  resolved: 'dark' | 'light'
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const getSystem = (): 'dark' | 'light' =>
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'

const applyTheme = (resolved: 'dark' | 'light') => {
  const root = document.documentElement
  root.classList.toggle('light', resolved === 'light')
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark'
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'dark'
  })

  const [resolved, setResolved] = useState<'dark' | 'light'>(() =>
    theme === 'system' ? getSystem() : (theme as 'dark' | 'light'),
  )

  useEffect(() => {
    const next = theme === 'system' ? getSystem() : (theme as 'dark' | 'light')
    setResolved(next)
    applyTheme(next)
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => {
      const next = getSystem()
      setResolved(next)
      applyTheme(next)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const setTheme = (next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next)
    setThemeState(next)
  }

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
