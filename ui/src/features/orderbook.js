// Order book / depth snapshot — fetches /v1/quote?symbol=X and renders
// a compact bid/offer/spread panel in the stock-detail left sidebar.
//
// The GSE doesn't publish real L2 depth (multiple price levels); what
// we surface here is the latest indicative bid/offer from the most
// recent trading session plus derived spread metrics as a liquidity
// proxy. The visual "depth bar" represents the bid–offer range with
// the last-traded price marked inside it.

import { escapeHTML } from '../util/escape.js';

let _lastSymbol = null;

function fmtPrice(v) {
    if (v == null || v === 0) return '—';
    return `¢${Number(v).toFixed(2)}`;
}

function renderDepth(container, data) {
    // Position of lastPrice within the bid–offer range (0–100%).
    const range = data.offerPrice - data.bidPrice;
    const lastPos = range > 0
        ? Math.min(100, Math.max(0, ((data.lastPrice - data.bidPrice) / range) * 100))
        : 50;

    container.innerHTML = `
        <!-- Bid / Offer row -->
        <div class="flex items-center justify-between mb-3">
            <div class="text-center flex-1">
                <p class="text-[9px] text-emerald-400 uppercase font-black tracking-widest mb-0.5">Bid</p>
                <p class="text-sm font-bold text-emerald-400">${fmtPrice(data.bidPrice)}</p>
            </div>
            <div class="text-center px-4">
                <p class="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-0.5">Spread</p>
                <p class="text-xs font-bold text-slate-300">${fmtPrice(data.spread)}</p>
                <p class="text-[9px] text-slate-500 mono">${data.spreadPct != null ? data.spreadPct.toFixed(2) + '%' : '—'}</p>
            </div>
            <div class="text-center flex-1">
                <p class="text-[9px] text-rose-400 uppercase font-black tracking-widest mb-0.5">Offer</p>
                <p class="text-sm font-bold text-rose-400">${fmtPrice(data.offerPrice)}</p>
            </div>
        </div>

        <!-- Depth bar — bid (green) ← last price marker → offer (red) -->
        <div class="relative h-3 w-full rounded-full overflow-hidden bg-white/5 mb-2">
            <div class="absolute inset-y-0 left-0 bg-emerald-500/30 rounded-l-full" style="width:${lastPos}%"></div>
            <div class="absolute inset-y-0 right-0 bg-rose-500/30 rounded-r-full" style="width:${100 - lastPos}%"></div>
            <div class="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-10" style="left:${lastPos}%" title="Last: ${fmtPrice(data.lastPrice)}"></div>
        </div>

        <!-- Mid price + volume -->
        <div class="flex items-center justify-between text-[10px] text-slate-500 mono">
            <span>Mid ${fmtPrice(data.midPrice)}</span>
            <span>Vol ${data.volume != null ? Number(data.volume).toLocaleString() : '—'}</span>
        </div>
    `;
}

function renderLoading(container) {
    container.innerHTML = `
        <div class="flex items-center gap-2 py-3">
            <div class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></div>
            <span class="mono text-[10px] uppercase tracking-[0.22em] text-blue-400">Loading quote&hellip;</span>
        </div>`;
}

function renderEmpty(container) {
    container.innerHTML = `<p class="text-xs text-slate-500/60 py-2">No quote data available.</p>`;
}

// fetchQuote is called from app.js alongside fetchAIInsight / fetchBacktest
// when a stock is selected. It fetches the latest bid/offer snapshot and
// renders the depth panel.
export async function fetchQuote(symbol) {
    const panel = document.getElementById('depth-panel');
    const container = document.getElementById('depth-body');
    if (!panel || !container) return;
    panel.classList.remove('hidden');

    const sym = symbol || window.currentSymbol;
    if (!sym) { renderEmpty(container); return; }
    if (sym === _lastSymbol && container.innerHTML.includes('Bid')) return; // already rendered
    _lastSymbol = sym;

    renderLoading(container);
    try {
        const res = await fetch(`/v1/quote?symbol=${encodeURIComponent(sym)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (sym !== window.currentSymbol) return; // stale
        renderDepth(container, data);
    } catch (e) {
        if (sym !== window.currentSymbol) return;
        renderEmpty(container);
    }
}

export function initOrderBook() {
    // Panel starts hidden; fetchQuote unhides it on stock select.
}
