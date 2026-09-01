import { useEffect, useRef } from 'react'

interface HotkeyOptions {
  /** Don't trigger when focus is inside an editable element. Default true. */
  ignoreEditable?: boolean
  /** prevent default when fired. Default true. */
  preventDefault?: boolean
}

const isEditable = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

const matches = (e: KeyboardEvent, combo: string): boolean => {
  const parts = combo.toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const want = {
    meta: parts.includes('mod') || parts.includes('cmd') || parts.includes('meta'),
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  }
  // 'mod' = meta on mac, ctrl elsewhere
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)
  const modOk = parts.includes('mod') ? (isMac ? e.metaKey : e.ctrlKey) : (e.metaKey === want.meta && e.ctrlKey === want.ctrl)
  return (
    modOk &&
    e.shiftKey === want.shift &&
    e.altKey === want.alt &&
    e.key.toLowerCase() === key
  )
}

/**
 * Bind a global keyboard shortcut.
 *
 * Examples:
 *   useHotkey('mod+k', () => openPalette())
 *   useHotkey('shift+/', () => openHelp(), { ignoreEditable: false })
 */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, options: HotkeyOptions = {}) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const { ignoreEditable = true, preventDefault = true } = options
    const onKey = (e: KeyboardEvent) => {
      if (ignoreEditable && isEditable(e.target)) return
      if (!matches(e, combo)) return
      if (preventDefault) e.preventDefault()
      handlerRef.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combo, options.ignoreEditable, options.preventDefault])
}
