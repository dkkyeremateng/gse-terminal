// WebSocket live updates + auto-refresh scheduler.
// Extracted from app.js; all function calls go through window.* to
// ensure they resolve regardless of module load order.

import { countUp } from '../util/count-up.js';
import { invalidateHistory } from '../util/history-cache.js';
import { invalidateInsight } from '../util/insight-cache.js';
// Side-effect import — registers window.setConnectionState. Without
// this, entry points that load socket.js standalone (settings.js) hit
// `window.setConnectionState is not a function` the first time the
// socket opens or drops. app.js already imports connection.js so the
// double-load is a no-op there.
import '../ui/connection.js';

export function scheduleNextRefresh() {
    const now = new Date();
    // Schedule exactly 5 minutes after 15:30 UTC market close
    let nextRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 15, 35, 0, 0));

    // If it's already past 15:35 UTC today, bump to tomorrow
    if (now >= nextRun) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    }

    // Skip weekends and public holidays
    while (true) {
        const day = nextRun.getUTCDay();
        if (day === 0 || day === 6) {
            nextRun.setUTCDate(nextRun.getUTCDate() + 1);
            continue;
        }

        const dateStr = nextRun.toISOString().split('T')[0];
        if (window.GHANA_HOLIDAYS && window.GHANA_HOLIDAYS[dateStr]) {
            nextRun.setUTCDate(nextRun.getUTCDate() + 1);
            continue;
        }
        break;
    }

    const delay = nextRun.getTime() - now.getTime();
    console.debug(`[Terminal] Next UI data sync scheduled at ${nextRun.toLocaleString()} (in ${Math.round(delay/60000)} minutes)`);

    setTimeout(() => {
        if (typeof window.updateMarketStatus === 'function') window.updateMarketStatus();
        if (typeof window.fetchWatchlistPanel === 'function') window.fetchWatchlistPanel();
        if (window.currentSymbol) {
            if (typeof window.fetchHistory === 'function') window.fetchHistory(true);
        } else {
            if (typeof window.fetchMarketSummary === 'function') window.fetchMarketSummary();
        }
        // Reprime the next day's scheduled fetch
        scheduleNextRefresh();
    }, delay);
}

// WebSocket Uplink
window.socket = null;
window.reconnectDelay = 1000;
// When the tab is hidden we tear the socket down on purpose. The onclose
// reconnect loop honours this flag so the browser doesn't burn battery
// or eat a server slot in the background; reopen on visibilitychange.
let _intentionalClose = false;
let _reconnectTimer = null;
// Track whether we've ever opened a socket so the onopen handler can
// distinguish a first connect (nothing to recover) from a reconnect
// after a network blip (we may have missed a cache:bust frame).
let _hasConnected = false;
// Sticky companion to _intentionalClose: survives the close → reopen
// cycle so onopen knows whether the reconnect was "tab came back"
// (skip the cache bust — we don't want to refetch on tab return) or
// a real network drop (run the cache bust to recover from any missed
// {type:"cache:bust"} frames).
let _reopenAfterIntentional = false;
// Timestamp of the last visibility-hide. Used on visibility-back to
// decide whether the hidden interval was long enough that we may
// have missed a server cache:bust frame and should invalidate the
// side caches (history / symbols / briefing / insight) defensively.
let _hiddenAt = 0;
// Anything beyond this is "long enough that a missed cache:bust frame
// could leave actively wrong data in the caches." Under it, we trust
// the *client-side* per-key TTLs (briefing 10 min, symbols 15 min in
// util/briefing-cache.js / util/symbols-cache.js) to cover us. Server-
// side Redis TTLs are independent and longer (see internal/server/cache.go
// dataCacheTTL); they're invalidated explicitly on upload/scrape, not by
// this threshold.
const STALE_AFTER_HIDDEN_MS = 5 * 60 * 1000;

