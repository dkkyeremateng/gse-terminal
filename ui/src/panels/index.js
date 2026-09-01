// Panels — comparables, market summary, stock row, movers, market news,
// watchlist, and clearSelectedStock. Extracted from app.js.

import { twColor } from '../util/tw-colors.js';
import { escapeHTML } from '../util/escape.js';
import { getBriefing } from '../util/briefing-cache.js';
import { showPortfolioEquityChart, splitAtZero, returnSeries, windowCashflow } from '../charts/portfolio.js';
import { getPortfolioHistory } from '../util/portfolio-history-cache.js';

// renderPortfolioBriefingCard returns the HTML for the "Your Portfolio
// Today" card that sits alongside the daily briefing summary on the
// landing dashboard. Returns '' in the three cases the card shouldn't
// render at all (guest, fetch failure, unauthenticated), a CTA variant
// for authenticated users with zero holdings, and the live stat strip
// (today's Δ%, Δ¢, total value, holding count) for the populated case.
// `history` is the optional PortfolioHistoryResponse from
// GET /v1/me/portfolio/history — when ≥ 2 points are present we render
// a sparkline placeholder that mountPortfolioSparkline() hydrates after
// innerHTML is committed. Shape of `portfolio` is the PortfolioSummary
// response from GET /v1/me/portfolio.
function renderPortfolioBriefingCard(portfolio, history) {
    if (!portfolio) return '';
    // holdingCount from the server counts holding rows (lots), so a user
    // with one symbol bought twice reads as "2 holdings". Collapse to
    // unique symbols so this card matches the positions table.
    const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
    const count = holdings.length > 0
        ? new Set(holdings.map(h => h.symbol)).size
        : Number(portfolio.holdingCount || 0);
    if (count === 0) {
        return `
        <a href="/terminal#portfolio" class="market-portfolio-card market-portfolio-card--empty glass-card rounded-2xl p-5 h-full flex flex-col justify-center items-start border-blue-500/10 hover:border-blue-500/30 transition-colors group" data-portfolio-briefing-card>
            <span class="text-[10px] font-bold text-blue-400 uppercase tracking-[0.2em] mb-2">Your Portfolio</span>
            <p class="text-sm text-slate-300 leading-relaxed font-light mb-3">Track holdings to see live P&amp;L, sector exposure, and today's move alongside the market briefing.</p>
            <span class="text-[11px] text-blue-400 group-hover:text-blue-300 uppercase tracking-[0.2em] font-bold inline-flex items-center gap-1">
                Add your first holding <span aria-hidden="true">→</span>
            </span>
        </a>`;
    }

    const totalValue  = Number(portfolio.totalValue || 0);
    const valStr = totalValue.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Full history is fetched once (?window=all) and filtered client-side
    // by the range pills. Stash the full set on the sparkline wrapper so
    // the update handler can re-window without another round trip.
    const fullPoints = Array.isArray(history?.points) ? history.points : [];
    const defaultRange = 'YTD';
    const windowed = computeCardWindow(fullPoints, defaultRange);
    // Stash the portfolio summary so the update handler can fall back to
    // today's P&L when the selected range yields fewer than 2 points.
    window._portfolioCardSummary = portfolio;

    const stats = computeCardPerfStats(windowed, portfolio, defaultRange);
    const emptyMsg = windowed.length < 2
        ? `<div class="h-full flex items-center text-[10px] text-slate-500">Equity curve populates after your first multi-day price history lands.</div>`
        : '';

    const rangePill = (r, active = false) =>
        `<button type="button" data-action="update-portfolio-card-range" data-range="${r}" class="range-btn${active ? ' active' : ''}" style="font-size:9px;padding:2px 6px;">${r}</button>`;
    const pillsHTML = `
        <div class="flex flex-wrap gap-1 mb-2" role="radiogroup" aria-label="Portfolio performance range">
            ${rangePill('1M')}${rangePill('3M')}${rangePill('6M')}${rangePill('YTD', true)}${rangePill('1Y')}${rangePill('MAX')}
        </div>`;

    const sparklineHTML = `
        <div class="market-portfolio-card__spark mb-3"
             data-portfolio-sparkline
             data-portfolio-range="${defaultRange}"
             data-portfolio-points='${escapeAttr(JSON.stringify(fullPoints))}'>
            <div class="flex items-center justify-between mb-1">
                <span class="text-[9px] text-slate-500 uppercase tracking-[0.2em] font-bold">Performance · <span id="portfolio-card-window-label">${defaultRange}</span></span>
            </div>
            <div id="portfolio-sparkline" class="h-[56px]">${emptyMsg}</div>
        </div>`;

    return `
    <a href="/terminal#portfolio" class="market-portfolio-card glass-card rounded-2xl p-5 h-full flex flex-col border-blue-500/10 hover:border-blue-500/30 transition-colors group" data-portfolio-briefing-card>
        <div class="flex items-center justify-between mb-3">
            <span class="text-[10px] font-bold text-blue-400 uppercase tracking-[0.2em]">Your Portfolio Today</span>
            <span class="text-[10px] text-slate-500 mono">${count} holding${count === 1 ? '' : 's'}</span>
        </div>
        <div class="flex items-baseline gap-2 mb-1">
            <span class="text-2xl font-display font-bold text-slate-100 mono">¢ ${valStr}</span>
        </div>
        <div class="flex items-center gap-2 text-[11px] mb-3">
            <span id="portfolio-card-pct" class="${PORTFOLIO_CARD_PCT_BASE} ${stats.toneCls}">${stats.arrow} ${stats.sign}${stats.pctStr}%</span>
            <span id="portfolio-card-abs" class="text-slate-400 mono">${stats.sign}¢ ${stats.absStr}</span>
            <span id="portfolio-card-label" class="text-slate-500 text-[10px] uppercase tracking-[0.2em]">${stats.label}</span>
        </div>
        ${pillsHTML}
        ${sparklineHTML}
        <span class="mt-auto text-[10px] text-slate-500 group-hover:text-blue-400 uppercase tracking-[0.2em] font-bold inline-flex items-center gap-1">
            Open portfolio <span aria-hidden="true">→</span>
        </span>
    </a>`;
}

const PORTFOLIO_CARD_PCT_BASE = 'inline-flex items-center gap-1 px-2 py-0.5 rounded border mono font-bold';

// renderSectorHeatmap returns the HTML for the deterministic sector
// breadth tile grid that anchors the dashboard's analytics row. Backed
// by /v1/market-sectors/overview (public, breadth-only) — the full
// constituents view stays Pro-gated behind /v1/market-sectors. Tiles are
// colored by avg % move with intensity bands (>2%, >0.5%, >0%, etc.) so
// even a glance differentiates "hot" sectors from "drifting".
function renderSectorHeatmap(sectors) {
    if (!Array.isArray(sectors) || sectors.length === 0) return '';
    const toneFor = (pct) => {
        if (pct >=  2.0) return 'bg-emerald-500/25 border-emerald-400/40 text-emerald-200';
        if (pct >=  0.5) return 'bg-emerald-500/15 border-emerald-400/25 text-emerald-300';
        if (pct >   0.0) return 'bg-emerald-500/5  border-emerald-400/15 text-emerald-300/80';
        if (pct ===  0)  return 'bg-white/5        border-white/10       text-slate-400';
        if (pct >  -0.5) return 'bg-rose-500/5     border-rose-400/15    text-rose-300/80';
        if (pct >  -2.0) return 'bg-rose-500/15    border-rose-400/25    text-rose-300';
        return                  'bg-rose-500/25    border-rose-400/40    text-rose-200';
    };
    const tiles = sectors.map(s => {
        const pct = Number(s.avgPctChange) || 0;
        const sign = pct > 0 ? '+' : '';
        const breadth = `${s.advanceCount || 0}↑ ${s.declineCount || 0}↓`;
        return `
        <div class="rounded-lg p-3 border ${toneFor(pct)} flex flex-col gap-1">
            <div class="text-[10px] font-bold uppercase tracking-[0.15em] truncate">${escapeHTML(s.sector || '—')}</div>
            <div class="text-base font-display font-bold mono">${sign}${pct.toFixed(2)}%</div>
            <div class="text-[9px] opacity-70 mono">${breadth}</div>
        </div>`;
    }).join('');
    return `
    <div class="market-section-header flex items-center gap-2 mb-3">
        <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
        <h4 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Sector Heatmap</h4>
        <span class="text-[10px] text-slate-600 ml-auto mono">turnover-weighted</span>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-6">
        ${tiles}
    </div>`;
}

