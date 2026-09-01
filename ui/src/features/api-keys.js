// API key management — list, create, revoke.
//
// CRUD against /v1/me/api-keys (see internal/server/platform_handlers.go).
// The server returns the raw secret exactly once on create; this module
// surfaces it in a one-time banner the user must copy before reloading.
// All form submits route through the delegated app.js dispatcher so the
// HTML stays CSP-friendly (no inline event handlers).

import { escapeHTML } from '../util/escape.js';
import { showToast } from '../ui/toast.js';

let _keys = [];

async function fetchKeys() {
    try {
        const res = await fetch('/v1/me/api-keys', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _keys = await res.json() || [];
        return _keys;
    } catch (e) {
        console.debug('[api-keys] fetch failed', e);
        return [];
    }
}

function renderKeysList() {
    const list = document.getElementById('api-key-list');
    if (!list) return;
    if (_keys.length === 0) {
        list.innerHTML = `<p class="mono text-[11px] text-[var(--paper)]/50">No keys yet. Generate one above.</p>`;
        return;
    }
    const fmtDate = (iso) => {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
        } catch { return '—'; }
    };
    list.innerHTML = `
        <div class="border border-[var(--hair)] divide-y divide-[var(--hair)]">
            ${_keys.map(k => `
                <div class="px-4 py-3 flex items-center justify-between gap-3" data-api-key-id="${k.id}">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-baseline gap-2">
                            <span class="font-display text-sm font-bold text-[var(--paper)] truncate">${escapeHTML(k.name || 'Untitled key')}</span>
                            <span class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/45">${escapeHTML(k.prefix || '')}…</span>
                        </div>
                        <p class="mono text-[10px] text-[var(--paper)]/50 mt-0.5">
                            Created ${fmtDate(k.createdAt)}${k.lastUsedAt ? ` · Last used ${fmtDate(k.lastUsedAt)}` : ' · Never used'}
                        </p>
                    </div>
                    <button data-action="revoke-api-key" data-key-id="${k.id}" class="mono text-[9px] uppercase tracking-[0.22em] text-[var(--paper)]/60 hover:text-[var(--rust)] px-2 py-1 border border-[var(--hair)]">Revoke</button>
                </div>
            `).join('')}
        </div>`;
}

async function createKey(name) {
    const body = new URLSearchParams();
    body.set('name', name || 'Untitled key');
    const res = await fetch('/v1/me/api-keys', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

async function revokeKey(id) {
    const res = await fetch(`/v1/me/api-keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
}

// ── Action handlers (wired through app.js delegated dispatcher) ─────────────

window.submitCreateAPIKey = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const name = (form.elements.name.value || '').trim();
    const statusEl = document.getElementById('api-key-status');
    if (statusEl) statusEl.textContent = '';
    try {
        const result = await createKey(name);
        // Reveal the one-time secret banner.
        const newBox = document.getElementById('api-key-new');
        const secretEl = document.getElementById('api-key-new-secret');
        if (secretEl) secretEl.textContent = result.key || '';
        if (newBox) newBox.classList.remove('hidden');
        form.reset();
        await fetchKeys();
        renderKeysList();
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(String(e.message || e))}</span>`;
    }
};

window.copyAPIKey = async function() {
    const el = document.getElementById('api-key-new-secret');
    if (!el) return;
    const text = el.textContent || '';
    try {
        await navigator.clipboard.writeText(text);
        showToast('Key copied to clipboard', 'success', 3000);
    } catch {
        // Fallback — select the text so the user can copy manually.
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        showToast('Select the text and copy with Ctrl/Cmd+C', 'info', 4000);
    }
};

window.revokeAPIKey = async function(keyID) {
    if (!keyID) return;
    if (!confirm('Revoke this API key? Anything using it will stop working immediately.')) return;
    try {
        await revokeKey(keyID);
        await fetchKeys();
        renderKeysList();
        showToast('Key revoked', 'success', 3000);
    } catch (e) {
        showToast(String(e.message || e), 'error', 4000);
    }
};

// ── Boot ───────────────────────────────────────────────────────────────────

export async function initAPIKeysPage() {
    await fetchKeys();
    renderKeysList();
}
