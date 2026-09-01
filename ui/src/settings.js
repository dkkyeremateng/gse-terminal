// Settings page entry point. Drives the /settings route, which
// consolidates the three user-facing self-service surfaces — account
// (identity / email / password), watchlist alert rules, and API keys —
// in one place. Previously each lived as a modal or drawer inside the
// terminal; moving them to a dedicated page lets us link deep (e.g.
// /settings#alerts) and reduces the terminal's payload.

import './styles.css';
import './styles/terminal.css';
import './styles/terminal-mobile.css';
import './styles/settings.css';

import './util/time.js'; // side-effect — window.timeAgo for any callers
import { showToast } from './ui/toast.js';
import { initTheme } from './ui/theme.js';
import { initErrorBoundary } from './ui/error-boundary.js';
// Side-effect import — registers the global logout-click listener that
// flushes the service worker's runtime cache before the user signs out
// (privacy guard for shared devices). See util/sw.js bottom block.
import './util/sw.js';
// WS connection so admin-notifications + future user-targeted frames
// (pro_request:decided, role:changed) reach the settings page. Without
// this the settings tab is a WS dead zone and admins miss live
// pro-request frames while editing their account.
import './live/socket.js';
// Persistent admin-notifications widget. Self-gated: it noops for
// non-admin users and renders a floating bell only when there's
// something pending. Imported here so /settings shows the indicator.
import './features/admin-notifications.js';

// Feature modules. Each exposes an initXPage() that renders its section
// without requiring a modal-open flow.
import { initAccountPage } from './features/account.js';
import { initAlerts, initAlertsPage } from './features/alerts.js';
import { initAPIKeysPage } from './features/api-keys.js';

// htmx is loaded from CDN for the logout button (uses hx-post).
if (typeof htmx !== 'undefined') window.htmx = htmx;

// Shim — features/alerts.js and features/account.js both check
// `window.isUserAuthenticated`. On the settings page we're already
// behind RequireAuth on the server, so set it true immediately and let
// /v1/me fill in role-based gates below.
window.isUserAuthenticated = true;

initErrorBoundary();
initTheme();

// Delegated button action dispatcher. The action names here mirror the
// ones emitted by features/account.js + features/alerts.js + the new
// features/api-keys.js so the same handler lights up buttons no matter
// which module rendered them. Keeps the page CSP-friendly (no inline
// onclick). Registry stays shallow — each case delegates to the
// window.* entry point installed by the owning module.
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    switch (action) {
        // ── Account buttons ───────────────────────────────────────────
        case 'account-unlink-provider':
            if (window.submitAccountUnlinkProvider) window.submitAccountUnlinkProvider(e);
            break;
        case 'account-unlink-email':
            if (window.submitAccountUnlinkEmail) window.submitAccountUnlinkEmail(e);
            break;

        // ── Alert rules buttons ───────────────────────────────────────
        case 'toggle-alert-rule': {
            const ruleID = el.getAttribute('data-rule-id');
            const enabled = el.getAttribute('data-enabled') === 'true';
            if (ruleID && window.toggleAlertRule) window.toggleAlertRule(Number(ruleID), enabled);
            break;
        }
        case 'delete-alert-rule': {
            const ruleID = el.getAttribute('data-rule-id');
            if (ruleID && window.deleteAlertRule) window.deleteAlertRule(Number(ruleID));
            break;
        }
        case 'link-oauth-for-verify':
            // The <a href> navigates on its own — no extra handler.
            break;

        // ── API keys buttons ──────────────────────────────────────────
        case 'copy-api-key':
            if (window.copyAPIKey) window.copyAPIKey();
            break;
        case 'revoke-api-key': {
            const keyID = el.getAttribute('data-key-id');
            if (keyID && window.revokeAPIKey) window.revokeAPIKey(Number(keyID));
            break;
        }
    }
});

// Delegated form submit dispatcher. Mirrors app.js's `data-submit-action`
// convention so the same `<form>` markup works regardless of which bundle
// loads it.
document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-submit-action]');
    if (!form) return;
    const action = form.getAttribute('data-submit-action');
    switch (action) {
        case 'account-request-verify-email':
            if (window.submitAccountRequestVerifyEmail) window.submitAccountRequestVerifyEmail(e);
            break;
        case 'account-set-password':
            if (window.submitAccountSetPassword) window.submitAccountSetPassword(e);
            break;
        case 'account-change-password':
            if (window.submitAccountChangePassword) window.submitAccountChangePassword(e);
            break;
        case 'create-alert-rule':
            if (window.submitAlertRule) window.submitAlertRule(e);
            break;
        case 'request-verify-email':
            if (window.submitVerifyEmail) window.submitVerifyEmail(e);
            break;
        case 'create-api-key':
            if (window.submitCreateAPIKey) window.submitCreateAPIKey(e);
            break;
        case 'account-request-pro':
            if (window.submitAccountRequestPro) window.submitAccountRequestPro(e);
            break;
    }
});

