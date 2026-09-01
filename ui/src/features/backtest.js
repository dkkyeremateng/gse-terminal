// Backtest UI — fetches /v1/backtest?symbol=X and renders signal
// stats + an equity-style sparkline into the #backtest-panel container
// inside the stock-detail left sidebar. Pro/Admin gated client-side
// (same pattern as AI Oracle); server returns 403 for other tiers.

import { escapeHTML } from '../util/escape.js';

function canUseBacktest() {
    return !!window.isUserAuthenticated &&
        (window.userRole === 'admin' || window.userRole === 'pro');
}

let _lastSymbol = null;
let _loading = false;

function renderLoading(container) {
    container.innerHTML = `
        <div class="flex items-center gap-2 py-4">
            <div class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></div>
            <span class="mono text-[10px] uppercase tracking-[0.22em] text-blue-400">Running backtest&hellip;</span>
        </div>`;
}

function renderError(container, msg) {
    container.innerHTML = `
        <p class="text-xs text-[var(--paper)]/55 py-3">${escapeHTML(msg)}</p>
        <button data-action="run-backtest" class="mono text-[9px] uppercase tracking-[0.22em] px-3 py-1.5 border border-[var(--hair)] text-[var(--paper)]/60 hover:text-[var(--amber)] hover:border-[var(--amber)] transition">Retry</button>`;
}

// Dedicated empty state for the 422 "insufficient data" case — the
// backtest needs a minimum bar count (~71 days) to produce stats, and
// no retry affordance helps when the only fix is more sessions in
// QuestDB. Mirrors the AI Oracle insufficient-data card on the stock
// detail page for a consistent empty-state story.
function renderInsufficient(container, symbol) {
    container.innerHTML = `
        <div class="flex flex-col items-center text-center py-6">
            <div class="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center text-amber-500 mb-3">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            </div>
            <h4 class="text-sm font-bold text-white/90 mb-1.5">Not Enough History</h4>
            <p class="text-[11px] text-slate-400 leading-relaxed max-w-xs">There isn't enough data yet to run a signal backtest on <span class="text-amber-400 font-bold">${escapeHTML(symbol)}</span>. The model needs several weeks of daily closes; check back after more sessions have printed.</p>
        </div>`;
}

