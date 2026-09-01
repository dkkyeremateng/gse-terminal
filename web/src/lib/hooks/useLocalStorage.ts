import { useEffect, useState } from 'react'

/**
 * Simple localStorage-backed React state.
 *
 * Reads the initial value from localStorage on first render, falling back to
 * `initial` when the key is empty or parse fails. Writes back on every change.
 * Same shape as `useState` so it drops in cleanly:
 *
 *   const [open, setOpen] = useLocalStorage('markets:heatmap-open', true)
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = window.localStorage.getItem(key)
      if (raw == null) return initial
      return JSON.parse(raw) as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* quota / private mode — silent fallback to in-memory only */
    }
  }, [key, value])

  return [value, setValue]
}