// ─── Dossier chrome (hero, dateline, stats, scroll-spy) ────────────────────
//
// Purely presentational — none of this writes into DOM owned by the feature
// modules. The hero/stats placeholders render em-dashes at load, then these
// helpers populate them once /v1/me + the feature modules have resolved.

function renderDateline() {
    const el = document.getElementById('dateline-today');
    if (!el) return;
    const fmt = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    });
    el.textContent = fmt.format(new Date());
}

function titleCase(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function renderDossierHero() {
    const username = window._currentUsername || '—';
    const role     = window.userRole || 'user';
    const provider = window.userProvider || '';
    const email    = window.userEmail || '';
    const verified = !!window.userEmailVerified;

    // Nameplate + seal number (deterministic hash of the username so it
    // stays stable across sessions without leaking anything sensitive).
    setText('dossier-name', username);
    const seal = (() => {
        let h = 0;
        for (let i = 0; i < username.length; i++) h = ((h << 5) - h + username.charCodeAt(i)) | 0;
        return String(Math.abs(h) % 9999).padStart(4, '0');
    })();
    const monogramEl = document.getElementById('dossier-monogram');
    if (monogramEl) {
        monogramEl.textContent = (username[0] || '—').toUpperCase();
        monogramEl.setAttribute('data-seal', seal);
    }
    setText('masthead-file', seal);

    // Eyebrow role.
    const eyebrowRole = {
        admin: 'Administrator',
        pro:   'Pro Subscriber',
        user:  'Observer',
    }[role] || titleCase(role);
    setText('dossier-role-eyebrow', eyebrowRole);

    // Chips.
    const providerChip = document.getElementById('dossier-provider-chip');
    if (providerChip) {
        const providerDisplay = provider
            ? (window.userAvailableProviders?.find(p => p.name === provider)?.displayName || provider)
            : 'Password auth';
        providerChip.textContent = providerDisplay;
        providerChip.classList.toggle('chip--muted', !provider);
    }
    const emailChip = document.getElementById('dossier-email-chip');
    if (emailChip) {
        if (!email) {
            emailChip.textContent = 'Email pending';
            emailChip.classList.add('chip--muted');
            emailChip.classList.remove('chip--primary');
        } else if (verified) {
            emailChip.textContent = 'Email verified';
            emailChip.classList.remove('chip--muted');
            emailChip.classList.add('chip--primary');
        } else {
            emailChip.textContent = 'Email unverified';
            emailChip.classList.remove('chip--primary');
            emailChip.classList.add('chip--muted');
        }
    }

    // Italic dossier-bio line — shows a live summary of who the user is.
    const bio = document.getElementById('dossier-bio');
    if (bio) {
        const tier = role === 'admin' ? 'Administrator tier' :
                     role === 'pro'   ? 'Pro tier access'    :
                                        'Standard tier';
        const entry = provider
            ? `signed in via ${window.userAvailableProviders?.find(p => p.name === provider)?.displayName || titleCase(provider)}`
            : 'signed in with a password';
        bio.textContent = `${tier} · ${entry}. A quiet logbook for the credentials, notifications, and keys that keep this terminal yours.`;
    }
}

function renderDossierStats() {
    // Tier
    const role = window.userRole || 'user';
    const tierEl = document.getElementById('stat-tier');
    if (tierEl) {
        const map = { admin: 'Admin', pro: 'Pro', user: 'Standard' };
        const label = map[role] || titleCase(role);
        tierEl.innerHTML = role === 'admin' || role === 'pro'
            ? `<em>${label}</em>`
            : label;
    }

    // Email — show "Verified" / "Unverified" / "None"
    const email    = window.userEmail || '';
    const verified = !!window.userEmailVerified;
    const emailEl = document.getElementById('stat-email');
    const noteEl  = document.getElementById('stat-email-note');
    if (emailEl) {
        if (!email) {
            emailEl.textContent = 'None';
            if (noteEl) noteEl.textContent = 'Add one below';
        } else if (verified) {
            emailEl.innerHTML = '<em>Verified</em>';
            if (noteEl) noteEl.textContent = email;
        } else {
            emailEl.textContent = 'Pending';
            if (noteEl) noteEl.textContent = email;
        }
    }
}

// Feature modules fetch and render into their own IDs; we observe those
// containers and mirror the counts into the stats strip. No hook into the
// module internals required.
function observeDossierCounts() {
    const apiKeyList = document.getElementById('api-key-list');
    const rulesList  = document.getElementById('alert-rules-list');
    const rulesEmpty = document.getElementById('alert-rules-empty');

    const updateKeys = () => {
        if (!apiKeyList) return;
        // features/api-keys.js renders each row as a [data-api-key-id] div.
        // Count those; fallback to zero if only the empty-state paragraph
        // is present.
        const n = apiKeyList.querySelectorAll('[data-api-key-id]').length;
        setText('stat-keys', String(n || 0));
        const note = document.getElementById('stat-keys-note');
        if (note) note.textContent = n === 0 ? 'None issued' : (n === 1 ? '1 active credential' : `${n} active credentials`);
    };

    const updateRules = () => {
        if (!rulesList) return;
        const rows = rulesList.querySelectorAll('[data-alert-rule-id]');
        const armed  = [...rows].filter(r => r.querySelector('[data-enabled="false"]')).length; // toggle button says "Pause" → rule is armed
        // The toggle button's data-enabled attribute carries the *next* state,
        // so a rule that's currently armed renders a button with data-enabled="false".
        const total = rows.length;
        setText('stat-rules', String(total));
        const note = document.getElementById('stat-rules-note');
        if (note) {
            if (total === 0)      note.textContent = 'None armed';
            else if (armed === total) note.textContent = total === 1 ? '1 armed' : `${total} armed`;
            else                  note.textContent = `${armed} armed · ${total - armed} paused`;
        }
        // Hide the "No rules armed yet" placeholder whenever the list has
        // content. features/alerts.js toggles `.hidden` on rulesList itself.
        if (rulesEmpty) {
            rulesEmpty.classList.toggle('hidden', total > 0);
        }
    };

    updateKeys();
    updateRules();

    if (apiKeyList) new MutationObserver(updateKeys).observe(apiKeyList, { childList: true, subtree: true });
    if (rulesList)  new MutationObserver(updateRules).observe(rulesList,  { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

// IntersectionObserver-driven scroll spy. Highlights the TOC entry whose
// section is most prominently in view. Falls back to click-to-activate on
// browsers without IntersectionObserver (effectively IE, so nobody we
// target — but the code is cheap).
function initScrollSpy() {
    const sections = ['account', 'alerts', 'api-keys']
        .map(id => document.getElementById(id))
        .filter(Boolean);
    const tocLinks = document.querySelectorAll('[data-toc], [data-toc-mobile]');
    if (!sections.length || !tocLinks.length) return;

    const setActive = (id) => {
        tocLinks.forEach(a => {
            const match = a.getAttribute('data-toc') === id || a.getAttribute('data-toc-mobile') === id;
            a.classList.toggle('active', match);
        });
    };

    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            // Pick the entry closest to the top that's currently intersecting.
            const visible = entries
                .filter(e => e.isIntersecting)
                .sort((a, b) => a.target.getBoundingClientRect().top - b.target.getBoundingClientRect().top);
            if (visible[0]) setActive(visible[0].target.id);
        }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 });
        sections.forEach(s => io.observe(s));
    }

    // On direct click, optimistically flip the TOC so it feels snappy
    // before the observer catches up.
    tocLinks.forEach(a => a.addEventListener('click', () => {
        const id = a.getAttribute('data-toc') || a.getAttribute('data-toc-mobile');
        if (id) setActive(id);
    }));
}

