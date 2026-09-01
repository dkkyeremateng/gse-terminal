// Singleton cache for /v1/symbols. The list changes only when an admin
// adds a new ticker, so we let it sit for the full TTL and rely on the
// upload-driven cache:bust to refresh within a session. Previously the
// symbols list was a module-local `_allSymbols` in search.js; routing it
// through the shared cache means both the search dropdown and any future
// screener/filter feature share a single copy.

import { createSessionCache } from './session-cache.js';

const cache = createSessionCache({
    name: 'symbols',
    buildURL: () => '/v1/symbols',
    keyOf: () => '_',
    ttlMs: 15 * 60_000,
});

export function getSymbols()        { return cache.get(); }
export function invalidateSymbols() { cache.invalidate(); }
