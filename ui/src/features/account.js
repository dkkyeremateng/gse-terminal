// Account management modal — opened from the navbar gear icon.
//
// Single source of truth for the user's email + OAuth + password state.
// Each section reads the latest /v1/me payload (via window.* state set by
// auth-ticker.js + a fresh probe on open) and renders one of a few
// possible UIs based on (provider linked? email present? email verified?
// password set?). All form submits + button taps go through the delegated
// app.js dispatcher so the markup stays CSP-friendly.

import { escapeHTML } from '../util/escape.js';

// ─── State + helpers ───────────────────────────────────────────────────────

function isAuthed() {
    return !!window.isUserAuthenticated;
}

// Re-probe /v1/me so the modal always reflects the current backend state.
// Cached values on window.* may be stale (e.g. the user just clicked a
// verification link in another tab, or completed an OAuth round-trip).
async function refreshAccountState() {
    try {
        const res = await fetch('/v1/me', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        window.userEmail              = data.email || '';
        window.userEmailVerified      = !!data.emailVerified;
        window.userProvider           = data.provider || '';
        window.userProviderEmail      = data.providerEmail || '';
        window.userAvailableProviders = Array.isArray(data.availableProviders) ? data.availableProviders : [];
        window.userHasPassword        = !!data.hasPassword;
        window._currentUsername       = data.username || '';
        return data;
    } catch (e) {
        console.debug('[account] /v1/me probe failed', e);
        return null;
    }
}

// ─── Section renderers ─────────────────────────────────────────────────────

function renderIdentity() {
    const el = document.getElementById('account-identity');
    if (!el) return;
    const username = window._currentUsername || '—';
    const role     = window.userRole || 'user';
    el.innerHTML = `
        <div class="flex flex-col gap-1 min-w-0">
            <span class="font-display text-[15px] font-bold text-[var(--paper)] truncate">${escapeHTML(username)}</span>
            <span class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/45">Signed in</span>
        </div>
        <span class="mono text-[10px] uppercase tracking-[0.22em] text-[var(--amber)] border border-[var(--amber)]/40 px-2 py-1">${escapeHTML(role)}</span>
    `;
}

function renderEmailSection() {
    const body = document.getElementById('account-email-body');
    if (!body) return;
    const email      = window.userEmail || '';
    const verified   = !!window.userEmailVerified;
    const provider   = window.userProvider || '';
    const isOAuthEmail = email && provider; // OAuth-managed addresses

    if (!email) {
        // No email on file — offer the same dual flow as before.
        body.innerHTML = `
            <p class="text-[12px] text-[var(--paper)]/70 leading-relaxed">No email on file. Required for password recovery and watchlist alerts.</p>
            <div id="account-email-oauth" class="flex flex-col gap-2"></div>
            <div class="flex items-center gap-3">
                <div class="flex-1 h-px bg-[var(--hair)]"></div>
                <span class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/40">Or</span>
                <div class="flex-1 h-px bg-[var(--hair)]"></div>
            </div>
            <form data-submit-action="account-request-verify-email" class="flex flex-col gap-2">
                <input id="account-email-input" name="email" type="email" placeholder="you@example.com" required autocomplete="email" spellcheck="false"
                       class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)]">
                <div id="account-email-status" class="mono text-[10px] tracking-widest min-h-[14px]"></div>
                <button type="submit" class="py-2 bg-[var(--amber)] text-[var(--ink)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:opacity-90 transition">Send verification link</button>
            </form>
        `;
        renderInlineOAuthLinks('account-email-oauth');
        return;
    }

    if (isOAuthEmail) {
        // OAuth-managed — the email and the provider are the same
        // source of truth, so the unlink action for the provider lives
        // here. Unlinking clears both email + provider (+ email_verified)
        // and falls back to password-only auth, provided the user has a
        // password set (otherwise the server returns 409 and the
        // unlink-provider handler surfaces a "set password first" toast).
        const displayName = escapeHTML(
            window.userAvailableProviders.find(p => p.name === provider)?.displayName || provider,
        );
        body.innerHTML = `
            <div class="flex items-center justify-between gap-3">
                <div class="flex flex-col min-w-0">
                    <span class="text-[14px] font-bold text-[var(--paper)] truncate">${escapeHTML(email)}</span>
                    <span class="mono text-[9px] uppercase tracking-[0.22em]" style="color:var(--moss)">Verified · managed by ${displayName}</span>
                </div>
                <button data-action="account-unlink-provider" class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/60 hover:text-[var(--rust)] px-3 py-1.5 border border-[var(--hair)]">Unlink</button>
            </div>
            <p class="mono text-[10px] text-[var(--paper)]/45 leading-relaxed">Unlinking ${displayName} removes this email from your account. ${window.userHasPassword ? 'You can keep signing in with your password.' : 'Set a password below before unlinking, or you\u2019ll lose access.'}</p>
        `;
        return;
    }

    // Manual email — verified or unverified, both editable.
    const statusLine = verified
        ? `<span class="mono text-[9px] uppercase tracking-[0.22em]" style="color:var(--moss)">Verified</span>`
        : `<span class="mono text-[9px] uppercase tracking-[0.22em]" style="color:var(--rust)">Unverified — check your inbox</span>`;
    body.innerHTML = `
        <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col min-w-0">
                <span class="text-[14px] font-bold text-[var(--paper)] truncate">${escapeHTML(email)}</span>
                ${statusLine}
            </div>
            <button data-action="account-unlink-email" class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/60 hover:text-[var(--rust)] px-3 py-1.5 border border-[var(--hair)]">Unlink</button>
        </div>

        <details class="border border-[var(--hair)] p-3">
            <summary class="cursor-pointer mono text-[10px] uppercase tracking-[0.22em] text-[var(--paper)]/70 hover:text-[var(--amber)] select-none">${verified ? 'Change email' : 'Resend or change email'}</summary>
            <form data-submit-action="account-request-verify-email" class="flex flex-col gap-2 mt-3">
                <input id="account-email-input" name="email" type="email" placeholder="you@example.com" required autocomplete="email" spellcheck="false" value="${escapeHTML(email)}"
                       class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)]">
                <div id="account-email-status" class="mono text-[10px] tracking-widest min-h-[14px]"></div>
                <button type="submit" class="py-2 bg-[var(--amber)] text-[var(--ink)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:opacity-90 transition">Send verification link</button>
            </form>
        </details>
    `;
}

function renderInlineOAuthLinks(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const providers = window.userAvailableProviders || [];
    const linked    = window.userProvider || '';
    if (providers.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = providers.filter(p => p.name !== linked).map(p => `
        <a href="/auth/link/${encodeURIComponent(p.name)}"
           class="inline-flex items-center justify-center gap-2 py-2.5 border border-[var(--hair-strong)] text-[var(--paper)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:border-[var(--amber)] hover:text-[var(--amber)] transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
            Continue with ${escapeHTML(p.displayName || p.name)}
        </a>
    `).join('');
}

function renderPasswordSection() {
    const body = document.getElementById('account-password-body');
    if (!body) return;
    const hasPw = !!window.userHasPassword;

    if (!hasPw) {
        // Set-password flow — uses the existing /v1/me/set-password
        // form-encoded handler (HTMX-compatible legacy endpoint), so
        // the form posts as application/x-www-form-urlencoded.
        body.innerHTML = `
            <p class="text-[12px] text-[var(--paper)]/70 leading-relaxed">No password set yet. Add one so you can keep signing in if you ever unlink your provider.</p>
            <form data-submit-action="account-set-password" class="flex flex-col gap-2">
                <input name="password" type="password" required minlength="8" placeholder="New password (min 8 chars)" autocomplete="new-password"
                       class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)]">
                <div id="account-password-status" class="mono text-[10px] tracking-widest min-h-[14px]"></div>
                <button type="submit" class="py-2 bg-[var(--amber)] text-[var(--ink)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:opacity-90 transition">Set password</button>
            </form>
        `;
        return;
    }

    // Change-password flow — current + new, JSON.
    body.innerHTML = `
        <form data-submit-action="account-change-password" class="flex flex-col gap-2">
            <label class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/50">Current password</label>
            <input name="currentPassword" type="password" required autocomplete="current-password"
                   class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)]">
            <label class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/50 mt-2">New password</label>
            <input name="newPassword" type="password" required minlength="8" autocomplete="new-password"
                   class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)]">
            <div id="account-password-status" class="mono text-[10px] tracking-widest min-h-[14px] mt-1"></div>
            <button type="submit" class="py-2 bg-[var(--amber)] text-[var(--ink)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:opacity-90 transition">Update password</button>
        </form>
    `;
}

function renderProAccessSection() {
    const body = document.getElementById('account-pro-body');
    if (!body) return;
    const role = (window.userRole || 'user').toLowerCase();
    const req  = window._proRequest || null;

    // Already-elevated roles never see the request flow — they have
    // nothing to gain. Admins see a short note acknowledging their tier;
    // analyst / bot / pro see the same.
    if (role !== 'user') {
        const labels = {
            pro:     'You already have Pro access. Premium features are unlocked.',
            admin:   'Admin access includes every Pro feature plus the admin portal.',
            analyst: 'Your Analyst tier already includes Pro features.',
            bot:     'Bot accounts already have programmatic Pro access.',
        };
        body.innerHTML = `
            <p class="text-[12px] text-[var(--paper)]/70 leading-relaxed">${escapeHTML(labels[role] || 'Your account already has elevated access.')}</p>
        `;
        return;
    }

    // Pending — request awaiting admin review. Deliberately render no
    // form here so the user can't submit a second request; the server
    // would reject it with 409 anyway, but hiding the form is the
    // clearer UX. They'll see this same panel in any tab they reload.
    if (req && req.status === 'pending') {
        const submitted = fmtRequestTime(req.createdAt);
        body.innerHTML = `
            <div class="flex flex-col gap-2">
                <span class="mono text-[10px] uppercase tracking-[0.22em]" style="color:var(--amber)">Request pending review</span>
                <p class="text-[12px] text-[var(--paper)]/70 leading-relaxed">
                    You already have a Pro access request submitted ${escapeHTML(submitted)}. An admin will review it shortly — you don't need to submit another. You'll be notified the moment a decision is made.
                </p>
                ${req.reason ? `<div class="mono text-[10px] text-[var(--paper)]/45 border-l-2 border-[var(--hair)] pl-3">"${escapeHTML(req.reason)}"</div>` : ''}
            </div>
        `;
        return;
    }

    // Denied — show the rejection (with the admin's note if any) and
    // allow a fresh submission. No cooldown on the client; the server
    // is permissive and admins can lock the account if it becomes spam.
    if (req && req.status === 'denied') {
        const decided = fmtRequestTime(req.decidedAt);
        body.innerHTML = `
            <div class="flex flex-col gap-3">
                <span class="mono text-[10px] uppercase tracking-[0.22em]" style="color:var(--rust)">Request denied</span>
                <p class="text-[12px] text-[var(--paper)]/70 leading-relaxed">Decided ${escapeHTML(decided)}. You can submit a new request below.</p>
                ${req.adminNote ? `<div class="mono text-[10px] text-[var(--paper)]/55 border-l-2 border-[var(--rust)]/40 pl-3">${escapeHTML(req.adminNote)}</div>` : ''}
                ${proRequestForm()}
            </div>
        `;
        return;
    }

    // No request, or an old approved request that didn't promote
    // (extremely rare race — surface the form anyway).
    body.innerHTML = `
        <div class="flex flex-col gap-3">
            <p class="text-[12px] text-[var(--paper)]/70 leading-relaxed">Pro access unlocks AI Oracle insights, the natural-language query, watchlist alerts, sector analytics, and CSV export.</p>
            ${proRequestForm()}
        </div>
    `;
}

function proRequestForm() {
    return `
        <form data-submit-action="account-request-pro" class="flex flex-col gap-2">
            <label class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/50">Why do you want Pro? <span class="text-[var(--paper)]/30 normal-case tracking-normal">(optional)</span></label>
            <textarea name="reason" rows="2" maxlength="1024" placeholder="A short note for the admin reviewing your request"
                      class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)] resize-none"></textarea>
            <div id="account-pro-status" class="mono text-[10px] tracking-widest min-h-[14px]"></div>
            <button type="submit" class="py-2 bg-[var(--amber)] text-[var(--ink)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:opacity-90 transition">Request Pro access</button>
        </form>
    `;
}

function fmtRequestTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Loads the current pro request from the API and stashes it on window
// for the renderer. Called on first render and after any state change
// (submit, WS notification of decision).
async function refreshProRequest() {
    try {
        const res = await fetch('/v1/me/pro-request', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        window._proRequest = data.request || null;
        if (data.role) window.userRole = data.role;
    } catch (e) {
        console.debug('[account] /v1/me/pro-request probe failed', e);
        window._proRequest = null;
    }
}

function renderAll() {
    renderIdentity();
    renderEmailSection();
    renderPasswordSection();
    renderProAccessSection();
}

// ─── Public window.* entry points ──────────────────────────────────────────

window.openAccountModal = async function() {
    if (!isAuthed()) return;
    const modal = document.getElementById('account-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    await Promise.all([refreshAccountState(), refreshProRequest()]);
    renderAll();
};

window.closeAccountModal = function() {
    const modal = document.getElementById('account-modal');
    if (modal) modal.classList.add('hidden');
};

// Sets the amber pip on the navbar gear when there's something the user
// should act on. Today: email present-but-unverified is the only trigger;
// expand the rule below as new actionable states appear (e.g. expiring
// password, no password on OAuth-only account, etc.).
function syncAccountAttentionPip() {
    const btn = document.getElementById('account-btn');
    if (!btn) return;
    const needs = !!(window.userEmail && !window.userEmailVerified);
    btn.setAttribute('data-needs-attention', needs ? 'true' : 'false');
}

// ── Form handlers ──────────────────────────────────────────────────────────

window.submitAccountRequestVerifyEmail = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const statusEl = document.getElementById('account-email-status');
    if (statusEl) statusEl.textContent = '';
    const email = (form.elements.email.value || '').trim().toLowerCase();
    if (!email) {
        if (statusEl) statusEl.innerHTML = '<span class="text-[var(--rust)]">Enter an email.</span>';
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
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--moss)">Sent. Check ${escapeHTML(email)} to confirm.</span>`;
        window.userEmail = email;
        window.userEmailVerified = false;
        // Re-render so the badge / status line update immediately.
        renderEmailSection();
        syncAccountAttentionPip();
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(String(e.message || e))}</span>`;
    }
};

window.submitAccountUnlinkEmail = async function() {
    const ok = window.confirm('Remove your email from this account?\n\nWatchlist alerts and password recovery will stop working until you add a new one.');
    if (!ok) return;
    try {
        const res = await fetch('/v1/me/email/unlink', {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({ error: 'Failed' }));
            window.showToast?.(err.error || 'Failed to unlink email', 'error');
            return;
        }
        window.userEmail = '';
        window.userEmailVerified = false;
        renderEmailSection();
        syncAccountAttentionPip();
        window.showToast?.('Email removed', 'info', 4000);
    } catch (e) {
        window.showToast?.('Failed to unlink email', 'error');
    }
};

window.submitAccountUnlinkProvider = async function() {
    const provider = window.userProvider || 'your provider';
    const ok = window.confirm(`Disconnect ${provider} from this account?\n\nThe provider's email will also be removed.`);
    if (!ok) return;
    try {
        const res = await fetch('/v1/me/unlink-provider', {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (res.status === 409) {
            // Server says we need a password first.
            window.showToast?.('Set a password first — you would lose access without one.', 'error', 6000);
            return;
        }
        if (!res.ok) {
            window.showToast?.('Failed to unlink provider', 'error');
            return;
        }
        await refreshAccountState();
        renderAll();
        syncAccountAttentionPip();
        window.showToast?.('Provider disconnected', 'info', 4000);
    } catch (e) {
        window.showToast?.('Failed to unlink provider', 'error');
    }
};

window.submitAccountSetPassword = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const statusEl = document.getElementById('account-password-status');
    if (statusEl) statusEl.textContent = '';
    // Existing endpoint accepts form-encoded for HTMX compatibility.
    const fd = new FormData(form);
    try {
        const res = await fetch('/v1/me/set-password', {
            method: 'POST',
            credentials: 'same-origin',
            body: new URLSearchParams(fd),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => 'Failed');
            if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(txt)}</span>`;
            return;
        }
        window.userHasPassword = true;
        renderPasswordSection();
        // Email-section copy for OAuth-managed addresses varies on
        // hasPassword (the unlink warning toggles), so re-render it too.
        renderEmailSection();
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--moss)">Password set.</span>`;
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(String(e.message || e))}</span>`;
    }
};

window.submitAccountRequestPro = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const statusEl = document.getElementById('account-pro-status');
    if (statusEl) statusEl.textContent = '';
    // Disable the submit button for the duration of the round trip so a
    // double-click can't race the server into rejecting the second
    // attempt with a 409. Re-enabling on early-return covers the network
    // failure path; the success path destroys the form via re-render.
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Submitting…';
    }
    const reason = (form.elements.reason?.value || '').trim();
    try {
        const res = await fetch('/v1/me/pro-request', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        if (res.status === 409) {
            // The server says a pending request already exists — most
            // likely we have stale client state (another tab submitted,
            // or the initial probe failed silently). Re-fetch the
            // canonical state and re-render: the user lands on the
            // "Awaiting review" panel, which already explains the
            // situation, instead of staring at a red error message
            // next to a form they can't actually use.
            await refreshProRequest();
            renderProAccessSection();
            window.showToast?.('You already have a pending request — admins have been notified.', 'info', 6000);
            return;
        }
        if (res.status === 429) {
            // Rate limiter — be explicit so the user knows to back off
            // rather than thinking the form is broken.
            if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">Too many requests — please wait a minute and try again.</span>`;
            window.showToast?.('Rate limit hit — please wait a moment.', 'error', 5000);
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Request Pro access';
            }
            return;
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            const msg = err.error || `HTTP ${res.status}`;
            if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(msg)}</span>`;
            window.showToast?.(`Pro request failed: ${msg}`, 'error', 6000);
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Request Pro access';
            }
            return;
        }
        const data = await res.json();
        window._proRequest = data.request || null;
        // Re-render replaces the form with the "Awaiting review" panel,
        // so the disabled-button cleanup isn't needed on the happy path.
        renderProAccessSection();
        window.showToast?.('Pro access request submitted — an admin will review it shortly.', 'success', 6000);
    } catch (e) {
        const msg = String(e.message || e);
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(msg)}</span>`;
        window.showToast?.(`Pro request failed: ${msg}`, 'error', 6000);
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'Request Pro access';
        }
    }
};

