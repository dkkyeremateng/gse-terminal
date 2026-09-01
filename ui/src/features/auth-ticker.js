// Auth state check + ticker hydration.
// Extracted from app.js; all window.* shims preserved.

import { escapeHTML } from '../util/escape.js';

window.isUserAuthenticated = false;
window.userRole = '';

// Swaps the AI Oracle locked panel's copy + CTA based on *why* the user
// can't use the oracle. Two modes:
//   'guest'   — unauthenticated. CTA: sign in.
//   'upgrade' — authenticated but role !== pro/admin. CTA: upgrade to Pro.
// The panel always renders the same card shell (icon, gradient, border);
// only the heading, body paragraph, and CTA button change.
function setOracleLockedCopy(mode) {
    const titleEl = document.getElementById('ai-oracle-locked-title');
    const bodyEl  = document.getElementById('ai-oracle-locked-body');
    const ctaEl   = document.getElementById('ai-oracle-locked-cta');
    if (!titleEl || !bodyEl || !ctaEl) return;
    if (mode === 'upgrade') {
        titleEl.textContent = 'Pro Tier Required';
        bodyEl.textContent  = 'AI Market Oracle — fair-value modeling, sentiment-weighted signals, and LLM consensus — is available on the Pro tier. Upgrade to unlock predictive intel for every stock.';
        ctaEl.textContent   = 'Upgrade to Pro';
        ctaEl.setAttribute('href', 'mailto:upgrade@gse-terminal.com?subject=Upgrade%20to%20Pro');
    } else {
        // Default: guest / sign-in path.
        titleEl.textContent = 'Predictive Intel Locked';
        bodyEl.textContent  = 'Gain deep access to real-time predictive analytics and fair value modeling by establishing a terminal uplink.';
        ctaEl.textContent   = 'Establish Uplink';
        ctaEl.setAttribute('href', '/login');
    }
}
window.checkAuthState = async function() {
    try {
        const response = await fetch('/v1/me');
        if (!response.ok) {
            window.isUserAuthenticated = false;
            throw new Error("Auth check failed");
        }
        const data = await response.json();
        window.isUserAuthenticated = data.isAuthenticated;
        window.userRole = data.role;
        window._currentUsername = data.username || '';
        
        const adminLink = document.getElementById('admin-link');
        const loginBtn = document.getElementById('login-nav-btn');
        const logoutBtn = document.getElementById('logout-nav-btn');
        const oracleAuth = document.getElementById('ai-oracle-authenticated');
        const oracleLocked = document.getElementById('ai-oracle-locked');
        const watchlistAuth = document.getElementById('watchlist-panel');
        const watchlistLocked = document.getElementById('watchlist-locked');
        const csvContainer = document.getElementById('download-csv-container');
        // Stash email + provider state on window so other modules (alerts.js,
        // account.js) can consult it without re-probing /v1/me. These are
        // the canonical values as of the most recent checkAuthState call;
        // the account modal refreshes them on open.
        window.userEmail              = data.email || '';
        window.userEmailVerified      = !!data.emailVerified;
        window.userAvailableProviders = Array.isArray(data.availableProviders) ? data.availableProviders : [];
        window.userLinkedProvider     = data.provider || '';
        window.userHasPassword        = !!data.hasPassword;
        
        if (data.isAuthenticated) {
            if (loginBtn) loginBtn.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.remove('hidden');
            // Reveal the /admin link only for admins. Cosmetic — the
            // /admin route + every /v1/admin/** endpoint sit behind
            // chi's AdminMiddleware, so a user removing the `hidden`
            // class in DevTools still gets a 403 from the server.
            if (data.isAdmin && adminLink) {
                adminLink.classList.remove('hidden');
                adminLink.classList.add('flex');
            }
            // Switch AI Oracle UI. Gated to Pro/Admin (mirrors the
            // RequireProOrAdmin middleware on /v1/ai-insight). Basic-tier
            // users stay on the locked panel but with upgrade-focused
            // copy instead of the sign-in prompt.
            const canUseOracle = data.role === 'admin' || data.role === 'pro';
            if (canUseOracle) {
                if (oracleAuth) oracleAuth.classList.remove('hidden');
                if (oracleLocked) oracleLocked.classList.add('hidden');
            } else {
                if (oracleAuth) oracleAuth.classList.add('hidden');
                if (oracleLocked) {
                    oracleLocked.classList.remove('hidden');
                    setOracleLockedCopy('upgrade');
                }
            }

            // Switch Watchlist UI
            if (watchlistAuth) watchlistAuth.classList.remove('hidden');
            if (watchlistLocked) watchlistLocked.classList.add('hidden');

            // Handle Download CSV Button visibility
            if (csvContainer) {
                if (window.userRole === 'admin' || window.userRole === 'pro') {
                    csvContainer.classList.remove('hidden');
                } else {
                    csvContainer.classList.add('hidden');
                }
            }

            // The previous link-email navbar button has been folded into
            // the consolidated #account-modal (gear icon). features/account.js
            // shows the gear for any authenticated user and sets the
            // attention pip when an unverified email needs follow-up.

            // Store provider info on window so other modules can inspect
            // it (e.g. the email-verify modal renders provider-specific
            // OAuth buttons via renderVerifyOAuthOptions). The navbar
            // OAuth icon row was removed — the same link flow is now
            // reachable from #email-verify-modal opened via the navbar
            // link-email icon.
            window.userProvider = data.provider || '';
            window.userProviderEmail = data.providerEmail || '';

            // Show merge button for OAuth-only users (provider linked, no password)
            const mergeBtn = document.getElementById('merge-account-btn');
            if (mergeBtn) {
                if (data.provider && !data.hasPassword) {
                    mergeBtn.classList.remove('hidden');
                } else {
                    mergeBtn.classList.add('hidden');
                }
            }

            // Sector tab button is always visible; access gating happens
            // inside fetchMarketSectors / switchMarketPulse.
        } else {
            if (loginBtn) loginBtn.classList.remove('hidden');
            if (logoutBtn) logoutBtn.classList.add('hidden');
            if (adminLink) {
                adminLink.classList.add('hidden');
                adminLink.classList.remove('flex');
            }
            // Switch AI Oracle UI — guest path: sign-in CTA.
            if (oracleAuth) oracleAuth.classList.add('hidden');
            if (oracleLocked) {
                oracleLocked.classList.remove('hidden');
                setOracleLockedCopy('guest');
            }

            // Switch Watchlist UI — the standalone "Watchlist Locked"
            // card is suppressed for guests; the unified portfolio
            // sign-in CTA (features/portfolio.js) advertises watchlist
            // + alerts in a single panel to avoid stacking duplicates.
            if (watchlistAuth) watchlistAuth.classList.add('hidden');
            if (watchlistLocked) watchlistLocked.classList.add('hidden');

            if (csvContainer) csvContainer.classList.add('hidden');
            const accountBtn = document.getElementById('account-btn');
            if (accountBtn) accountBtn.classList.add('hidden');
        }
    } catch (e) {
        window.isUserAuthenticated = false;
        console.warn("Guest mode active", e);
        // Ensure UI is in locked state on failure — treat as guest since
        // we couldn't confirm a role.
        const oracleAuth = document.getElementById('ai-oracle-authenticated');
        const oracleLocked = document.getElementById('ai-oracle-locked');
        if (oracleAuth) oracleAuth.classList.add('hidden');
        if (oracleLocked) {
            oracleLocked.classList.remove('hidden');
            setOracleLockedCopy('guest');
        }

        const watchlistAuth = document.getElementById('watchlist-panel');
        const watchlistLocked = document.getElementById('watchlist-locked');
        if (watchlistAuth) watchlistAuth.classList.add('hidden');
        // Standalone watchlist-locked card stays hidden — see merged
        // sign-in CTA in features/portfolio.js.
        if (watchlistLocked) watchlistLocked.classList.add('hidden');

        const csvContainer = document.getElementById('download-csv-container');
        if (csvContainer) csvContainer.classList.add('hidden');
        const accountBtn = document.getElementById('account-btn');
        if (accountBtn) accountBtn.classList.add('hidden');
    }
};

