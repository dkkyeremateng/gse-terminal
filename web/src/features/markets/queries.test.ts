import { describe, expect, it } from 'vitest'
import { marketKeys } from './queries'
import { sessionKeys } from '@/features/session/useMarketSession'

describe('market query key namespaces', () => {
  it('uses quote and session namespaces', () => {
    expect(marketKeys.quotes.summary()).toEqual(['quotes', 'summary'])
    expect(marketKeys.quotes.bySymbol('GCB')).toEqual(['quotes', 'GCB'])
    expect(sessionKeys.all()).toEqual(['session'])
  })
})
