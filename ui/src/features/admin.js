// Admin panel logic — extracted from inline <script> in admin.html.
// Import app.js to guarantee window.updateFileName / renderPreviewUI
// are defined before we patch them below.
import '../app.js';

// ── Tab switching ──────────────────────────────────────────────
window.switchTab = function (tab) {
    const views = {
        ingestion: document.getElementById('view-ingestion'),
        users: document.getElementById('view-users'),
        audit: document.getElementById('view-audit'),
        alerts: document.getElementById('view-alerts'),
        'pro-requests': document.getElementById('view-pro-requests'),
    };
    const tabs = {
        ingestion: document.getElementById('tab-ingestion'),
        users: document.getElementById('tab-users'),
        audit: document.getElementById('tab-audit'),
        alerts: document.getElementById('tab-alerts'),
        'pro-requests': document.getElementById('tab-pro-requests'),
    };
    const activeClass = {
        ingestion: 'active-ingestion',
        users: 'active-users',
        audit: 'active-audit',
        alerts: 'active-alerts',
        'pro-requests': 'active-pro-requests',
    };

    Object.values(views).forEach((v) => v && v.classList.add('hidden'));
    Object.entries(tabs).forEach(([, el]) => {
        if (el) el.classList.remove('active-ingestion', 'active-users', 'active-audit', 'active-alerts', 'active-pro-requests');
    });

    if (views[tab]) views[tab].classList.remove('hidden');
    if (tabs[tab]) tabs[tab].classList.add(activeClass[tab]);

    if (tab === 'audit' && window.htmx) {
        htmx.trigger('#audit-table-container', 'refresh');
    }
    // The alerts tab renders fully from JS (no htmx swaps) — load on first
    // entry and every subsequent activation so stat deltas stay fresh.
    if (tab === 'alerts' && typeof window.loadAlertsTab === 'function') {
        window.loadAlertsTab();
    }
    if (tab === 'pro-requests' && typeof window.loadProRequestsTab === 'function') {
        window.loadProRequestsTab();
    }

    const url = new URL(window.location);
    if (tab === 'ingestion') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url);
};

// Restore tab from URL on load
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab && ['ingestion', 'users', 'audit', 'alerts', 'pro-requests'].includes(tab)) {
        window.switchTab(tab);
    }
});

// ── Delegated click dispatch — replaces inline onclick handlers so
//    admin.html is CSP-friendly. Each trigger element opts in via
//    data-action (+ data-arg for tab name / preview mode / etc.). ──
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    const arg = el.getAttribute('data-arg');
    switch (action) {
        case 'switch-tab':
            if (arg) window.switchTab(arg);
            break;
        case 'open-file-dialog': {
            const input = document.getElementById('file-input');
            if (input) input.click();
            break;
        }
        case 'clear-file':
            window.clearFile();
            break;
        case 'set-preview-mode':
            if (arg) window.setPreviewMode(arg);
            break;
        case 'audit-refresh':
            if (typeof htmx !== 'undefined') htmx.trigger('#audit-table-container', 'refresh');
            break;
        case 'close-reset-modal':
            window.closeResetModal();
            break;
        case 'admin-reset-password': {
            // Username arrives via data-username (HTML-escaped server-side).
            // The DOM has already decoded the entity references, so by the
            // time we read it back it matches the original string — safe to
            // pass to our modal helper since the modal renders via
            // textContent, not innerHTML.
            const id = parseInt(el.getAttribute('data-user-id'), 10);
            const username = el.getAttribute('data-username') || '';
            if (id && window.adminResetPassword) {
                window.adminResetPassword(id, username);
            }
            break;
        }
    }
});

