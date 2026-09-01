// Portfolio tracking — holdings table with live P&L, summary stats,
// and sector exposure. Fetches /v1/me/portfolio which returns holdings
// enriched with current prices + derived P&L from the market snapshot.
//
// Renders into #portfolio-panel in the terminal's left sidebar or the
// market overview dashboard (mobile: dedicated tab).

import { escapeHTML } from '../util/escape.js';
import { showToast } from '../ui/toast.js';
import { destroyPortfolioEquityChart, showPortfolioEquityChart } from '../charts/portfolio.js';
import { invalidatePortfolioHistory } from '../util/portfolio-history-cache.js';

let _data = null;
let _holdingsHTML = '';

// Clear in-memory portfolio state on logout so a different user
// signing in on the same device doesn't see stale holdings HTML.
if (typeof window !== 'undefined') {
    const origLogout = window.handleCacheBust;
    // handleCacheBust fires on both cache:bust (admin upload) and is
    // called from the logout hook via postMessageToSW. Piggyback on
    // the same path to zero portfolio state.
    const _clearPortfolioState = () => { _data = null; _holdingsHTML = ''; };
    // Also listen for the SW logout message relay if it arrives before
    // handleCacheBust is wired (race on module load order).
    window.addEventListener('message', (e) => {
        if (e.data?.type === 'logout') _clearPortfolioState();
    });
    // Expose for direct call from the logout click hook in util/sw.js
    window._clearPortfolioState = _clearPortfolioState;
}

function isAuthed() { return !!window.isUserAuthenticated; }
function isProOrAdmin() { return isAuthed() && (window.userRole === 'admin' || window.userRole === 'pro'); }

function fmtPrice(v) { return v != null ? `¢${Number(v).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; }
function fmtPct(v) { return v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'; }
function clr(v) { return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-400'; }

// ── Render ──────────────────────────────────────────────────────────────

function renderPortfolio(container, data) {
    _data = data;
    if (!data || data.holdingCount === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center text-center py-6">
                <div class="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-4 border border-amber-500/20">
                    <svg class="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </div>
                <h4 class="text-sm font-display font-bold text-white/80 mb-1">No Holdings</h4>
                <p class="text-[11px] text-slate-500 max-w-xs leading-relaxed mb-4">Track your GSE positions with live P&L, weighted returns, and sector exposure.</p>
                <button data-action="open-add-position-modal" class="mono text-[9px] uppercase tracking-[0.22em] px-4 py-2 bg-[var(--amber)] text-[var(--ink)] font-bold hover:opacity-90 transition rounded">Add a Position</button>
            </div>`;
        return;
    }

    // Summary strip — 2 cols on mobile, stacked cleanly
    const summary = `
        <div class="grid grid-cols-2 gap-3 mb-5">
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Value</p>
                <p class="text-sm font-bold text-white/90 truncate">${fmtPrice(data.totalValue)}</p>
            </div>
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Cost</p>
                <p class="text-sm font-bold text-slate-400 truncate">${fmtPrice(data.totalCost)}</p>
            </div>
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">P&L</p>
                <p class="text-sm font-bold ${clr(data.totalPnl)} truncate">${fmtPrice(data.totalPnl)}</p>
            </div>
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Return</p>
                <p class="text-sm font-bold ${clr(data.totalPnlPct)} truncate">${fmtPct(data.totalPnlPct)}</p>
            </div>
        </div>`;

    // Sector exposure bar
    const sectors = data.sectorExposure || {};
    const sectorKeys = Object.keys(sectors).sort((a, b) => sectors[b] - sectors[a]);
    const sectorColors = ['bg-amber-500', 'bg-blue-500', 'bg-emerald-500', 'bg-rose-500', 'bg-purple-500', 'bg-cyan-500', 'bg-orange-500', 'bg-pink-500'];
    const sectorBar = sectorKeys.length > 0 ? `
        <div class="mb-5">
            <p class="mono text-[9px] uppercase tracking-[0.22em] text-slate-500 mb-2">Sector Exposure</p>
            <div class="h-2.5 w-full rounded-full overflow-hidden flex">
                ${sectorKeys.map((s, i) => `<div class="h-full ${sectorColors[i % sectorColors.length]}" style="width:${sectors[s]}%" title="${escapeHTML(s)}: ${sectors[s]}%"></div>`).join('')}
            </div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                ${sectorKeys.map((s, i) => `<span class="flex items-center gap-1.5 text-[9px] text-slate-500"><span class="w-2 h-2 rounded-sm ${sectorColors[i % sectorColors.length]}"></span>${escapeHTML(s)} ${sectors[s]}%</span>`).join('')}
            </div>
        </div>` : '';

    // Holdings table
    // Group holdings by symbol for the aggregated table view
    const grouped = {};
    for (const h of (data.holdings || [])) {
        if (!grouped[h.symbol]) {
            grouped[h.symbol] = {
                symbol: h.symbol,
                sector: h.sector,
                totalQty: 0,
                totalCost: 0,
                totalValue: 0,
                currentPrice: h.currentPrice,
                lots: [],
            };
        }
        const g = grouped[h.symbol];
        g.totalQty += h.quantity;
        g.totalCost += h.costValue;
        g.totalValue += h.marketValue;
        g.currentPrice = h.currentPrice;
        g.lots.push(h);
    }

    const symbols = Object.keys(grouped).sort();
    const mobileList = buildHoldingsMobileList(symbols, grouped, data.totalValue);
    const desktopTable = buildHoldingsTable(symbols, grouped, data.totalValue);
    const holdingsTable = mobileList + desktopTable;

    container.innerHTML = summary + sectorBar + `
        <div class="flex gap-2">
            <button data-action="show-positions-view" class="flex-1 mono text-[9px] uppercase tracking-[0.22em] px-4 py-2.5 border border-[var(--hair)] text-[var(--paper)]/60 hover:text-[var(--amber)] hover:border-[var(--amber)] transition rounded">${symbols.length} Position${symbols.length !== 1 ? 's' : ''} →</button>
            <button data-action="open-add-position-modal" class="mono text-[9px] uppercase tracking-[0.22em] px-4 py-2.5 bg-[var(--amber)] text-[var(--ink)] font-bold hover:opacity-90 transition rounded">+ Add</button>
        </div>`;

    // Store for the inline positions view
    _holdingsHTML = holdingsTable;
}