// renderExtremesRow is the shared row layout for the RSI/volume blocks
// below — one symbol on the left, one tinted metric chip on the right,
// click-navigable via the existing data-stock-row-symbol handler.
function renderExtremesRow(i, metricLabel, metricValue, tone) {
    return `
        <div data-stock-row-symbol="${escapeHTML(i.symbol)}" class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-white/[0.04] cursor-pointer transition-colors">
            <span class="text-[11px] font-bold font-display text-slate-200">${escapeHTML(i.symbol)}</span>
            <span class="text-[10px] mono ${tone}">${metricLabel} ${metricValue}</span>
        </div>`;
}

// renderRSIExtremes produces the two-column "RSI Extremes" board —
// oversold (RSI ascending) on the left, overbought (RSI descending) on
// the right. Each side surfaces up to 5 symbols. Sourced from the same
// briefing.insights payload — no extra round trip.
function renderRSIExtremes(insights) {
    if (!Array.isArray(insights) || insights.length === 0) return '';
    const withPrice = insights.filter(i => Number(i.lastPrice) > 0);
    if (withPrice.length === 0) return '';
    const oversold   = [...withPrice].sort((a, b) => Number(a.rsi) - Number(b.rsi)).slice(0, 5);
    const overbought = [...withPrice].sort((a, b) => Number(b.rsi) - Number(a.rsi)).slice(0, 5);
    const col = (title, items, tone, emptyMsg) => `
        <div class="glass-card rounded-xl p-3">
            <div class="text-[10px] font-bold text-slate-500 uppercase tracking-[0.18em] mb-2">${title}</div>
            ${items.length ? items.map(i => renderExtremesRow(i, 'RSI', Number(i.rsi).toFixed(1), tone)).join('') : `<p class="text-[10px] text-slate-600 italic px-2 py-1.5">${emptyMsg}</p>`}
        </div>`;
    return `
    <div class="market-section-header flex items-center gap-2 mb-3">
        <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
        <h4 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">RSI Extremes</h4>
        <span class="text-[10px] text-slate-600 ml-auto mono">14-day Wilder</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        ${col('Oversold · low RSI',   oversold,   'text-rose-400',    'No oversold prints')}
        ${col('Overbought · high RSI', overbought, 'text-emerald-400', 'No overbought prints')}
    </div>`;
}

// computeClientConfidence re-derives the per-card confidence number on
// the client. The server-side Confidence() function (technical.go:130)
// is deterministic but its differentiating bonuses (signal direction,
// sentiment alignment, volume conviction) all depend on inputs that
// the current briefing leaves NEUTRAL/zero, so every card collapses to
// the same baseline 68. This client-side version keeps the same scale
// (0-95) but adds two dimensions that DO vary per symbol from the
// available payload: trend conviction (|sma20-sma50| as % of price)
// and a data-quality penalty when lastPrice or RSI is unread.
function computeClientConfidence(ins) {
    const sma20       = Number(ins.sma20)       || 0;
    const sma50       = Number(ins.sma50)       || 0;
    const rsi         = Number(ins.rsi)         || 0;
    const lastPrice   = Number(ins.lastPrice)   || 0;
    const dataPoints  = Number(ins.dataPoints)  || 0;
    const volumeRatio = Number(ins.volumeRatio) || 0;
    const signal      = String(ins.signal || 'NEUTRAL').toUpperCase();

    let score = 50;

    if      (dataPoints >= 50) score += 10;
    else if (dataPoints >= 30) score += 5;

    // Trend conviction: how far the 20-day average has separated from
    // the 50-day, expressed as % of the longer average. A 5%+ gap is a
    // well-established trend; under 1% is noise.
    if (sma50 > 0) {
        const trendGapPct = Math.abs(sma20 - sma50) / sma50 * 100;
        if      (trendGapPct >= 5)   score += 12;
        else if (trendGapPct >= 2)   score += 8;
        else if (trendGapPct >= 1)   score += 4;
    }

    // Directional signal bonuses (only fire when the briefing actually
    // has a directional read — most symbols today don't).
    if (signal !== 'NEUTRAL' && rsi > 0) {
        const rsiExtreme = (rsi < 30 && signal === 'BULLISH') || (rsi > 70 && signal === 'BEARISH');
        const rsiMild    = (rsi < 40 && signal === 'BULLISH') || (rsi > 60 && signal === 'BEARISH');
        if      (rsiExtreme) score += 15;
        else if (rsiMild)    score += 8;
    }

    if      (volumeRatio >= 2.0) score += 7;
    else if (volumeRatio >= 1.5) score += 3;

    // Data-quality penalty: missing inputs should not be hidden behind
    // a confident-looking number. Each missing input subtracts.
    if (lastPrice <= 0) score -= 12;   // VWAP fallback in use
    if (rsi <= 0.001)   score -= 10;   // RSI calc failed

    if (score < 5)  score = 5;
    if (score > 95) score = 95;
    return Math.round(score);
}

