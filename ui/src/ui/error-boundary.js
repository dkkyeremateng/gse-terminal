// Global error boundary — catches uncaught exceptions and unhandled
// promise rejections so a single thrown error doesn't silently kill
// the WebSocket reconnect loop, chart rendering, or other async work.
// Surfaces errors to the toast system (if loaded), the console, and
// reports a fingerprint to the backend telemetry endpoint via the
// `sendBeacon` API (fire-and-forget, survives page unload).
//
// Backend contract: `POST /v1/client-error` accepts a JSON body with
// `{ msg, stack, url, ua, when }`. If the endpoint isn't wired yet the
// beacon is silently dropped — the browser never throws on that path.

const TELEMETRY_ENDPOINT = '/v1/client-error';
const recentlyReported = new Set();
// Cap the dedupe window so a busted client doesn't spam the backend
// indefinitely — clear the fingerprint set every 60s. A burst of
// identical errors becomes one report per minute, max.
setInterval(() => recentlyReported.clear(), 60_000);

function fingerprint(msg, stack) {
    // Strip dynamic line/column refs so retries with slightly different
    // stack frames still hash to the same key. Cap at 200 chars so a
    // pathological stack doesn't blow out memory.
    const norm = (stack || msg || '').replace(/:\d+:\d+/g, '').slice(0, 200);
    return norm;
}

function report(msg, stack) {
    const key = fingerprint(msg, stack);
    if (recentlyReported.has(key)) return;
    recentlyReported.add(key);
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    try {
        const payload = JSON.stringify({
            msg: String(msg).slice(0, 500),
            stack: stack ? String(stack).slice(0, 4000) : undefined,
            url: window.location.href,
            ua: navigator.userAgent,
            when: new Date().toISOString(),
        });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(TELEMETRY_ENDPOINT, blob);
    } catch (_) {
        // Telemetry must never throw — swallow.
    }
}

export function initErrorBoundary() {
    window.addEventListener('error', (event) => {
        const msg = event.error?.message || event.message || 'Unknown error';
        console.error('[uncaught]', msg, event.error);
        if (typeof window.showToast === 'function') {
            window.showToast(msg, 'error', 6000);
        }
        report(msg, event.error?.stack);
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const msg = reason?.message || String(reason) || 'Unhandled promise rejection';
        console.error('[unhandledrejection]', msg, reason);
        if (typeof window.showToast === 'function') {
            window.showToast(msg, 'error', 6000);
        }
        report(msg, reason?.stack);
    });
}