window.connectWebSocket = function() {
    // Always release `_intentionalClose` first — it describes a
    // teardown that has already happened. Leaving it true across a
    // fresh connect attempt would cause the next onclose (network
    // drop) to silently bail without scheduling a retry. We hoist
    // this above the early-return guard so a fast tab toggle that
    // hits the guard (socket still in CONNECTING/OPEN from a close
    // that hasn't transitioned yet) doesn't wedge the flag.
    _intentionalClose = false;
    if (window.socket && window.socket.readyState <= WebSocket.OPEN) {
        // Existing socket is alive — no new onopen will fire to
        // consume `_reopenAfterIntentional`, so drop it now.
        // Otherwise a subsequent real reconnect (network drop, not
        // tab toggle) would inherit the stale flag and skip its
        // legitimate cache bust.
        _reopenAfterIntentional = false;
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    console.debug(`[Uplink] Connecting to ${wsUrl}...`);
    const s = new WebSocket(wsUrl);
    window.socket = s;

    s.onopen = () => {
        console.debug('[Uplink] Real-time market link established.');
        window.reconnectDelay = 1000;
        window.setConnectionState(false);
        // On RE-connect after a real network drop, conservatively flush
        // the client + SW caches. While the socket was down we may have
        // missed a {type:"cache:bust"} frame fired by an admin upload or
        // nightly scrape — without this hook the tab would keep serving
        // the pre-bust snapshot until each per-key TTL expires (up to
        // 15 minutes for the symbols list). First connect doesn't need
        // it; the page just loaded fresh.
        //
        // Skip the bust when the reopen was triggered by tab-return —
        // we deliberately don't want to re-burst /v1/market-summary +
        // /v1/me/portfolio every time the user switches tabs. Live
        // ticks resuming on the socket will patch prices in place; the
        // briefing/symbols caches naturally expire on TTL or get busted
        // by a fresh server frame.
        const skipBust = _reopenAfterIntentional;
        _reopenAfterIntentional = false;
        if (_hasConnected && !skipBust && typeof window.handleCacheBust === 'function') {
            window.handleCacheBust();
        }
        _hasConnected = true;
    };

    s.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (Array.isArray(data)) {
                handleLiveUpdate(data);
                return;
            }
            // User-targeted frames — discriminated by `type`. Alerts are
            // the only such frame today; add more cases as features land.
            if (data && typeof data === 'object') {
                if (data.type === 'alert' && typeof window.handleAlertPush === 'function') {
                    window.handleAlertPush(data);
                } else if (data.type === 'cache:bust' && typeof window.handleCacheBust === 'function') {
                    // Broadcast by the server after an admin upload or
                    // a nightly scrape — drop every in-memory GET cache
                    // so the next fetch sees fresh data instead of
                    // waiting on per-key TTL.
                    window.handleCacheBust();
                } else if (data.type === 'admin:pro_request') {
                    // Targeted at admin sessions only — fired when a
                    // standard user submits a Pro request. We always
                    // surface a toast (so admins on /terminal still see
                    // it), and let the admin page hook in via
                    // window.handleAdminProRequestPush to bump the
                    // sidebar badge / refresh the queue table.
                    console.debug('[Uplink] admin:pro_request received', data);
                    const requester = (data && data.username) || 'a user';
                    if (typeof window.showToast === 'function') {
                        window.showToast(
                            `New Pro access request from ${requester}.`,
                            'info',
                            8000,
                        );
                    }
                    if (typeof window.handleAdminProRequestPush === 'function') {
                        window.handleAdminProRequestPush(data);
                    }
                } else if (data.type === 'pro_request:decided' && typeof window.handleProRequestDecided === 'function') {
                    // Targeted at the requester so the account page
                    // updates without a reload.
                    window.handleProRequestDecided(data);
                } else if (data.type === 'role:changed' && typeof window.handleRoleChanged === 'function') {
                    // Companion frame to pro_request:decided when an
                    // approval happened. Tells the client the JWT is
                    // stale; account.js re-probes /v1/me.
                    window.handleRoleChanged(data);
                }
            }
        } catch (e) {
            console.error('[Uplink] Data corruption:', e);
        }
    };

    s.onclose = () => {
        // Stale-close guard: if a previous socket is closing and we've
        // already created its replacement (e.g. fast tab-toggle, a
        // visibility-back firing connectWebSocket while an earlier
        // close is still in CLOSING), the older socket's onclose can
        // fire after we've reassigned `window.socket`. Without this
        // check, the older handler would either schedule a phantom
        // reconnect (if _intentionalClose was already cleared by the
        // new connect) or no-op when it shouldn't (clobbering a real
        // reconnect's recovery state). Bailing on a non-current
        // socket keeps lifecycle decisions tied to the active one.
        if (s !== window.socket) {
            return;
        }
        if (_intentionalClose) {
            console.debug('[Uplink] Connection closed (tab hidden).');
            return;
        }
        console.warn(`[Uplink] Connection lost. Retrying in ${window.reconnectDelay}ms...`);
        window.setConnectionState(true);
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(window.connectWebSocket, window.reconnectDelay);
        window.reconnectDelay = Math.min(window.reconnectDelay * 2, 30000);
    };

    s.onerror = (err) => {
        console.error('[Uplink] Connection error:', err);
        s.close();
    };
};