// composeInsightAnalysis is a JS port of analysis/insight.go's
// heuristicSummary. It generates the per-card prose deterministically
// from the same indicator fields the briefing payload already exposes
// (rsi, sma50, lastPrice, signal, sentiment, volumeRatio) — no LLM
// dependency, no chance of stale "VWAP of ¢0.00" boilerplate, and the
// text re-renders fresh on every load instead of being baked into a
// stored briefing row. Keep this in sync with insight.go:185-228 if
// the Go heuristic ever changes.
function composeInsightAnalysis(ins) {
    const symbol      = String(ins.symbol || '').toUpperCase();
    const sma20       = Number(ins.sma20)       || 0;
    const sma50       = Number(ins.sma50)       || 0;
    // Fallback chain for the displayed/described price: lastPrice
    // (preferred) → sma20 → sma50. Briefing rows occasionally land with
    // lastPrice 0 when the most recent bucket is empty.
    const rawLastPrice = Number(ins.lastPrice) || 0;
    const lastPrice    = rawLastPrice > 0 ? rawLastPrice
                       : sma20 > 0        ? sma20
                       :                    sma50;
    const haveLast     = rawLastPrice > 0;
    const rsi         = Number(ins.rsi)         || 0;
    const sentiment   = Number(ins.sentiment)   || 0;
    const volumeRatio = Number(ins.volumeRatio) || 0;
    const signal      = String(ins.signal || 'NEUTRAL').toUpperCase();

    // ── Dimension 1: momentum (RSI) ──────────────────────────────────
    // RSI exactly 0 is a calc failure (insufficient data or flat closes),
    // not a bearish extreme — call it out honestly instead of mislabeling
    // the symbol as oversold.
    let momentumTxt;
    if      (rsi <= 0.001) momentumTxt = 'momentum unread (insufficient closes for a clean RSI)';
    else if (rsi < 30)     momentumTxt = `oversold at RSI ${rsi.toFixed(1)}, in the historical bounce zone`;
    else if (rsi < 45)     momentumTxt = `cooling at RSI ${rsi.toFixed(1)}, drifting toward support`;
    else if (rsi < 60)     momentumTxt = `balanced at RSI ${rsi.toFixed(1)}, with no directional pressure`;
    else if (rsi < 70)     momentumTxt = `building momentum at RSI ${rsi.toFixed(1)}, breaking out of neutral`;
    else                   momentumTxt = `overbought at RSI ${rsi.toFixed(1)}, with the rally extended`;

    // ── Dimension 2: trend (price vs SMA20 vs SMA50) ─────────────────
    // Using both averages varies the prose even when every symbol shares
    // an RSI band. When lastPrice is the sma20 fallback, the
    // price-vs-sma20 comparison is tautological — skip it and lean on
    // the sma20/sma50 cross alone.
    const sma20Above50 = sma20 > sma50;
    let trendTxt;
    if (!haveLast) {
        trendTxt = sma20Above50
            ? ` 20-day average rides above the 50-day (¢${sma20.toFixed(2)} > ¢${sma50.toFixed(2)}) — trend structure remains constructive.`
            : ` 20-day average sits below the 50-day (¢${sma20.toFixed(2)} < ¢${sma50.toFixed(2)}) — trend structure is deteriorating.`;
    } else {
        const aboveSMA20 = lastPrice > sma20;
        const aboveSMA50 = lastPrice > sma50;
        if (aboveSMA20 && aboveSMA50 && sma20Above50) {
            trendTxt = ` Price clears both moving averages with the 20-day above the 50-day (¢${sma20.toFixed(2)} > ¢${sma50.toFixed(2)}) — a clean uptrend stack.`;
        } else if (!aboveSMA20 && !aboveSMA50 && !sma20Above50) {
            trendTxt = ` Price sits below both moving averages and the 20-day has crossed under the 50-day (¢${sma20.toFixed(2)} < ¢${sma50.toFixed(2)}) — a confirmed downtrend.`;
        } else if (aboveSMA50 && !aboveSMA20) {
            trendTxt = ` Price is above the 50-day (¢${sma50.toFixed(2)}) but slipped below the 20-day (¢${sma20.toFixed(2)}) — short-term pullback inside a longer uptrend.`;
        } else if (!aboveSMA50 && aboveSMA20) {
            trendTxt = ` Price reclaimed the 20-day (¢${sma20.toFixed(2)}) but still trades below the 50-day (¢${sma50.toFixed(2)}) — early reversal attempt.`;
        } else if (sma20Above50) {
            trendTxt = ` 20-day average sits above the 50-day (¢${sma20.toFixed(2)} vs ¢${sma50.toFixed(2)}), suggesting trend support is intact despite the recent dip.`;
        } else {
            trendTxt = ` 20-day average sits below the 50-day (¢${sma20.toFixed(2)} vs ¢${sma50.toFixed(2)}), pointing to a deteriorating trend structure.`;
        }
    }

    // ── Dimension 3: action / volume / sentiment modifiers ───────────
    let actionTxt = 'Maintain current positioning';
    if      (signal === 'BULLISH') actionTxt = 'Trend-following accumulation supported';
    else if (signal === 'BEARISH') actionTxt = 'Defensive stance warranted';
    if      (sentiment >=  0.4) actionTxt += '; news flow leans positive';
    else if (sentiment <= -0.4) actionTxt += '; negative news flow argues for caution';

    let volTxt = '';
    if      (volumeRatio >= 2.0) volTxt = ` Session volume ran ${volumeRatio.toFixed(1)}× the 20-day average, lending strong conviction.`;
    else if (volumeRatio <  0.5 && volumeRatio > 0) volTxt = ' Volume was notably thin, weakening signal reliability.';

    return `Technical read: ${symbol} at ¢${lastPrice.toFixed(2)} — ${momentumTxt}.${trendTxt}${volTxt} ${actionTxt}.`;
}

// computeCardWindow filters the full portfolio-history series down to
// the points within the selected range. Matches the big performance
// chart's computeBounds semantics so stats stay consistent between the
// briefing card and the full equity curve.
function computeCardWindow(points, range) {
    if (!points || points.length === 0) return [];
    const maxTs = new Date(points[points.length - 1].date).getTime();
    const maxD = new Date(maxTs);
    let minTs;
    switch (range) {
        case '1M':  { const d = new Date(maxD); d.setMonth(d.getMonth() - 1);    minTs = d.getTime(); break; }
        case '3M':  { const d = new Date(maxD); d.setMonth(d.getMonth() - 3);    minTs = d.getTime(); break; }
        case '6M':  { const d = new Date(maxD); d.setMonth(d.getMonth() - 6);    minTs = d.getTime(); break; }
        case 'YTD': { minTs = new Date(maxD.getFullYear(), 0, 1).getTime(); break; }
        case '1Y':  { const d = new Date(maxD); d.setFullYear(d.getFullYear() - 1); minTs = d.getTime(); break; }
        case 'MAX':
        default:    return points;
    }
    return points.filter(p => new Date(p.date).getTime() >= minTs);
}

// computeCardPerfStats returns the display-ready stats row (pct, abs,
// tone, arrow, sign, label) for the given windowed series. Uses the
// shared returnSeries helper so the briefing card, the big performance
// chart, and its header all report the same number for any given
// window. Falls back to today's P&L when the window has fewer than
// 2 points so the card still reads sensibly for very new portfolios.
function computeCardPerfStats(windowedPoints, portfolio, range) {
    let pct, abs, label;
    if (windowedPoints.length >= 2) {
        // Normalize {date, value, cashflow} → {x, y, cashflow} shape
        // that returnSeries / windowCashflow expect.
        const series = windowedPoints.map(p => ({
            x: new Date(p.date).getTime(),
            y: Number(p.value) || 0,
            cashflow: Number(p.cashflow) || 0,
        }));
        const twr = returnSeries(series);
        pct   = twr.length > 0 ? twr[twr.length - 1].y : 0;
        // Market-only ¢ gain: last value − first value − Σ cashflows.
        abs   = series[series.length - 1].y - series[0].y - windowCashflow(series);
        label = range;
    } else {
        pct   = Number(portfolio?.todayPnlPct || 0);
        abs   = Number(portfolio?.todayPnl || 0);
        label = 'today';
    }
    const isFlat = Math.abs(abs) < 0.005;
    const isUp   = !isFlat && abs > 0;
    return {
        pct, abs, label,
        toneCls: isFlat
            ? 'text-slate-300 border-slate-500/20'
            : isUp
                ? 'text-emerald-400 border-emerald-500/20'
                : 'text-rose-400 border-rose-500/20',
        arrow: isFlat ? '→' : isUp ? '▲' : '▼',
        sign:  isFlat ? ''  : isUp ? '+' : '−',
        pctStr: Math.abs(pct).toFixed(2),
        absStr: Math.abs(abs).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    };
}

// updatePortfolioCardRange is invoked by the data-action dispatcher on
// range-pill clicks. Re-windows the stashed full-history series, rewrites
// the stat row in place, and re-mounts the sparkline — no round trip.
window.updatePortfolioCardRange = function(range) {
    if (!range) return;
    const wrapper = document.querySelector('[data-portfolio-sparkline]');
    if (!wrapper) return;
    const raw = wrapper.getAttribute('data-portfolio-points');
    if (!raw) return;
    let fullPoints;
    try { fullPoints = JSON.parse(raw); } catch { return; }

    wrapper.setAttribute('data-portfolio-range', range);

    document.querySelectorAll('[data-action="update-portfolio-card-range"]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-range') === range);
    });

    const windowed = computeCardWindow(fullPoints, range);
    const stats = computeCardPerfStats(windowed, window._portfolioCardSummary, range);

    const pctEl   = document.getElementById('portfolio-card-pct');
    const absEl   = document.getElementById('portfolio-card-abs');
    const labelEl = document.getElementById('portfolio-card-label');
    const winEl   = document.getElementById('portfolio-card-window-label');
    if (pctEl) {
        pctEl.className = `${PORTFOLIO_CARD_PCT_BASE} ${stats.toneCls}`;
        pctEl.textContent = `${stats.arrow} ${stats.sign}${stats.pctStr}%`;
    }
    if (absEl) absEl.textContent = `${stats.sign}¢ ${stats.absStr}`;
    if (labelEl) labelEl.textContent = stats.label;
    if (winEl) winEl.textContent = range;

    mountPortfolioSparkline();
};

// escapeAttr produces a safe value for the single-quoted HTML attribute
// where we stash the JSON-serialised sparkline points. The JSON string
// itself already has no single quotes (JSON uses double quotes), but a
// point value containing an apostrophe — or a future caller passing
// through arbitrary data — would break the attribute boundary.
function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