window.submitAccountChangePassword = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const statusEl = document.getElementById('account-password-status');
    if (statusEl) statusEl.textContent = '';
    const body = {
        currentPassword: form.elements.currentPassword.value,
        newPassword:     form.elements.newPassword.value,
    };
    try {
        const res = await fetch('/v1/me/password', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({ error: 'Failed' }));
            if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(err.error || 'Failed')}</span>`;
            return;
        }
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--moss)">Password updated.</span>`;
        form.reset();
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(String(e.message || e))}</span>`;
    }
};

// ─── Boot ───────────────────────────────────────────────────────────────────

// Called from app.js after checkAuthState resolves. Reveals the navbar
// gear for any authenticated user; sets the attention pip if there's an
// unverified email pending.
export function initAccount() {
    if (!isAuthed()) return;
    const btn = document.getElementById('account-btn');
    if (btn) btn.classList.remove('hidden');
    syncAccountAttentionPip();
}

// Inline init for the /settings page. Renders the account sections into
// the page without requiring the modal-open flow. Settings.js calls this
// on DOMContentLoaded; the same module powers the nav-gear modal on the
// terminal page (though we now link to /settings from the gear instead).
export async function initAccountPage() {
    if (!isAuthed()) return;
    await Promise.all([refreshAccountState(), refreshProRequest()]);
    renderAll();
}

// WS frame handlers — wired into the dispatcher in live/socket.js. The
// requester sees their pending row flip to approved/denied without a
// reload; if approved, the role:changed frame nudges account.js to
// re-probe /v1/me so window.userRole catches up before the next render.
window.handleProRequestDecided = async function() {
    await refreshProRequest();
    renderProAccessSection();
    if (window._proRequest && window._proRequest.status === 'approved') {
        window.showToast?.('Pro access approved — please reload to see new features.', 'success', 8000);
    } else if (window._proRequest && window._proRequest.status === 'denied') {
        window.showToast?.('Your Pro access request was denied.', 'info', 6000);
    }
};

window.handleRoleChanged = async function() {
    await refreshAccountState();
    renderAll();
};

// Esc-to-close.
if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const modal = document.getElementById('account-modal');
        if (modal && !modal.classList.contains('hidden')) window.closeAccountModal();
    });
}
