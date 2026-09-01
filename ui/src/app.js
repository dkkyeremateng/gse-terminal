// Styles. Both imports go through PostCSS (Tailwind + autoprefixer) and
// end up in the single dist/assets/app-*.css bundle, replacing both the
// old /static/styles.css <link> and the Tailwind CDN <script>.
import './styles.css';
import './styles/terminal.css';
// Mobile overrides import last so they sit after everything in the cascade.
import './styles/terminal-mobile.css';

// Hydrate window.userRole from the <meta name="user-role"> tag the server
// renders into terminal.html. Inline <script> blocks were removed to keep
// CSP free of 'unsafe-inline'; modules below still read window.userRole.
window.userRole = document.querySelector('meta[name="user-role"]')?.content || '';

// ── Modules extracted from the former 3,500-line monolith. Each module
//    still writes to window.* for legacy template strings, but the
//    canonical entry points are the ES exports. See ui/ui.md item 6. ──
import { twColor } from './util/tw-colors.js';
import { escapeHTML } from './util/escape.js';
import { countUp } from './util/count-up.js';
import { openModal, closeModal } from './util/modal.js';
import { isAbortError } from './util/abort.js';
import { getHistory, prefetchHistory, invalidateHistory } from './util/history-cache.js';
import { getInsight, prefetchInsight, invalidateInsight } from './util/insight-cache.js';
import { invalidateBriefing } from './util/briefing-cache.js';
import { invalidateSymbols } from './util/symbols-cache.js';
import { GSE_WIKI, GHANA_HOLIDAYS } from './util/reference.js';
import { sanitizeSymbol } from './util/symbol.js';
// Side-effect import — registers window.timeAgo + window.parseNewsTitle etc.
// for features/news.js and dynamic JS templates.
import './util/time.js';
import { showToast } from './ui/toast.js';
import { toggleTheme, initTheme } from './ui/theme.js';
// Side-effect import — wires DOMContentLoaded handlers + registers
// window._syncTabState / window.activateStockTab.
import './ui/tabs.js';
import { preloadSymbols, initSearchInput, resetSymbolsList } from './ui/search.js';
import { setConnectionState } from './ui/connection.js';
import { initErrorBoundary } from './ui/error-boundary.js';
import { registerServiceWorker, postMessageToSW } from './util/sw.js';
import { subscribeToPush } from './util/push-subscribe.js';
import './charts/index.js';
import './charts/sectors.js';
import './panels/index.js';
import './live/socket.js';
import './features/news.js';
import './features/tear-sheet.js';
import './features/auth-ticker.js';
import { initAlerts } from './features/alerts.js';
import { initAccount } from './features/account.js';
import { initBacktest, fetchBacktest } from './features/backtest.js';
import { fetchQuote } from './features/orderbook.js';
import { initPortfolio, showStockPortfolio } from './features/portfolio.js';
// Persistent admin-notifications widget — self-gated to admin sessions.
// Loaded here so it surfaces on /terminal, /, and (transitively, since
// admin.js imports app.js) /admin. Settings + developers pages import
// it directly from their own entries.
import './features/admin-notifications.js';

// Global library references (provided by CDN in HTML)
// window.htmx, window.ApexCharts, window.html2pdf are available globally

// Ensure libraries are available on the window for existing inline scripts/HTMX
// Guard with typeof — admin.html does not load ApexCharts or html2pdf
if (typeof htmx !== 'undefined') window.htmx = htmx;
if (typeof ApexCharts !== 'undefined') window.ApexCharts = ApexCharts;
if (typeof html2pdf !== 'undefined') window.html2pdf = html2pdf;

// Exposed so the event delegate (see below) and any inline templates can
// warm the history cache on hover/focus without a direct ES import.
window.prefetchHistory = prefetchHistory;
window.prefetchInsight = prefetchInsight;

// Invoked by live/socket.js when the server broadcasts {"type":"cache:bust"}
// after an admin upload or nightly scrape. Flushes every client-side GET
// cache so the next user action sees fresh data. The tiny re-fetch cost
// on visible panels is worth dropping the stale briefing / symbols list.
//
// opts.skipFetch — invalidate caches but don't refetch the dashboard.
// Used by the visibility-back path in live/socket.js: the user
// explicitly doesn't want a request burst on tab return, but a long
// hidden interval may have caused us to miss a server-broadcast
// cache:bust frame, so we still need to drop stale snapshots.
//
// Dedupe windows are tracked separately for skipFetch (visibility-back)
// and full bust (server frame, onopen-recovery). A skipFetch on tab-
// return must not swallow a server cache:bust that lands within the
// next 300ms — those are independent events: the visibility path only
// invalidates, while the server frame must trigger a refetch on the
// landing dashboard. A single shared window collapsed them and left
// post-upload data masked by the pre-upload tab-return invalidation.
let _lastFullBustAt = 0;
let _lastSkipFetchBustAt = 0;
window.handleCacheBust = function(opts) {
    const skipFetch = opts && opts.skipFetch === true;
    // Tight dedupe — same-instant races (e.g., a server cache:bust
    // frame delivered immediately after an onopen-driven bust on
    // reconnect) get coalesced. Independent events still go through:
    // a skipFetch from visibility-back doesn't suppress a real server
    // bust 100ms later, because they track separate timestamps.
    const now = Date.now();
    const last = skipFetch ? _lastSkipFetchBustAt : _lastFullBustAt;
    if (now - last < 300) return;
    if (skipFetch) {
        _lastSkipFetchBustAt = now;
    } else {
        _lastFullBustAt = now;
    }
    invalidateHistory();  // no symbol → everything
    invalidateInsight();
    invalidateBriefing();
    invalidateSymbols();
    resetSymbolsList();
    // Deliberately NOT invalidating the dashboard's rendered briefing
    // HTML cache here — see panels/index.js _briefingHTMLCache. Per
    // user preference, the stock insights / sector heatmap / RSI
    // extremes block must stay visually stable for the whole session
    // and not re-render on cache:bust events (which fire on socket
    // reconnect, tab-return, or admin upload). Trade-off: the dashboard
    // shows the briefing snapshot from the first paint until a full
    // page reload. Live ticks still patch prices in place via
    // applyTickToRows for the gainers/losers/active rows.
    // Propagate to the service worker so its runtime cache is flushed
    // alongside the in-tab caches. Without this, an offline-capable
    // client could keep serving stale /v1/briefing responses from the
    // SW runtime cache even after the page caches were cleared.
    postMessageToSW({ type: 'cache:bust' });
    if (skipFetch) return;
    // If the landing dashboard is visible, re-fetch so the operator sees
    // the new briefing immediately rather than on next interaction.
    const overviewDash = document.getElementById('market-overview-dashboard');
    if (overviewDash && !overviewDash.classList.contains('hidden')
        && typeof window.fetchMarketSummary === 'function') {
        window.fetchMarketSummary();
    }
};

// Global error boundary — must be early so it catches init errors.
initErrorBoundary();

// Register the PWA service worker. Idempotent + guarded on browser
// support so it silently no-ops in older browsers / insecure contexts.
registerServiceWorker();

// Connection state moved to ./ui/connection.js

// Theme moved to ./ui/theme.js
initTheme();

// GSE_WIKI and GHANA_HOLIDAYS now live in ./util/reference.js and are
// shimmed onto window at import time for legacy callers.

window.unlinkProvider = async function() {
    try {
        const res = await fetch('/v1/me/unlink-provider', { method: 'POST' });
        if (res.status === 409) {
            const data = await res.json();
            if (data.status === 'needs_password') {
                window.showSetPasswordModal();
                return;
            }
        }
        if (!res.ok) {
            const text = await res.text();
            window.showToast(text || 'Failed to unlink account', 'error');
            return;
        }
        window.showToast('Google account unlinked', 'success');
        window.checkAuthState();
    } catch (e) {
        window.showToast('Failed to unlink account', 'error');
    }
};