// mountPortfolioSparkline hydrates the #portfolio-sparkline placeholder
// left behind by renderPortfolioBriefingCard with an ApexCharts area
// sparkline. Colour tracks whether the curve ended up (emerald) or
// down (rose) net over the window so the chart's gist is legible at
// a glance even without axis labels. No-ops if ApexCharts isn't on
// window yet (e.g. CDN blocked) or the placeholder wasn't rendered.
function mountPortfolioSparkline() {
    if (typeof window.ApexCharts === 'undefined') {
        console.debug('[portfolio-card] ApexCharts not loaded, skipping sparkline');
        return;
    }
    const host = document.getElementById('portfolio-sparkline');
    if (!host) return;
    const wrapper = host.closest('[data-portfolio-sparkline]');
    const raw = wrapper?.getAttribute('data-portfolio-points');
    if (!raw) return;
    let fullPoints;
    try { fullPoints = JSON.parse(raw); } catch (e) {
        console.debug('[portfolio-card] sparkline data parse failed', e);
        return;
    }
    if (!Array.isArray(fullPoints) || fullPoints.length < 2) {
        console.debug('[portfolio-card] sparkline skipped, points:', Array.isArray(fullPoints) ? fullPoints.length : typeof fullPoints);
        return;
    }
    // Window the full-history series down to whatever range the pill row
    // currently has selected (defaults to YTD on first mount). Stays
    // client-side so a pill click is a DOM update, not a network call.
    const range = wrapper.getAttribute('data-portfolio-range') || 'YTD';
    const points = computeCardWindow(fullPoints, range);
    // Clear the empty-state placeholder rendered by
    // renderPortfolioBriefingCard before ApexCharts draws into the slot.
    host.innerHTML = '';
    if (points.length < 2) {
        host.innerHTML = `<div class="h-full flex items-center text-[10px] text-slate-500">Not enough history in this range.</div>`;
        if (window._portfolioSparkline) {
            try { window._portfolioSparkline.destroy(); } catch {}
            window._portfolioSparkline = null;
        }
        return;
    }

    // Performance series — cumulative money-weighted simple return
    // across the window, computed via the shared returnSeries helper
    // so the sparkline, the big chart, and the header stats all agree
    // (and share sign with the ¢ gain by construction).
    const perfSeries = returnSeries(points.map(p => ({
        x: new Date(p.date).getTime(),
        y: Number(p.value) || 0,
        cashflow: Number(p.cashflow) || 0,
    })));
    // Split into positive/negative halves so segments above 0% render
    // emerald and segments below 0% render rose — same technique the
    // big performance chart uses. Without this the whole sparkline is
    // coloured by the final point's sign, which hides any earlier
    // gains on a net-loss window.
    const { positive, negative } = splitAtZero(perfSeries);

    // Destroy any existing instance so a re-render (e.g. after cache
    // bust → fetchMarketSummary) doesn't leak multiple SVGs into the
    // same slot.
    if (window._portfolioSparkline) {
        try { window._portfolioSparkline.destroy(); } catch {}
        window._portfolioSparkline = null;
    }

    const options = {
        chart: {
            type: 'area', height: 56, sparkline: { enabled: true },
            animations: { enabled: true, easing: 'easeinout', speed: 250,
                animateGradually: { enabled: false }, dynamicAnimation: { enabled: false } },
        },
        stroke: { curve: 'smooth', width: 1.75, lineCap: 'round', dashArray: 0 },
        fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.02 } },
        // Negative first so Positive draws on top — flat / touching-zero
        // segments paint emerald, matching the big chart.
        colors: ['#f43f5e', '#10b981'],
        // showNullDataPoints:false — the split series carry null where
        // the other owns the slot; default ApexCharts would render
        // those nulls as dashed markers.
        markers: { size: 0, showNullDataPoints: false },
        series: [
            { name: 'Negative', data: negative },
            { name: 'Positive', data: positive },
        ],
        tooltip: {
            theme: 'dark',
            marker: { show: false },
            // Custom layout so the tooltip matches the big portfolio
            // performance chart's style: uppercase date header, dot +
            // "Return:" label, coloured percent, raw ¢ value
            // underneath. Raw ApexCharts defaults leak the epoch
            // timestamp as the date row on sparklines, so we render
            // the whole card ourselves.
            custom: function ({ series, seriesIndex, dataPointIndex, w }) {
                // Two overlaid series: whichever is non-null at the
                // hovered index owns the point; fall back to the other
                // for hover slots where the point is null (off-segment).
                let val = series[seriesIndex]?.[dataPointIndex];
                let ts  = w.globals.seriesX[seriesIndex]?.[dataPointIndex];
                if (val === null || val === undefined) {
                    const other = seriesIndex === 0 ? 1 : 0;
                    val = series[other]?.[dataPointIndex];
                    ts  = w.globals.seriesX[other]?.[dataPointIndex] ?? ts;
                }
                if (val === null || val === undefined) return '';
                const dateLabel = new Date(ts).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
                const raw = points.find(p => new Date(p.date).getTime() === ts);
                const rawVal = raw ? Number(raw.value) || 0 : null;
                const isUp = val >= 0;
                const cls = isUp ? 'text-emerald-400' : 'text-rose-400';
                const dot = isUp ? '#10b981' : '#f43f5e';
                const sign = val >= 0 ? '+' : '';
                const ghsStr = rawVal !== null
                    ? `¢${rawVal.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : '';
                return `
                    <div class="p-3 bg-slate-950/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl">
                        <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">${dateLabel}</p>
                        <div class="grid items-center gap-x-4 gap-y-1 mt-1" style="grid-template-columns: auto auto;">
                            <span class="flex items-center gap-2">
                                <span class="inline-block w-2 h-2 rounded-full" style="background:${dot}"></span>
                                <span class="text-xs font-bold text-white/80">Return:</span>
                            </span>
                            <span class="text-sm font-bold tabular-nums ${cls}">${sign}${Number(val).toFixed(2)}%</span>
                        </div>
                        ${ghsStr ? `<p class="text-[10px] text-slate-500 mt-1">${ghsStr}</p>` : ''}
                    </div>`;
            },
        },
    };

    window._portfolioSparkline = new window.ApexCharts(host, options);
    window._portfolioSparkline.render();
}

// Exposed on window so the fetchMarketSummary path (which doesn't
// import this file directly) and cache:bust re-renders can hydrate
// the sparkline after setting innerHTML.
window.mountPortfolioSparkline = mountPortfolioSparkline;

window.renderComparables = async function(symbol) {
    const widget = document.getElementById('comparables-widget');
    const container = document.getElementById('comparables-container');
    if (!widget || !container) return;

    if (!window.GSE_WIKI[symbol] || !window.MARKET_SUMMARY_DATA || !window.MARKET_SUMMARY_DATA.all) {
        widget.classList.add('hidden');
        return;
    }

    const targetDesc = window.GSE_WIKI[symbol].toLowerCase();
    
    // Lexical analysis vectors for GSE industries
    const INDUSTRIES = [
        { name: "Financial Services", keywords: ["bank", "financial", "insurance", "pension"] },
        { name: "Energy & Petroleum", keywords: ["oil", "gas", "petroleum", "energy"] },
        { name: "Agriculture", keywords: ["agro", "palm", "agricultural", "cocoa"] },
        { name: "Consumer Goods", keywords: ["consumer", "fmcg", "food", "dairy"] },
        { name: "Telecommunications", keywords: ["telecom", "mobile"] },
        { name: "Mining", keywords: ["gold", "mining"] }
    ];
    
    let targetInd = null;
    for (let ind of INDUSTRIES) {
        for (let kw of ind.keywords) {
            if (targetDesc.includes(kw)) {
                targetInd = ind;
                break;
            }
        }
        if (targetInd) break;
    }
    
    if (!targetInd) {
        widget.classList.add('hidden');
        return;
    }
    
    let peerSymbols = [];
    for (let [sym, desc] of Object.entries(window.GSE_WIKI)) {
        if (sym === symbol) continue;
        let isMatch = false;
        const d = desc.toLowerCase();
        for (let kw of targetInd.keywords) {
            if (d.includes(kw)) {
                isMatch = true; 
                break;
            }
        }
        if (isMatch) peerSymbols.push(sym);
    }
    
    if (peerSymbols.length === 0) {
        // Fallback for monopolies like MTNGH with no exact sector peers
        if (window.MARKET_SUMMARY_DATA.active) {
            peerSymbols = window.MARKET_SUMMARY_DATA.active.map(x => x.symbol).filter(s => s !== symbol).slice(0, 4);
        }
    }
    
    // Cross-reference peers with latest trading data
    let peersData = [];
    for (let ps of peerSymbols) {
         const dataBlock = window.MARKET_SUMMARY_DATA.all.find(x => x.symbol === ps);
         if (dataBlock && (dataBlock.lastPrice > 0)) {
             peersData.push({
                 symbol: ps,
                 price: dataBlock.lastPrice,
                 percentChange: dataBlock.percentChange
             });
         }
    }

    if (peersData.length > 0) {
        const activeSet = new Set(
            window.compareState ? window.compareState.series.slice(1).map(s => s.symbol) : []
        );
        // On mobile, render the movers/renderStockRow-style row card so
        // the Compare-to section matches the rest of the design system.
        container.innerHTML = peersData.map(p => {
             const isUp = p.percentChange >= 0;
             const color = isUp ? 'emerald' : 'rose';
             const sign = isUp ? '+' : '';
             const fmtPrice = (v) => v >= 100 ? `¢${Math.round(v)}` : `¢${v.toFixed(2)}`;
             const isActive = activeSet.has(p.symbol);
             const isLoading = window._loadingPeer === p.symbol;
             const onClickAttr = isLoading ? '' : `data-action="toggle-peer-compare" data-symbol="${window.escapeHTML(p.symbol)}"`;

             const cc = twColor(color);
             const stateCls = isLoading
                 ? 'border border-blue-500/40 bg-blue-500/[0.05] animate-pulse cursor-wait'
                 : isActive
                 ? 'border-2 border-amber-500/60 bg-amber-500/[0.06] shadow-lg shadow-amber-500/10 cursor-pointer'
                 : 'cursor-pointer hover:scale-[1.01] hover:bg-white/[0.06]';
             return `
             <div ${onClickAttr} class="glass-card rounded-xl p-3 flex items-center justify-between transition-all group stagger-enter ${stateCls}">
                 <div>
                     <p class="text-sm font-bold font-display text-slate-200 group-hover:text-blue-400 transition-colors light:text-slate-800">${window.escapeHTML(p.symbol)}</p>
                     <p class="text-[10px] text-slate-500 font-black uppercase tracking-widest mt-0.5 opacity-80 light:text-slate-400">${isActive ? '✓ Comparing' : 'Peer'}</p>
                 </div>
                 <div class="text-right">
                     <p class="text-xs font-bold text-white/90 light:text-slate-700">${fmtPrice(p.price)}</p>
                     <p class="text-[10px] font-black ${cc.text500} light:${cc.text600}"><span class="sr-only">${isUp ? 'Up' : 'Down'}</span>${sign}${p.percentChange.toFixed(2)}%</p>
                 </div>
             </div>`;
        }).join('');
        widget.classList.remove('hidden');
    } else {
        widget.classList.add('hidden');
    }
}

// _briefingHTMLCache holds the rendered briefing block (sector heatmap +
// summary card + RSI extremes + insight cards) between fetchMarketSummary
// invocations. Without this, navigating away (stock detail, settings) and
// coming back wipes the dashboard skeleton-style and re-fetches the
// briefing/portfolio/history/sectors quartet every time — visible flash,
// repeated work. invalidateBriefingRender() clears it on cache:bust so a
// genuine refresh still surfaces fresh data.
let _briefingHTMLCache = null;
if (typeof window !== 'undefined') {
    window.invalidateBriefingRender = function() { _briefingHTMLCache = null; };
}

window.fetchMarketSummary = async function() {
    const dash = document.getElementById('market-overview-dashboard');
    if (!dash) return;

    // Short-circuit when the dashboard is already mounted AND the
    // briefing HTML cache is warm. Re-entering fetchMarketSummary
    // (return-from-stock-detail, socket reconnect bust, post-cache-bust
    // refresh that landed on the same briefing snapshot) used to paint
    // the skeleton and rebuild the entire dash innerHTML even when the
    // cached briefing was identical — that's the visible re-render.
    // Live ticks already patch prices in place via applyTickToRows
    // (see live/socket.js:316), so the dashboard doesn't need a full
    // re-render to stay current. handleCacheBust calls
    // invalidateBriefingRender() which clears _briefingHTMLCache,
    // forcing a real refresh through this guard.
    const alreadyMounted = dash.querySelector('.market-briefing') !== null;
    if (alreadyMounted && _briefingHTMLCache !== null) return;

    // Skeleton
    dash.innerHTML = `
        <div class="space-y-4 w-full max-w-4xl stagger-enter stagger-1">
            <h3 class="text-xl font-display font-medium text-slate-300">Market Overview</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                ${Array(6).fill(0).map(() => '<div class="glass-card rounded-2xl shimmer h-24"></div>').join('')}
            </div>
        </div>
    `;

    try {
        const signal = window.abortableSignal ? window.abortableSignal('market-summary') : undefined;
        const res = await fetch('/v1/market-summary', { signal });
        if (!res.ok) throw new Error(`market-summary ${res.status}`);
        const data = await res.json();
        window.MARKET_SUMMARY_DATA = data;
        
        // Filter out bad/ghost data: stocks without a symbol or with zero price
        const cleanItems = (arr) => (arr || []).filter(x => x.symbol && x.symbol.trim() !== '' && x.lastPrice > 0);
        data.topGainers = cleanItems(data.topGainers);
        data.topLosers = cleanItems(data.topLosers);
        data.active = cleanItems(data.active);
        
        const renderCards = (items) => {
            if (!items || items.length === 0) return `<p class="text-xs text-slate-500">No data</p>`;
            return items.map(item => window.renderStockRow(item)).join('');
        };

        const hasData = data.topGainers.length > 0 || data.topLosers.length > 0 || data.active.length > 0;

        if (!hasData) {
            dash.innerHTML = `
                <div class="w-full flex flex-col items-center justify-center py-20 text-center stagger-enter">
                    <div class="w-16 h-16 rounded-full bg-blue-500/10 flex items-center justify-center mb-6 border border-blue-500/20">
                        <svg class="w-8 h-8 text-blue-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <h3 class="text-xl font-display font-bold text-white mb-2">Live Status: Link Established</h3>
                    <p class="text-slate-500 max-w-md mx-auto text-sm leading-relaxed">The terminal has bridged to the GSE data engine, but no active trading records were found for the current session. The engine may be performing its initial seed scrape.</p>
                </div>
            `;
        } else {
            const refreshedAt = data.lastUpdated
                ? new Date(data.lastUpdated).toLocaleDateString('en-GH', {
                    day: 'numeric', month: 'short', year: 'numeric'
                })
                : '—';

            // Fetch daily briefing in parallel — renders into the
            // placeholder once it arrives, doesn't block the dashboard.
            // Module-scope cache short-circuits re-renders triggered by
            // navigation back to the dashboard (stock detail, settings,
            // tab return). cache:bust clears it via invalidateBriefingRender.
            const briefingHTML = _briefingHTMLCache !== null ? _briefingHTMLCache : await (async () => {
                try {
                    // Routed through the session cache (see util/briefing-cache.js).
                    // Tab-return or navigation back to the landing doesn't
                    // re-fire the request within the 10-minute TTL; upload
                    // events bust the cache so fresh briefings surface fast.
                    //
                    // Portfolio fetch runs in parallel so the "Your
                    // Portfolio Today" card lands in the same paint as
                    // the briefing summary. Guests skip the call entirely;
                    // a failed fetch falls back to an empty card (which
                    // just collapses back to the full-width briefing).
                    // History powers the 30-day equity sparkline; a
                    // failure there still lets the stat card render (just
                    // without the chart). Failures are logged to
                    // console.debug so a blank sparkline is diagnosable
                    // without a trip to the network tab.
                    const fetchJSON = (url) => fetch(url).then(r => {
                        if (!r.ok) { console.debug('[portfolio-card]', url, 'returned', r.status); return null; }
                        return r.json();
                    }).catch(err => { console.debug('[portfolio-card]', url, 'failed', err); return null; });
                    // History is deduped across the briefing card and
                    // the big equity chart via portfolio-history-cache
                    // — a concurrent fetch from the chart shares this
                    // same promise instead of firing a second request.
                    const historyPromise = window.isUserAuthenticated
                        ? getPortfolioHistory('all').catch(err => { console.debug('[portfolio-card] history failed', err); return null; })
                        : Promise.resolve(null);
                    const [briefing, portfolio, history, sectors] = await Promise.all([
                        getBriefing(),
                        window.isUserAuthenticated ? fetchJSON('/v1/me/portfolio') : Promise.resolve(null),
                        historyPromise,
                        fetchJSON('/v1/market-sectors/overview'),
                    ]);
                    if (window.isUserAuthenticated) {
                        console.debug('[portfolio-card] history points:', history?.points?.length ?? '—', 'window:', history?.window ?? '—');
                    }
                    if (!briefing || !briefing.summary) return '';

                    const portfolioCardHTML = renderPortfolioBriefingCard(portfolio, history);

                    // Per-symbol insight cards. The placeholder branch is
                    // gone — RSI/signal/SMA20 are deterministic and present
                    // even when the briefing's lastPrice is 0 (zero-volume
                    // bucket), so the cards always have meaningful content.
                    // The price chip falls back to SMA20 with a "20d" tag
                    // when the last close is unavailable.
                    const parsedInsights = (briefing.insights || []).map(raw => {
                        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
                        catch { return null; }
                    }).filter(Boolean);
                    const insightCards = parsedInsights.map(ins => {
                        const signal = (ins.signal || 'Neutral').toLowerCase();
                        const signalLabel = signal.charAt(0).toUpperCase() + signal.slice(1);
                        const signalCls = signal.includes('bullish') || signal.includes('bull')
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : signal.includes('bearish') || signal.includes('bear')
                            ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                            : 'bg-slate-500/10 text-slate-400 border-white/5';
                        const lastPrice = Number(ins.lastPrice);
                        const sma20 = Number(ins.sma20) || 0;
                        const sma50 = Number(ins.sma50) || 0;
                        const displayPrice = lastPrice > 0 ? lastPrice : (sma20 > 0 ? sma20 : sma50);
                        const priceChip = lastPrice > 0
                            ? `¢${lastPrice.toFixed(2)}`
                            : `¢${displayPrice.toFixed(2)} <span class="text-slate-600 text-[9px]">·20d</span>`;
                        return `
                        <div data-stock-row-symbol="${window.escapeHTML(ins.symbol)}" class="glass-card rounded-xl p-4 cursor-pointer hover:bg-white/[0.04] group" style="animation:none;opacity:1;">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-sm font-bold font-display text-slate-200">${window.escapeHTML(ins.symbol)}</span>
                                <span class="px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest border shrink-0 ${signalCls}">${window.escapeHTML(signalLabel)}</span>
                            </div>
                            <div class="flex items-center gap-4 text-[10px] text-slate-500 mb-3">
                                <span>${priceChip}</span>
                                <span>RSI ${Number(ins.rsi).toFixed(1)}</span>
                                <span>Conf ${computeClientConfidence(ins)}%</span>
                            </div>
                            <p class="text-[11px] text-slate-400 leading-relaxed line-clamp-3">${window.escapeHTML(composeInsightAnalysis(ins))}</p>
                        </div>`;
                    }).join('');

                    // Format the ISO trading date (YYYY-MM-DD) as
                    // "Mon D, YYYY" for the briefing header. Parse the
                    // components manually instead of `new Date(iso)` so
                    // the UTC-midnight interpretation doesn't bump the
                    // display back a day for western timezones.
                    const fmtBriefingDate = (iso) => {
                        if (!iso || typeof iso !== 'string') return '';
                        const parts = iso.split('-');
                        if (parts.length !== 3) return iso;
                        const [y, m, d] = parts.map(Number);
                        if (!y || !m || !d) return iso;
                        return new Date(y, m - 1, d).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                        });
                    };

                    // Summary + portfolio card pairing. The card is
                    // mobile-only — on lg+ the main dashboard already
                    // renders the full equity-curve chart, so the
                    // briefing card would duplicate it. Card column gets
                    // `lg:hidden` and the summary stretches to all 5
                    // columns on desktop.
                    const briefingRow = portfolioCardHTML
                        ? `<div class="market-briefing__row grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
                               <div class="lg:hidden">${portfolioCardHTML}</div>
                               <div class="lg:col-span-5 market-briefing__card glass-card rounded-2xl p-5 border-amber-500/10">
                                   <p class="market-briefing__summary text-sm text-slate-300 leading-relaxed font-light">${window.escapeHTML(briefing.summary)}</p>
                               </div>
                           </div>`
                        : `<div class="market-briefing__card glass-card rounded-2xl p-5 mb-6 border-amber-500/10">
                               <p class="market-briefing__summary text-sm text-slate-300 leading-relaxed font-light">${window.escapeHTML(briefing.summary)}</p>
                           </div>`;

                    // Deterministic blocks — sector heatmap (primary)
                    // and the RSI extremes board. Render above the
                    // insight cards so the page is meaningful even when
                    // the briefing is empty or stale.
                    const heatmapHTML     = renderSectorHeatmap(sectors);
                    const rsiExtremesHTML = renderRSIExtremes(parsedInsights);

                    const renderedHTML = `
                    <!-- Sector heatmap leads — sits above Today's Briefing
                         so the macro "where money rotated" read anchors the
                         dashboard before the per-symbol prose. -->
                    <div class="stagger-enter stagger-1">
                        ${heatmapHTML}
                    </div>
                    <!-- Daily Market Briefing -->
                    <div class="stagger-enter stagger-1 market-briefing">
                        <div class="market-section-header flex items-center gap-2 mb-4">
                            <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
                            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Today's Briefing</h3>
                            <span class="text-[10px] text-slate-500 ml-auto mono">${window.escapeHTML(fmtBriefingDate(briefing.tradingDate))}</span>
                        </div>
                        ${briefingRow}
                        ${rsiExtremesHTML}
                        ${insightCards ? `
                        <div class="market-section-header flex items-center gap-2 mb-3" style="animation:none;opacity:1;">
                            <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
                            <h4 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Stock Insights</h4>
                        </div>
                        <div class="market-insights-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" style="animation:none;opacity:1;">
                            ${insightCards}
                        </div>` : ''}
                    </div>`;
                    _briefingHTMLCache = renderedHTML;
                    return renderedHTML;
                } catch { return ''; }
            })();

            // Full-size portfolio equity chart above Today's Briefing —
            // desktop + authenticated only. The sparkline inside the
            // briefing row still renders for small screens / quick
            // glance. Host div is emitted unconditionally above;
            // showPortfolioEquityChart is called only when gated.
            const isDesktop = window.matchMedia('(min-width: 1024px)').matches;
            const showBigPortfolioChart = !!window.isUserAuthenticated && isDesktop;
            const portfolioChartHTML = showBigPortfolioChart
                ? `<div id="portfolio-equity-section-host" class="stagger-enter stagger-1"></div>`
                : '';

            dash.innerHTML = `
                <div class="w-full max-w-6xl space-y-8 pb-10 market-dashboard">
                    <!-- Dashboard topbar — mono dateline, echoes the stock-detail topbar -->

                    ${portfolioChartHTML}

                    ${briefingHTML}

                    ${!briefingHTML ? `
                    <!-- Fallback: Most Active -->
                    <div class="stagger-enter stagger-2 market-section" data-market-section="active">
                        <div class="market-section-header flex items-center gap-2 mb-4">
                            <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
                            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Most Active</h3>
                        </div>
                        <div class="market-stock-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            ${renderCards(data.active)}
                        </div>
                    </div>

                    <!-- Fallback: Top Gainers -->
                    <div class="stagger-enter stagger-3 market-section" data-market-section="gainers">
                        <div class="market-section-header flex items-center gap-2 mb-4">
                            <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
                            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Top Gainers</h3>
                        </div>
                        <div class="market-stock-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            ${renderCards(data.topGainers)}
                        </div>
                    </div>

                    <!-- Fallback: Top Losers -->
                    <div class="stagger-enter stagger-4 market-section" data-market-section="losers">
                        <div class="market-section-header flex items-center gap-2 mb-4">
                            <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
                            <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Top Losers</h3>
                        </div>
                        <div class="market-stock-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            ${renderCards(data.topLosers)}
                        </div>
                    </div>
                    ` : ''}
                </div>
            `;

            // Mount the portfolio sparkline AFTER the dashboard HTML is
            // committed — ApexCharts needs a live DOM node. No-op when
            // the placeholder wasn't rendered (guest, empty portfolio,
            // or history fetch yielded <2 points).
            mountPortfolioSparkline();

            // Mount the full-size portfolio equity chart above the
            // briefing when the gating conditions matched above. The
            // chart module handles its own fetch, skeleton, and
            // destroy/recreate on range + mode clicks.
            if (showBigPortfolioChart) {
                showPortfolioEquityChart('portfolio-equity-section-host');
            }
        }

        window.setConnectionState(false);
        // Initialize the sidebar pulse panel with 'movers' by default once data is bridging
        window.switchMarketPulse('movers');
    } catch (e) {
        if (window.isAbortError && window.isAbortError(e)) return;
        console.debug('[fetchMarketSummary]', e);
        window.setConnectionState(true);
    }
}

// renderStockRow is shared across market-overview, movers, and watchlist.
// opts.showAlertBtn=true adds a bell button that opens the alert-rules
// modal prefilled with this symbol — wired only for the watchlist caller
// so movers rows don't grow a second action column. The bell carries its
// own data-action so handleStockRowTap (see app.js) defers the click to
// the delegated dispatcher instead of navigating to the symbol.
window.renderStockRow = function(item, opts) {
    opts = opts || {};
    const isUp = item.percentChange >= 0;
    const c = twColor(isUp ? 'emerald' : 'rose');
    const sign = isUp ? '+' : '';
    const fmtPrice = (p) => p >= 100 ? `¢${Math.round(p)}` : `¢${p.toFixed(2)}`;

    // Bell button — small, outlined, amber-on-hover. Placed outside the
    // right-aligned price stack so the price/delta alignment of existing
    // rows is unchanged (kept visually identical for non-authenticated /
    // non-watchlist contexts). Opens the existing modal via the global
    // dispatcher — no new action handler needed.
    const bellBtn = opts.showAlertBtn ? `
        <button data-action="open-alert-rules-modal" data-symbol="${window.escapeHTML(item.symbol)}"
                class="ml-2 p-1.5 text-slate-500 hover:text-amber-400 transition-colors rounded-full hover:bg-amber-500/10 shrink-0"
                title="Set an alert for ${window.escapeHTML(item.symbol)}" aria-label="Set alert for ${window.escapeHTML(item.symbol)}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path>
            </svg>
        </button>` : '';

    const sym = window.escapeHTML(item.symbol);
    return `
    <div data-stock-row-symbol="${sym}"
         class="glass-card rounded-xl p-3 flex items-center justify-between cursor-pointer transition-all hover:scale-[1.01] hover:bg-white/[0.06] group stagger-enter">
        <div>
            <p class="text-sm font-bold font-display text-slate-200 group-hover:text-blue-400 transition-colors light:text-slate-800">${sym}</p>
            <p data-tick-symbol="${sym}" data-tick-cell="volume" class="text-[10px] text-slate-500 font-black uppercase tracking-widest mt-0.5 opacity-80 light:text-slate-400">${(item.volume / 1000).toFixed(1)}k Vol</p>
        </div>
        <div class="flex items-center">
            <div class="text-right">
                <p data-tick-symbol="${sym}" data-tick-cell="price" class="text-xs font-bold text-white/90 light:text-slate-700">${fmtPrice(item.lastPrice)}</p>
                <p data-tick-symbol="${sym}" data-tick-cell="change" class="text-[10px] font-black ${c.text500} light:${c.text600}"><span class="sr-only">${isUp ? 'Up' : 'Down'}</span>${sign}${item.percentChange.toFixed(2)}%</p>
            </div>
            ${bellBtn}
        </div>
    </div>`;
}
// Sector views moved to ./charts/sectors.js


window.switchMarketPulse = function(type, btn) {
    const itemsCont = document.getElementById('market-pulse-items');
    const titleEl = document.getElementById('pulse-title');
    const indicator = document.getElementById('pulse-indicator');
    
    // UI Containers
    const sectorsDashboard = document.getElementById('market-sectors-dashboard');
    const overviewDashboard = document.getElementById('market-overview-dashboard');
    const chartMain = document.getElementById('chart-main');

    if (!itemsCont || !window.MARKET_SUMMARY_DATA) return;

    // Update Tab UI
    if (btn) {
        document.querySelectorAll('.pulse-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    let items = [];
    let title = "Movers";
    let color = "fuchsia";

    // Toggle Sector View vs Overview View
    const priceSummary = document.getElementById('price-summary');
    if (type === 'sectors') {
        if (sectorsDashboard) sectorsDashboard.classList.remove('hidden');
        if (overviewDashboard) overviewDashboard.classList.add('hidden');
        if (chartMain) chartMain.classList.add('hidden'); // Sector view overrides chart temporarily
        // Populate the dateline from the market summary's lastUpdated so
        // it matches the date shown on the home Market Pulse topbar.
        const sectorDate = document.getElementById('sector-topbar-date');
        if (sectorDate) {
            const summaryData = window.MARKET_SUMMARY_DATA;
            const srcDate = summaryData?.lastUpdated
                ? new Date(summaryData.lastUpdated)
                : new Date();
            sectorDate.textContent = srcDate.toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
        }
        // Hide the per-stock price header — it doesn't apply to the aggregate view.
        if (priceSummary) priceSummary.classList.add('hidden');
        // Swap the right rail to GSE Market News if it isn't already there.
        const sidebarContent = document.getElementById('sidebar-content');
        const sidebarPlaceholder = document.getElementById('sidebar-placeholder');
        if (sidebarContent && sidebarPlaceholder && sidebarPlaceholder.classList.contains('hidden')) {
            sidebarContent.classList.add('hidden');
            sidebarPlaceholder.classList.remove('hidden');
            if (typeof window.fetchMarketNews === 'function') window.fetchMarketNews();
        }

        // Sector view is aggregate — hide stock-specific left panels
        document.getElementById('left-stock-panels')?.classList.add('hidden');

        window.fetchMarketSectors();
        title = "Sectors";
        color = "amber";
        // Sidebar will hydrate via window.renderSectorPulse in fetchMarketSectors
    } else {
        if (sectorsDashboard) sectorsDashboard.classList.add('hidden');
        // Restore the price header if a stock is currently loaded.
        const symbolInputForHeader = document.getElementById('symbol-search');
        if (priceSummary && symbolInputForHeader && symbolInputForHeader.value) {
            priceSummary.classList.remove('hidden');
        }
        // If we are NOT in search mode, show overview. If we ARE, show chart.
        const symbolInput = document.getElementById('symbol-search');
        if (symbolInput && symbolInput.value) {
            if (chartMain) chartMain.classList.remove('hidden');
            // Restore stock-specific left panels when returning from sectors
            document.getElementById('left-stock-panels')?.classList.remove('hidden');
        } else {
            if (overviewDashboard) overviewDashboard.classList.remove('hidden');
        }

        switch(type) {
            case 'gainers':
                items = window.MARKET_SUMMARY_DATA.topGainers || [];
                title = "Gainers";
                color = "emerald";
                break;
            case 'losers':
                items = window.MARKET_SUMMARY_DATA.topLosers || [];
                title = "Losers";
                color = "rose";
                break;
            case 'active':
                items = window.MARKET_SUMMARY_DATA.active || [];
                title = "Active";
                color = "blue";
                break;
            default: // movers
                const all = [...(window.MARKET_SUMMARY_DATA.topGainers||[]), ...(window.MARKET_SUMMARY_DATA.topLosers||[])];
                all.sort((a,b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
                const seen = new Set();
                const distinctMovers = [];
                for (let m of all) {
                    if(!seen.has(m.symbol) && distinctMovers.length < 5) {
                        distinctMovers.push(m);
                        seen.add(m.symbol);
                    }
                }
                items = distinctMovers;
                title = "Movers";
                color = "fuchsia";
        }
    }

    titleEl.innerText = title;
    indicator.className = `w-1 h-3 rounded-full ${twColor(color).indicator}`;

    if (type !== 'sectors') {
        if (items.length === 0) {
            itemsCont.innerHTML = `<p class="text-[10px] text-slate-500 text-center py-4">No data available</p>`;
            return;
        }

        // Deduplicate items
        const dedupSeen = new Set();
        const deduped = [];
        for (let item of items) {
            if (item.symbol && !dedupSeen.has(item.symbol) && item.lastPrice > 0) {
                dedupSeen.add(item.symbol);
                deduped.push(item);
            }
        }
        itemsCont.innerHTML = deduped.slice(0, 5).map(item => window.renderStockRow(item)).join('');
    }
    
    // Only show movers panel when no stock is selected
    if (!window.currentSymbol) {
        document.getElementById('market-pulse-panel').classList.remove('hidden');
    }
};

// Mobile tab state moved to ./ui/tabs.js
// Toast system moved to ./ui/toast.js
// timeAgo moved to ./util/time.js
// fetchMarketNews moved to ../features/news.js (colocated with fetchNews).


// Uses window.GHANA_HOLIDAYS defined at the top of this file

// WebSocket + auto-refresh moved to ./live/socket.js


window.userWatchlist = new Set();

window.toggleWatchlist = async function(symbol) {
    if (!symbol) return;
    if (!window.isUserAuthenticated) {
        window.showToast('Uplink Required. Please log in to pin securities to your terminal.', 'error');
        return;
    }
    try {
        const res = await fetch(`/v1/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            if (data.isWatchlisted) {
                window.userWatchlist.add(symbol);
            } else {
                window.userWatchlist.delete(symbol);
            }
            window.showToast(data.isWatchlisted ? `${symbol} pinned to terminal` : `${symbol} removed from watchlist`, 'success');
            window.updateWatchlistUI(symbol);
            window.fetchWatchlistPanel(); // refresh sidebar
            window.setConnectionState(false);
        } else if (res.status === 401) {
            window.isUserAuthenticated = false;
            window.showToast('Session expired. Please log in again.', 'error');
        }
    } catch(e) {
        window.setConnectionState(true);
    }
}