// ── Modal ───────────────────────────────────────────────────────────────

// ── Holdings table builder (grouped by symbol) ─────────────────────────

// Mobile card list — one card per symbol, stacked vertically.
// Shows: symbol + sector + shares on left, value + P&L on right.
function buildHoldingsMobileList(symbols, grouped, totalPortfolioValue) {
    if (symbols.length === 0) return '';

    const cards = symbols.map(sym => {
        const g = grouped[sym];
        const pnl = g.totalValue - g.totalCost;
        const pnlPct = g.totalCost > 0 ? (pnl / g.totalCost * 100) : 0;
        const initial = sym.charAt(0);

        return `
        <div class="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--hair)]" data-stock-row-symbol="${escapeHTML(sym)}">
            <div class="flex-1 min-w-0">
                <div class="font-display font-bold text-sm text-[var(--paper)] truncate">${escapeHTML(sym)}</div>
                <div class="text-[10px] text-slate-500 mt-0.5">${escapeHTML(g.sector || 'Other')} · ${g.totalQty} shares</div>
            </div>
            <div class="text-right shrink-0">
                <div class="font-display font-bold text-sm text-[var(--paper)]">${fmtPrice(g.totalValue)}</div>
                <div class="text-[10px] mt-0.5 ${clr(pnl)}">${fmtPrice(pnl)} ${pnl >= 0 ? '▲' : '▼'} ${Math.abs(pnlPct).toFixed(2)}%</div>
            </div>
        </div>`;
    }).join('');

    // Total row
    const totalPnl = symbols.reduce((s, sym) => s + grouped[sym].totalValue - grouped[sym].totalCost, 0);
    const totalCost = symbols.reduce((s, sym) => s + grouped[sym].totalCost, 0);
    const totalValue = symbols.reduce((s, sym) => s + grouped[sym].totalValue, 0);
    const totalPnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100) : 0;

    const totalRow = `
        <div class="flex items-center gap-3 px-4 py-3.5 bg-white/[0.02]">
            <div class="flex-1 min-w-0">
                <div class="font-display font-bold text-sm text-[var(--paper)]">Total</div>
                <div class="text-[10px] text-slate-500 mt-0.5">${symbols.length} holdings</div>
            </div>
            <div class="text-right shrink-0">
                <div class="font-display font-bold text-sm text-[var(--paper)]">${fmtPrice(totalValue)}</div>
                <div class="text-[10px] mt-0.5 ${clr(totalPnl)}">${fmtPrice(totalPnl)} ${totalPnl >= 0 ? '▲' : '▼'} ${Math.abs(totalPnlPct).toFixed(2)}%</div>
            </div>
        </div>`;

    return `<div class="lg:hidden border border-[var(--hair)] rounded-lg overflow-hidden mb-4">${cards}${totalRow}</div>`;
}