window.hydrateTicker = async function() {
    const tracks = document.querySelectorAll('.tape-track');
    if (!tracks.length) return;

    // Detection: Hydrate if we see placeholder text OR if we don't see any uppercase equity symbols
    // (This handles the case where Vite stripped the Go templates but left empty spans behind).
    const needsHydration = Array.from(tracks).some(t => {
        const text = t.innerText;
        return text.includes('Awaiting') || !/[A-Z]{2,}/.test(text);
    });

    if (!needsHydration) {
        console.debug("[Ticker] Content exists (Server-side rendered), skipping hydration.");
        return;
    }

    console.debug("[Ticker] Initiating client-side hydration for dev environment...");

    try {
        const res = await fetch('/v1/market-summary');
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const data = await res.json();
        
        // Aggregate all market activity for a rich ticker
        const equities = [...(data.topGainers || []), ...(data.topDecliners || []), ...(data.mostActive || [])];
        if (!equities.length) {
            console.debug("[Ticker] Backend returned no market summary data yet.");
            return;
        }

        // Deduplicate symbols to keep the scroll meaningful
        const symbolMap = new Map();
        equities.forEach(e => {
            if (!symbolMap.has(e.symbol)) symbolMap.set(e.symbol, e);
        });
        const uniqueEquities = Array.from(symbolMap.values());

        const html = uniqueEquities.map(e => {
            const isUp = e.percentChange > 0;
            const isDown = e.percentChange < 0;
            const icon = isUp ? '▲ ' : isDown ? '▼ ' : '→ ';
            const cls = isUp ? 'text-[var(--moss)]' : isDown ? 'text-[var(--rust)]' : 'text-[var(--paper)]/40';
            const pct = Math.abs(e.percentChange).toFixed(2);
            
            return `
                <span class="px-5">
                    ${escapeHTML(e.symbol)} <b class="text-[var(--amber)]">${Number(e.lastPrice).toFixed(2)}</b>
                    <span class="${cls}">${icon}${pct}%</span>
                </span>
            `;
        }).join('');

        tracks.forEach(t => {
            t.innerHTML = `
                <span class="flex items-center">${html}</span>
                <span class="flex items-center" aria-hidden="true">${html}</span>
            `;
        });
        console.debug(`[Ticker] Hydration complete (${uniqueEquities.length} symbols injected).`);
    } catch (e) {
        console.warn("[Ticker] Hydration failed:", e);
    }
};