// ── Programmatic bindings for events that don't map to click ──
document.addEventListener('DOMContentLoaded', () => {
    // Dropzone drag + drop. preventDefault on dragover is required so
    // the browser doesn't veto the drop event.
    const dropzone = document.getElementById('dropzone');
    if (dropzone) {
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
        });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
            const input = document.getElementById('file-input');
            if (input && e.dataTransfer && e.dataTransfer.files) {
                input.files = e.dataTransfer.files;
                if (typeof window.updateFileName === 'function') window.updateFileName();
            }
        });
    }

    // File input → updateFileName (was inline onchange).
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            if (typeof window.updateFileName === 'function') window.updateFileName();
        });
    }

    // Audit search filter (was inline oninput).
    const auditFilter = document.getElementById('audit-filter');
    if (auditFilter) {
        auditFilter.addEventListener('input', (e) => {
            if (typeof window.filterAuditRows === 'function') {
                window.filterAuditRows(e.target.value);
            }
        });
    }
});

// ── Audit filter (client-side) ─────────────────────────────────
window.filterAuditRows = function (query) {
    const q = (query || '').trim().toLowerCase();
    const container = document.getElementById('audit-table-container');
    if (!container) return;
    container.querySelectorAll('.audit-row').forEach((row) => {
        if (!q) {
            row.style.display = '';
            return;
        }
        row.style.display = row.innerText.toLowerCase().includes(q) ? '' : 'none';
    });
};

// Compute audit summary stats after each fragment load.
document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.target?.id !== 'audit-table-container') return;
    const rows = e.target.querySelectorAll('.audit-row');
    const total = rows.length;
    let userCount = 0,
        authCount = 0;
    let latestTs = '';
    rows.forEach((row) => {
        const action = row.querySelector('.audit-action')?.innerText.toLowerCase() || '';
        if (action.startsWith('user.')) userCount++;
        if (action.startsWith('auth.')) authCount++;
    });
    if (rows[0]) latestTs = rows[0].querySelector('.audit-time')?.innerText || '';
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.innerText = v;
    };
    set('audit-stat-total', total.toLocaleString());
    set('audit-stat-user', userCount.toLocaleString());
    set('audit-stat-auth', authCount.toLocaleString());
    set('audit-stat-latest', latestTs || '—');
});

// ── Clear file selection ───────────────────────────────────────
window.clearFile = function () {
    document.getElementById('file-input').value = '';
    const display = document.getElementById('file-name-display');
    if (display) display.classList.remove('visible');
    window.previewLines = [];
    const section = document.getElementById('preview-section');
    const container = document.getElementById('preview-container');
    const header = document.getElementById('preview-header');
    const empty = document.getElementById('preview-empty');
    const stats = document.getElementById('preview-stats');
    const rowCount = document.getElementById('file-row-count');
    const sizeStat = document.getElementById('file-size-stat');
    if (section) section.classList.add('hidden');
    if (container) container.innerHTML = '';
    if (header) {
        header.classList.add('hidden');
        header.classList.remove('flex');
    }
    if (empty) empty.classList.remove('hidden');
    if (stats) {
        stats.textContent = '';
        stats.classList.add('hidden');
    }
    if (rowCount) rowCount.textContent = '—';
    if (sizeStat) sizeStat.textContent = '—';
};

