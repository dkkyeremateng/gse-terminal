import { describe, expect, it } from 'vitest'
import { signedMoney } from './currency'
import { formatAsOfText, formatDateTimeTitle, formatSessionCloseLabel } from './date'

describe('currency formatters', () => {
  it('formats signed Ghana cedi amounts with currency symbol', () => {
    expect(signedMoney(440)).toContain('GH₵')
    expect(signedMoney(440)).toContain('+')
  })
})

describe('date formatters', () => {
  it('drops midnight from date-only markers', () => {
    const iso = '2026-05-19T00:00:00Z'
    expect(formatAsOfText(iso)).toBe('as of 19 May')
    expect(formatSessionCloseLabel(iso)).toBe('Closed · last session 19 May')
    expect(formatDateTimeTitle(iso)).toBe('19 May 2026')
  })

  it('retains clock time for intraday timestamps', () => {
    const iso = '2026-05-19T15:30:00Z'
    expect(formatAsOfText(iso)).toContain('15:30')
    expect(formatDateTimeTitle(iso)).toContain('2026')
  })
})
