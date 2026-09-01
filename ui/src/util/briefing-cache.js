// Singleton cache for /v1/briefing (daily market briefing + insights).
// Briefings regenerate after each nightly scrape, so within a session the
// payload is effectively static — a long TTL keeps the dashboard instant
// on tab return without any invalidation story beyond the upload hook.

import { createSessionCache } from './session-cache.js';

const cache = createSessionCache({
    name: 'briefing',
    buildURL: () => '/v1/briefing',
    keyOf: () => '_',
    ttlMs: 10 * 60_000, // 10 minutes; upload bust clears it before expiry
});

export function getBriefing()      { return cache.get(); }
export function invalidateBriefing() { cache.invalidate(); }