// ── Patch app.js functions after module load ──────────────────
document.addEventListener('DOMContentLoaded', function () {
    if (typeof window.updateMarketStatus === 'function') {
        window.updateMarketStatus();
    }
    if (typeof window.connectWebSocket === 'function') {
        window.connectWebSocket();
    }

    // Patch updateFileName to also populate file stat pills
    const origUpdate = window.updateFileName;
    if (origUpdate) {
        window.updateFileName = function () {
            origUpdate();
            const input = document.getElementById('file-input');
            if (!input || !input.files.length) return;
            const file = input.files[0];
            const size =
                file.size < 1024 * 1024
                    ? (file.size / 1024).toFixed(1) + ' KB'
                    : (file.size / 1024 / 1024).toFixed(2) + ' MB';
            const sizeEl = document.getElementById('file-size-stat');
            if (sizeEl) sizeEl.textContent = size;
            const display = document.getElementById('file-name-display');
            if (display) display.classList.add('visible');
        };
    }

    // Patch renderPreviewUI to hide empty state + populate metadata
    const orig = window.renderPreviewUI;
    if (!orig) return;
    window.renderPreviewUI = function () {
        orig();

        const empty = document.getElementById('preview-empty');
        if (empty) empty.classList.add('hidden');
        const header = document.getElementById('preview-header');
        if (header && !header.classList.contains('hidden')) header.classList.add('flex');

        const lines = window.previewLines || [];
        if (lines.length > 0) {
            const cols = lines[0].split(',').length;
            const statsEl = document.getElementById('preview-stats');
            if (statsEl) {
                statsEl.textContent = `${cols} cols · ${lines.length - 1} rows`;
                statsEl.classList.remove('hidden');
            }
            const rowCountEl = document.getElementById('file-row-count');
            if (rowCountEl) rowCountEl.textContent = (lines.length - 1).toLocaleString();
        }
    };
});

// ── Password reset modal ──────────────────────────────────────
window.adminResetPassword = function (id, username) {
    const modal = document.getElementById('password-reset-modal');
    const form = document.getElementById('reset-password-form');
    const display = document.getElementById('reset-user-display');
    const status = document.getElementById('reset-status');

    display.innerText = `User: ${username}`;
    status.innerHTML = '';
    form.reset();
    form.setAttribute('hx-post', `/v1/admin/users/${id}/password`);
    htmx.process(form);

    modal.classList.remove('opacity-0', 'pointer-events-none');
    modal.children[0].classList.remove('scale-95');
    modal.children[0].classList.add('scale-100');
};

window.closeResetModal = function () {
    const modal = document.getElementById('password-reset-modal');
    modal.classList.add('opacity-0', 'pointer-events-none');
    modal.children[0].classList.add('scale-95');
    modal.children[0].classList.remove('scale-100');
};

// ── Watchlist alerts admin tab ────────────────────────────────
//
// This subtree is rendered entirely client-side: the three endpoints
// (/v1/admin/alert-rules, /v1/admin/alert-events, /v1/admin/alert-stats)
// return JSON, and loadAlertsTab composes them into the three sections.
// Refresh happens on tab entry + via the toolbar Refresh button + after
// a successful admin-delete.

// escapeHTML is local (not imported) so we avoid another cross-module
// dep; duplicate of the two-line util but keeps admin.js standalone.
function escAdmin(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtAlertValue(metric, v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    switch (metric) {
        case 'price':      return `GH\u00a2${v.toFixed(2)}`;
        case 'pct_change': return `${v.toFixed(2)}%`;
        case 'rsi':        return v.toFixed(1);
        default:           return v.toFixed(4);
    }
}

function fmtAlertTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Keep the latest payloads cached so the filter input can reflow without
// refetching. Also lets "admin delete" optimistically drop the row.
let _alertRules = [];
let _alertEvents = [];

async function fetchAlertStats() {
    const res = await fetch('/v1/admin/alert-stats', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`stats ${res.status}`);
    return res.json();
}
async function fetchAlertRules() {
    const res = await fetch('/v1/admin/alert-rules?limit=500', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`rules ${res.status}`);
    return res.json();
}
async function fetchAlertEvents() {
    const res = await fetch('/v1/admin/alert-events?limit=200', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`events ${res.status}`);
    return res.json();
}

function renderAlertStats(stats) {
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.innerText = (v == null ? '—' : Number(v).toLocaleString());
    };
    set('alerts-stat-total',  stats.totalRules);
    set('alerts-stat-active', stats.activeRules);
    set('alerts-stat-users',  stats.usersWithRule);
    set('alerts-stat-today',  stats.firesToday);
    set('alerts-stat-week',   stats.firesThisWeek);
}