window.updateWatchlistUI = function(symbol) {
    if (window.currentSymbol !== symbol) return;
    // Price summary renders twice (desktop + mobile); both stars carry
    // `data-watchlist-star` — update every match instead of fighting
    // duplicate IDs.
    const stars = document.querySelectorAll('[data-watchlist-star]');
    const isWatched = window.userWatchlist.has(symbol);
    for (const starBtn of stars) {
        if (isWatched) {
            starBtn.classList.add('text-amber-400');
            starBtn.classList.remove('text-slate-500');
        } else {
            starBtn.classList.remove('text-amber-400');
            starBtn.classList.add('text-slate-500');
        }
        const svg = starBtn.querySelector('svg');
        if (svg) svg.setAttribute('fill', isWatched ? 'currentColor' : 'none');
    }
};

window.fetchWatchlistPanel = async function() {
    if (!window.isUserAuthenticated) {
        document.getElementById('watchlist-panel').classList.add('hidden');
        // Standalone watchlist-locked card stays hidden — see merged
        // sign-in CTA in features/portfolio.js.
        document.getElementById('watchlist-locked').classList.add('hidden');
        return;
    }
    try {
        const res = await fetch('/v1/watchlist');
        if (res.ok) {
            const data = await res.json();
            window.userWatchlist = new Set(data.symbols || []);

            if (window.currentSymbol) {
                window.updateWatchlistUI(window.currentSymbol);
            }

            const panel = document.getElementById('watchlist-panel');
            const listEl = document.getElementById('watchlist-items');
            if (!data.details || data.details.length === 0) {
                panel.classList.remove('hidden');
                listEl.innerHTML = `<p class="text-[10px] text-slate-500 italic text-center py-4">⭐ Star a stock to track it here</p>`;
            } else {
                panel.classList.remove('hidden');
                // Watchlist rows expose the bell button so users can create
                // a price/RSI alert for any starred symbol in one tap. The
                // movers + market-overview renderers below keep the plain
                // row — alerts are a watchlist-anchored concept. The bell
                // is Pro/Admin-only, mirroring the RequireProOrAdmin gate
                // on /v1/me/alerts* so a basic-tier user doesn't see an
                // action that would 403.
                const canAlert = window.userRole === 'admin' || window.userRole === 'pro';
                listEl.innerHTML = data.details.map(item => window.renderStockRow(item, { showAlertBtn: canAlert })).join('');
            }
            window.setConnectionState(false);
        }
    } catch(e) {
        window.setConnectionState(true);
    }
}

