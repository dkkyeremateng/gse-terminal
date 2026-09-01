const LOCALE = 'en-GH'

export const money = (value: number, currency = 'GHS', maximumFractionDigits = 2) =>
  new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    maximumFractionDigits,
  }).format(value)

export const signedMoney = (value: number, currency = 'GHS', maximumFractionDigits = 2) =>
  new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    maximumFractionDigits,
    signDisplay: 'exceptZero',
  }).format(value)