function renderAlertRules(rules) {
    const body = document.getElementById('alerts-rules-body');
    const count = document.getElementById('alerts-rules-count');
    if (!body) return;
    if (count) count.innerText = rules.length.toLocaleString();
    if (rules.length === 0) {
        body.innerHTML = '<div class="px-6 py-12 text-center text-slate-500 italic text-xs">No alert rules have been created yet.</div>';
        return;
    }
    body.innerHTML = rules.map((r) => {
        const metricLabel = r.metric === 'pct_change' ? '%CHG'
                          : r.metric === 'rsi'        ? 'RSI14'
                          : r.metric === 'price'      ? 'PRICE'
                          : r.metric.toUpperCase();
        const predicate = `${escAdmin(r.op)} ${escAdmin(fmtAlertValue(r.metric, r.threshold))}`;
        const stateClass = r.enabled ? 'armed' : 'paused';
        const stateLabel = r.enabled ? 'Armed' : 'Paused';
        const lastFired = r.lastFiredAt ? fmtAlertTime(r.lastFiredAt) : '—';
        const owner = r.username ? escAdmin(r.username) : `<span class="text-slate-600 italic">user #${r.userId}</span>`;
        return `
            <div class="alert-row" data-alert-row data-rule-id="${r.id}">
                <div class="alert-symbol">${escAdmin(r.symbol)}</div>
                <div class="alert-metric">${metricLabel}</div>
                <div class="alert-predicate">${predicate}</div>
                <div class="alert-owner" title="user #${r.userId}">${owner}</div>
                <div class="alert-meta">${lastFired}${r.fireCount > 0 ? ` · ${r.fireCount}\u00d7` : ''}</div>
                <div><span class="alert-status ${stateClass}">${stateLabel}</span></div>
                <div class="text-right">
                    <button class="alert-delete" data-action="admin-delete-alert-rule"
                            data-rule-id="${r.id}" data-symbol="${escAdmin(r.symbol)}" data-username="${escAdmin(r.username || ('user #' + r.userId))}">
                        Delete
                    </button>
                </div>
            </div>`;
    }).join('');
}

function renderAlertEvents(events) {
    const body = document.getElementById('alerts-events-body');
    const count = document.getElementById('alerts-events-count');
    if (!body) return;
    if (count) count.innerText = events.length.toLocaleString();
    if (events.length === 0) {
        body.innerHTML = '<div class="px-6 py-12 text-center text-slate-500 italic text-xs">No alerts have fired yet.</div>';
        return;
    }
    body.innerHTML = events.map((e) => {
        const metricLabel = e.metric === 'pct_change' ? '%CHG'
                          : e.metric === 'rsi'        ? 'RSI14'
                          : e.metric === 'price'      ? 'PRICE'
                          : e.metric.toUpperCase();
        const predicate = `${escAdmin(e.op)} ${escAdmin(fmtAlertValue(e.metric, e.threshold))}`;
        const observed  = fmtAlertValue(e.metric, e.observedValue);
        const owner = e.username ? escAdmin(e.username) : `<span class="text-slate-600 italic">user #${e.userId}</span>`;
        return `
            <div class="event-row" data-event-row>
                <div class="event-time">${fmtAlertTime(e.firedAt)}</div>
                <div class="event-symbol">${escAdmin(e.symbol)}</div>
                <div class="event-metric">${metricLabel}</div>
                <div class="event-observed">${escAdmin(observed)}</div>
                <div class="event-predicate">${predicate}</div>
                <div class="event-owner" title="user #${e.userId}">${owner}</div>
            </div>`;
    }).join('');
}