function buildHoldingsTable(symbols, grouped, totalPortfolioValue) {
    if (symbols.length === 0) return '';

    // Two-line cell helper: primary value on top, secondary below
    const cell2 = (primary, secondary, extraCls = '') =>
        `<div class="${extraCls}"><div>${primary}</div><div class="text-[9px] text-slate-500 mt-0.5">${secondary}</div></div>`;

    const header = `
        <tr class="border-b border-[var(--hair)]">
            <th class="text-left py-3 px-4 font-normal">Holding</th>
            <th class="text-right py-3 px-3 font-normal">Shares</th>
            <th class="text-right py-3 px-3 font-normal">Cost Basis</th>
            <th class="text-right py-3 px-3 font-normal">Current Value</th>
            <th class="text-right py-3 px-3 font-normal">Total Profit</th>
            <th class="text-right py-3 px-3 font-normal">Daily</th>
            <th class="text-right py-3 px-3 font-normal">Share</th>
            <th class="py-3 px-2 w-8"></th>
        </tr>`;

    let totalCost = 0, totalValue = 0, totalPnl = 0, totalShares = 0;

    const rows = symbols.map(sym => {
        const g = grouped[sym];
        const avgCost = g.totalQty > 0 ? g.totalCost / g.totalQty : 0;
        const pnl = g.totalValue - g.totalCost;
        const pnlPct = g.totalCost > 0 ? (pnl / g.totalCost * 100) : 0;
        const daily = g.currentPrice - (g.lots[0]?.currentPrice || g.currentPrice); // approximate
        const dailyPct = avgCost > 0 ? ((g.currentPrice - avgCost) / avgCost * 100) : 0;
        const hasMultiple = g.lots.length > 1;
        const share = totalPortfolioValue > 0 ? (g.totalValue / totalPortfolioValue * 100) : 0;

        totalCost += g.totalCost;
        totalValue += g.totalValue;
        totalPnl += pnl;
        totalShares += g.totalQty;

        const lotRows = g.lots.map(lot => {
            const lotPnl = lot.marketValue - lot.costValue;
            const lotPnlPct = lot.costValue > 0 ? (lotPnl / lot.costValue * 100) : 0;
            return `
            <tr class="hidden border-b border-[var(--hair)]/40 bg-white/[0.015]" data-lots="${escapeHTML(sym)}">
                <td class="py-2 px-4 pl-10">
                    <div class="text-[10px] text-slate-500">${lot.purchaseDate}</div>
                    ${lot.notes ? `<div class="text-[9px] text-slate-500/60 truncate max-w-[160px]">${escapeHTML(lot.notes)}</div>` : ''}
                </td>
                <td class="text-right py-2 px-3 text-[10px] text-slate-500">${lot.quantity}</td>
                <td class="text-right py-2 px-3">
                    ${cell2(fmtPrice(lot.costValue), fmtPrice(lot.costBasis) + '/sh', 'text-[10px] text-slate-500')}
                </td>
                <td class="text-right py-2 px-3 text-[10px] text-slate-400">${fmtPrice(lot.marketValue)}</td>
                <td class="text-right py-2 px-3">
                    ${cell2(`<span class="${clr(lotPnl)}">${fmtPrice(lotPnl)}</span>`, `<span class="${clr(lotPnl)}">${fmtPct(lotPnlPct)}</span>`, 'text-[10px]')}
                </td>
                <td class="text-right py-2 px-3"></td>
                <td class="text-right py-2 px-3"></td>
                <td class="py-2 px-2 text-center">
                    <button data-action="delete-portfolio-holding" data-holding-id="${lot.id}" class="p-1 text-slate-500 hover:text-[var(--rust)] transition" title="Remove lot">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </td>
            </tr>`;
        }).join('');

        // Main symbol row
        let result = `
        <tr class="border-b border-[var(--hair)] hover:bg-white/[0.02] transition cursor-pointer" data-action="toggle-lots" data-symbol="${escapeHTML(sym)}">
            <td class="py-3 px-4">
                <div class="flex items-center gap-2.5">
                    ${hasMultiple ? `<svg class="w-3.5 h-3.5 text-slate-500 transition-transform portfolio-chevron shrink-0" data-chevron="${escapeHTML(sym)}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>` : '<span class="w-3.5 shrink-0"></span>'}
                    <div>
                        <div class="font-display font-bold text-sm text-[var(--paper)]" data-stock-row-symbol="${escapeHTML(sym)}">${escapeHTML(sym)}</div>
                        <div class="text-[9px] text-slate-500 mt-0.5">${escapeHTML(g.sector || '')}</div>
                    </div>
                </div>
            </td>
            <td class="text-right py-3 px-3 mono text-xs text-slate-300">${g.totalQty}</td>
            <td class="text-right py-3 px-3">
                ${cell2(fmtPrice(g.totalCost), fmtPrice(avgCost) + '/sh', 'mono text-xs text-slate-400')}
            </td>
            <td class="text-right py-3 px-3">
                ${cell2(fmtPrice(g.totalValue), fmtPrice(g.currentPrice) + '/sh', 'mono text-xs text-slate-200 font-bold')}
            </td>
            <td class="text-right py-3 px-3">
                ${cell2(`<span class="${clr(pnl)}">${fmtPrice(pnl)}</span>`, `<span class="${clr(pnl)}">${fmtPct(pnlPct)}</span>`, 'mono text-xs')}
            </td>
            <td class="text-right py-3 px-3">
                ${cell2(`<span class="${clr(g.currentPrice - avgCost)}">${fmtPrice(g.currentPrice - avgCost)}</span>`, '', 'mono text-[10px]')}
            </td>
            <td class="text-right py-3 px-3 mono text-xs text-slate-400">${share.toFixed(1)}%</td>
            <td class="py-3 px-2"></td>
        </tr>`;

        // Lot rows — same <tbody>, same columns, so they align naturally
        result += lotRows;

        return result;
    }).join('');

    // Total footer row
    const totalPnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100) : 0;
    const footer = `
        <tr class="border-t-2 border-[var(--hair-strong)] bg-white/[0.02]">
            <td class="py-3 px-4 font-display font-bold text-sm text-[var(--paper)]">Total</td>
            <td class="text-right py-3 px-3 mono text-xs text-slate-300 font-bold">${totalShares}</td>
            <td class="text-right py-3 px-3 mono text-xs text-slate-400 font-bold">${fmtPrice(totalCost)}</td>
            <td class="text-right py-3 px-3 mono text-xs text-slate-200 font-bold">${fmtPrice(totalValue)}</td>
            <td class="text-right py-3 px-3">
                ${cell2(`<span class="${clr(totalPnl)} font-bold">${fmtPrice(totalPnl)}</span>`, `<span class="${clr(totalPnl)}">${fmtPct(totalPnlPct)}</span>`, 'mono text-xs')}
            </td>
            <td class="text-right py-3 px-3"></td>
            <td class="text-right py-3 px-3 mono text-xs text-slate-300 font-bold">100%</td>
            <td class="py-3 px-2"></td>
        </tr>`;

    return `
        <div class="hidden lg:block border border-[var(--hair)] rounded-lg overflow-x-auto no-scrollbar mb-4">
            <table class="w-full mono text-[9px] uppercase tracking-[0.18em] text-slate-500 border-collapse">
                <thead>${header}</thead>
                <tbody>${rows}</tbody>
                <tfoot>${footer}</tfoot>
            </table>
        </div>`;
}

// ── Symbol autocomplete + price lookup inside the modal ─────────────

let _symbolList = [];
let _priceMap = {};

async function loadSymbolsAndPrices() {
    // Reuse the cached market summary — it has both symbol list + prices.
    if (_symbolList.length > 0) return;
    try {
        const res = await fetch('/v1/market-summary');
        if (!res.ok) return;
        const data = await res.json();
        const all = data.all || [];
        _symbolList = all.map(s => s.symbol).sort();
        for (const s of all) _priceMap[s.symbol] = s.lastPrice;
    } catch { /* non-fatal */ }
}

function renderSymbolDropdown(container, query) {
    if (!query || query.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    const q = query.toUpperCase();
    const matches = _symbolList.filter(s => s.includes(q)).slice(0, 8);
    if (matches.length === 0) {
        container.classList.add('hidden');
        return;
    }
    container.innerHTML = matches.map(sym => {
        const price = _priceMap[sym];
        return `<div class="portfolio-sym-option px-3 py-2 cursor-pointer hover:bg-white/[0.06] flex items-center justify-between" data-sym="${escapeHTML(sym)}">
            <span class="text-sm font-display font-bold text-[var(--paper)]">${escapeHTML(sym)}</span>
            ${price ? `<span class="mono text-[10px] text-slate-500">¢${price.toFixed(2)}</span>` : ''}
        </div>`;
    }).join('');
    container.classList.remove('hidden');
}

function wireModalAutocomplete() {
    const symInput = document.getElementById('portfolio-sym-input');
    const dropdown = document.getElementById('portfolio-sym-dropdown');
    const priceHint = document.getElementById('portfolio-price-hint');
    if (!symInput || !dropdown) return;

    symInput.addEventListener('input', () => {
        renderSymbolDropdown(dropdown, symInput.value);
    });
    symInput.addEventListener('focus', () => {
        if (symInput.value) renderSymbolDropdown(dropdown, symInput.value);
    });

    dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.portfolio-sym-option');
        if (!opt) return;
        const sym = opt.getAttribute('data-sym');
        symInput.value = sym;
        dropdown.classList.add('hidden');
        // Fill current price into the cost basis as a default hint.
        const price = _priceMap[sym];
        if (price) {
            const costInput = document.querySelector('#add-position-modal input[name="costBasis"]');
            if (costInput && !costInput.value) costInput.value = price.toFixed(2);
            if (priceHint) {
                priceHint.textContent = `Current price: ¢${price.toFixed(2)}`;
                priceHint.classList.remove('hidden');
            }
        }
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#portfolio-sym-input') && !e.target.closest('#portfolio-sym-dropdown')) {
            dropdown.classList.add('hidden');
        }
    });

    // When the purchase date changes, look up the historical close price
    // for the selected symbol on that date and fill the cost basis.
    const dateInput = document.querySelector('#add-position-modal input[name="purchaseDate"]');
    const costInput = document.querySelector('#add-position-modal input[name="costBasis"]');
    if (dateInput && costInput) {
        dateInput.addEventListener('change', () => lookupHistoricalPrice(symInput, dateInput, costInput, priceHint));
        // Also trigger when symbol changes after date is already set
        symInput.addEventListener('change', () => {
            if (dateInput.value) lookupHistoricalPrice(symInput, dateInput, costInput, priceHint);
        });
    }
}

async function lookupHistoricalPrice(symInput, dateInput, costInput, priceHint) {
    const sym = (symInput.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const date = dateInput.value; // YYYY-MM-DD
    if (!sym || !date) return;

    try {
        const res = await fetch(`/v1/history?symbol=${encodeURIComponent(sym)}&interval=1d`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || data.length === 0) return;

        // Find the exact date or the closest preceding trading day.
        const target = new Date(date + 'T00:00:00Z').getTime();
        let best = null;
        for (const bar of data) {
            const barDate = new Date(bar.timestamp).setHours(0, 0, 0, 0);
            if (barDate <= target) {
                best = bar;
            } else {
                break; // data is sorted ASC
            }
        }

        if (best && best.close > 0) {
            costInput.value = best.close.toFixed(2);
            const barDateStr = new Date(best.timestamp).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
            if (priceHint) {
                priceHint.textContent = `Close on ${barDateStr}: ¢${best.close.toFixed(2)}`;
                priceHint.classList.remove('hidden');
            }
        }
    } catch {
        // Non-fatal — user can still type the cost manually.
    }
}

function ensureModal() {
    if (document.getElementById('add-position-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'add-position-modal';
    modal.className = 'hidden fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-action', 'close-add-position-backdrop');
    modal.innerHTML = `
        <div class="glass w-[95%] max-w-md border border-[var(--hair-strong)] flex flex-col max-h-[90vh] overflow-y-auto no-scrollbar" onclick="event.stopPropagation()">
            <div class="flex items-center justify-between px-5 py-4 border-b border-[var(--hair)]">
                <h3 class="mono text-[11px] uppercase tracking-[0.22em] text-[var(--amber)]">Add Position</h3>
                <button data-action="close-add-position-modal" class="p-2 -mr-2 text-[var(--paper)]/60 hover:text-[var(--amber)] transition" aria-label="Close">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <form data-submit-action="add-portfolio-holding" class="p-5 flex flex-col gap-4">
                <div class="grid grid-cols-2 gap-3">
                    <div class="flex flex-col gap-1.5 relative">
                        <label class="mono text-[8px] uppercase tracking-[0.22em] text-slate-500">Symbol</label>
                        <input id="portfolio-sym-input" name="symbol" type="text" placeholder="e.g. MTNGH" maxlength="10" autocomplete="off" required
                               class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] uppercase focus:outline-none focus:border-[var(--amber)] rounded">
                        <div id="portfolio-sym-dropdown" class="hidden absolute top-full left-0 right-0 z-10 mt-1 bg-[var(--ink)] border border-[var(--hair-strong)] rounded max-h-48 overflow-y-auto no-scrollbar"></div>
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label class="mono text-[8px] uppercase tracking-[0.22em] text-slate-500">Quantity</label>
                        <input name="quantity" type="number" step="any" min="0.0001" placeholder="e.g. 500" required
                               class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)] rounded">
                    </div>
                </div>
                <div id="portfolio-price-hint" class="hidden mono text-[9px] text-emerald-400 -mt-2"></div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="flex flex-col gap-1.5">
                        <label class="mono text-[8px] uppercase tracking-[0.22em] text-slate-500">Purchase Date</label>
                        <input name="purchaseDate" type="date" required
                               class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)] rounded">
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <label class="mono text-[8px] uppercase tracking-[0.22em] text-slate-500">Cost / Share (¢)</label>
                        <input name="costBasis" type="number" step="any" min="0" placeholder="e.g. 1.20" required
                               class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)] rounded">
                    </div>
                </div>
                <div class="flex flex-col gap-1.5">
                    <label class="mono text-[8px] uppercase tracking-[0.22em] text-slate-500">Notes (optional)</label>
                    <input name="notes" type="text" placeholder="e.g. Averaged down on dip" maxlength="200"
                           class="px-3 py-2.5 bg-white/[0.03] border border-[var(--hair)] text-sm text-[var(--paper)] focus:outline-none focus:border-[var(--amber)] rounded">
                </div>
                <button type="submit" class="w-full py-2.5 bg-[var(--amber)] text-[var(--ink)] mono text-[10px] uppercase tracking-[0.22em] font-bold hover:opacity-90 transition rounded">Add to Portfolio</button>
                <div id="portfolio-form-status" class="mono text-[10px] min-h-[14px]"></div>
            </form>
        </div>`;
    document.body.appendChild(modal);
    wireModalAutocomplete();
}

window.openAddPositionModal = async function() {
    await loadSymbolsAndPrices();
    ensureModal();
    // Reset form + hints
    const form = document.querySelector('#add-position-modal form');
    if (form) form.reset();
    const hint = document.getElementById('portfolio-price-hint');
    if (hint) hint.classList.add('hidden');
    const status = document.getElementById('portfolio-form-status');
    if (status) status.textContent = '';
    const dropdown = document.getElementById('portfolio-sym-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    const modal = document.getElementById('add-position-modal');
    if (modal) modal.classList.remove('hidden');
};

window.closeAddPositionModal = function() {
    const modal = document.getElementById('add-position-modal');
    if (modal) modal.classList.add('hidden');
};

function renderLoading(container) {
    container.innerHTML = `
        <div class="flex items-center gap-2 py-4">
            <div class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></div>
            <span class="mono text-[10px] uppercase tracking-[0.22em] text-blue-400">Loading portfolio&hellip;</span>
        </div>`;
}

// ── Data + actions ──────────────────────────────────────────────────────

async function fetchPortfolio() {
    const container = document.getElementById('portfolio-body');
    if (!container) return;
    renderLoading(container);
    try {
        const res = await fetch('/v1/me/portfolio', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        renderPortfolio(container, data);
    } catch (e) {
        console.debug('[portfolio]', e);
        if (container) container.innerHTML = `<p class="text-xs text-slate-500/60 py-3">Failed to load portfolio.</p>`;
    }
}

window.submitAddPortfolioHolding = async function(ev) {
    ev.preventDefault();
    const form = ev.target;
    const statusEl = document.getElementById('portfolio-form-status');
    if (statusEl) statusEl.textContent = '';

    const symbol = (form.elements.symbol.value || '').trim().toUpperCase();
    const quantity = parseFloat(form.elements.quantity.value);
    const costBasis = parseFloat(form.elements.costBasis.value);
    const purchaseDate = form.elements.purchaseDate.value;
    if (!symbol || isNaN(quantity) || isNaN(costBasis) || !purchaseDate) {
        if (statusEl) statusEl.innerHTML = '<span class="text-[var(--rust)]">All fields are required.</span>';
        return;
    }
    try {
        const res = await fetch('/v1/me/portfolio', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, quantity, costBasis, purchaseDate }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Failed' }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        form.reset();
        window.closeAddPositionModal();
        showToast(`${symbol} added to portfolio`, 'success', 3000);
        invalidatePortfolioHistory();
        await fetchPortfolio();
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="text-[var(--rust)]">${escapeHTML(String(e.message || e))}</span>`;
    }
};

