// Service worker registration + bridge.
//
// Registers /sw.js once the page has loaded. The SW file is served from
// the URL root so its scope is the whole origin — routes like /terminal,
// /settings, and /v1 all pass through it. The `scope: '/'` option is a
// belt-and-braces explicit match; the server also sets the
// `Service-Worker-Allowed: /` header so the registration can't be
// denied on a future path move.
//
// The `forwardCacheBust` export lets app.js pipe the WS cache:bust
// frame (emitted by the server after admin upload / nightly scrape)
// into the SW so its runtime cache is cleared in lockstep with the
// in-page caches. Without this the SW would keep serving stale
// briefings/history for up to its TTL.

// Only register in browsers that support the API and on secure
// contexts (including http://localhost which browsers exempt). Prod
// must serve over HTTPS.
export function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (typeof window === 'undefined' || !window.isSecureContext) return;

    // Defer until after the load event so the SW install doesn't
    // contend with first-paint critical requests.
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/sw.js', { scope: '/' })
            .then((reg) => {
                // When a new SW version is detected, DON'T auto-reload.
                // skipWaiting is removed from sw.js so the new version
                // activates only when all tabs close. The update check
                // below still tells the browser to look for changes so
                // the user picks it up on next navigation.
                try { reg.update(); } catch (e) { console.debug('[sw] update', e); }
            })
            .catch((e) => console.debug('[sw] register failed', e));
    });
}

// Forward a message to the active service worker. No-op when the SW
// isn't controlling the page yet (first install).
export function postMessageToSW(message) {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker.controller;
    if (sw) sw.postMessage(message);
}

// Privacy guard: when the user signs out, every page in the app fires
// hx-post="/logout" via htmx. We catch that click in capture phase and
// tell the service worker to flush its runtime cache BEFORE the request
// goes out, so the cached private data (watchlist, briefing, history)
// isn't visible to the next user signing in on the same device.
//
// Side-effect on import — a single listener at document scope is
// enough; app.js and settings.js both pull this module in, but the
// guard at the top prevents duplicate registration.
if (typeof document !== 'undefined' && !window.__swLogoutHookInstalled) {
    window.__swLogoutHookInstalled = true;
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('[hx-post="/logout"]');
        if (!btn) return;
        postMessageToSW({ type: 'logout' });
        // Clear in-memory portfolio state so the next user doesn't see
        // the previous user's holdings HTML on a shared device.
        if (typeof window._clearPortfolioState === 'function') window._clearPortfolioState();
    }, { capture: true });
}
