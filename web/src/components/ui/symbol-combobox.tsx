import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils/cn'

interface Props {
  id?: string
  value: string
  onChange: (next: string) => void
  /** Optional onBlur for react-hook-form integration. */
  onBlur?: () => void
  symbols: string[]
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Max items shown in the dropdown. Default 80. */
  maxResults?: number
  'aria-invalid'?: boolean
}

/**
 * Styled symbol autocomplete.
 *
 * Replaces native `<datalist>`, which the browser renders as an unstyled
 * viewport-edge column. Behaves like a Combobox — typing filters, ↑/↓
 * navigates, ↵ selects, Esc closes; click-outside closes; the input itself
 * is fully controlled so this drops into react-hook-form via Controller.
 *
 * Filter ranking: exact match → prefix matches → substring matches, then
 * alphabetical inside each tier.
 */
export const SymbolCombobox = forwardRef<HTMLInputElement, Props>(function SymbolCombobox(
  {
    id,
    value,
    onChange,
    onBlur,
    symbols,
    placeholder,
    disabled,
    className,
    maxResults = 80,
    'aria-invalid': ariaInvalid,
  },
  ref,
) {
  const fallbackId = useId()
  const inputId = id ?? fallbackId
  const listboxId = `${inputId}-listbox`

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => {
    const q = value.trim().toUpperCase()
    if (!q) {
      return symbols.slice(0, maxResults)
    }
    return symbols
      .filter((s) => s.toUpperCase().includes(q))
      .sort((a, b) => {
        const A = a.toUpperCase()
        const B = b.toUpperCase()
        if (A === q && B !== q) return -1
        if (B === q && A !== q) return 1
        const ap = A.startsWith(q)
        const bp = B.startsWith(q)
        if (ap && !bp) return -1
        if (bp && !ap) return 1
        return A.localeCompare(B)
      })
      .slice(0, maxResults)
  }, [symbols, value, maxResults])

  // Reset highlighted row when the filtered list changes shape.
  useEffect(() => {
    setActive(0)
  }, [value])

  // Click-outside → close.
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLLIElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const select = (sym: string) => {
    onChange(sym)
    setOpen(false)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && filtered[active]) {
        e.preventDefault()
        select(filtered[active])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
      }
    } else if (e.key === 'Tab') {
      // Don't steal Tab — let the form move focus, but close the listbox.
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Input
          ref={ref}
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={ariaInvalid}
          onChange={(e) => {
            onChange(e.target.value.toUpperCase())
            if (!open) setOpen(true)
          }}
          onFocus={() => !disabled && setOpen(true)}
          onBlur={onBlur}
          onKeyDown={handleKey}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          className="pr-8"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? 'Close symbols' : 'Open symbols'}
          onMouseDown={(e) => {
            e.preventDefault()
            if (disabled) return
            setOpen((o) => !o)
          }}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
          disabled={disabled}
        >
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Symbols"
          className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-[var(--shadow-lg)]"
        >
          {filtered.map((sym, i) => (
            <li
              key={sym}
              data-idx={i}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                // Prevent the input from blurring before our click registers.
                e.preventDefault()
                select(sym)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'cursor-pointer px-3 py-1.5 transition-colors',
                i === active ? 'bg-secondary text-foreground' : 'text-foreground-muted',
              )}
            >
              {sym}
            </li>
          ))}
        </ul>
      )}
      {open && filtered.length === 0 && value.trim() && (
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-md border border-border bg-popover px-3 py-2 text-xs text-foreground-muted shadow-[var(--shadow-lg)]">
          No matching symbols.
        </div>
      )}
    </div>
  )
})