window.showSetPasswordModal = function() {
    const modal = document.getElementById('set-password-modal');
    if (!modal) return;
    const input = modal.querySelector('input[type="password"]');
    if (input) input.value = '';
    const status = document.getElementById('set-password-status');
    if (status) status.innerHTML = '';
    const usernameEl = document.getElementById('set-password-username');
    if (usernameEl) usernameEl.textContent = window._currentUsername || '';
    openModal('set-password-modal');
};

window.closeSetPasswordModal = function() {
    closeModal('set-password-modal');
};

window.submitSetPassword = async function(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('set-password-input');
    const status = document.getElementById('set-password-status');
    const password = input?.value;
    if (!password) return;

    try {
        const res = await fetch('/v1/me/set-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `password=${encodeURIComponent(password)}`
        });
        if (!res.ok) {
            const text = await res.text();
            if (status) status.innerHTML = `<span class="text-rose-400 text-[10px]">${window.escapeHTML(text)}</span>`;
            return;
        }
        // Password set — now unlink
        window.closeSetPasswordModal();
        window.showToast('Password set. Unlinking Google account...', 'success');
        // Auto-unlink after password is set
        setTimeout(() => window.unlinkProvider(), 500);
    } catch (e) {
        if (status) status.innerHTML = '<span class="text-rose-400 text-[10px]">Failed to set password</span>';
    }
};

window.showMergeAccountModal = function() {
    const modal = document.getElementById('merge-account-modal');
    if (!modal) return;
    modal.querySelectorAll('input').forEach(i => { i.value = ''; });
    const status = document.getElementById('merge-account-status');
    if (status) status.innerHTML = '';
    openModal('merge-account-modal');
};

window.closeMergeAccountModal = function() {
    closeModal('merge-account-modal');
};

window.submitMergeAccount = async function(e) {
    if (e) e.preventDefault();
    const username = document.getElementById('merge-username')?.value;
    const password = document.getElementById('merge-password')?.value;
    const status = document.getElementById('merge-account-status');
    if (!username || !password) return;

    try {
        const res = await fetch('/v1/me/merge-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const msg = data?.error || await res.text() || 'Merge failed';
            if (status) status.innerHTML = `<span class="text-rose-400 text-[10px]">${window.escapeHTML(msg)}</span>`;
            return;
        }
        window.closeMergeAccountModal();
        window.showToast(`Account merged. You are now signed in as ${data.username}.`, 'success');
        await window.checkAuthState();
        if (typeof window.fetchWatchlistPanel === 'function') window.fetchWatchlistPanel();
    } catch (e) {
        if (status) status.innerHTML = '<span class="text-rose-400 text-[10px]">Failed to merge accounts</span>';
    }
};

// CSV export — the role check below is a UX guardrail (avoid an
// avoidable 403 round-trip and show a friendly message). The real
// authorization gate is server-side: chi's RequireProOrAdmin middleware
// fronts /v1/stock/export and rejects with 403 for non-pro/non-admin
// callers. Don't move the security boundary into this client check.
window.downloadStockData = function() {
    if (window.userRole !== 'admin' && window.userRole !== 'pro') {
        window.showToast('CSV export is available to Pro and Admin users only.', 'error');
        return;
    }
    const sym = window.currentSymbol;
    if (!sym) return;
    window.location.href = `/v1/stock/export/${encodeURIComponent(sym.toUpperCase())}/csv`;
};

// Share the current stock. Uses Web Share API where available, falls
// back to copying the canonical URL to the clipboard with a visual
// confirmation flash on the originating button.
window.shareStock = async function(btnEl) {
    const sym = (btnEl && btnEl.getAttribute('data-symbol')) || window.currentSymbol || '';
    const title = sym ? `${sym} · GSE Terminal` : 'GSE Terminal';
    const url = `${window.location.origin}${window.location.pathname}${sym ? `?symbol=${encodeURIComponent(sym)}` : ''}`;
    try {
        if (navigator.share) {
            await navigator.share({ title, url });
            return;
        }
    } catch (e) { /* user cancelled / not allowed — fall through to clipboard */ }
    try {
        await navigator.clipboard.writeText(url);
        if (btnEl) {
            btnEl.classList.add('copied');
            setTimeout(() => btnEl.classList.remove('copied'), 1400);
        }
        if (window.showToast) window.showToast('Link copied to clipboard', 'success');
    } catch (e) {
        if (window.showToast) window.showToast('Could not copy link', 'error');
    }
};

window.updateMarketStatus = function() {
    const now = new Date();
    const utcDay = now.getUTCDay(); // 0: Sun, 1: Mon, ..., 6: Sat
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcTotalMinutes = (utcHours * 60) + utcMinutes;

    const isWeekday = utcDay >= 1 && utcDay <= 5;
    
    // Trading Sessions (GMT/UTC)
    const preOpenStart = 9 * 60 + 30;  // 09:30 UTC
    const tradingStart = 10 * 60;      // 10:00 UTC
    const tradingEnd   = 15 * 60;      // 15:00 UTC

    const holidayName = window.GHANA_HOLIDAYS[now.toISOString().split('T')[0]];

    let status = { text: "Closed", color: "red", pulse: false };

    if (holidayName) {
        status = { text: `Closed (${holidayName})`, color: "red", pulse: false };
    } else if (isWeekday) {
        if (utcTotalMinutes >= tradingStart && utcTotalMinutes < tradingEnd) {
            status = { text: "Open (Continuous Trading)", color: "emerald", pulse: true };
        } else if (utcTotalMinutes >= preOpenStart && utcTotalMinutes < tradingStart) {
            status = { text: "Pre-Opening Session", color: "amber", pulse: true };
        } else {
            status = { text: "Closed (Post-Market)", color: "red", pulse: false };
        }
    } else {
        status = { text: "Closed (Weekend)", color: "red", pulse: false };
    }

    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const container = document.getElementById('market-status-indicator');
    
    const navDot = document.getElementById('nav-status-dot');
    const navText = document.getElementById('nav-status-text');

    const c = twColor(status.color);
    if (dot && text && container) {
        dot.className = `w-1.5 h-1.5 rounded-full ${c.dotBg} ${status.pulse ? 'animate-pulse' : ''}`;
        text.className = `text-xs ${c.text500} font-medium lowercase tracking-wide`;
        text.innerText = status.text;
        container.className = `flex items-center gap-2 px-3 py-2 ${c.chipBg} rounded-lg border ${c.chipBorder} transition-all duration-500`;
    }

    if (navDot && navText) {
        navDot.className = `w-1.5 h-1.5 rounded-full ${c.dotBg} ${status.pulse ? 'animate-pulse' : ''}`;
        const navLabel = status.color === 'emerald' ? 'Market Open'
                       : status.color === 'amber'   ? 'Pre-Opening'
                       :                              'Market Closed';
        navText.innerText = navLabel;
        navText.className = `text-[10px] font-black uppercase tracking-widest ${c.text500} transition-colors`;
    }

    return status;
}

// countUp moved to ./util/count-up.js

window.toggleDrawer = function() {
    const d = document.getElementById('drawer');
    const o = document.getElementById('drawer-overlay');
    if(!d || !o) return;
    const isOpen = d.classList.contains('active');
    
    if (isOpen) {
        d.classList.remove('active');
        o.classList.add('hidden');
        o.classList.remove('opacity-100');
    } else {
        d.classList.add('active');
        o.classList.remove('hidden');
        setTimeout(() => o.classList.add('opacity-100'), 10);
    }
}

