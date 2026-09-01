// Persistent admin notification widget.
//
// Renders a fixed-position bell in the top-right corner of every page
// when the current user is an admin AND there are pending admin-side
// tasks (today: Pro role requests; future: data anomalies, locked-account
// flags, etc.). Click → /admin?tab=pro-requests.
//
// Why this lives outside admin.js: the admin sidebar badge only exists
// on /admin. An admin browsing /terminal or /settings would otherwise
// have no idea a request had landed. This widget is loaded by every
// entry point (app.js, settings.js, developers.js) so it surfaces on
// every authenticated page.
//
// State sources, in priority order:
//   1. WebSocket frame `admin:pro_request` (live, instant) — handled
//      by socket.js which calls window.handleAdminProRequestPush.
//   2. /v1/admin/pro-requests/count poll on initial page load — covers
//      the cold-load case where a request landed while the admin was
//      offline / on another device.
//   3. /v1/me probe to determine the role — we don't render the widget
//      at all for non-admins.

const COUNT_ENDPOINT = '/v1/admin/pro-requests/count';
const WIDGET_ID = 'admin-notif-widget';

let _widget = null;
let _isAdmin = false;
let _initialized = false;

function isAdminFromWindow() {
    // window.userRole is populated by auth-ticker on app.js pages and
    // by the settings probe on /settings. If neither has run yet we
    // fall through to the /v1/me fetch below.
    const r = (window.userRole || '').toLowerCase();
    return r === 'admin';
}

async function probeRole() {
    if (isAdminFromWindow()) return true;
    try {
        const res = await fetch('/v1/me', { credentials: 'same-origin' });
        if (!res.ok) return false;
        const data = await res.json();
        if (data && data.role) {
            window.userRole = data.role;
            return data.role.toLowerCase() === 'admin';
        }
    } catch {
        // Silent — the widget is a UX hint, not load-bearing.
    }
    return false;
}

// Inject a one-shot <style> tag for the bell pip's pulse animation.
// admin-notifications.js runs on every authed page; the keyframes need
// to be in the document for any of those entry points, and Tailwind's
// JIT can't see a class injected at runtime, so we own a tiny stylesheet.
function ensurePipStyles() {
    if (document.getElementById('admin-pip-styles')) return;
    const style = document.createElement('style');
    style.id = 'admin-pip-styles';
    style.textContent = `
        @keyframes adminPipPulse {
            0%, 100% { box-shadow: 0 0 0 2px var(--ink, #0a0a0c), 0 0 6px rgba(245,158,11,0.6); }
            50%      { box-shadow: 0 0 0 2px var(--ink, #0a0a0c), 0 0 12px rgba(245,158,11,0.95); }
        }
    `;
    document.head.appendChild(style);
}

// Attach a small pulsing pip to the navbar bell (if present on this
// page) when there are pending admin tasks. Returns true if the bell
// was found and updated; the caller falls back to the floating pill
// only when this returns false.
//
// The bell already owns a `::after` pseudo-element driven by
// data-count for watchlist-alert unread state, so we anchor the
// admin pip to the top-LEFT corner to avoid stacking on top of it.
// Distinct corners + the same amber palette keep the two indicators
// readable without inventing a second colour vocabulary.
function setBellIndicator(count) {
    const bell = document.getElementById('alerts-bell-btn');
    if (!bell) return false;

    let pip = bell.querySelector('[data-admin-pip]');
    if (count > 0) {
        ensurePipStyles();
        if (!pip) {
            pip = document.createElement('span');
            pip.setAttribute('data-admin-pip', '');
            pip.setAttribute('aria-hidden', 'true');
            pip.style.cssText = [
                'position:absolute',
                'top:4px',
                'left:4px',
                'width:7px',
                'height:7px',
                'border-radius:9999px',
                'background:var(--amber,#f59e0b)',
                'animation:adminPipPulse 1.6s ease-in-out infinite',
                'pointer-events:none',
            ].join(';');
            // Bell is already `class="relative"` in the markup, but
            // be defensive — a future template change shouldn't break
            // the pip silently.
            const computed = window.getComputedStyle(bell);
            if (computed.position === 'static') bell.style.position = 'relative';
            bell.appendChild(pip);
        }
        bell.setAttribute(
            'title',
            count === 1
                ? 'Alerts · 1 pending Pro request (visit Admin)'
                : `Alerts · ${count} pending Pro requests (visit Admin)`,
        );
    } else {
        if (pip) pip.remove();
        bell.setAttribute('title', 'Alerts');
    }
    return true;
}