// ─── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    // Render the bits that don't depend on /v1/me first so the page
    // doesn't look frozen while the probe resolves.
    renderDateline();
    initScrollSpy();

    // Seed auth state so the gated renderers (email verify panel etc.)
    // can read window.* without an extra round-trip.
    try {
        const res = await fetch('/v1/me', { credentials: 'same-origin' });
        if (res.ok) {
            const me = await res.json();
            window.userEmail              = me.email || '';
            window.userEmailVerified      = !!me.emailVerified;
            window.userRole               = me.role || window.userRole || '';
            window.userProvider           = me.provider || '';
            window.userAvailableProviders = Array.isArray(me.availableProviders) ? me.availableProviders : [];
            window.userHasPassword        = !!me.hasPassword;
            window._currentUsername       = me.username || '';
        }
    } catch (e) {
        console.debug('[settings] /v1/me probe failed', e);
    }

    // Hero + stats can render from the probed state immediately; the counts
    // for alerts/keys light up via the MutationObservers set up below.
    renderDossierHero();
    renderDossierStats();

    // initAlerts is a no-op without a nav bell (not on this page) but
    // seeds internal state features/alerts.js relies on — cheap to call.
    try { await initAlerts(); } catch (e) { console.debug('[settings] initAlerts', e); }

    await Promise.allSettled([
        initAccountPage().catch(e => { console.debug('[settings] account', e); showToast('Failed to load account', 'error'); }),
        initAlertsPage().catch(e => { console.debug('[settings] alerts', e); showToast('Failed to load alerts', 'error'); }),
        initAPIKeysPage().catch(e => { console.debug('[settings] api-keys', e); showToast('Failed to load API keys', 'error'); }),
    ]);

    // Account feature may have refreshed email/verified state after its
    // own /v1/me round-trip — re-render the dossier chrome so chips and
    // stats reflect the latest values.
    renderDossierHero();
    renderDossierStats();
    observeDossierCounts();

    // Deep-link support — /settings#alerts jumps the user straight to
    // the Alerts section. scroll-margin-top on each <section> keeps the
    // heading clear of the page padding.
    if (window.location.hash) {
        const target = document.querySelector(window.location.hash);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
});