window.deletePortfolioHolding = async function(holdingID) {
    if (!holdingID) return;
    if (!confirm('Remove this holding from your portfolio?')) return;
    try {
        const res = await fetch(`/v1/me/portfolio/${encodeURIComponent(holdingID)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Holding removed', 'success', 3000);
        invalidatePortfolioHistory();
        await fetchPortfolio();
    } catch (e) {
        showToast(String(e.message || e), 'error', 4000);
    }
};

// ── Init ────────────────────────────────────────────────────────────────

// ── Positions inline view (replaces the market briefing in the center) ──

window.showPositionsView = function() {
    const isMobile = window.matchMedia('(max-width: 1023px)').matches;

    if (isMobile) {
        // On mobile: swap within the portfolio panel itself
        const container = document.getElementById('portfolio-body');
        if (!container) return;
        if (!window._portfolioSummaryHTML) {
            window._portfolioSummaryHTML = container.innerHTML;
        }
        // Chart is desktop-only — mobile portfolio panel is too narrow
        // for the stock-chart-style header + 380px canvas to land
        // cleanly. Omit the host div and skip the mount call on small
        // screens; hidePositionsView's destroy() is a no-op when the
        // chart was never created.
        const backHeader = `
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-2">
                    <button data-action="hide-positions-view" class="flex items-center gap-1 text-slate-500 hover:text-amber-400 transition-colors" title="Back to Portfolio">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                    </button>
                    <span class="mono text-[10px] font-bold text-slate-500 uppercase tracking-[0.28em]">Positions</span>
                </div>
                <button data-action="open-add-position-modal" class="mono text-[9px] uppercase tracking-[0.22em] px-3 py-1.5 bg-[var(--amber)] text-[var(--ink)] font-bold hover:opacity-90 transition rounded">+ Add</button>
            </div>`;
        container.innerHTML = backHeader + (_holdingsHTML || '<p class="text-xs text-slate-500 py-8 text-center">No positions yet.</p>');
    } else {
        // On desktop: swap the center dashboard
        const dash = document.getElementById('market-overview-dashboard');
        if (!dash) return;
        const existingTopbar = dash.querySelector('.market-topbar');
        const topbarHTML = existingTopbar ? existingTopbar.outerHTML : '';
        // Positions view no longer mounts the equity-curve chart — it
        // now lives on the main dashboard above Today's Briefing.
        // Positions view stays focused on the holdings table alone.
        const backBtn = `
            ${topbarHTML}
            <div class="flex items-center justify-between mt-4 mb-5 stagger-enter stagger-1">
                <div class="flex items-center gap-2">
                    <button data-action="hide-positions-view" class="flex items-center gap-1 text-slate-500 hover:text-amber-400 transition-colors" title="Back to Market Pulse">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                    </button>
                    <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
                    <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Portfolio Positions</h3>
                </div>
                <button data-action="open-add-position-modal" class="mono text-[9px] uppercase tracking-[0.22em] px-3 py-1.5 bg-[var(--amber)] text-[var(--ink)] font-bold hover:opacity-90 transition rounded">+ Add</button>
            </div>`;
        const content = _holdingsHTML || '<p class="text-xs text-slate-500 py-8 text-center">No positions yet.</p>';
        if (!dash.dataset.originalStashed) {
            window._dashOriginalHTML = dash.innerHTML;
            dash.dataset.originalStashed = 'true';
        }
        dash.innerHTML = `<div class="w-full max-w-6xl">${backBtn}${content}</div>`;
    }
};

window.hidePositionsView = function() {
    // Destroy the equity-curve chart first so we don't leak the
    // ApexCharts instance across open/close cycles. No-op if the
    // chart was never mounted.
    destroyPortfolioEquityChart();

    const isMobile = window.matchMedia('(max-width: 1023px)').matches;

    if (isMobile) {
        // Restore the portfolio summary in the sidebar panel
        const container = document.getElementById('portfolio-body');
        if (container && window._portfolioSummaryHTML) {
            container.innerHTML = window._portfolioSummaryHTML;
            window._portfolioSummaryHTML = null;
        } else {
            fetchPortfolio();
        }
    } else {
        // Restore the center dashboard from the snapshot we took on
        // the way in. The ApexCharts instance was destroyed by the
        // innerHTML swap when we entered the positions view, so the
        // host divs in the stashed markup are empty — re-mount the
        // charts after restoring. Live ticks have continued to update
        // window.MARKET_SUMMARY_DATA and would have patched the visible
        // dashboard rows via applyTickToRows; the stashed HTML is the
        // pre-positions snapshot, so cards may show prices a beat
        // stale until the next tick lands and patches them. We accept
        // that staleness over re-firing /v1/market-summary +
        // /v1/me/portfolio just to return to a rendered view.
        const dash = document.getElementById('market-overview-dashboard');
        if (!dash) return;
        if (window._dashOriginalHTML) {
            dash.innerHTML = window._dashOriginalHTML;
            window._dashOriginalHTML = null;
            delete dash.dataset.originalStashed;
            // Re-mount charts: sparkline is mobile-only (no-ops if its
            // host isn't in the restored markup). Equity chart is
            // desktop+auth-only and its host div is conditionally
            // emitted into the stashed HTML — guard on its presence.
            if (typeof window.mountPortfolioSparkline === 'function') {
                window.mountPortfolioSparkline();
            }
            if (document.getElementById('portfolio-equity-section-host')) {
                showPortfolioEquityChart('portfolio-equity-section-host');
            }
        }
    }
};

// Esc-to-close for the add-position modal.
if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const addModal = document.getElementById('add-position-modal');
        if (addModal && !addModal.classList.contains('hidden')) window.closeAddPositionModal();
    });
}

// Show a per-stock mini summary when a stock is selected. Called from
// app.js alongside fetchAIInsight/fetchBacktest. If the symbol isn't in
// the portfolio, hides the panel. On return to dashboard, initPortfolio
// restores the full view.
export function showStockPortfolio(symbol) {
    const panel = document.getElementById('stock-portfolio-panel');
    const container = document.getElementById('stock-portfolio-body');
    if (!panel || !container || !isProOrAdmin() || !_data) {
        if (panel) panel.classList.add('hidden');
        return;
    }

    const sym = (symbol || '').toUpperCase();
    const holdings = (_data.holdings || []).filter(h => h.symbol === sym);

    if (holdings.length === 0) {
        panel.classList.add('hidden');
        return;
    }

    panel.classList.remove('hidden');

    const totalQty = holdings.reduce((s, h) => s + h.quantity, 0);
    const totalCost = holdings.reduce((s, h) => s + h.costValue, 0);
    const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
    const pnl = totalValue - totalCost;
    const pnlPct = totalCost > 0 ? (pnl / totalCost * 100) : 0;

    container.innerHTML = `
        <div class="grid grid-cols-2 gap-3">
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Value</p>
                <p class="text-sm font-bold text-white/90 truncate">${fmtPrice(totalValue)}</p>
            </div>
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Cost</p>
                <p class="text-sm font-bold text-slate-400 truncate">${fmtPrice(totalCost)}</p>
            </div>
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">P&L</p>
                <p class="text-sm font-bold ${clr(pnl)} truncate">${fmtPrice(pnl)}</p>
            </div>
            <div class="glass-card rounded-2xl p-4">
                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Return</p>
                <p class="text-sm font-bold ${clr(pnlPct)} truncate">${fmtPct(pnlPct)}</p>
            </div>
        </div>
        <p class="mono text-[9px] text-slate-500 mt-2">${totalQty} shares · ${holdings.length} lot${holdings.length !== 1 ? 's' : ''}</p>`;
}

export function initPortfolio() {
    const panel = document.getElementById('portfolio-panel');
    if (!panel) return;
    panel.classList.remove('hidden');

    const container = document.getElementById('portfolio-body');
    if (!container) return;

    // Guest → unified sign-in CTA. Covers portfolio + watchlist + alerts
    // in one card so the guest sidebar isn't a wall of repeated locked
    // panels — the standalone watchlist-locked card is hidden below.
    if (!isAuthed()) {
        container.innerHTML = `
            <div class="glass-card rounded-2xl p-6 border-amber-500/20 relative overflow-hidden flex flex-col items-center text-center">
                <div class="absolute inset-0 bg-gradient-to-br from-amber-600/5 to-orange-600/5 pointer-events-none"></div>
                <div class="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center text-amber-500 mb-3 group-hover:scale-110 transition-transform duration-500">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </div>
                <h4 class="text-[11px] font-bold text-white/90 mb-1.5 uppercase tracking-wider">Sign in to unlock</h4>
                <p class="text-[9px] text-slate-500 leading-relaxed mb-4">Portfolio P&amp;L, pinned watchlist, and price/RSI alerts — all gated to a terminal uplink.</p>
                <a href="/login" class="w-full py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/20 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all text-center">
                    Establish Uplink
                </a>
            </div>`;
        const wlLocked = document.getElementById('watchlist-locked');
        if (wlLocked) wlLocked.classList.add('hidden');
        return;
    }

    // Basic/user tier → upgrade CTA
    if (!isProOrAdmin()) {
        container.innerHTML = `
            <div class="glass-card rounded-2xl p-8 border-blue-500/20 relative overflow-hidden flex flex-col items-center text-center">
                <div class="absolute inset-0 bg-gradient-to-br from-blue-600/5 to-indigo-600/5 pointer-events-none"></div>
                <div class="w-12 h-12 bg-blue-500/10 rounded-xl flex items-center justify-center text-blue-500 mb-4">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                </div>
                <h4 class="text-sm font-bold text-white/90 mb-1.5 uppercase tracking-wider">Upgrade Required</h4>
                <p class="text-[11px] text-slate-500 leading-relaxed mb-4">Portfolio tracking with live P&L, sector exposure, and weighted returns is available on Pro and Admin tiers.</p>
                <a href="/settings" class="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all text-center shadow-lg shadow-blue-600/20">
                    Upgrade Account
                </a>
            </div>`;
        return;
    }

    // Pro/Admin → load the real portfolio
    fetchPortfolio();
}