function ensureWidget() {
    if (_widget) return _widget;
    const el = document.createElement('a');
    el.id = WIDGET_ID;
    el.href = '/admin?tab=pro-requests';
    el.setAttribute('aria-label', 'Pending admin tasks');
    el.setAttribute('title', 'Pending Pro access requests');
    // Inline styles rather than Tailwind classes: this widget renders
    // outside any page's compiled class set, and Tailwind's JIT only
    // sees classes referenced in the source HTML at build time.
    //
    // Bottom-right placement avoids two collisions seen in production:
    //   - The navbar sits at top:0 across every page, so a top-right
    //     widget overlaps account/settings buttons.
    //   - showToast() also docks at top:12px right:12px, so a
    //     top-right widget hides incoming toasts.
    // Bottom-right is the conventional notification corner and clears
    // both collision zones.
    el.style.cssText = [
        'position:fixed',
        'bottom:18px',
        'right:18px',
        'z-index:9000',
        'display:none',
        'align-items:center',
        'gap:8px',
        'padding:8px 14px 8px 12px',
        'background:rgba(15,15,17,0.92)',
        'border:1px solid rgba(245,158,11,0.5)',
        'border-radius:999px',
        'color:#fbbf24',
        'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
        'font-size:10px',
        'font-weight:700',
        'letter-spacing:0.16em',
        'text-decoration:none',
        'text-transform:uppercase',
        'backdrop-filter:blur(8px)',
        '-webkit-backdrop-filter:blur(8px)',
        'box-shadow:0 6px 22px rgba(0,0,0,0.45), 0 0 0 1px rgba(245,158,11,0.12) inset',
        'transition:transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
        'cursor:pointer',
        'white-space:nowrap',
        'line-height:1',
    ].join(';');
    el.innerHTML = `
        <span aria-hidden="true" style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="display:block">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
            </svg>
            <span data-pending-dot style="position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:999px;background:#f59e0b;box-shadow:0 0 0 2px rgba(15,15,17,0.92);"></span>
        </span>
        <span data-pending-label style="display:inline-block;">0 pending</span>
    `;
    el.addEventListener('mouseenter', () => {
        el.style.transform = 'translateY(-1px)';
        el.style.borderColor = 'rgba(245,158,11,0.85)';
        el.style.boxShadow = '0 8px 26px rgba(0,0,0,0.5), 0 0 0 1px rgba(245,158,11,0.22) inset';
    });
    el.addEventListener('mouseleave', () => {
        el.style.transform = '';
        el.style.borderColor = 'rgba(245,158,11,0.5)';
        el.style.boxShadow = '0 6px 22px rgba(0,0,0,0.45), 0 0 0 1px rgba(245,158,11,0.12) inset';
    });
    document.body.appendChild(el);
    _widget = el;
    return el;
}

function updateWidget(count) {
    if (!_isAdmin) return;
    // Two indicators, on purpose:
    //   1. A pulsing pip on the navbar bell — passive, peripheral,
    //      glanceable. Catches the eye while the admin is doing
    //      something else.
    //   2. A floating bottom-right pill with the explicit count and
    //      a click-through to /admin?tab=pro-requests — actionable,
    //      removes the "now what?" step.
    // Pages without a bell (settings, developers) still see the pill;
    // pages with a bell see both, which is intentional redundancy.
    setBellIndicator(count);
    const el = ensureWidget();
    const label = el.querySelector('[data-pending-label]');
    if (count > 0) {
        if (label) label.textContent = `${count} Pro request${count === 1 ? '' : 's'}`;
        el.style.display = 'inline-flex';
    } else {
        el.style.display = 'none';
    }
}

async function refreshCount() {
    if (!_isAdmin) return;
    try {
        const res = await fetch(COUNT_ENDPOINT, { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        updateWidget(data.count || 0);
    } catch {
        // Silent.
    }
}

async function init() {
    if (_initialized) return;
    _initialized = true;

    // Wait a tick for auth-ticker / settings probe to populate
    // window.userRole. If it hasn't, fall through to a /v1/me fetch.
    _isAdmin = await probeRole();
    if (!_isAdmin) return;

    // Make sure the WebSocket is up. On /terminal and /admin app.js's
    // own DOMContentLoaded already calls this, but on /settings nothing
    // does — we'd otherwise miss every live `admin:pro_request` frame
    // and only see the count via the 60s poll fallback. The function
    // is idempotent (socket.js short-circuits if already open), so
    // calling it from multiple entry points is safe.
    if (typeof window.connectWebSocket === 'function') {
        try { window.connectWebSocket(); } catch {}
    }

    await refreshCount();

    // Hook the WS pipeline. socket.js dispatches both showToast and
    // handleAdminProRequestPush for new-request frames; we add our
    // widget refresh as another listener on the window-level handler.
    // If admin.js (the admin page) also defines handleAdminProRequestPush,
    // we wrap it so both the in-page badge and the floating widget
    // update — first-come-first-served wrap pattern.
    const prev = window.handleAdminProRequestPush;
    window.handleAdminProRequestPush = function(data) {
        try { refreshCount(); } catch {}
        if (typeof prev === 'function') prev(data);
    };

    // The admin's own decision flow needs to repaint the widget too.
    // When they approve/deny on /admin, decideProRequest in admin.js
    // updates the in-page state but the floating widget doesn't know.
    // Wrap window.decideProRequest the same way so a successful
    // decision triggers a count refresh.
    const prevDecide = window.decideProRequest;
    if (typeof prevDecide === 'function') {
        window.decideProRequest = async function(...args) {
            const result = await prevDecide.apply(this, args);
            try { refreshCount(); } catch {}
            return result;
        };
    }

    // Belt-and-braces: if the page lives long enough that the WS
    // dropped silently, a 60s poll keeps the badge honest. Cheap —
    // the count query is one indexed COUNT(*).
    setInterval(refreshCount, 60_000);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // Script may have been imported after DOMContentLoaded already
        // fired (entry points that run their own readiness setup).
        init();
    }
}
