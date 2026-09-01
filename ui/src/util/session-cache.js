// Factory for in-memory, TTL-bounded client caches over GET endpoints.
// Callers get a trio: fetch-through `get`, fire-and-forget `prefetch`,
// and `invalidate` for tick/upload-driven purges.
//
// Design notes:
//   * Concurrent and repeat requests within TTL share a single promise.
//   * A failed fetch evicts so retries don't poison the cache (aborts
//     are treated as benign — the promise was superseded, not failed).
//   * Prefetch is strictly best-effort; it never throws.
//   * Keys are per-endpoint + per-argument-tuple; a browser session with
//     60 stocks visited holds ~60 small objects — well inside budget.

import { abortableSignal, isAbortError } from './abort.js';

const DEFAULT_TTL_MS = 60_000;

/**
 * Build a cache for a GET endpoint.
 *
 * @param {object}   opts
 * @param {string}   opts.name        — debug / abort-key namespace, unique per endpoint
 * @param {function} opts.buildURL    — (...args) => string
 * @param {function} [opts.keyOf]     — (...args) => string (defaults to args.join(':'))
 * @param {number}   [opts.ttlMs]     — cache TTL (default 60s)
 * @param {function} [opts.parse]     — (Response) => Promise<any> (default json())
 */
export function createSessionCache(opts) {
    const {
        name,
        buildURL,
        keyOf = (...args) => args.map(a => String(a ?? '').toUpperCase()).join(':'),
        ttlMs = DEFAULT_TTL_MS,
        parse = (res) => res.json(),
    } = opts;

    // Entry shape: { promise, resolved, data, ts }
    const cache = new Map();

    const isFresh = (entry) => entry && (Date.now() - entry.ts) < ttlMs;

    function startFetch(args) {
        const key = keyOf(...args);
        const signal = abortableSignal(`${name}:${key}`);
        const promise = fetch(buildURL(...args), { signal })
            .then(res => {
                if (!res.ok) {
                    // Attach the status code so callers can branch on
                    // specific non-OK codes (e.g. 422 "insufficient data"
                    // → render an empty state instead of a generic LINK
                    // ERROR). Error message stays pre-existing shape for
                    // existing callers that only inspect .message.
                    const err = new Error(`${name} ${res.status}`);
                    err.status = res.status;
                    throw err;
                }
                return parse(res);
            })
            .then(data => {
                const entry = cache.get(key);
                if (entry) {
                    entry.resolved = true;
                    entry.data = data;
                    entry.ts = Date.now();
                }
                return data;
            })
            .catch(err => {
                if (!isAbortError(err)) cache.delete(key);
                throw err;
            });
        cache.set(key, { promise, resolved: false, data: null, ts: Date.now() });
        return promise;
    }

    function get(...args) {
        const key = keyOf(...args);
        const entry = cache.get(key);
        if (isFresh(entry)) {
            return entry.resolved ? Promise.resolve(entry.data) : entry.promise;
        }
        return startFetch(args);
    }

    function prefetch(...args) {
        const key = keyOf(...args);
        if (isFresh(cache.get(key))) return;
        startFetch(args).catch(() => { /* swallow */ });
    }

    function invalidate(...args) {
        if (args.length === 0) {
            cache.clear();
            return;
        }
        cache.delete(keyOf(...args));
    }

    // Invalidate every entry whose key includes the given substring
    // (uppercased). Useful for "drop all entries touching symbol X" when
    // keys are composite.
    function invalidateMatching(fragment) {
        const f = String(fragment ?? '').toUpperCase();
        if (!f) return;
        for (const k of cache.keys()) {
            if (k.includes(f)) cache.delete(k);
        }
    }

    return { get, prefetch, invalidate, invalidateMatching };
}