// Suspend the uplink when the tab is backgrounded — reconnect on focus.
// Without this the reconnect loop runs forever in hidden tabs, burning
// mobile battery and inflating server socket counts on idle sessions.
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            _hiddenAt = Date.now();
            clearTimeout(_reconnectTimer);
            // Only mark the close as intentional (and arm the
            // reopen-skip flag) when there's actually a live socket
            // to close. If the socket was already gone — e.g., a
            // prior network drop's onclose ran but the reconnect
            // timer hadn't fired yet — leaving these flags off lets
            // the next reconnect behave normally (running its
            // legitimate cache bust). Setting them in that case
            // would suppress the next bust against an unrelated
            // server event.
            if (window.socket && window.socket.readyState <= WebSocket.OPEN) {
                _intentionalClose = true;
                _reopenAfterIntentional = true;
                window.socket.close();
            }
        } else {
            // After a long hidden interval, the cache:bust frame the
            // server fired during our absence (admin upload, nightly
            // scrape) was never delivered — the socket was closed.
            // Live ticks resuming will patch visible prices, but the
            // history / symbols / briefing / insight caches can hold
            // pre-bust snapshots that bite the next stock click. We
            // invalidate (without refetching) so the next user action
            // hits the network for a fresh response. Quick tab
            // toggles below the threshold leave caches alone — well
            // under any TTL, no correctness risk.
            const hiddenFor = _hiddenAt ? Date.now() - _hiddenAt : 0;
            _hiddenAt = 0;
            if (hiddenFor > STALE_AFTER_HIDDEN_MS &&
                typeof window.handleCacheBust === 'function') {
                window.handleCacheBust({ skipFetch: true });
            }
            // Reopen the socket. No HTTP refetches here — the existing
            // rendered data stays put, and live ticks arriving on the
            // new connection will patch prices in place via
            // applyTickToRows.
            window.connectWebSocket();
        }
    });
}

