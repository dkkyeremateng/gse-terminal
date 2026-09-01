// Watchlist-alerts UI: bell + badge in the nav, right-side drawer of recent
// events, and a rule-management modal.
//
// Lifecycle:
//  - initAlerts() is called from app.js on DOMContentLoaded. It hides the bell
//    for guests and seeds the unread count + events list.
//  - window.handleAlertPush is invoked by live/socket.js when the server
//    emits a `{type: "alert", …}` WebSocket frame. It increments the badge,
//    surfaces a toast, and refreshes the drawer feed if it's open.
//  - Delegated click handlers in app.js route the data-action names to the
//    exported window.* entry points below.

import { escapeHTML } from '../util/escape.js';

// ─── State ──────────────────────────────────────────────────────────────────

// _unread is the canonical badge count. Server pushes set it explicitly; the
// optimistic local path (mark-as-read) decrements and then confirms via the
// server response.
let _unread = 0;
// Cached events for the drawer; refetched on open + after each push frame.
let _events = [];
// Cached rules for the modal; refetched whenever the modal opens.
let _rules = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

// Entitlement check — alerts are gated to Pro/Admin on the server. The
// client mirror keeps the bell, drawer, and rule-creation buttons hidden
// for basic-tier users so they don't hit a 403 on /v1/me/alerts. Keep
// this in lockstep with the RequireProOrAdmin middleware in main.go.
function canUseAlerts() {
    return !!window.isUserAuthenticated &&
        (window.userRole === 'admin' || window.userRole === 'pro');
}

function isAuthenticated() {
    return canUseAlerts();
}

function setUnread(n) {
    _unread = Math.max(0, Number(n) || 0);
    const bell = document.getElementById('alerts-bell-btn');
    if (bell) bell.setAttribute('data-count', String(_unread));
    // Drawer's "Clear" action is only meaningful when there's at least
    // one unread event; hide otherwise so the header doesn't offer a
    // no-op button. Funnelled through the setUnread chokepoint so
    // every mutation path (push, drawer open, mark-read, mark-all-read)
    // stays in sync automatically.
    const clearBtn = document.getElementById('alerts-clear-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', _unread === 0);
}

function fmtValue(metric, v) {
    if (typeof v !== 'number' || Number.isNaN(v)) return '—';
    switch (metric) {
        case 'price':      return `¢${v.toFixed(2)}`;
        case 'pct_change': return `${v.toFixed(2)}%`;
        case 'rsi':        return v.toFixed(1);
        default:           return v.toFixed(4);
    }
}

function metricLabel(metric) {
    switch (metric) {
        case 'price':      return 'Price';
        case 'pct_change': return '% Change';
        case 'rsi':        return 'RSI(14)';
        default:           return metric;
    }
}