window.loadAlertsTab = async function () {
    try {
        const [stats, rules, events] = await Promise.all([
            fetchAlertStats(),
            fetchAlertRules(),
            fetchAlertEvents(),
        ]);
        _alertRules = rules || [];
        _alertEvents = events || [];
        renderAlertStats(stats || {});
        renderAlertRules(_alertRules);
        renderAlertEvents(_alertEvents);
        // Reapply any active filter (survives refresh).
        const filterEl = document.getElementById('alerts-filter');
        if (filterEl && filterEl.value) window.filterAlertRows(filterEl.value);
    } catch (e) {
        console.error('[admin/alerts] load failed', e);
        const body = document.getElementById('alerts-rules-body');
        if (body) body.innerHTML = `<div class="px-6 py-10 text-center text-rose-400 italic text-xs">Failed to load alerts: ${escAdmin(String(e.message || e))}</div>`;
    }
};

// Client-side filter — walks both tables and hides rows whose text doesn't
// include the query. Case-insensitive substring match, same pattern as the
// audit filter above.
window.filterAlertRows = function (query) {
    const q = (query || '').trim().toLowerCase();
    const apply = (selector) => {
        document.querySelectorAll(selector).forEach((row) => {
            if (!q) { row.style.display = ''; return; }
            row.style.display = row.innerText.toLowerCase().includes(q) ? '' : 'none';
        });
    };
    apply('#alerts-rules-body [data-alert-row]');
    apply('#alerts-events-body [data-event-row]');
};