function handleLiveUpdate(ticks) {
    // Update Global Cache
    if (!window.MARKET_SUMMARY_DATA) window.MARKET_SUMMARY_DATA = { all: [], active: [], gainers: [], losers: [] };

    ticks.forEach(tick => {
        const existingIdx = window.MARKET_SUMMARY_DATA.all.findIndex(t => t.symbol === tick.symbol);
        if (existingIdx > -1) {
            window.MARKET_SUMMARY_DATA.all[existingIdx] = { ...window.MARKET_SUMMARY_DATA.all[existingIdx], ...tick };
        } else {
            window.MARKET_SUMMARY_DATA.all.push(tick);
        }

        // The cached history/insight payloads for this symbol are now
        // stale — the new close/volume won't appear until we re-fetch.
        // Drop them so the next visit hits a fresh server response
        // instead of the pre-tick snapshot.
        invalidateHistory(tick.symbol);
        invalidateInsight(tick.symbol);

        // Live UI Refresh for Current View
        if (window.currentSymbol && tick.symbol === window.currentSymbol.toUpperCase()) {
            updateDashboardWithTick(tick);
        }

        // Patch any rendered rows (market overview, watchlist, sidebar
        // pulse) in place. Replaces the previous fetchMarketSummary +
        // fetchWatchlistPanel calls that wiped innerHTML on every tick
        // and caused the dashboard skeleton/animations to re-flash.
        //
        // Note: we deliberately don't update MARKET_SUMMARY_DATA.gainers
        // / .losers / .active / .topGainers / .topLosers from ticks.
        // Those are membership lists (which symbols qualify), not price
        // snapshots, and re-ranking them on every tick would cause
        // visible churn. Their members are kept fresh by the daily
        // post-close scheduled refresh and by the cache:bust path.
        //
        // Audited readers — peer suggestions in panels/index.js and the
        // "Movers / Gainers / Losers / Active" panel switcher — all
        // cross-reference symbols against MARKET_SUMMARY_DATA.all
        // (which IS updated by ticks) for live prices, so a stale
        // membership list never produces stale displayed prices, only
        // a stale set of which symbols appear. That's the intended
        // behaviour.
        applyTickToRows(tick);
    });
}

// Patch the live cells of every rendered stock row matching this tick's
// symbol — rows are tagged in renderStockRow with [data-tick-symbol] +
// [data-tick-cell="price|change|volume"]. Briefing insight cards don't
// carry these attrs, so they're left alone (they pair price with a
// snapshot RSI/confidence — partial updates would mislead).
function applyTickToRows(tick) {
    if (!tick || !tick.symbol) return;
    const sel = `[data-tick-symbol="${CSS.escape(tick.symbol)}"]`;
    const fmtPrice = (p) => p >= 100 ? `¢${Math.round(p)}` : `¢${p.toFixed(2)}`;

    if (typeof tick.lastPrice === 'number') {
        document.querySelectorAll(`${sel}[data-tick-cell="price"]`).forEach(el => {
            el.textContent = fmtPrice(tick.lastPrice);
        });
    }

    if (typeof tick.percentChange === 'number') {
        const isUp = tick.percentChange >= 0;
        const sign = isUp ? '+' : '';
        document.querySelectorAll(`${sel}[data-tick-cell="change"]`).forEach(el => {
            el.classList.remove('text-emerald-500', 'text-rose-500',
                'light:text-emerald-600', 'light:text-rose-600');
            el.classList.add(
                isUp ? 'text-emerald-500' : 'text-rose-500',
                isUp ? 'light:text-emerald-600' : 'light:text-rose-600',
            );
            el.innerHTML = `<span class="sr-only">${isUp ? 'Up' : 'Down'}</span>${sign}${tick.percentChange.toFixed(2)}%`;
        });
    }

    if (typeof tick.volume === 'number') {
        document.querySelectorAll(`${sel}[data-tick-cell="volume"]`).forEach(el => {
            el.textContent = `${(tick.volume / 1000).toFixed(1)}k Vol`;
        });
    }
}

function updateDashboardWithTick(tick) {
    // Price header is rendered twice (desktop + mobile); countUp resolves
    // [data-count-target] to hit both. Presence check via the same path.
    if (document.querySelector('[data-count-target="main-price-display"]')) {
        countUp('main-price-display', tick.lastPrice, 300, "¢");
    }

    // Update Chart if it exists
    if (window.chart && window.currentChartData) {
        const lastData = window.currentChartData[window.currentChartData.length - 1];
        const now = new Date().getTime();

        const lastDate = new Date(lastData.x).setHours(0,0,0,0);
        const tickDate = new Date().setHours(0,0,0,0);

        if (lastDate === tickDate) {
            lastData.y = tick.lastPrice;
        } else {
            window.currentChartData.push({ x: now, y: tick.lastPrice });
        }

        window.chart.updateSeries([{ data: window.currentChartData }], false);
    }
}

// Export scheduleNextRefresh as window shim so app.js can call it
if (typeof window !== 'undefined') {
    window.scheduleNextRefresh = scheduleNextRefresh;
}
