// In-memory cache for /v1/me/portfolio/history responses. Pairs with
// the server-side Redis cache: dedupes concurrent dashboard fetches
// (briefing-card sparkline + big equity chart both open ?window=all
// on load) into one round-trip, and caches the parsed response for
// follow-up range-pill clicks.
//
// A BroadcastChannel echoes invalidations across tabs so an add/delete
// in tab A drops the cache in tab B (and every other open dashboard)
// instead of leaving stale entries up for the 60s TTL.

import { createSessionCache } from './session-cache.js';

const cache = createSessionCache({
    name: 'portfolio-history',
    buildURL: (windowParam) =>
        `/v1/me/portfolio/history?window=${encodeURIComponent(windowParam)}`,
    // 60s is plenty — the server already caches for 15m and explicit
    // invalidate() below clears locally on holdings CRUD.
});

// One channel per tab; all tabs of the same origin subscribe to the
// same name. Fall back to null on older browsers that lack the API —
// cross-tab sync degrades to the local-TTL behaviour.
const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('portfolio-history-cache')
    : null;
if (channel) {
    channel.addEventListener('message', (e) => {
        if (e?.data === 'invalidate') cache.invalidate();
    });
}

export function getPortfolioHistory(windowParam = 'all') {
    return cache.get(windowParam);
}

/**
 * Drop all cached history windows locally AND broadcast the
 * invalidation to peer tabs so their caches drop in lockstep.
 *
 * Call this after ANY mutation to the user's holdings — POST /v1/me/portfolio
 * (add), DELETE /v1/me/portfolio/{id} (remove), and PATCH /v1/me/portfolio/{id}
 * (edit, when that UI exists). The server's Redis cache is invalidated by the
 * same CRUD on the backend (see invalidatePortfolioHistoryCache in
 * portfolio_handlers.go); this client-side call just keeps the in-memory
 * cache from serving stale data until its 60s TTL would otherwise expire.
 *
 * Missing this call after a mutation = stale sparkline / chart for up to 60s.
 */
export function invalidatePortfolioHistory() {
    cache.invalidate();
    if (channel) channel.postMessage('invalidate');
}