window.parseCSVLine = function(str) {
    const arr = [];
    let quote = false;
    let val = '';
    for (let c of str) {
        if (c === '"' && quote === false) quote = true;
        else if (c === '"' && quote === true) quote = false;
        else if (c === ',' && quote === false) { arr.push(val.trim()); val = ''; }
        else val += c;
    }
    arr.push(val.trim());
    return arr;
}

window.previewLines = [];
window.previewMode = 'top';

window.setPreviewMode = function(mode) {
    window.previewMode = mode;
    document.getElementById('btn-top').classList.toggle('active', mode === 'top');
    document.getElementById('btn-bottom').classList.toggle('active', mode === 'bottom');
    renderPreviewUI();
}

window.renderPreviewUI = function() {
    const previewContainer = document.getElementById('preview-container');
    const previewHeader = document.getElementById('preview-header');
    if (!window.previewLines || window.previewLines.length === 0) return;

    const lines = window.previewLines;
    const headers = parseCSVLine(lines[0]);
    let html = '<div class="overflow-x-auto"><table class="w-full text-xs text-left text-slate-400 border border-white/5 whitespace-nowrap">';
    html += '<thead class="bg-white/[0.03]"><tr>';
    headers.forEach(h => html += `<th class="px-2 py-1.5 border-r border-white/5 font-black uppercase text-[10px] text-slate-500">${escapeHTML(h)}</th>`);
    html += '</tr></thead><tbody>';

    let startIdx, endIdx;
    if (window.previewMode === 'top') {
        startIdx = 1;
        endIdx = Math.min(lines.length, 21);
    } else {
        startIdx = Math.max(1, lines.length - 20);
        endIdx = lines.length;
    }

    for (let i = startIdx; i < endIdx; i++) {
        html += '<tr class="border-b border-white/5 hover:bg-white/[0.01] transition-colors">';
        const cols = parseCSVLine(lines[i]);
        for(let j=0; j < headers.length; j++) {
            const val = cols[j] !== undefined ? cols[j] : '';
            const isSymbol = headers[j].toLowerCase().includes('code') || headers[j].toLowerCase().includes('symbol');
            html += `<td class="px-2 py-1.5 border-r border-white/5 ${isSymbol ? 'font-bold text-white/70' : ''}">${escapeHTML(val)}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    
    previewContainer.innerHTML = html;
    
    // Unhide the section components
    const section = document.getElementById('preview-section');
    if (section) section.classList.remove('hidden');
    if (previewContainer) previewContainer.classList.remove('hidden');
    if (previewHeader) previewHeader.classList.remove('hidden');
}

window.updateFileName = function() {
    const input = document.getElementById('file-input');
    const display = document.getElementById('file-name-display');
    if (input.files.length > 0) {
        const file = input.files[0];
        const span = display.querySelector('span');
        // Middle-truncate: keep the last 8 chars (typically "_1234.csv"
        // or just ".csv") visible at all times, ellipsize the rest on the
        // left. The full name remains in the title attribute on hover.
        const name = file.name;
        const tail = name.length > 8 ? name.slice(-8) : '';
        const head = tail ? name.slice(0, -8) : name;
        span.innerHTML = '';
        const leftEl = document.createElement('span');
        leftEl.className = 'file-left';
        leftEl.textContent = head;
        const rightEl = document.createElement('span');
        rightEl.className = 'file-right';
        rightEl.textContent = tail;
        span.appendChild(leftEl);
        span.appendChild(rightEl);
        span.setAttribute('title', name);
        display.classList.remove('hidden');

        const reader = new FileReader();
        reader.onload = function(e) {
            window.previewLines = e.target.result.split('\n').filter(line => line.trim() !== '');
            renderPreviewUI();
        };
        reader.readAsText(file);
    }
}

// Chart subsystem (single + compare + annotation) moved to ./charts/index.js


window.fetchAIInsight = async function(symbol) {
    // Gate mirrors the server-side RequireProOrAdmin middleware on
    // /v1/ai-insight. Basic-tier users stay on the locked panel (with
    // the upgrade CTA copy already set by auth-ticker.js) — don't issue
    // a request we know will 403, and don't flip the card back to the
    // authed view by accident.
    const canUseOracle = window.isUserAuthenticated &&
        (window.userRole === 'admin' || window.userRole === 'pro');
    if (!canUseOracle) {
        document.getElementById('ai-oracle-authenticated').classList.add('hidden');
        document.getElementById('ai-oracle-locked').classList.remove('hidden');
        return;
    }

    const priceEl = document.getElementById('ai-suggested-price');
    const signalBox = document.getElementById('ai-signal-badge');
    const confEl = document.getElementById('ai-confidence');
    const sentEl = document.getElementById('ai-sentiment');
    const card = document.getElementById('ai-insight-card');

    // The AI insight endpoint may take 5+ seconds (LLM call). Show a clear
    // loading state so the user knows the panel is alive. Reset ALL fields
    // to prevent stale data from a previous symbol showing through.
    if (signalBox) {
        signalBox.innerText = 'ANALYZING…';
        signalBox.className = 'px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-widest bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse';
    }
    if (confEl) confEl.innerText = '— %';
    if (priceEl) priceEl.innerText = '¢—';
    const fairEl = document.getElementById('ai-fair-value');
    if (fairEl) fairEl.innerText = '¢—';
    if (sentEl) { sentEl.innerText = '…'; sentEl.className = 'text-xs font-bold italic font-display text-slate-300'; }
    const scoreEl = document.getElementById('sentiment-score');
    if (scoreEl) scoreEl.innerText = '—';
    document.getElementById('sentiment-bar-pos')?.style.setProperty('width', '50%');
    document.getElementById('sentiment-bar-neg')?.style.setProperty('width', '50%');
    const analysisTxt = document.getElementById('ai-analysis-text');
    if (analysisTxt) analysisTxt.classList.add('hidden');
    if (window._typewriterTimer) clearTimeout(window._typewriterTimer);
    // Clear stale SMA50 annotation from the previous stock
    window._pendingFairValue = null;
    if (window.chart) {
        try { window.chart.removeAnnotation('fair-value-line'); } catch (_) {}
    }

    try {
        const data = await getInsight(symbol);
        // If the user switched stocks while the LLM was thinking, drop
        // the stale response so it doesn't overwrite the newer insight.
        if (symbol !== window.currentSymbol) return;
        // Cache for the tear sheet exporter
        window._lastInsight = { symbol, data };
        // Ensure the insufficient-data panel is hidden on a successful
        // fetch — user may have previously seen it for a different
        // symbol that lacked history.
        document.getElementById('ai-oracle-insufficient')?.classList.add('hidden');
        document.getElementById('ai-oracle-authenticated')?.classList.remove('hidden');

        // Signal styling
        const s = data.signal;
        signalBox.innerText = s;
        signalBox.className = `px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-widest ${
            s === 'BULLISH' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
            s === 'BEARISH' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 
            'bg-slate-500/10 text-slate-400 border-white/5'
        }`;
        card.style.borderColor = s === 'BULLISH' ? 'rgba(16, 185, 129, 0.2)' : s === 'BEARISH' ? 'rgba(244, 63, 94, 0.2)' : 'rgba(255, 255, 255, 0.08)';

        setTimeout(() => countUp('ai-suggested-price', data.priceRangeLow, 300, "¢"), 40);
        setTimeout(() => countUp('ai-fair-value', data.sma50, 300, "¢"), 80);
        confEl.innerText = `${data.confidence.toFixed(0)}%`;

        // Store so the chart can apply it once rendered if not ready yet
        window._pendingFairValue = data.sma50;
        window.applyFairValueAnnotation(data.sma50);
        
        const sent = data.sentiment;
        sentEl.innerText = sent > 0.3 ? 'Bullish' : sent < -0.3 ? 'Bearish' : 'Neutral';
        sentEl.className = `text-xs font-bold italic font-display ${sent > 0.3 ? 'text-emerald-400' : sent < -0.3 ? 'text-rose-400' : 'text-slate-300'}`;

        const normalized = (sent + 1) / 2; // -1 to 1 -> 0 to 1
        const posWidth = normalized * 100;
        const negWidth = 100 - posWidth;
        document.getElementById('sentiment-bar-pos').style.width = `${posWidth}%`;
        document.getElementById('sentiment-bar-neg').style.width = `${negWidth}%`;
        document.getElementById('sentiment-score').innerText = sent.toFixed(2);

        // Render the AI analysis paragraph in one go. The typewriter
        // effect (15ms/char, ~3s for a 200-char summary) looked nice the
        // first time but made re-selecting the same stock feel sluggish.
        // The CSS fade on .ai-analysis-text covers the appearance.
        if (data.analysis) {
            const txtBox = document.getElementById('ai-analysis-text');
            const txtContent = document.getElementById('ai-analysis-content');
            if (window._typewriterTimer) {
                clearTimeout(window._typewriterTimer);
                window._typewriterTimer = null;
            }
            txtContent.textContent = data.analysis;
            txtBox.classList.remove('hidden');
        }

    } catch (e) {
        if (isAbortError(e)) return; // superseded by a newer symbol
        console.debug('[fetchAIInsight]', e);
        // 422 = server says "insufficient data for AI modeling". Show
        // the friendly empty-state card instead of the half-rendered
        // skeleton with "LINK ERROR" — retry won't help; the only fix
        // is more trading sessions landing in QuestDB.
        if (e?.status === 422) {
            const insufficient = document.getElementById('ai-oracle-insufficient');
            const authed = document.getElementById('ai-oracle-authenticated');
            const symEl = document.getElementById('ai-oracle-insufficient-symbol');
            if (symEl) symEl.textContent = symbol;
            authed?.classList.add('hidden');
            insufficient?.classList.remove('hidden');
            return;
        }
        signalBox.innerText = "LINK ERROR";
        priceEl.innerText = "¢--.00";
        window.setConnectionState(true);
    }
}

window.fetchHistory = async function(isBackground = false) {
    const symInput = document.getElementById('symbol-search');
    const sym = isBackground ? window.currentSymbol : symInput.value;
    if (!sym) return;
    symInput.blur();

    // User-initiated symbol change always exits comparison mode so the new
    // stock loads as the sole main symbol. Background refreshes preserve
    // the active comparison.
    if (!isBackground && sym !== window.currentSymbol) {
        window.compareState = null;
    }

    window.currentSymbol = sym;
    try { localStorage.setItem('gse:lastSymbol', sym); } catch (e) { console.debug('[storage]', e); }

    // Mobile-only: selecting a stock from the watchlist / movers / briefing
    // cards leaves the scroll position mid-feed. Jump to the top so the
    // price header is the first thing the user sees. Desktop already
    // renders everything in one viewport, so we skip the scroll there
    // to avoid stealing the user's place on the page.
    if (!isBackground && window.matchMedia('(max-width: 1023px)').matches) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Highlight the active stock in the watchlist/movers sidebar
    document.querySelectorAll('[data-stock-row-symbol]').forEach(el => {
        el.setAttribute('data-stock-row-active', el.getAttribute('data-stock-row-symbol') === sym.toUpperCase() ? 'true' : 'false');
    });
    // Reflect the selected symbol in the URL so the link is shareable
    // and revisits restore the same stock. Also clear any tab :target
    // hash so the user is taken to the chart view (Quote/Chart tab),
    // regardless of where they tapped the stock from (e.g. from the
    // Movers/Watchlist mobile tabs).
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('symbol', sym);
        const cleanUrl = url.pathname + url.search;
        // Some mobile browsers (Safari) do not recompute :target on
        // history.replaceState alone. Use location.replace on a hash-less
        // URL via a two-step trick: scroll to top, then replaceState.
        if (window.location.hash) {
            // Temporarily navigate to a non-existent fragment to force
            // :target to clear, then immediately replaceState to a clean URL
            // (no history pollution, no reload).
            window.location.hash = '';
        }
        window.history.replaceState({}, '', cleanUrl);
    } catch (e) { console.debug('[nav] symbol URL:', e); }

    const err = document.getElementById('error-result');
    if (!isBackground) err.classList.add('hidden');

    const priceSummaryEl = document.getElementById('price-summary');
    if (!isBackground && priceSummaryEl) {
        priceSummaryEl.innerHTML = `
            <div class="flex flex-col sm:flex-row justify-between gap-6 stagger-enter stagger-1 w-full">
                <div class="space-y-4">
                    <div class="h-6 w-32 bg-white/5 shimmer rounded-lg"></div>
                    <div class="h-14 w-48 bg-white/5 shimmer rounded-xl mt-2"></div>
                </div>
            </div>`;
        priceSummaryEl.classList.remove('hidden');
    }

    const techStats = document.getElementById('tech-stats');
    if (!isBackground && techStats) {
        techStats.innerHTML = Array(4).fill(0).map((_, i) => `<div class="h-24 glass-card rounded-2xl shimmer stagger-enter" style="--stagger-i: ${3+i}"></div>`).join('');
    }

    // Reset chart-main to a clean state — hide the no-data empty state,
    // restore chart elements so renderChart can find #chart-container.
    // Also hide the market-overview-dashboard (landing/briefing view) so
    // the two don't stack visibly while the chart fetches. The inverse
    // transition (stock → landing) lives in panels/index.js.
    if (!isBackground) {
        document.getElementById('chart-empty-state')?.classList.add('hidden');
        document.getElementById('chart-controls')?.classList.remove('hidden');
        document.getElementById('chart-container')?.classList.remove('hidden');
        document.getElementById('comparables-widget')?.classList.add('hidden');
        document.getElementById('chart-main')?.classList.remove('hidden');
        document.getElementById('market-overview-dashboard')?.classList.add('hidden');
    }

    document.getElementById('sidebar-placeholder')?.classList.add('hidden');
    const sidebarContent = document.getElementById('sidebar-content');
    if (sidebarContent) {
        sidebarContent.classList.remove('hidden');
        sidebarContent.querySelectorAll('.animate-in').forEach(el => {
            el.style.animation = 'none';
            void el.offsetWidth;
            el.style.animation = '';
        });
    }
    document.body.dataset.view = 'stock';
    // Reset the mobile section tabs to Overview for each new stock load.
    if (typeof window.activateStockTab === 'function') window.activateStockTab('overview');
    // Show AI Oracle + Market Indicators in the left sidebar, hide movers + watchlist
    document.getElementById('market-pulse-panel')?.classList.add('hidden');
    document.getElementById('watchlist-panel-container')?.classList.add('hidden');
    // Portfolio full view hides; showStockPortfolio will re-show with
    // a per-symbol mini summary if the stock is in the portfolio.
    document.getElementById('portfolio-panel')?.classList.add('hidden');
    const leftPanels = document.getElementById('left-stock-panels');
    if (leftPanels) {
        leftPanels.classList.remove('hidden');
        // Re-trigger entry animations
        leftPanels.querySelectorAll('.animate-in').forEach(el => {
            el.style.animation = 'none';
            void el.offsetWidth;
            el.style.animation = '';
        });
    }
    if (typeof window._syncTabState === 'function') window._syncTabState();
    const aiInsightCard = document.getElementById('ai-insight-card');
    if (aiInsightCard) {
        // Re-trigger stagger animation
        aiInsightCard.classList.remove('stagger-enter', 'stagger-2');
        void aiInsightCard.offsetWidth; // trigger reflow
        aiInsightCard.classList.add('stagger-enter', 'stagger-2');
    }

    // News + AI insight fire AFTER we know the symbol has data. Firing
    // them up-front means a stock with no OHLC (delisted / unlisted)
    // would flash a "LINK ERROR" on the AI Oracle and a "News engine
    // throttled" on the right rail before the empty state replaced the
    // center — making the whole page look broken.

    try {
        // Uses the session cache: a hover/focus prefetch may have already
        // started this fetch, in which case we await the same promise rather
        // than fire a second request.
        const data = await getHistory(sym, '1d');
        // If the user switched symbols while we were awaiting, drop the
        // stale response so we don't overwrite the newer selection's view.
        // (The previous impl relied on a single shared AbortController to
        // cancel in-flight fetches; per-symbol cache keys require an
        // explicit currentSymbol check instead.)
        if (sym !== window.currentSymbol) return;
        if (!data || data.length === 0) {
            if (!isBackground) showEmptyState(sym, 'no-data');
            return;
        }
        if (!isBackground) err.classList.add('hidden');

        window.setConnectionState(false);
        // Data arrived — clear any previous empty-state flag so the CSS
        // stops suppressing the left-rail + tabs nav, and unhide the
        // containers we hid on the way in.
        delete document.body.dataset.stockState;
        document.getElementById('chart-empty-state')?.classList.add('hidden');
        document.getElementById('chart-controls')?.classList.remove('hidden');
        document.getElementById('chart-container')?.classList.remove('hidden');
        document.getElementById('sidebar-content')?.classList.remove('hidden');
        document.getElementById('left-stock-panels')?.classList.remove('hidden');
        // QuestDB's GetOHLC already returns rows ORDER BY trading_date ASC
        // (see internal/repository/questdb.go), so re-sorting here is dead
        // work. Keep the `sorted` alias for downstream readers.
        const sorted = data;
        renderChart(sorted);

        // Update the chart date-range label (start – end)
        const firstTs = sorted[0]?.timestamp;
        const lastTs = sorted[sorted.length - 1]?.timestamp;
        const labelEl = document.getElementById('last-updated-label');
        const dateEl = document.getElementById('last-updated-date');
        const startEl = document.getElementById('chart-date-start');
        const dateFmt = { day: 'numeric', month: 'short', year: 'numeric' };
        if (lastTs && labelEl && dateEl) {
            dateEl.textContent = new Date(lastTs).toLocaleDateString('en-GH', dateFmt);
            if (startEl && firstTs) {
                startEl.textContent = new Date(firstTs).toLocaleDateString('en-GH', dateFmt);
            }
            labelEl.classList.remove('hidden');
        }

        if (!isBackground) {
            window.renderComparables(sym);
            // Fire downstream panels now that we know data exists — stocks
            // with no OHLC skip these entirely, so we never flash "LINK
            // ERROR" or "News throttled" for dead symbols.
            fetchNews(sym);
            fetchAIInsight(sym);
            fetchBacktest(sym);
            fetchQuote(sym);
            showStockPortfolio(sym);
        }
    } catch (e) {
        // AbortError fires when the user switched symbols mid-flight; the
        // newer request has already taken over — don't flag a connection
        // failure or spam the console.
        if (isAbortError(e)) return;
        console.debug('[fetchHistory]', e);
        // Differentiate a per-symbol HTTP error (e.g. 404 for an unknown
        // ticker) from a real network outage. TypeError is what fetch
        // throws when it can't reach the server at all; the WebSocket
        // already tracks that state, so we only flip the connection
        // banner on genuine network failures. HTTP 4xx/5xx just means
        // this one symbol has no data — show the empty-state card.
        const isNetworkDown = (e instanceof TypeError);
        if (isNetworkDown) window.setConnectionState(true);
        if (!isBackground) {
            showEmptyState(sym, isNetworkDown ? 'error' : 'no-data');
        }
    }
}

// showEmptyState renders the "nothing to chart" UI for the center panel.
// Two modes — 'no-data' (the symbol returned an empty series) and 'error'
// (the fetch failed). Both share a card template but differ in icon,
// copy, and whether a retry button is offered.
function showEmptyState(sym, mode) {
    const escSym = window.escapeHTML(sym || '');
    const symInitial = sym ? sym.charAt(0).toUpperCase() : '·';

    // Slim down the price header to a ticker-only block so we don't leave
    // shimmer skeletons hanging above the empty card.
    const priceSummaryEl = document.getElementById('price-summary');
    if (priceSummaryEl) {
        priceSummaryEl.innerHTML = `
            <div class="stagger-enter stagger-1">
                <div class="hidden lg:flex items-center gap-2.5 mb-3">
                    <button data-action="clear-selected-stock" class="flex items-center gap-1 text-slate-500 hover:text-amber-400 transition-colors" title="Back to Dashboard">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                    </button>
                    <h2 class="text-lg font-display font-bold text-white/90 tracking-tight">${escSym}</h2>
                </div>
                <div class="lg:hidden stock-header">
                    <div class="stock-header__topbar">
                        <button data-action="clear-selected-stock" class="stock-header__iconbtn" aria-label="Back">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                        </button>
                        <span class="stock-header__topbar-title">Stock Details</span>
                        <div class="stock-header__actions"></div>
                    </div>
                    <div class="stock-header__identity">
                        <div class="stock-header__logo" aria-hidden="true">${symInitial}</div>
                        <div class="stock-header__ticker">
                            <h2 class="stock-header__ticker-name">${escSym}</h2>
                            <span class="stock-header__ticker-sub">${mode === 'error' ? 'Unable to load' : 'No data available'}</span>
                        </div>
                        <div class="stock-header__price-block">
                            <h1 class="stock-header__price stock-header__price--empty">—</h1>
                        </div>
                    </div>
                </div>
            </div>`;
        priceSummaryEl.classList.remove('hidden');
    }

    // Hide everything in the main panel except the empty-state card.
    document.getElementById('chart-controls')?.classList.add('hidden');
    document.getElementById('chart-container')?.classList.add('hidden');
    document.getElementById('comparables-widget')?.classList.add('hidden');

    // Clear any shimmer skeletons so empty market-indicator cards aren't
    // sitting under the left rail looking like broken placeholders.
    const techStats = document.getElementById('tech-stats');
    if (techStats) techStats.innerHTML = '';
    // Fold away the whole left-rail stock panels block (Market Indicators
    // + AI Oracle) — both are useless without OHLC. Same for the right
    // rail news/about content; operator sees the ticker + empty card and
    // nothing else broken. `data-stock-state="empty"` drives CSS rules
    // (styles.css + terminal-mobile.css) that apply display:none !important
    // so mobile's own `!important` overrides don't force these visible.
    document.body.dataset.stockState = 'empty';
    document.getElementById('left-stock-panels')?.classList.add('hidden');
    document.getElementById('sidebar-content')?.classList.add('hidden');
    document.getElementById('sidebar-placeholder')?.classList.add('hidden');

    // Fill in the empty-state card with mode-specific copy + affordances.
    const emptyState = document.getElementById('chart-empty-state');
    if (!emptyState) return;
    const title = document.getElementById('chart-empty-title');
    const message = document.getElementById('chart-empty-message');
    const symSpan = document.getElementById('chart-empty-symbol');
    const retryBtn = document.getElementById('chart-empty-retry');
    if (mode === 'error') {
        if (title) title.textContent = 'Unable to load';
        if (message) {
            message.innerHTML = `Couldn't reach the data service for <span id="chart-empty-symbol" class="text-amber-400 font-bold">${escSym}</span>. Check your connection and try again.`;
        }
        if (retryBtn) retryBtn.classList.remove('hidden');
    } else {
        if (title) title.textContent = 'No Trading Data';
        if (message) {
            message.innerHTML = `No price history available for <span id="chart-empty-symbol" class="text-amber-400 font-bold">${escSym}</span>. The data may not have been uploaded yet or this symbol has no recent activity.`;
        }
        if (retryBtn) retryBtn.classList.add('hidden');
        if (symSpan) symSpan.textContent = sym;
    }
    emptyState.classList.remove('hidden');
    // Re-trigger the fade-in so rapid symbol flicks still animate on.
    emptyState.style.animation = 'none';
    void emptyState.offsetWidth;
    emptyState.style.animation = '';
}

