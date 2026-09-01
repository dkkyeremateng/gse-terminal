// Client-side cache for /v1/ai-insight — the most expensive endpoint on
// the page (LLM call, often 1-3s). Caching it means flipping back to a
// stock the user visited earlier in the session is instant.
//
// TTL is longer than history (5 minutes) because the insight combines
// daily OHLC + sentiment and doesn't swing with intraday ticks — but the
// live tick handler invalidates the current symbol so a big price move
// still re-prompts the LLM on the next view.

import { createSessionCache } from './session-cache.js';

const cache = createSessionCache({
    name: 'ai-insight',
    buildURL: (sym) => `/v1/ai-insight?symbol=${encodeURIComponent(sym)}`,
    ttlMs: 5 * 60_000,
});

export function getInsight(sym)      { return cache.get(sym); }
export function prefetchInsight(sym) { if (sym) cache.prefetch(sym); }
export function invalidateInsight(sym) {
    if (sym) cache.invalidate(sym); else cache.invalidate();
}
