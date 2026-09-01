// GSE Terminal service worker.
//
// Strategies:
//  - Static assets under /static/ → cache-first (Vite hashes filenames so
//    a new build invalidates by URL — no need to version-bump).
//  - Public GET endpoints under /v1/ → stale-while-revalidate (instant
//    response from cache + background refresh; falls back to cached on
//    network failure so the app stays useful offline).
//  - Navigation requests → network-first with an offline shell fallback.
//  - All other requests → pass through.
//
// Cache versioning: bump CACHE_VERSION when changing the strategies
// here (the install + activate handlers wipe stale caches automatically).
// Daily content rotates inside the runtime cache via SWR; we don't try
// to manually invalidate per-symbol — the WS cache:bust frame already
// handles in-tab freshness, and the runtime cache happily overwrites.

const CACHE_VERSION = 'v4';
const STATIC_CACHE  = `gse-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `gse-runtime-${CACHE_VERSION}`;
const OFFLINE_URL  = '/offline.html';
// Pre-cache list — the offline shell plus everything its <head> + the
// install banner reference, so DevTools reports "Manifest detected"
// and icons render even when the user's first navigation is offline.
const PRECACHE_URLS = [
    OFFLINE_URL,
    '/manifest.webmanifest',
    '/favicon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE).then((cache) =>
            // Use addAll-with-Promise.all so a single missing asset on a
            // brand-new install doesn't abort the whole pre-cache step.
            Promise.all(PRECACHE_URLS.map((u) => cache.add(u).catch(() => {}))),
        ),
    );
    // Don't call skipWaiting() — let the new SW activate only when all
    // existing tabs are closed. skipWaiting + the client-side
    // controllerchange reload listener caused a thundering herd: every
    // open tab reloaded simultaneously on deploy, overloading the
    // server. The new SW will activate naturally on next navigation.
});

// Drop caches from prior versions on activate.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys.filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)),
            );
            await self.clients.claim();
        })(),
    );
});

// Page → SW message handler.
//   cache:bust — fired after admin upload / nightly scrape; clears the
//                runtime cache so the next fetch hits the server with
//                the freshly ingested data.
//   logout    — fired when the user signs out; clears the runtime cache
//                so the next user signing in on the same device doesn't
//                see the previous user's market data + watchlist
//                (anything that survived cross-session would otherwise
//                leak between accounts on a shared phone/desktop).
// Static cache stays untouched in both cases — it only holds Vite-
// hashed assets (invalidated implicitly by URL change) plus the offline
// shell + manifest, none of which are user-scoped.
self.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'cache:bust' || event.data.type === 'logout') {
        caches.delete(RUNTIME_CACHE);
    }
});

// ── Push notifications ─────────────────────────────────────────────────
// The server sends a Web Push for two events:
//   data.type === 'alert'     → per-symbol alert rule fired
//   data.type === 'watchlist' → daily post-scrape digest of the user's
//                                watchlist (top-3 by |Δ%|, multi-line body)
// Clicking either opens the terminal — alerts at the triggering stock,
// digests at the watchlist anchor.
self.addEventListener('push', (event) => {
    if (!event.data) return;
    let data;
    try { data = event.data.json(); } catch { return; }
    const title = data.title || 'GSE Terminal';
    // Tag dedupes notifications: alerts collapse per-event, watchlist
    // digests collapse per-day so a re-fired digest replaces yesterday's.
    const today = new Date().toISOString().split('T')[0];
    const tag = data.type === 'watchlist'
        ? `watchlist-${today}`
        : `alert-${data.eventId || Date.now()}`;
    const options = {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/favicon.png',
        tag: tag,
        data: { type: data.type, symbol: data.symbol },
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a push notification opens (or focuses) the terminal — at the
// triggering symbol for alerts, or at the watchlist anchor for digests.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const d = event.notification.data || {};
    let url = '/terminal';
    if (d.type === 'watchlist') {
        url = '/terminal#watchlist';
    } else if (d.symbol) {
        url = `/terminal?symbol=${encodeURIComponent(d.symbol)}`;
    }
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            // If a terminal tab is already open, focus it and navigate.
            for (const client of list) {
                if (client.url.includes('/terminal') && 'focus' in client) {
                    client.focus();
                    client.navigate(url);
                    return;
                }
            }
            return clients.openWindow(url);
        }),
    );
});

const isStaticAsset = (url) => url.pathname.startsWith('/static/');
// User-scoped endpoints that must NEVER be served from a shared cache —
// caching them across sessions would expose one user's data to the next
// user signing in on the same device. Anything else under /v1/ is
// market-wide and safe to share via stale-while-revalidate.
const PRIVATE_API_PATHS = ['/v1/me', '/v1/watchlist'];
// /v1/me/portfolio is already covered by the /v1/me prefix.
const isApiRead = (url) => {
    if (!url.pathname.startsWith('/v1/')) return false;
    return !PRIVATE_API_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'));
};
const isNavigation  = (req) => req.mode === 'navigate';

async function cacheFirst(request) {
    const cache  = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
}

async function staleWhileRevalidate(request) {
    const cache  = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
        .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => cached); // fall back to whatever's cached on net error
    return cached || network;
}

async function networkFirstNavigation(request) {
    try {
        const response = await fetch(request);
        return response;
    } catch (_) {
        const cache = await caches.open(STATIC_CACHE);
        const offline = await cache.match(OFFLINE_URL);
        return offline || new Response('Offline', { status: 503, statusText: 'Offline' });
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    // Only handle GETs — POST/DELETE/etc. are user actions that shouldn't
    // be replayed from cache, and intercepting them risks breaking auth.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    // Ignore cross-origin (CDN scripts, fonts) — let the browser cache
    // those via HTTP cache headers; intercepting them just adds latency.
    if (url.origin !== self.location.origin) return;
    // Don't cache the auth probe endpoints. Stale auth state is worse
    // than a network round-trip.
    if (url.pathname.startsWith('/v1/me')) return;
    // WebSocket upgrades pass through.
    if (url.pathname === '/ws') return;

    if (isStaticAsset(url)) {
        event.respondWith(cacheFirst(request));
        return;
    }
    // Pre-cached root assets (manifest, icons, favicon) — serve from
    // cache when offline so the install banner + offline shell stay
    // intact without network. Falls through to network on hit-miss.
    if (PRECACHE_URLS.includes(url.pathname)) {
        event.respondWith(cacheFirst(request));
        return;
    }
    if (isApiRead(url)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }
    if (isNavigation(request)) {
        event.respondWith(networkFirstNavigation(request));
        return;
    }
});
