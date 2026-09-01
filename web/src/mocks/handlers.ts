import { http, HttpResponse } from 'msw'

/**
 * MSW request handlers — empty for Phase 0.
 *
 * Real auth runs against the live Go backend (Vite proxies /login etc to :8080).
 * Future phases will add handlers here for endpoints we want to drive from
 * fixtures during design review (markets, portfolio, watchlist, etc.).
 *
 * Each handler should match a real backend endpoint shape, conforming to the
 * generated types in src/lib/api/types-generated.ts after `npm run gen:api`.
 */
export const handlers = [
  // Example placeholder — uncomment + flesh out once we have fixtures
  // http.get('/v1/market-summary', () => HttpResponse.json(marketSummaryFixture)),
]

export { http, HttpResponse }