function timeAgo(isoDate) {
    const delta = (Date.now() - new Date(isoDate).getTime()) / 1000;
    if (delta < 60)    return `${Math.floor(delta)}s ago`;
    if (delta < 3600)  return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

// ─── Network ────────────────────────────────────────────────────────────────

async function fetchEvents() {
    if (!isAuthenticated()) return { events: [], unreadCount: 0 };
    try {
        const res = await fetch('/v1/me/alerts/events?limit=50', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        _events = Array.isArray(data.events) ? data.events : [];
        setUnread(data.unreadCount || 0);
        return data;
    } catch (e) {
        console.debug('[alerts] fetch events failed', e);
        return { events: [], unreadCount: _unread };
    }
}

async function fetchRules() {
    if (!isAuthenticated()) return [];
    try {
        const res = await fetch('/v1/me/alerts', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _rules = await res.json() || [];
        return _rules;
    } catch (e) {
        console.debug('[alerts] fetch rules failed', e);
        return [];
    }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderDrawer() {
    const body = document.getElementById('alerts-drawer-body');
    if (!body) return;
    if (_events.length === 0) {
        body.innerHTML = `
            <div class="p-10 text-center">
                <div class="mono text-[10px] uppercase tracking-[0.22em] text-[var(--paper)]/40 mb-2">No alerts</div>
                <p class="text-[11px] text-[var(--paper)]/50">Create a rule from the Rules button to be notified when a watched stock crosses a threshold.</p>
            </div>`;
        return;
    }
    body.innerHTML = _events.map(ev => {
        const unread = !ev.readAt;
        const row = `
            <div class="px-5 py-4 border-b border-[var(--hair)] ${unread ? 'bg-[rgba(255,177,43,0.035)]' : ''}" data-alert-event-id="${ev.id}">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-baseline gap-2 mb-1">
                            <span class="font-display font-bold text-[15px] text-[var(--paper)]">${escapeHTML(ev.symbol)}</span>
                            <span class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/40">${metricLabel(ev.metric)}</span>
                        </div>
                        <p class="mono text-[11px] text-[var(--paper)]/75">
                            <span class="text-[var(--amber)]">${fmtValue(ev.metric, ev.observedValue)}</span>
                            <span class="text-[var(--paper)]/45">${escapeHTML(ev.op)}</span>
                            <span>${fmtValue(ev.metric, ev.threshold)}</span>
                        </p>
                    </div>
                    <div class="flex flex-col items-end gap-1 shrink-0">
                        <span class="mono text-[9px] uppercase tracking-[0.2em] text-[var(--paper)]/40">${timeAgo(ev.firedAt)}</span>
                        ${unread ? '<span class="w-1.5 h-1.5 rounded-full bg-[var(--amber)]"></span>' : ''}
                    </div>
                </div>
                <div class="mt-2 flex items-center gap-3">
                    <button data-action="load-symbol-from-alert" data-symbol="${escapeHTML(ev.symbol)}" data-event-id="${ev.id}" class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--amber)] hover:opacity-80">View →</button>
                    ${unread ? `<button data-action="mark-alert-read" data-event-id="${ev.id}" class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/50 hover:text-[var(--amber)]">Mark read</button>` : ''}
                </div>
            </div>`;
        return row;
    }).join('');
}

function renderRules() {
    const list = document.getElementById('alert-rules-list');
    if (!list) return;
    // Hide the list container entirely when there's nothing in it —
    // the form above is already self-describing ("Add rule") so an
    // empty "No rules yet" placeholder only adds vertical noise.
    // The container's border + padding disappear along with it.
    if (_rules.length === 0) {
        list.innerHTML = '';
        list.classList.add('hidden');
        return;
    }
    list.classList.remove('hidden');
    list.innerHTML = _rules.map(r => {
        const statusColour = r.enabled ? 'var(--moss)' : 'var(--paper)';
        const toggleLabel = r.enabled ? 'Pause' : 'Resume';
        return `
            <div class="px-4 py-3 border-b border-[var(--hair)] flex items-center justify-between gap-3" data-alert-rule-id="${r.id}">
                <div class="flex-1 min-w-0">
                    <div class="flex items-baseline gap-2">
                        <span class="font-display font-bold text-[14px] text-[var(--paper)]">${escapeHTML(r.symbol)}</span>
                        <span class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/40">${metricLabel(r.metric)}</span>
                    </div>
                    <p class="mono text-[11px] text-[var(--paper)]/70 mt-1">
                        <span class="text-[var(--paper)]/45">${escapeHTML(r.op)}</span> ${fmtValue(r.metric, r.threshold)}
                        <span class="ml-3 text-[9px] uppercase tracking-[0.22em]" style="color:${statusColour}">${r.enabled ? 'armed' : 'paused'}</span>
                        ${r.fireCount > 0 ? `<span class="ml-2 text-[9px] text-[var(--paper)]/35">fired ${r.fireCount}×</span>` : ''}
                    </p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <button data-action="toggle-alert-rule" data-rule-id="${r.id}" data-enabled="${!r.enabled}" class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/60 hover:text-[var(--amber)] px-2 py-1 border border-[var(--hair)]">${toggleLabel}</button>
                    <button data-action="delete-alert-rule" data-rule-id="${r.id}" class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/60 hover:text-[var(--rust)] px-2 py-1 border border-[var(--hair)]">Delete</button>
                </div>
            </div>`;
    }).join('');
}

// ─── Public window.* entry points ───────────────────────────────────────────

// Called from live/socket.js when the server pushes a user-targeted alert
// frame. Bumps the badge, shows a toast, refreshes the drawer if open.
window.handleAlertPush = async function(data) {
    if (!data || data.type !== 'alert') return;
    setUnread(_unread + 1);
    const msg = `${data.symbol}: ${metricLabel(data.metric)} ${data.op} ${fmtValue(data.metric, data.threshold)} (now ${fmtValue(data.metric, data.value)})`;
    if (typeof window.showToast === 'function') {
        window.showToast(msg, 'info', 8000);
    }
    // Refresh the drawer if it's visible so the new event shows up immediately.
    const drawer = document.getElementById('alerts-drawer');
    if (drawer && !drawer.classList.contains('hidden')) {
        await fetchEvents();
        renderDrawer();
    }
};

window.openAlertsDrawer = async function() {
    if (!isAuthenticated()) return;
    const drawer = document.getElementById('alerts-drawer');
    if (!drawer) return;
    drawer.classList.remove('hidden');
    await fetchEvents();
    renderDrawer();
};

window.closeAlertsDrawer = function() {
    const drawer = document.getElementById('alerts-drawer');
    if (drawer) drawer.classList.add('hidden');
};

// Fetches the definitive email-verification state from /v1/me. Cached on
// window.* globals so a second open within the same session skips the
// round-trip; gets refreshed after a successful verify-link click.
async function fetchEmailState() {
    try {
        const res = await fetch('/v1/me', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        window.userEmail         = data.email || '';
        window.userEmailVerified = !!data.emailVerified;
        window.userAvailableProviders = Array.isArray(data.availableProviders) ? data.availableProviders : [];
        window.userLinkedProvider = data.provider || '';
        return data;
    } catch (e) {
        console.debug('[alerts] /v1/me probe failed', e);
        return null;
    }
}

// Renders the OAuth-provider buttons into any supplied container. Each
// button is a plain <a> to /auth/link/{provider} — the server handles
// the OAuth round-trip + returns with email_verified=TRUE. Pattern
// mirrors auth-ticker.js's link-buttons.
//
// Parameterised on container id so the same helper drives both the
// inline verify panel inside #alert-rules-modal (id 'alert-verify-oauth')
// and the standalone #email-verify-modal (id 'email-verify-oauth').
function renderVerifyOAuthOptions(containerId) {
    const container = document.getElementById(containerId || 'alert-verify-oauth');
    if (!container) return;
    const providers = window.userAvailableProviders || [];
    const linked    = window.userLinkedProvider || '';
    const label = (p) => `Continue with ${p.displayName || p.name}`;
    if (providers.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = providers.map(p => {
        // If the provider is already linked, the email must be unverified
        // for some other reason (legacy row, manual entry). Skip the
        // button in that case — it would just loop through the same OAuth
        // that already populated a stale address.
        if (p.name === linked) return '';
        return `<a href="/auth/link/${encodeURIComponent(p.name)}" class="inline-flex items-center justify-center gap-2 py-2.5 border border-[var(--hair-strong)] text-[var(--paper)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:border-[var(--amber)] hover:text-[var(--amber)] transition" data-action="link-oauth-for-verify">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
            ${escapeHTML(label(p))}
        </a>`;
    }).join('');
}

// Shows or hides the verify vs. authoring sub-panels inside the modal
// based on the caller's email verification state.
function toggleVerifyPanel(needsVerify) {
    const verifyPanel   = document.getElementById('alert-verify-panel');
    const authoringPanel = document.getElementById('alert-authoring-panel');
    if (verifyPanel)   verifyPanel.classList.toggle('hidden', !needsVerify);
    if (authoringPanel) authoringPanel.classList.toggle('hidden', needsVerify);
}

window.openAlertRulesModal = async function(prefillSymbol) {
    if (!isAuthenticated()) return;
    const modal = document.getElementById('alert-rules-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const statusEl       = document.getElementById('alert-form-status');
    const verifyStatusEl = document.getElementById('verify-form-status');
    if (statusEl) statusEl.textContent = '';
    if (verifyStatusEl) verifyStatusEl.textContent = '';

    // Probe the latest email state — cheap, and protects against the
    // cached window.userEmailVerified going stale (e.g. the user just
    // clicked the verify link in another tab).
    await fetchEmailState();
    const needsVerify = !window.userEmailVerified;

    toggleVerifyPanel(needsVerify);

    if (needsVerify) {
        renderVerifyOAuthOptions('alert-verify-oauth');
        // Prefill the manual-entry field with the user's stashed email
        // (if any, e.g. an unverified address from a prior request) so
        // re-sending is one click.
        const emailInput = document.getElementById('verify-form-email');
        if (emailInput && window.userEmail) emailInput.value = window.userEmail;
        return; // authoring panel stays hidden until verified
    }

    // Authoring path — existing flow.
    const sym = (prefillSymbol || window.currentSymbol || '').toUpperCase();
    const symInput = document.getElementById('alert-form-symbol');
    if (symInput && sym) symInput.value = sym;
    await fetchRules();
    renderRules();
};

// Submit handler for the manual-email form inside the verify panel.
// Wired via data-submit-action="request-verify-email" in app.js's
// delegated dispatcher.
window.submitVerifyEmail = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const statusEl = document.getElementById('verify-form-status');
    const email = (form.elements.email.value || '').trim().toLowerCase();
    if (statusEl) statusEl.textContent = '';
    if (!email) {
        if (statusEl) statusEl.innerHTML = '<span class="text-[var(--rust)]">Enter an email address.</span>';
        return;
    }
    try {
        const res = await fetch('/v1/me/email/request-verify', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Failed' }));
            if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(err.error || 'Failed')}</span>`;
            return;
        }
        // Success — "check your inbox" state. The verify link lands on
        // /auth/verify-email → redirects to /terminal?email_verified=1
        // where the success-toast handler (below) picks it up.
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--moss)">Verification email sent to ${escapeHTML(email)}. Click the link in your inbox to finish.</span>`;
        }
        window.userEmail = email;
        window.userEmailVerified = false;
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(String(e.message || e))}</span>`;
    }
};

window.closeAlertRulesModal = function() {
    const modal = document.getElementById('alert-rules-modal');
    if (modal) modal.classList.add('hidden');
};

window.submitAlertRule = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const statusEl = document.getElementById('alert-form-status');
    if (statusEl) statusEl.textContent = '';

    const body = {
        symbol:    (form.elements.symbol.value || '').trim().toUpperCase(),
        metric:    form.elements.metric.value,
        op:        form.elements.op.value,
        threshold: parseFloat(form.elements.threshold.value),
    };
    if (!body.symbol || !Number.isFinite(body.threshold)) {
        if (statusEl) statusEl.innerHTML = '<span class="text-[var(--rust)]">Fill in all fields.</span>';
        return;
    }

    try {
        const res = await fetch('/v1/me/alerts', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Failed' }));
            if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(err.error || 'Failed')}</span>`;
            return;
        }
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--moss)">Rule created.</span>';
        form.reset();
        await fetchRules();
        renderRules();
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(String(e.message || e))}</span>`;
    }
};

window.toggleAlertRule = async function(ruleID, enabled) {
    try {
        const res = await fetch(`/v1/me/alerts/${encodeURIComponent(ruleID)}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchRules();
        renderRules();
    } catch (e) {
        if (typeof window.showToast === 'function') window.showToast('Failed to update rule', 'error');
    }
};