function pct(v) { return v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'; }
function clr(v) { return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-400'; }

function renderResult(container, data) {
    // Stat strip
    const stats = `
        <div class="grid grid-cols-2 gap-3 mb-4">
            <div class="glass-card rounded-xl p-3">
                <p class="stat-label text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1 has-tooltip">Win Rate (5d)<span class="tooltip">Of all days the signal said BULLISH, this is the percentage where the price was higher 5 trading days later. Above 50% means the signal has historically been better than a coin flip.</span></p>
                <p class="stat-value text-sm font-bold ${clr(data.winRate5d - 50)}">${pct(data.winRate5d).replace('+', '')}</p>
            </div>
            <div class="glass-card rounded-xl p-3">
                <p class="stat-label text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1 has-tooltip">Avg Return (5d)<span class="tooltip">The average gain or loss measured 5 trading days after every BULLISH signal. Positive means the signal's calls have been profitable on average; negative means they lost money.</span></p>
                <p class="stat-value text-sm font-bold ${clr(data.avgReturn5d)}">${pct(data.avgReturn5d)}</p>
            </div>
            <div class="glass-card rounded-xl p-3">
                <p class="stat-label text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1 has-tooltip">Sharpe Ratio<span class="tooltip">Risk-adjusted return of the signal strategy (annualised). Above 1.0 is decent, above 2.0 is strong. A high win rate with wild swings scores poorly here because it penalises volatility.</span></p>
                <p class="stat-value text-sm font-bold ${clr(data.sharpeRatio)}">${data.sharpeRatio?.toFixed(2) ?? '—'}</p>
            </div>
            <div class="glass-card rounded-xl p-3">
                <p class="stat-label text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1 has-tooltip">Max Drawdown<span class="tooltip">The worst peak-to-trough loss the strategy experienced during the backtest period. A 15% drawdown means at one point you would have been sitting on a 15% unrealised loss before it recovered.</span></p>
                <p class="stat-value text-sm font-bold text-rose-400">${data.maxDrawdown != null ? '-' + data.maxDrawdown.toFixed(2) + '%' : '—'}</p>
            </div>
        </div>`;

    // Signal breakdown bar
    const total = data.totalSignals || 1;
    const bullPct = (data.bullish / total * 100).toFixed(0);
    const bearPct = (data.bearish / total * 100).toFixed(0);
    const neutPct = (data.neutral / total * 100).toFixed(0);
    const breakdown = `
        <div class="mb-4">
            <div class="flex items-center justify-between mb-1.5">
                <span class="mono text-[9px] uppercase tracking-[0.22em] text-slate-500">${data.totalSignals} signals</span>
                <span class="mono text-[9px] text-slate-500">${data.startDate} — ${data.endDate}</span>
            </div>
            <div class="h-2 w-full rounded-full overflow-hidden flex">
                <div class="h-full bg-emerald-500" style="width:${bullPct}%" title="Bullish ${bullPct}%"></div>
                <div class="h-full bg-slate-500" style="width:${neutPct}%" title="Neutral ${neutPct}%"></div>
                <div class="h-full bg-rose-500" style="width:${bearPct}%" title="Bearish ${bearPct}%"></div>
            </div>
            <div class="flex justify-between mt-1">
                <span class="text-[9px] text-emerald-400 font-bold">${bullPct}% bull</span>
                <span class="text-[9px] text-slate-400 font-bold">${neutPct}% flat</span>
                <span class="text-[9px] text-rose-400 font-bold">${bearPct}% bear</span>
            </div>
        </div>`;

    // Win-rate detail
    const winRates = `
        <div class="flex items-center gap-4 mb-4 mono text-[10px] text-slate-500">
            <span>1d: <b class="${clr(data.winRate1d - 50)}">${pct(data.winRate1d).replace('+', '')}</b></span>
            <span>5d: <b class="${clr(data.winRate5d - 50)}">${pct(data.winRate5d).replace('+', '')}</b></span>
            <span>20d: <b class="${clr(data.winRate20d - 50)}">${pct(data.winRate20d).replace('+', '')}</b></span>
        </div>`;

    // Signal sparkline — last 30 signals as coloured dots
    const recentSignals = (data.signals || []).slice(-30);
    const sparkline = `
        <div class="flex items-center gap-[3px] mb-3" title="Last ${recentSignals.length} signals">
            ${recentSignals.map(s => {
                const c = s.signal === 'BULLISH' ? 'bg-emerald-500' : s.signal === 'BEARISH' ? 'bg-rose-500' : 'bg-slate-500';
                return `<div class="w-1.5 h-3 rounded-[1px] ${c}" title="${s.date}: ${s.signal} (${s.confidence}%)"></div>`;
            }).join('')}
        </div>`;

    // Disclaimer
    const disclaimer = `<p class="text-[9px] text-slate-500/70 leading-relaxed mt-3">${escapeHTML(data.note || '')}</p>`;

    container.innerHTML = stats + breakdown + winRates + sparkline + disclaimer + `
        <button data-action="run-backtest" class="mt-2 mono text-[9px] uppercase tracking-[0.22em] px-3 py-1.5 border border-[var(--hair)] text-[var(--paper)]/60 hover:text-[var(--amber)] hover:border-[var(--amber)] transition">Re-run</button>`;
}

window.runBacktest = async function(symbol) {
    if (!canUseBacktest()) return;
    const sym = symbol || window.currentSymbol;
    if (!sym) return;

    const container = document.getElementById('backtest-body');
    if (!container) return;

    if (_loading) return;
    _loading = true;
    _lastSymbol = sym;
    renderLoading(container);

    try {
        const res = await fetch(`/v1/backtest?symbol=${encodeURIComponent(sym)}`, { credentials: 'same-origin' });
        if (!res.ok) {
            // 422 = insufficient data. Short-circuit to the friendly
            // empty-state panel; no Retry button because more sessions
            // landing in QuestDB is the only fix — a user re-click
            // won't help. Other failures (503, 500, etc.) fall through
            // to the generic error branch where Retry is useful.
            if (res.status === 422) {
                if (sym !== window.currentSymbol) return;
                renderInsufficient(container, sym);
                return;
            }
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        // Guard against stale responses if the user switched symbols.
        if (sym !== window.currentSymbol) return;
        renderResult(container, data);
    } catch (e) {
        if (sym !== window.currentSymbol) return;
        renderError(container, String(e.message || e));
    } finally {
        _loading = false;
    }
};

// Auto-run when a stock is selected (pro/admin only). Called from app.js
// after fetchHistory succeeds, alongside fetchAIInsight and fetchNews.
export function fetchBacktest(symbol) {
    if (!canUseBacktest()) return;
    const panel = document.getElementById('backtest-panel');
    if (panel) panel.classList.remove('hidden');
    window.runBacktest(symbol);
}

// Hide the panel for guests / basic tier.
export function initBacktest() {
    if (!canUseBacktest()) return;
    const panel = document.getElementById('backtest-panel');
    if (panel) panel.classList.remove('hidden');
}