// Panels moved to ./panels/index.js


// _selectSymbol, openSymbolDropdown, closeSymbolDropdown,
// filterSymbolDropdown, symbolDropdownKeyNav moved to ./ui/search.js

// Command+K / Ctrl+K search focus shortcut + Escape to blur
// Guard against HMR double-registration in Vite dev mode.
if (!window._appListenersRegistered) {
window._appListenersRegistered = true;
window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
        e.preventDefault();
        const searchInput = document.getElementById('symbol-search');
        if (searchInput && document.activeElement !== searchInput) {
            searchInput.focus();
        }
    }

    if (e.key === 'Escape') {
        const searchInput = document.getElementById('symbol-search');
        if (searchInput && document.activeElement === searchInput) {
            window.closeSymbolDropdown();
            searchInput.blur();
        }
    }
});


// Prefetch /v1/history when the user hovers (desktop) or tab-focuses
// (keyboard) any stock-selectable element. By the time they click, the
// response is usually in the in-memory cache, so the chart render starts
// immediately instead of waiting on a round-trip. Dedup'd and TTL-bounded
// by history-cache.js — calling many times is cheap.
//
// Covers three entry points via a single delegated listener:
//   * Watchlist / movers rows        → data-stock-row-symbol
//   * Briefing "Stock Insights" cards → data-stock-row-symbol
//   * Search dropdown suggestions    → data-symbol (on .symbol-option)
function _prefetchFromEvent(e) {
    const row = e.target.closest?.('[data-stock-row-symbol], .symbol-option[data-symbol]');
    if (!row) return;
    const rawSym = row.getAttribute('data-stock-row-symbol') || row.getAttribute('data-symbol');
    // Sanitise — upstream briefing payloads have been seen with markdown
    // emphasis like `**ALW**`; without this the prefetch fires against a
    // URL the server will 400 and wastes a round trip.
    const sym = sanitizeSymbol(rawSym);
    if (!sym) return;
    window.prefetchHistory(sym, '1d');
    // Also warm the LLM insight for pro/admin users — it's the slowest
    // endpoint on the stock-detail view (1-3s). Non-pro users skip this
    // so we don't spam /v1/ai-insight with 403s.
    if (window.isUserAuthenticated && (window.userRole === 'admin' || window.userRole === 'pro')) {
        window.prefetchInsight(sym);
    }
}
document.addEventListener('pointerenter', _prefetchFromEvent, { capture: true, passive: true });
document.addEventListener('focusin', _prefetchFromEvent);