// ── Symbol Autocomplete Dropdown ────────────────────────────────────────────
// Symbol autocomplete dropdown moved to ./ui/search.js

// Clear the currently selected stock and return to the default
// "main page" view (market overview, no symbol) without triggering
// a full page reload. Wired to the Home chip in the mobile section nav.
window.clearSelectedStock = function(event) {
    if (!window.currentSymbol) return; // already on home — let anchor scroll
    if (event) event.preventDefault();

    // 1. URL + persistence
    try { localStorage.removeItem('gse:lastSymbol'); } catch (e) { console.debug('[storage]', e); }
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('symbol');
        url.hash = '';
        window.history.replaceState({}, '', url.pathname + url.search);
    } catch (e) { console.debug('[nav] clearStock URL:', e); }

    // 2. Reset in-memory state
    window.currentSymbol = null;
    window.compareState = null;
    window._chartBasePrice = null;
    // Leaving the stock view — drop the empty-state CSS flag so the
    // dashboard's own sections aren't suppressed by the rules keyed on
    // body[data-stock-state="empty"].
    delete document.body.dataset.stockState;

    // 3. Tear down the chart
    if (window.chart) {
        try { window.chart.destroy(); } catch (e) { console.debug("[chart] cleanup:", e); }
        window.chart = null;
    }

    // 4. Reset DOM visibility — inverse of fetchHistory
    const byId = (id) => document.getElementById(id);
    byId('chart-main')?.classList.add('hidden');
    byId('price-summary')?.classList.add('hidden');
    byId('comparables-widget')?.classList.add('hidden');
    byId('market-overview-dashboard')?.classList.remove('hidden');
    byId('sidebar-content')?.classList.add('hidden');
    const sidebarPlaceholder = byId('sidebar-placeholder');
    if (sidebarPlaceholder) {
        sidebarPlaceholder.classList.remove('hidden');
        sidebarPlaceholder.querySelectorAll('.animate-in').forEach(el => {
            el.style.animation = 'none';
            void el.offsetWidth;
            el.style.animation = '';
        });
    }
    // Restore movers + watchlist + portfolio, hide stock-specific left panels
    byId('left-stock-panels')?.classList.add('hidden');
    const pulsePanel = byId('market-pulse-panel');
    const watchlistContainer = byId('watchlist-panel-container');
    const portfolioPanel = byId('portfolio-panel');
    if (pulsePanel) pulsePanel.classList.remove('hidden');
    if (watchlistContainer) watchlistContainer.classList.remove('hidden');
    // Re-show the full portfolio panel; initPortfolio will have already
    // rendered it with the user's holdings on page load.
    if (portfolioPanel && window.isUserAuthenticated) portfolioPanel.classList.remove('hidden');
    // Re-trigger entry animations on restored panels
    [pulsePanel, watchlistContainer].forEach(panel => {
        if (!panel) return;
        panel.querySelectorAll('.animate-in').forEach(el => {
            el.style.animation = 'none';
            void el.offsetWidth;
            el.style.animation = '';
        });
    });
    delete document.body.dataset.view;
    delete document.body.dataset.stockTab;
    if (typeof window._syncTabState === 'function') window._syncTabState();

    // Clear the search input so the search field reflects the empty state
    const inp = byId('symbol-search');
    if (inp) inp.value = '';

    // No refetch on return: the home dashboard was just hidden via
    // classList while the user was on a stock view, and its rows have
    // been getting live tick updates in place via applyTickToRows the
    // whole time (querySelectorAll matches hidden elements too). The
    // rendered cards are already up to date, so /v1/market-summary +
    // /v1/me/portfolio do not need to fire again.
};

