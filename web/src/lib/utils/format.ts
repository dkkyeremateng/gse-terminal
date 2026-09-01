import { money, signedMoney } from '@/lib/format/currency'

const LOCALE = 'en-GH'

export { money, signedMoney }

export const number = (value: number, fractionDigits = 2) =>
  new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)

export const compact = (value: number) =>
  new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 }).format(value)

export const percent = (value: number, withSign = true) => {
  const sign = withSign && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export const signed = (value: number, fractionDigits = 2) => {
  const sign = value > 0 ? '+' : ''
  return `${sign}${number(value, fractionDigits)}`
}