// Admin-scope delete. Confirms in-page (browser confirm is enough here —
// the action is reversible for the user, who can just recreate the rule).
window.adminDeleteAlertRule = async function (ruleID, symbol, username) {
    const msg = `Delete alert rule for ${symbol} (owner: ${username})?\n\nThis cannot be undone.`;
    if (!window.confirm(msg)) return;
    try {
        const res = await fetch(`/v1/admin/alert-rules/${encodeURIComponent(ruleID)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        // Optimistic: remove from cache + re-render without refetching.
        _alertRules = _alertRules.filter((r) => String(r.id) !== String(ruleID));
        renderAlertRules(_alertRules);
        // Stats need a server roundtrip (active count etc changed).
        fetchAlertStats().then(renderAlertStats).catch(() => {});
    } catch (e) {
        alert(`Delete failed: ${e.message || e}`);
    }
};

// Wire the filter input + the refresh button via the delegated dispatcher.
document.addEventListener('DOMContentLoaded', () => {
    const filterEl = document.getElementById('alerts-filter');
    if (filterEl) {
        filterEl.addEventListener('input', (e) => window.filterAlertRows(e.target.value));
    }
});

// Delegated action dispatcher for alert-specific actions. Added in a
// separate listener so it's unambiguous which cases belong to the alerts
// subsystem — the base dispatcher at the top of this file handles the
// shared tabs / file / audit / reset-modal actions.
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    switch (action) {
        case 'alerts-refresh':
            if (typeof window.loadAlertsTab === 'function') window.loadAlertsTab();
            break;
        case 'admin-delete-alert-rule': {
            const id = el.getAttribute('data-rule-id');
            const sym = el.getAttribute('data-symbol') || '';
            const user = el.getAttribute('data-username') || '';
            if (id) window.adminDeleteAlertRule(id, sym, user);
            break;
        }
        case 'pro-requests-refresh':
            if (typeof window.loadProRequestsTab === 'function') window.loadProRequestsTab();
            break;
        case 'pro-request-decide': {
            const id = el.getAttribute('data-request-id');
            const decision = el.getAttribute('data-decision');
            const username = el.getAttribute('data-username') || '';
            if (id && decision) window.decideProRequest(id, decision, username);
            break;
        }
    }
});

// ── Pro role requests admin tab ───────────────────────────────────────
//
// Same client-side render pattern as the alerts tab: fetch JSON from
// /v1/admin/pro-requests, render rows into #pro-requests-body, refresh
// on tab entry / WS frame / after a decision. The badge (next to the
// sidebar tab label) is driven by /v1/admin/pro-requests/count so a
// freshly-loaded admin page reflects the queue depth even if the WS
// frame for the most recent request was missed.

let _proRequests = [];

function fmtProRequestTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderProRequests(reqs) {
    const body = document.getElementById('pro-requests-body');
    if (!body) return;
    if (!reqs || reqs.length === 0) {
        body.innerHTML = `
            <div class="px-6 py-16 text-center">
                <p class="text-[10px] font-black uppercase tracking-widest text-slate-600 mb-2">Inbox Zero</p>
                <p class="text-xs text-slate-500 italic">No Pro access requests are waiting for review.</p>
            </div>
        `;
        return;
    }
    body.innerHTML = reqs.map((r) => {
        const submitted = fmtProRequestTime(r.createdAt);
        const reasonHtml = r.reason
            ? `<div class="mt-2 text-[12px] text-slate-300 leading-relaxed border-l-2 border-amber-500/40 pl-3">${escAdmin(r.reason)}</div>`
            : `<div class="mt-2 text-[11px] text-slate-600 italic">No reason provided.</div>`;
        return `
            <div class="px-6 py-5 border-b border-white/5 last:border-b-0 flex flex-col gap-3" data-pro-request-row data-request-id="${r.id}">
                <div class="flex items-start justify-between gap-4">
                    <div class="min-w-0">
                        <div class="flex items-center gap-3">
                            <span class="text-sm font-bold text-white truncate">${escAdmin(r.username || ('user #' + r.userId))}</span>
                            <span class="mono text-[9px] uppercase tracking-widest text-amber-400/80">Submitted ${escAdmin(submitted)}</span>
                        </div>
                        ${reasonHtml}
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button data-action="pro-request-decide"
                                data-request-id="${r.id}"
                                data-decision="approve"
                                data-username="${escAdmin(r.username || ('user #' + r.userId))}"
                                class="px-3 py-1.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 mono text-[10px] font-black uppercase tracking-widest transition-all">
                            Approve
                        </button>
                        <button data-action="pro-request-decide"
                                data-request-id="${r.id}"
                                data-decision="deny"
                                data-username="${escAdmin(r.username || ('user #' + r.userId))}"
                                class="px-3 py-1.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 mono text-[10px] font-black uppercase tracking-widest transition-all">
                            Deny
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function setProRequestBadge(count) {
    const badge = document.getElementById('pro-requests-badge');
    if (!badge) return;
    if (!count || count <= 0) {
        badge.classList.add('hidden');
        badge.innerText = '0';
        return;
    }
    badge.classList.remove('hidden');
    badge.innerText = count > 99 ? '99+' : String(count);
}

window.loadProRequestsTab = async function() {
    try {
        const res = await fetch('/v1/admin/pro-requests', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reqs = await res.json();
        _proRequests = Array.isArray(reqs) ? reqs : [];
        renderProRequests(_proRequests);
        setProRequestBadge(_proRequests.length);
    } catch (e) {
        console.error('[admin/pro-requests] load failed', e);
        const body = document.getElementById('pro-requests-body');
        if (body) body.innerHTML = `<div class="px-6 py-10 text-center text-rose-400 italic text-xs">Failed to load: ${escAdmin(String(e.message || e))}</div>`;
    }
};

// Lightweight badge-only refresh — used on page load so the sidebar
// shows the queue depth without forcing a full table render. The full
// load happens lazily when the admin clicks the Pro Requests tab.
async function refreshProRequestBadge() {
    try {
        const res = await fetch('/v1/admin/pro-requests/count', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        setProRequestBadge(data.count || 0);
    } catch {
        // Silent — the badge is a UX hint, not load-bearing.
    }
}

// Approve / deny dispatch. We surface a prompt() for the optional admin
// note on Deny (admins use it to explain the rejection so the user
// knows what to fix before reapplying). Approve doesn't prompt — most
// approvals are routine and adding a friction step here slows a busy
// admin down for no good reason.
window.decideProRequest = async function(requestID, decision, username) {
    const isApprove = decision === 'approve';
    let note = '';
    if (!isApprove) {
        const input = window.prompt(`Deny ${username}'s Pro request?\n\nOptional note (visible to the user):`, '');
        if (input === null) return; // cancelled
        note = (input || '').trim().slice(0, 2048);
    } else {
        if (!window.confirm(`Approve ${username} for Pro access?`)) return;
    }

    // Locate the row up front so we can both disable its buttons (no
    // double-decisions on the same request while the network call is
    // in flight) and animate it out on success.
    const row = document.querySelector(`[data-pro-request-row][data-request-id="${requestID}"]`);
    if (row) {
        row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        row.style.opacity = '0.6';
    }

    try {
        const fd = new FormData();
        fd.append('decision', decision);
        if (note) fd.append('note', note);
        const res = await fetch(`/v1/admin/pro-requests/${encodeURIComponent(requestID)}/decide`, {
            method: 'POST',
            credentials: 'same-origin',
            body: new URLSearchParams(fd),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            // Roll back the visual disable so the admin can retry.
            if (row) {
                row.style.opacity = '';
                row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            }
            window.showToast?.(`Decision failed: ${err.error || res.status}`, 'error', 6000);
            return;
        }

        // Drop from local cache immediately so re-renders (e.g. the
        // tab being toggled, a filter being applied) don't bring it
        // back. We trust the server response and skip refetching —
        // a refetch race could otherwise resurrect the row visually
        // for a frame if the server hadn't yet committed the tx.
        _proRequests = _proRequests.filter((r) => String(r.id) !== String(requestID));
        setProRequestBadge(_proRequests.length);

        if (row) {
            // Animate out: fade + collapse the row's height, then
            // detach. CSS transition handles the visual; the timeout
            // matches the duration so the DOM removal lands after
            // the animation, not during it.
            row.style.transition = 'opacity 180ms ease, max-height 220ms ease, padding 220ms ease, margin 220ms ease';
            row.style.maxHeight = row.offsetHeight + 'px';
            // Force a reflow so max-height takes effect before we
            // collapse it; otherwise the browser optimises away the
            // intermediate state.
            void row.offsetHeight;
            row.style.overflow = 'hidden';
            row.style.opacity = '0';
            row.style.maxHeight = '0px';
            row.style.paddingTop = '0';
            row.style.paddingBottom = '0';
            row.style.marginTop = '0';
            row.style.marginBottom = '0';
            setTimeout(() => {
                row.remove();
                // If that was the last row, render the empty state in
                // place of the table — otherwise the body just
                // collapses to a thin border with nothing inside.
                if (_proRequests.length === 0) {
                    renderProRequests(_proRequests);
                }
            }, 230);
        } else {
            // No row reference (rare — shouldn't happen if the click
            // came from inside the table). Re-render whatever's left.
            renderProRequests(_proRequests);
        }

        window.showToast?.(
            isApprove
                ? `Approved Pro access for ${username}.`
                : `Denied Pro request from ${username}.`,
            isApprove ? 'success' : 'info',
            5000,
        );

        // The Identity Manager table shows roles — a freshly-promoted
        // user's role badge is now stale. Trigger a refresh so the
        // admin sees the updated tier without a manual reload.
        if (window.htmx) htmx.trigger('#users-table-container', 'refresh');
    } catch (e) {
        if (row) {
            row.style.opacity = '';
            row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
        window.showToast?.(`Decision failed: ${e.message || e}`, 'error', 6000);
    }
};

// WS frame from the server: a new request just landed. Bump the badge
// (always) and re-render the table if we're already on the tab.
window.handleAdminProRequestPush = function(_data) {
    refreshProRequestBadge();
    const view = document.getElementById('view-pro-requests');
    if (view && !view.classList.contains('hidden')) {
        window.loadProRequestsTab();
    }
};

// Sync the badge on initial page load — admins arriving fresh see the
// queue depth before they click the tab.
document.addEventListener('DOMContentLoaded', () => {
    refreshProRequestBadge();
});
