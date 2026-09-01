// In-memory client-side cache for /v1/history responses. Pairs with the
// server's Redis cache: the first visit to a symbol pays one round-trip,
// subsequent visits within TTL are instant.
//
// Also exposes a prefetch path so hover / focus on a stock row can start
// the fetch before the user clicks. The click handler awaits the same
// in-flight promise rather than firing a second request.

import { createSessionCache } from './session-cache.js';

const cache = createSessionCache({
    name: 'history',
    buildURL: (sym, interval) =>
        `/v1/history?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}`,
});

export function getHistory(sym, interval) {
    return cache.get(sym, interval);
}

export function prefetchHistory(sym, interval = '1d') {
    if (!sym) return;
    cache.prefetch(sym, interval);
}

// Drop a cached entry (e.g. on a live price tick that invalidates the
// close value). Without `interval`, purges every interval for that symbol.
// With no arguments, purges the entire history cache — used by the
// upload-driven cache:bust handler.
export function invalidateHistory(sym, interval) {
    if (!sym) { cache.invalidate(); return; }
    if (interval) cache.invalidate(sym, interval);
    else cache.invalidateMatching(sym);
}