// Magnetic Glow Effect — only on hover-capable pointers. On touch
// devices the listener still fires during scroll/swipe, burning CPU
// updating CSS vars on cards the user can't actually hover. matchMedia
// gates it cleanly: desktop opts in, mobile opts out.
if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
    window.addEventListener('mousemove', e => {
        document.querySelectorAll('.glow-surface').forEach(card => {
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
            card.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
        });
    });
}
} // end HMR guard

// ─── Tear Sheet PDF Export ──────────────────────────────────────────────────
// Tear sheet moved to ./features/tear-sheet.js

// Auth + ticker hydration moved to ./features/auth-ticker.js


// Initialize Page
document.addEventListener('DOMContentLoaded', async () => {
    // 0. Hydrate ticker if necessary
    window.hydrateTicker();

    // Delegated mousedown on symbol dropdown — safe alternative to inline onmousedown
    const dd = document.getElementById('symbols-dropdown');
    if (dd) {
        dd.addEventListener('mousedown', (e) => {
            const opt = e.target.closest('.symbol-option');
            if (opt && opt.dataset.symbol) {
                e.preventDefault();
                window._selectSymbol(opt.dataset.symbol);
            }
        });
    }

    // Delegated click on the watchlist + movers panels. The inline onclick
    // baked into renderStockRow can be unreliable on mobile when the parent
    // container is inside a fixed-positioned tab-isolated view, so we
    // additionally listen here and walk up to the symbol from data attrs.
    const handleStockRowTap = (e) => {
        const card = e.target.closest('[data-stock-row-symbol]');
        if (!card) return;
        // If the click originated on an interactive child (bell, star, any
        // [data-action]), defer to the delegated dispatcher below — don't
        // double-fire as both "navigate to symbol" and "open alert modal".
        const action = e.target.closest('[data-action]');
        if (action && card.contains(action)) return;
        e.preventDefault();
        e.stopPropagation();
        // Same sanitisation as the hover prefetch — strip any markdown
        // or punctuation a polluted upstream payload may have left on the
        // data attribute, so fetchHistory sees a server-valid ticker.
        const sym = sanitizeSymbol(card.getAttribute('data-stock-row-symbol'));
        if (!sym) return;
        // Clear any active tab hash so the chart view is restored.
        if (window.location.hash) {
            try { window.location.hash = ''; } catch (e) { console.debug('[nav]', e); }
        }
        const inp = document.getElementById('symbol-search');
        if (inp) inp.value = sym;
        if (window.fetchHistory) window.fetchHistory();
    };
    // Attach at the document level so any [data-stock-row-symbol] card
    // (in watchlist, movers, market overview, sectors drill-down, etc.)
    // is captured regardless of which container holds it.
    document.addEventListener('click', handleStockRowTap);

    // Delegated action dispatcher — replaces every inline onclick handler
    // in the project. Elements opt in with data-action="name" plus any
    // additional data-* payload; see the switch below for the registry.
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.getAttribute('data-action');
        const sym = el.getAttribute('data-symbol');
        const sector = el.getAttribute('data-sector');
        switch (action) {
            // JS-rendered templates
            case 'toggle-watchlist':
                if (sym && window.toggleWatchlist) window.toggleWatchlist(sym);
                break;
            case 'export-tearsheet':
                if (sym && window.generateTearSheet) window.generateTearSheet(sym);
                break;
            case 'promote-to-main':
                if (sym && window.promoteToMain) window.promoteToMain(sym);
                break;
            case 'toggle-peer-compare':
                if (sym && window.togglePeerCompare) window.togglePeerCompare(sym);
                break;
            case 'exit-compare-mode':
                if (window.exitCompareMode) window.exitCompareMode();
                break;
            case 'open-sector-drill':
                if (sector && window.openSectorDrill) window.openSectorDrill(sector);
                break;
            case 'load-symbol-from-drill': {
                if (!sym) break;
                if (window.closeSectorDrill) window.closeSectorDrill();
                const inp = document.getElementById('symbol-search');
                if (inp) inp.value = sym;
                if (window.fetchHistory) window.fetchHistory();
                break;
            }

            // Static terminal.html controls
            case 'reload-page':
                window.location.reload();
                break;
            case 'toggle-theme':
                if (window.toggleTheme) window.toggleTheme(e);
                break;
            case 'clear-selected-stock':
                if (window.clearSelectedStock) window.clearSelectedStock(e);
                break;
            case 'retry-fetch-history':
                if (window.currentSymbol) {
                    // Invalidate the cache so we don't just replay the
                    // failed response; hide the empty state and re-enter
                    // the fetch flow as if the user clicked the symbol.
                    invalidateHistory(window.currentSymbol);
                    document.getElementById('chart-empty-state')?.classList.add('hidden');
                    window.fetchHistory();
                }
                break;
            case 'switch-pulse': {
                const p = el.getAttribute('data-pulse');
                if (p && window.switchMarketPulse) window.switchMarketPulse(p, el);
                break;
            }
            case 'switch-sector-view': {
                const v = el.getAttribute('data-view');
                if (v && window.switchSectorView) window.switchSectorView(v, el);
                break;
            }
            case 'load-sector-rotation': {
                const r = el.getAttribute('data-range');
                if (r && window.loadSectorRotation) window.loadSectorRotation(r, el);
                break;
            }
            case 'update-chart-range': {
                const r = el.getAttribute('data-range');
                if (r && window.updateChartRange) window.updateChartRange(r, el);
                break;
            }
            case 'close-sector-drill':
                if (window.closeSectorDrill) window.closeSectorDrill();
                break;
            case 'close-sector-drill-backdrop':
                if (e.target === el && window.closeSectorDrill) window.closeSectorDrill();
                break;
            case 'download-stock-data':
                if (window.downloadStockData) window.downloadStockData();
                break;
            case 'run-backtest':
                if (window.runBacktest) window.runBacktest();
                break;
            case 'delete-portfolio-holding': {
                const hid = el.getAttribute('data-holding-id');
                if (hid && window.deletePortfolioHolding) window.deletePortfolioHolding(Number(hid));
                break;
            }
            case 'open-add-position-modal':
                if (window.openAddPositionModal) window.openAddPositionModal();
                break;
            case 'close-add-position-modal':
                if (window.closeAddPositionModal) window.closeAddPositionModal();
                break;
            case 'close-add-position-backdrop':
                if (e.target === el && window.closeAddPositionModal) window.closeAddPositionModal();
                break;
            case 'back-from-sectors':
                // Return to the main market overview from sector view
                if (window.switchMarketPulse) window.switchMarketPulse('movers', document.querySelector('.pulse-tab-btn'));
                break;
            case 'toggle-collapse': {
                const targetId = el.getAttribute('data-target');
                if (!targetId) break;
                const target = document.getElementById(targetId);
                const chevron = el.querySelector('.collapse-chevron');
                if (target) target.classList.toggle('hidden');
                if (chevron) chevron.classList.toggle('rotate-180');
                break;
            }
            case 'show-positions-view':
                if (window.showPositionsView) window.showPositionsView();
                break;
            case 'hide-positions-view':
                if (window.hidePositionsView) window.hidePositionsView();
                break;
            case 'update-portfolio-chart-range': {
                const range = el.getAttribute('data-range');
                if (range && window.updatePortfolioChartRange) window.updatePortfolioChartRange(range);
                break;
            }
            case 'update-portfolio-card-range': {
                // Range pill on the "Your Portfolio Today" briefing card.
                // The whole card is wrapped in an <a> — preventDefault
                // so clicking a pill updates the card instead of
                // navigating to /terminal#portfolio.
                e.preventDefault();
                const range = el.getAttribute('data-range');
                if (range && window.updatePortfolioCardRange) window.updatePortfolioCardRange(range);
                break;
            }
            case 'update-portfolio-chart-mode': {
                const mode = el.getAttribute('data-mode');
                if (mode && window.setPortfolioChartMode) window.setPortfolioChartMode(mode);
                break;
            }
            case 'toggle-lots': {
                const lotSym = el.closest('[data-symbol]')?.getAttribute('data-symbol') || el.getAttribute('data-symbol');
                if (!lotSym) break;
                // Each lot is its own <tr data-lots="SYM"> — toggle all of them.
                const lotRows = document.querySelectorAll(`[data-lots="${CSS.escape(lotSym)}"]`);
                const chevron = document.querySelector(`[data-chevron="${CSS.escape(lotSym)}"]`);
                lotRows.forEach(row => row.classList.toggle('hidden'));
                if (chevron) chevron.classList.toggle('rotate-90');
                break;
            }
            case 'share-stock':
                if (window.shareStock) window.shareStock(el);
                break;
            // Modal triggers — kept as data-action so terminal.html stays
            // free of inline onclick handlers (CSP-friendly, single-source
            // dispatch).
            case 'show-merge-account-modal':
                if (window.showMergeAccountModal) window.showMergeAccountModal();
                break;
            case 'close-merge-account-modal':
                if (window.closeMergeAccountModal) window.closeMergeAccountModal();
                break;
            case 'close-set-password-modal':
                if (window.closeSetPasswordModal) window.closeSetPasswordModal();
                break;
            case 'unlink-oauth-provider':
                // Injected by ui/src/features/auth-ticker.js when an OAuth
                // provider is linked — keeps the button CSP-safe (no inline
                // onclick) so 'unsafe-inline' can be dropped from script-src.
                if (window.unlinkProvider) window.unlinkProvider();
                break;

            // ── Account actions — the in-nav modal moved to /settings;
            //    the buttons below still live inside the alert-rules modal
            //    and the email-verify flow, so the dispatch targets here
            //    remain in play (the open/close modal entries are gone).
            case 'account-unlink-email':
                if (window.submitAccountUnlinkEmail) window.submitAccountUnlinkEmail();
                break;
            case 'account-unlink-provider':
                if (window.submitAccountUnlinkProvider) window.submitAccountUnlinkProvider();
                break;

            // ── Watchlist alerts ─────────────────────────────────────────
            case 'open-alerts-drawer':
                if (window.openAlertsDrawer) window.openAlertsDrawer();
                break;
            case 'close-alerts-drawer':
                if (window.closeAlertsDrawer) window.closeAlertsDrawer();
                break;
            case 'close-alerts-drawer-backdrop':
                // Backdrop has the data-action so a click on the panel
                // itself bubbles up — confine close to direct backdrop hits.
                if (e.target === el && window.closeAlertsDrawer) window.closeAlertsDrawer();
                break;
            case 'open-alert-rules-modal': {
                const sym = el.getAttribute('data-symbol') || '';
                if (window.openAlertRulesModal) window.openAlertRulesModal(sym);
                break;
            }
            case 'close-alert-rules-modal':
                if (window.closeAlertRulesModal) window.closeAlertRulesModal();
                break;
            case 'close-alert-rules-modal-backdrop':
                if (e.target === el && window.closeAlertRulesModal) window.closeAlertRulesModal();
                break;
            case 'mark-all-alerts-read':
                if (window.markAllAlertsRead) window.markAllAlertsRead();
                break;
            case 'mark-alert-read': {
                const id = el.getAttribute('data-event-id');
                if (id && window.markAlertEventRead) window.markAlertEventRead(id);
                break;
            }
            case 'load-symbol-from-alert': {
                const s = el.getAttribute('data-symbol');
                const id = el.getAttribute('data-event-id');
                if (s && window.loadSymbolFromAlert) window.loadSymbolFromAlert(s, id);
                break;
            }
            case 'toggle-alert-rule': {
                const id = el.getAttribute('data-rule-id');
                const enabled = el.getAttribute('data-enabled') === 'true';
                if (id && window.toggleAlertRule) window.toggleAlertRule(id, enabled);
                break;
            }
            case 'delete-alert-rule': {
                const id = el.getAttribute('data-rule-id');
                if (id && window.deleteAlertRule) window.deleteAlertRule(id);
                break;
            }
        }
    });

    // Delegated form submit dispatch — keeps modal forms free of inline
    // onsubmit handlers (CSP-friendly). Form opts in via
    // `data-submit-action="..."`.
    document.addEventListener('submit', (e) => {
        const form = e.target.closest('[data-submit-action]');
        if (!form) return;
        const action = form.getAttribute('data-submit-action');
        switch (action) {
            case 'merge-account':
                if (window.submitMergeAccount) window.submitMergeAccount(e);
                break;
            case 'set-password':
                if (window.submitSetPassword) window.submitSetPassword(e);
                break;
            case 'create-alert-rule':
                if (window.submitAlertRule) window.submitAlertRule(e);
                break;
            case 'add-portfolio-holding':
                if (window.submitAddPortfolioHolding) window.submitAddPortfolioHolding(e);
                break;
            case 'request-verify-email':
                // Fires the "send verification link" form inside the alert
                // rules modal's verify panel. Handler lives in features/alerts.js.
                if (window.submitVerifyEmail) window.submitVerifyEmail(e);
                break;
            // ── Account modal forms ──
            case 'account-request-verify-email':
                if (window.submitAccountRequestVerifyEmail) window.submitAccountRequestVerifyEmail(e);
                break;
            case 'account-set-password':
                if (window.submitAccountSetPassword) window.submitAccountSetPassword(e);
                break;
            case 'account-change-password':
                if (window.submitAccountChangePassword) window.submitAccountChangePassword(e);
                break;
            case 'account-request-pro':
                if (window.submitAccountRequestPro) window.submitAccountRequestPro(e);
                break;
        }
    });

    // Delegated tap on the Compare-to peer cards. Use pointerup so the
    // handler fires reliably on touch — some mobile webviews swallow
    // synthetic `click` events on elements inside scroll containers.
    const peers = document.getElementById('comparables-container');
    if (peers) {
        let _lastPeerTap = 0;
        const handlePeerTap = (e) => {
            const card = e.target.closest('[data-peer-symbol]');
            if (!card) return;
            // Debounce: pointerup + click both fire on desktop.
            const now = Date.now();
            if (now - _lastPeerTap < 400) return;
            _lastPeerTap = now;
            const sym = card.getAttribute('data-peer-symbol');
            if (sym && window.togglePeerCompare) window.togglePeerCompare(sym);
        };
        peers.addEventListener('click', handlePeerTap);
        peers.addEventListener('pointerup', handlePeerTap);
    }

    // 1. Initial visual state — theme icon was already set by initTheme()
    //    at module load time, nothing else needed here.

    // 2. Definitive Auth check (Awaited to prevent UI flicker)
    await window.checkAuthState();

    // 2a. Wire alerts UI (bell + unread badge seed). No-op for guests —
    // initAlerts itself returns early when !window.isUserAuthenticated,
    // so this is safe before the terminal-specific data step below.
    initAlerts();

    // 2a'. Wire account-management UI (navbar gear + attention pip).
    // Reveals the gear for any authenticated user; sets the amber pip
    // when an unverified email is sitting around.
    initAccount();

    // 2a''. Backtest panel — unhides the container for pro/admin.
    // The actual backtest runs on stock select (fetchBacktest in the
    // fetchHistory success path).
    initBacktest();

    // Collapse AI Oracle + Signal Backtest by default on desktop ONLY
    // when the user has a portfolio (pro/admin). Guests and users
    // without a portfolio see the Oracle expanded — it's the most
    // valuable content in the left rail for them.
    if (window.matchMedia('(min-width: 1024px)').matches) {
        const hasPortfolio = window.isUserAuthenticated &&
            (window.userRole === 'admin' || window.userRole === 'pro');
        if (hasPortfolio) {
            ['oracle-collapse-body', 'backtest-collapse-body'].forEach(id => {
                const body = document.getElementById(id);
                if (body) body.classList.add('hidden');
                const btn = document.querySelector(`[data-target="${id}"]`);
                const chevron = btn?.querySelector('.collapse-chevron');
                if (chevron) chevron.classList.add('rotate-180');
            });
        }
    }

    // 2a'''. Portfolio panel — unhides the container for authed users,
    // fetches holdings + live P&L immediately.
    initPortfolio();

    // 2a''''. Web Push — prompt for notification permission and register
    // the subscription with the server. Idempotent; no-ops if already
    // subscribed, user declines, or VAPID not configured on the server.
    subscribeToPush();

    // 2b. Show toast for OAuth redirect errors
    const oauthError = new URLSearchParams(window.location.search).get('oauth_error');
    if (oauthError) {
        const messages = {
            account_taken: 'This account is already linked to another user.',
            email_taken: 'This email is already linked to another account.',
            already_linked: 'This provider is already linked to your account.',
        };
        window.showToast(messages[oauthError] || 'OAuth linking failed.', 'error');
        // Clean the URL
        const url = new URL(window.location);
        url.searchParams.delete('oauth_error');
        window.history.replaceState({}, '', url.pathname + url.search);
    }

    // 2c. Show toast after a successful email verification redirect.
    // /auth/verify-email redirects here with ?email_verified=1 on success.
    if (new URLSearchParams(window.location.search).get('email_verified') === '1') {
        window.showToast('Email verified — you can now create alerts.', 'success', 6000);
        const url = new URL(window.location);
        url.searchParams.delete('email_verified');
        window.history.replaceState({}, '', url.pathname + url.search);
    }

    // 3. Terminal-specific data
    if (document.getElementById('symbol-search')) {
        preloadSymbols(); // preload symbols for autocomplete
        initSearchInput(); // wire focus/blur/input/keydown on #symbol-search
        updateMarketStatus();
        window.fetchMarketSummary();
        window.fetchWatchlistPanel();
        window.fetchMarketNews();

        // Restore the selected quote: prefer ?symbol= in the URL (so
        // shared/bookmarked links work), fall back to the last stock
        // saved in localStorage.
        try {
            const initialHash = window.location.hash;
            const urlSym = new URL(window.location.href).searchParams.get('symbol');
            const lastSym = urlSym || localStorage.getItem('gse:lastSymbol');
            if (lastSym) {
                const inp = document.getElementById('symbol-search');
                if (inp) inp.value = lastSym;
                window.fetchHistory();
            }
            // Restore the active chip from the URL hash (or sessionStorage
            // fallback). We programmatically click the matching chip after
            // a tick — this re-runs the chip's normal flow (set :target,
            // scroll into view, persist) and is robust against fetchHistory
            // clearing the hash mid-init.
            const targetHash = initialHash || (sessionStorage.getItem('gse:lastChip') || '');
            if (targetHash) {
                setTimeout(() => {
                    const chip = document.querySelector(`.mobile-section-nav .mobile-tab[href="${targetHash}"]`);
                    if (chip) chip.click();
                }, 100);
            }
            window.addEventListener('hashchange', () => {
                window._syncTabState();
                try {
                    if (window.location.hash) {
                        sessionStorage.setItem('gse:lastChip', window.location.hash);
                    } else {
                        sessionStorage.removeItem('gse:lastChip');
                    }
                } catch (e) { console.debug('[storage] chip persist:', e); }
            });
            window._syncTabState();
        } catch (e) { console.debug('[init] chip restore:', e); }
        
        if (typeof window.scheduleNextRefresh === 'function') {
            window.scheduleNextRefresh();
        }
        
        window.connectWebSocket();
    }
});