window.deleteAlertRule = async function(ruleID) {
    try {
        const res = await fetch(`/v1/me/alerts/${encodeURIComponent(ruleID)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchRules();
        renderRules();
    } catch (e) {
        if (typeof window.showToast === 'function') window.showToast('Failed to delete rule', 'error');
    }
};

window.markAlertEventRead = async function(eventID) {
    // Optimistic: decrement the badge and re-render immediately. The
    // server response is idempotent so a failure is harmless.
    const idx = _events.findIndex(e => e.id === Number(eventID));
    if (idx >= 0 && !_events[idx].readAt) {
        _events[idx].readAt = new Date().toISOString();
        setUnread(_unread - 1);
        renderDrawer();
    }
    try {
        await fetch(`/v1/me/alerts/events/${encodeURIComponent(eventID)}/read`, {
            method: 'POST',
            credentials: 'same-origin',
        });
    } catch (e) { /* optimistic — ignore */ }
};

window.markAllAlertsRead = async function() {
    try {
        await fetch('/v1/me/alerts/events/read-all', {
            method: 'POST',
            credentials: 'same-origin',
        });
        setUnread(0);
        _events = _events.map(e => ({ ...e, readAt: e.readAt || new Date().toISOString() }));
        renderDrawer();
    } catch (e) { /* ignore */ }
};

// From a drawer "View →" tap — loads the stock and closes the drawer.
window.loadSymbolFromAlert = function(symbol, eventID) {
    if (!symbol) return;
    window.closeAlertsDrawer();
    if (eventID) window.markAlertEventRead(eventID);
    const input = document.getElementById('symbol-search');
    if (input) input.value = symbol.toUpperCase();
    if (typeof window.fetchHistory === 'function') window.fetchHistory();
};

// (The previous standalone email-verify modal opened from the navbar
// has been folded into the consolidated #account-modal owned by
// features/account.js. The inline verify panel inside #alert-rules-modal
// stays — it kicks in when a Pro/Admin opens the rules modal without a
// verified email, sparing them a context switch into the account modal.)

// ─── Boot ───────────────────────────────────────────────────────────────────

// initAlerts is called by app.js after the user's auth state has been
// resolved (so `window.isUserAuthenticated` is stable). Shows the bell and
// seeds the unread count; guests never see alerts UI at all.
export async function initAlerts() {
    if (!isAuthenticated()) return;
    const bell = document.getElementById('alerts-bell-btn');
    if (bell) bell.classList.remove('hidden');
    await fetchEvents();
}

// Inline init for the /settings page. Populates the rules list (and the
// email-verify gate above it when the user has no verified email). Same
// module covers both the terminal's modal flow and the standalone page
// by delegating to openAlertRulesModal — the modal's DOM IDs were reused
// on the settings page, and openAlertRulesModal only unhides the root
// container whose `hidden` class we omit here, so calling it is idempotent.
export async function initAlertsPage() {
    if (!isAuthenticated()) {
        const hint = document.getElementById('alerts-role-hint');
        if (hint) hint.textContent = 'Pro/Admin only';
        const gate = document.getElementById('alert-authoring-panel');
        if (gate) gate.innerHTML = `<p class="text-xs text-[var(--paper)]/55 leading-relaxed">Alert rules are available on Pro and Admin tiers. Upgrade from the main terminal to unlock them.</p>`;
        return;
    }
    if (typeof window.openAlertRulesModal === 'function') {
        await window.openAlertRulesModal();
    }
}

// Close-on-Esc for both the drawer and the rule modal. Non-blocking —
// falls back to the explicit close buttons when the browser doesn't
// dispatch keydown (e.g. focus is inside an iframe).
if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const drawer = document.getElementById('alerts-drawer');
        const modal = document.getElementById('alert-rules-modal');
        if (drawer && !drawer.classList.contains('hidden')) window.closeAlertsDrawer();
        if (modal && !modal.classList.contains('hidden')) window.closeAlertRulesModal();
    });
}
