// Portfolio equity curve — large-format chart that mirrors the single-
// stock chart UX (area curve, range pills, tooltip) but for the
// reconstructed portfolio value series returned by
// GET /v1/me/portfolio/history. Rendered inside the Positions view
// (see features/portfolio.js showPositionsView), one instance at a
// time. All chart state is module-local; the data-action dispatcher
// in app.js routes range-pill and mode-pill clicks back through
// window.updatePortfolioChartRange / window.setPortfolioChartMode.
//
// Modes:
//   value       — area curve of raw ¢ portfolio value
//   performance — bar chart of period-over-period P&L within the
//                 selected window (daily bars for ranges ≤ 1Y,
//                 monthly bars for 5Y/MAX so the axis stays readable)

import { escapeHTML } from '../util/escape.js';
import { getPortfolioHistory } from '../util/portfolio-history-cache.js';

// Module-local state. Only one instance is alive at a time (the
// positions view creates it, the back button destroys it), so keeping
// these on the module rather than window is both safer and tidier.
let _chart = null;
let _series = [];        // full series as [{x: ms, y: value}]
let _rangeBase = 0;      // first y in currently-visible window; powers header stats
let _currentRange = 'YTD';
let _mode = 'performance';     // 'value' | 'performance'
let _isProgrammaticZoom = false;
// When the user drags a custom zoom on the chart, we stash the zoom
// bounds here so the series can rebuild against them (and rebase to
// 0% on the first visible day, just like a preset-range click).
// Cleared on every preset-range click and on mode switch.
let _zoomBounds = null;        // {minX, maxX} | null

const CHART_ID = 'portfolio-equity-chart-id';
const EMERALD = '#10b981';
const ROSE    = '#f43f5e';

// One-line caption under the VALUE/PERFORMANCE toggle explaining what
// each mode actually measures. Kept module-scope so both the initial
// shell render (buildShell) and the runtime mode switch
// (setPortfolioChartMode) can call it.
function modeCaption(mode) {
    return mode === 'performance'
        ? 'Return on invested capital'
        : 'Raw portfolio value in ¢';
}

function fmtGHS(v) {
    return `¢${Number(v).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(v) {
    const sign = v >= 0 ? '+' : '';
    return `${sign}${Number(v).toFixed(2)}%`;
}
function fmtDate(ms) {
    return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtMonth(ms) {
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ── Public API ────────────────────────────────────────────────────────

// Called by features/portfolio.js showPositionsView after it writes
// the container's innerHTML. Fetches the full-range history once,
// renders the chart, and applies the default YTD zoom.
export async function showPortfolioEquityChart(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Reset state on every open so a subsequent view doesn't inherit
    // the last-session mode/range from module-local state.
    _mode = 'performance';
    _currentRange = 'YTD';

    container.innerHTML = buildSkeleton();

    if (typeof window.ApexCharts === 'undefined') {
        // No chart library → hide the whole section, don't show an error
        // where a chart would normally be; keeps the dashboard clean.
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }

    let resp;
    try {
        // Shared with the briefing-card sparkline via
        // portfolio-history-cache — concurrent dashboard fetches
        // collapse to one round-trip, follow-up opens hit the cache.
        resp = await getPortfolioHistory('all');
    } catch (e) {
        // Non-2xx (incl. 401 for guests, 500 for handler errors) or
        // a network blip → hide the section rather than show an
        // error card; the chart is optional UX and a missing chart
        // shouldn't pollute the dashboard for users without a
        // portfolio.
        console.debug('[portfolio-equity] fetch failed', e);
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }

    const points = Array.isArray(resp?.points) ? resp.points : [];
    if (points.length < 2) {
        // No portfolio (or single data point) → hide the section so
        // only users with an actual portfolio see the chart.
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    // Real portfolio data — make sure the section is visible on
    // re-mount (it may have been hidden on a prior empty load).
    container.classList.remove('hidden');

    // Carry value + cashflow per point. Cashflow is the market value
    // of newly-added holdings on that date (qty × close_d for
    // purchases, plus OHLC-transition deltas) — exactly what
    // returnSeries needs to strip contributions out of each daily
    // return. `cost` was dropped from the payload when we switched to
    // the money-weighted return; nothing on the client reads it.
    _series = points.map(p => ({
        x: new Date(p.date).getTime(),
        y: Number(p.value) || 0,
        cashflow: Number(p.cashflow) || 0,
    }));
    container.innerHTML = buildShell();

    const host = document.getElementById('portfolio-equity-chart');
    if (!host) return;

    if (_chart) {
        try { _chart.destroy(); } catch {}
        _chart = null;
    }

    // Single render path: updatePortfolioChartRange builds + renders
    // the chart with the default YTD window. The earlier code did an
    // initial new + render here and then immediately destroyed it in
    // updatePortfolioChartRange — two full ApexCharts lifecycles per
    // open for identical output. One pass is enough.
    updatePortfolioChartRange('YTD');
}

// Called when the user leaves the positions view so we don't leak the
// ApexCharts instance (and so a subsequent open rebuilds fresh).
export function destroyPortfolioEquityChart() {
    if (_chart) {
        try { _chart.destroy(); } catch {}
    }
    _chart = null;
    _series = [];
    _rangeBase = 0;
    _currentRange = 'YTD';
    _mode = 'performance';
    _zoomBounds = null;
}

// rebuildChart destroys the live ApexCharts instance and re-creates it
// from scratch using the current bounds (preset range or custom zoom).
// Shared path for range-pill clicks, mode switches, and drag-zooms so
// every state change goes through the same lifecycle.
function rebuildChart() {
    const host = document.getElementById('portfolio-equity-chart');
    if (!host) return;
    if (_chart) {
        try { _chart.destroy(); } catch {}
        _chart = null;
    }
    _chart = new window.ApexCharts(host, buildOptions());
    _chart.render();
}

// Invoked by the data-action dispatcher (app.js) on range-pill clicks.
// We destroy + recreate the chart instead of juggling updateSeries /
// zoomX in place because performance mode uses two overlaid series
// (positive + negative halves split at y=0); ApexCharts' auto-scale
// and zoomX fight each other when the series is swapped under it,
// which manifests as "clicking a range doesn't change the chart."
// Rebuild is cheap (sub-300ms) and keeps the two modes on one path.
function updatePortfolioChartRange(range) {
    _currentRange = range;
    // Clicking a preset range pill clears any active drag-zoom so the
    // pill click is the unambiguous "new window" signal.
    _zoomBounds = null;

    const btnContainer = document.getElementById('portfolio-range-group');
    if (btnContainer) {
        btnContainer.querySelectorAll('.range-btn').forEach(b => {
            const match = b.getAttribute('data-range') === range;
            b.classList.toggle('active', match);
            b.setAttribute('aria-checked', match ? 'true' : 'false');
        });
    }
    if (_series.length === 0) return;

    const { minX, maxX } = computeBounds(range);
    updateHeaderStats(minX, maxX);

    const host = document.getElementById('portfolio-equity-chart');
    if (!host) return;
    if (_chart) {
        try { _chart.destroy(); } catch {}
        _chart = null;
    }
    _chart = new window.ApexCharts(host, buildOptions());
    _chart.render();
}

window.updatePortfolioChartRange = updatePortfolioChartRange;

// Invoked by the dispatcher when the user clicks the VALUE /
// PERFORMANCE segmented control. Destroy + recreate the chart because
// ApexCharts changing chart.type mid-lifecycle via updateOptions is
// unreliable — a clean rebuild is safer than coaxing area→bar in
// place.
function setPortfolioChartMode(mode) {
    if (mode !== 'value' && mode !== 'performance') return;
    if (mode === _mode) return;
    _mode = mode;
    // Mode switch reverts to whatever preset range was last active.
    _zoomBounds = null;

    const group = document.getElementById('portfolio-mode-group');
    if (group) {
        group.querySelectorAll('.range-btn').forEach(b => {
            const match = b.getAttribute('data-mode') === mode;
            b.classList.toggle('active', match);
            b.setAttribute('aria-checked', match ? 'true' : 'false');
        });
    }
    const captionEl = document.getElementById('portfolio-mode-caption');
    if (captionEl) captionEl.textContent = modeCaption(mode);

    const host = document.getElementById('portfolio-equity-chart');
    if (!host || _series.length === 0) return;

    if (_chart) {
        try { _chart.destroy(); } catch {}
        _chart = null;
    }
    _chart = new window.ApexCharts(host, buildOptions());
    _chart.render().then(() => updatePortfolioChartRange(_currentRange));
}

window.setPortfolioChartMode = setPortfolioChartMode;

// ── Range → bounds ─────────────────────────────────────────────────────

// currentBounds returns the active x-range for the chart. Prefers a
// custom drag-zoom range over the selected preset pill, so the chart
// rebuilds (and rebases to 0% on performance mode) against whatever
// the user is actually looking at.
function currentBounds() {
    if (_zoomBounds) return _zoomBounds;
    return _series.length ? computeBounds(_currentRange) : { minX: 0, maxX: 0 };
}

function computeBounds(range) {
    const maxX = _series[_series.length - 1].x;
    const maxD = new Date(maxX);
    let minX;
    switch (range) {
        case '7D':  { const d = new Date(maxD); d.setDate(d.getDate() - 7);    minX = d.getTime(); break; }
        case '1M':  { const d = new Date(maxD); d.setMonth(d.getMonth() - 1);  minX = d.getTime(); break; }
        case '3M':  { const d = new Date(maxD); d.setMonth(d.getMonth() - 3);  minX = d.getTime(); break; }
        case '6M':  { const d = new Date(maxD); d.setMonth(d.getMonth() - 6);  minX = d.getTime(); break; }
        case 'YTD': { minX = new Date(maxD.getFullYear(), 0, 1).getTime(); break; }
        case '1Y':  { const d = new Date(maxD); d.setFullYear(d.getFullYear() - 1); minX = d.getTime(); break; }
        case '5Y':  { const d = new Date(maxD); d.setFullYear(d.getFullYear() - 5); minX = d.getTime(); break; }
        case 'MAX':
        default:    { minX = _series[0].x; break; }
    }
    if (minX < _series[0].x) minX = _series[0].x;
    return { minX, maxX };
}

// ── Performance series builder ────────────────────────────────────────

// returnSeries computes the window's cumulative money-weighted simple
// return from raw history points (each carrying x, y=value, cashflow).
// For each day d it's the ratio of market-only gain over total capital
// invested by that day:
//
//     gain_d  = value_d − value_0 − Σ cashflow[1..d]
//     cap_d   = value_0 + Σ cashflow[1..d]
//     y_d     = gain_d / cap_d × 100
//
// First point is 0% by construction (gain_0 = 0). Every subsequent
// point reads as "how much the portfolio has gained as a percentage
// of all money ever put in by day d." Unlike TWR, this stays sign-
// consistent with the ¢ market gain (same numerator), so the
// header's %age and currency never disagree.
//
// Trade-off vs TWR: small early gains don't compound up — they're
// diluted as later contributions grow the denominator. That matches
// user intuition ("I'm up/down on my total investment") better than
// the size-agnostic geometric return for a consumer tracker.
//
// curVal <= 0 is treated as a data gap (every holding missing its
// close that day) and carries forward the prior %age instead of
// spiking to -100%; this schema has no sell/withdraw cashflow so a
// legitimate zero value can't happen.
export function returnSeries(points) {
    if (!points || points.length === 0) return [];
    const v0 = Number(points[0].y) || 0;
    const out = [{ x: points[0].x, y: 0 }];
    let cumCf = 0;
    for (let i = 1; i < points.length; i++) {
        const cur = points[i];
        const curVal = Number(cur.y) || 0;
        cumCf += Number(cur.cashflow) || 0;
        if (curVal <= 0) {
            out.push({ x: cur.x, y: out[out.length - 1].y });
            continue;
        }
        const gain  = curVal - v0 - cumCf;
        const denom = v0 + cumCf;
        const pct   = denom > 0 ? (gain / denom) * 100 : 0;
        out.push({ x: cur.x, y: pct });
    }
    return out;
}

// windowCashflow sums the cashflow over the window, excluding the
// first point (its cashflow is already baked into value_0). Used to
// compute the market-only ¢ gain: value_last − value_first − Σcf.
export function windowCashflow(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += Number(points[i].cashflow) || 0;
    return sum;
}

function performanceSeries(minX, maxX) {
    return returnSeries(_series.filter(p => p.x >= minX && p.x <= maxX));
}

// splitAtZero partitions a cumulative-return curve into two overlaid
// series so ApexCharts can draw the positive portion in emerald and the
// negative portion in rose. The two series share an x-domain; each
// point ends up in exactly one series (with `null` in the other to
// break its line). At every zero-crossing we insert an interpolated
// (x, 0) point into BOTH series so the two lines meet cleanly on the
// baseline — no visible gap, no orphaned segments.
export function splitAtZero(series) {
    const positive = [];
    const negative = [];
    for (let i = 0; i < series.length; i++) {
        const cur = series[i];
        const prev = i > 0 ? series[i - 1] : null;
        // Interpolate zero-crossings between strictly-signed neighbours.
        // If either neighbour is exactly 0 we don't interpolate — the
        // zero value itself already sits on the baseline.
        if (prev && ((prev.y > 0 && cur.y < 0) || (prev.y < 0 && cur.y > 0))) {
            const t = Math.abs(prev.y) / (Math.abs(prev.y) + Math.abs(cur.y));
            const xAtZero = prev.x + (cur.x - prev.x) * t;
            positive.push({ x: xAtZero, y: 0 });
            negative.push({ x: xAtZero, y: 0 });
        }
        if (cur.y > 0) {
            positive.push({ x: cur.x, y: cur.y });
            negative.push({ x: cur.x, y: null });
        } else if (cur.y < 0) {
            positive.push({ x: cur.x, y: null });
            negative.push({ x: cur.x, y: cur.y });
        } else {
            // cur.y === 0 — shared so the line sits exactly on baseline
            // in both series (first point of every window is always 0).
            positive.push({ x: cur.x, y: 0 });
            negative.push({ x: cur.x, y: 0 });
        }
    }
    return { positive, negative };
}

// ── Header stats ───────────────────────────────────────────────────────

// updateHeaderStats re-computes the window-level numbers and paints
// them into the stock-chart-style header layout.
//
//   value mode       — big ¢ value, coloured %, muted ∆
//   performance mode — big TWR %, coloured ∆, "Total return" caption
//
// Both modes also refresh the "Data as of <end>" caption and the
// "<start> – <end>" label on the range-controls row.
function updateHeaderStats(minX, maxX) {
    const filtered = _series.filter(p => p.x >= minX && p.x <= maxX);
    if (filtered.length === 0) return;

    const first = filtered[0];
    const last  = filtered[filtered.length - 1];

    // Value-mode metrics — portfolio-value change across the window.
    const valuePctChange  = first.y !== 0 ? ((last.y - first.y) / first.y) * 100 : 0;
    const valueDiffChange = last.y - first.y;

    // Performance-mode metrics — money-weighted simple return across
    // the window. Same formula as returnSeries so the chart's right
    // edge, the big %age, and the ¢ delta all agree by construction
    // (including in sign):
    //
    //   marketGain   = value_last − value_first − Σ cashflow[1..n]
    //   totalCapital = value_first + Σ cashflow[1..n]
    //   pct          = marketGain / totalCapital × 100
    const twr      = returnSeries(filtered);
    const twrPct   = twr.length > 0 ? twr[twr.length - 1].y : 0;
    const twrDiff  = last.y - first.y - windowCashflow(filtered);

    _rangeBase = first.y;

    // Value mode uses the window's raw-value change; performance
    // mode uses the window's TWR (last point of the curve).
    const valueIsUp = valuePctChange >= 0;
    const valueTone = valueIsUp ? 'text-emerald-400' : 'text-rose-400';
    const valueSign = valueIsUp ? '+' : '';
    const valuePctStr = `${valueSign}${valuePctChange.toFixed(2)}%`;
    const valueAbsStr = `${valueSign}${fmtGHS(Math.abs(valueDiffChange))}`;

    const perfIsUp  = twrPct >= 0;
    const perfTone  = perfIsUp ? 'text-emerald-400' : 'text-rose-400';
    const perfSign  = perfIsUp ? '+' : '';
    const twrPctStr = `${perfSign}${twrPct.toFixed(2)}%`;
    const twrAbsStr = `${twrDiff >= 0 ? '+' : '−'}${fmtGHS(Math.abs(twrDiff))}`;

    const valEl   = document.getElementById('portfolio-chart-value');
    const pctEl   = document.getElementById('portfolio-chart-pct');
    const absEl   = document.getElementById('portfolio-chart-abs');
    const rangeEl = document.getElementById('portfolio-chart-range-label');

    // Header shape per mode:
    //   value       — big ¢ value, coloured window %, coloured window ∆
    //   performance — big window TWR, coloured ¢ equivalent,
    //                 "TOTAL RETURN" caption. Big slot == chart's
    //                 right edge, always.
    if (_mode === 'performance') {
        if (valEl) {
            valEl.textContent = twrPctStr;
            valEl.className = `text-3xl font-display font-bold mono ${perfTone}`;
        }
        if (pctEl) {
            pctEl.textContent = twrAbsStr;
            pctEl.className = `text-base mono font-bold ${perfTone}`;
        }
        if (absEl) {
            absEl.textContent = 'TOTAL RETURN';
            absEl.className = `text-[10px] mono uppercase tracking-[0.22em] text-slate-500`;
        }
    } else {
        if (valEl) {
            valEl.textContent = fmtGHS(last.y);
            valEl.className = `text-3xl font-display font-bold text-slate-100 mono`;
        }
        if (pctEl) {
            pctEl.textContent = valuePctStr;
            pctEl.className = `text-base mono font-bold ${valueTone}`;
        }
        if (absEl) {
            absEl.textContent = valueAbsStr;
            absEl.className = `text-sm mono ${valueTone}`;
        }
    }

    // Date-range pill on the top-right of the header — always shows
    // the window's start → end as ISO dates.
    const fmtCaption = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (rangeEl) rangeEl.textContent = `${fmtCaption(first.x)} – ${fmtCaption(last.x)}`;

    if (_mode === 'value') {
        const stroke = valueIsUp ? EMERALD : ROSE;
        window.ApexCharts.exec(CHART_ID, 'updateOptions', { colors: [stroke] }, false, false);
    }
}

// ── Shell builders ────────────────────────────────────────────────────

function buildSkeleton() {
    return `
        <div class="py-6 flex items-center gap-2">
            <div class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></div>
            <span class="mono text-[10px] uppercase tracking-[0.22em] text-amber-400">Loading equity curve&hellip;</span>
        </div>`;
}

function buildEmptyShell() {
    return `
        <div class="py-12 flex flex-col items-center text-center">
            <p class="mono text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-2">Equity Curve</p>
            <p class="text-sm text-slate-400 max-w-md">Not enough price history yet. Add a holding or wait for the next market session for the curve to populate.</p>
        </div>`;
}

function buildErrorShell(msg) {
    return `
        <div class="py-12 flex flex-col items-center text-center">
            <p class="mono text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-2">Equity Curve</p>
            <p class="text-sm text-rose-400">${escapeHTML(msg)}</p>
        </div>`;
}

// Shell layout (earlier portfolio-specific design the user picked over
// the stock-chart parity variant):
//
//   row 1: "PORTFOLIO EQUITY CURVE" caption (left)
//          "<start date> – <end date>" range label (right)
//   row 2: 3-slot header — big value/%, medium ∆, small caption
//   row 3: range pills (7D·1M·3M·6M·YTD·1Y·5Y·MAX) on the left,
//          mode pills (VALUE·PERFORMANCE) on the right
//   row 4: ApexCharts host
function buildShell() {
    const rangeBtn = (r, active = false) =>
        `<button role="radio" aria-checked="${active ? 'true' : 'false'}" data-action="update-portfolio-chart-range" data-range="${r}" class="range-btn${active ? ' active' : ''}">${r}</button>`;

    const modeBtn = (m, label, active = false) =>
        `<button role="radio" aria-checked="${active ? 'true' : 'false'}" data-action="update-portfolio-chart-mode" data-mode="${m}" class="range-btn${active ? ' active' : ''}">${label}</button>`;

    return `
        <section class="portfolio-equity-section mb-6">
            <div class="flex items-start justify-between mb-2 flex-wrap gap-2">
                <div>
                    <div class="flex items-center gap-2 mb-2">
                        <span class="w-1 h-3 bg-amber-500 rounded-full"></span>
                        <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Portfolio Equity Curve</h3>
                    </div>
                    <div class="flex items-baseline gap-3 flex-wrap">
                        <span id="portfolio-chart-value" class="text-3xl font-display font-bold text-slate-100 mono">—</span>
                        <span id="portfolio-chart-pct" class="text-base mono font-bold text-slate-400">—</span>
                        <span id="portfolio-chart-abs" class="text-sm mono text-slate-500">—</span>
                    </div>
                </div>
                <span id="portfolio-chart-range-label" class="mono text-[10px] text-slate-500 uppercase tracking-[0.22em] mt-1">—</span>
            </div>
            <div class="flex items-center justify-between gap-3 mb-1 flex-wrap">
                <div id="portfolio-range-group" role="radiogroup" aria-label="Equity-curve time range" class="flex flex-wrap gap-2">
                    ${rangeBtn('7D')}${rangeBtn('1M')}${rangeBtn('3M')}${rangeBtn('6M')}${rangeBtn('YTD', true)}${rangeBtn('1Y')}${rangeBtn('5Y')}${rangeBtn('MAX')}
                </div>
                <div class="flex flex-col items-end gap-1">
                    <div id="portfolio-mode-group" role="radiogroup" aria-label="Chart mode" class="flex gap-2">
                        ${modeBtn('performance', 'PERFORMANCE', true)}${modeBtn('value', 'VALUE')}
                    </div>
                    <p id="portfolio-mode-caption" class="text-[10px] text-slate-500 italic">${modeCaption(_mode)}</p>
                </div>
            </div>
            <div class="mb-3"></div>
            <div id="portfolio-equity-chart" class="h-[340px]"></div>
        </section>
    `;
}

// ── ApexCharts options ────────────────────────────────────────────────

// Top-level options builder — branches on _mode so the destroy +
// recreate path in setPortfolioChartMode picks up the correct chart
// type (area vs. bar), initial series, and axis config.
function buildOptions() {
    return _mode === 'performance' ? buildPerformanceOptions() : buildValueOptions();
}

function buildValueOptions() {
    const isDark = document.documentElement.className === 'dark';
    // Scope the data to the current window so the chart renders only
    // [minX, maxX] directly. Pre-destroy-and-recreate we relied on
    // zoomX to trim the view; now the series itself is trimmed so the
    // y-axis auto-scales to what the user actually sees.
    const { minX, maxX } = currentBounds();
    const data = _series.length ? _series.filter(p => p.x >= minX && p.x <= maxX) : [];
    // Pick the stroke colour up-front from the window's direction.
    // Calling updateOptions({colors}) from updateHeaderStats used to
    // race with the destroy-and-recreate path — the repaint landed on
    // the chart we were about to throw away — so the new chart always
    // came up emerald. Deciding here ties colour to the actual data.
    const isUp = data.length > 1 ? data[data.length - 1].y >= data[0].y : true;
    const stroke = isUp ? EMERALD : ROSE;
    return {
        series: [{ name: 'Portfolio Value', data }],
        chart: {
            id: CHART_ID,
            type: 'area',
            height: 340,
            background: 'transparent',
            foreColor: '#64748b',
            toolbar: { show: false },
            animations: {
                enabled: true, easing: 'easeinout', speed: 250,
                animateGradually: { enabled: false },
                dynamicAnimation: { enabled: false },
            },
            zoom: {
                enabled: window.matchMedia('(min-width: 1024px)').matches,
                type: 'x',
                autoScaleYaxis: true,
                allowMouseWheelZoom: false,
            },
            events: {
                zoomed: function (_ctx, { xaxis }) {
                    if (xaxis.min && xaxis.max) {
                        updateHeaderStats(xaxis.min, xaxis.max);
                        if (!_isProgrammaticZoom) {
                            document.querySelectorAll('#portfolio-range-group .range-btn').forEach(b => b.classList.remove('active'));
                            // Stash zoom bounds and rebuild the chart so
                            // performance mode rebases to 0% on the new
                            // first visible day, matching the behaviour
                            // of preset-range pill clicks. rAF defers
                            // the rebuild so we don't destroy the chart
                            // in the middle of ApexCharts' own zoom
                            // event handler.
                            _zoomBounds = { minX: xaxis.min, maxX: xaxis.max };
                            requestAnimationFrame(rebuildChart);
                        }
                        _isProgrammaticZoom = false;
                    }
                },
            },
        },
        colors: [stroke],
        fill: {
            type: 'gradient',
            gradient: { shadeIntensity: 1, opacityFrom: 0.3, opacityTo: 0.05, stops: [0, 90, 100], colorStops: [] },
        },
        stroke: { curve: 'smooth', width: 2.5, lineCap: 'round' },
        markers: { size: 0, hover: { size: 6, sizeOffset: 3, strokeWidth: 2, strokeColor: '#fff' } },
        dataLabels: { enabled: false },
        tooltip: buildValueTooltip(isDark),
        theme: { mode: isDark ? 'dark' : 'light' },
        grid: {
            show: false,
            padding: { left: 10, right: 10 },
        },
        xaxis: {
            type: 'datetime',
            axisBorder: { show: false },
            axisTicks: { show: false },
            tooltip: { enabled: false },
        },
        yaxis: buildYAxis('value'),
        annotations: buildAnnotations('value'),
    };
}

function buildPerformanceOptions() {
    const isDark = document.documentElement.className === 'dark';
    const { minX, maxX } = currentBounds();
    const cum = _series.length ? performanceSeries(minX, maxX) : [];
    // Two overlaid series so segments above 0% render emerald and
    // segments below 0% render rose. Each carries null in the slots
    // the other owns; ApexCharts renders nulls as line breaks.
    const { positive, negative } = splitAtZero(cum);

    return {
        // Negative first so Positive draws on top — at any shared
        // y=0 point (flat windows, exact-zero data points, crossings)
        // emerald wins over rose. Header paints emerald on twrPct=0
        // too; keeping chart and header in sync.
        series: [
            { name: 'Negative', data: negative },
            { name: 'Positive', data: positive },
        ],
        chart: {
            id: CHART_ID,
            type: 'area',
            height: 340,
            background: 'transparent',
            foreColor: '#64748b',
            toolbar: { show: false },
            animations: {
                enabled: true, easing: 'easeinout', speed: 250,
                animateGradually: { enabled: false },
                dynamicAnimation: { enabled: false },
            },
            zoom: {
                enabled: window.matchMedia('(min-width: 1024px)').matches,
                type: 'x',
                autoScaleYaxis: true,
                allowMouseWheelZoom: false,
            },
            events: {
                zoomed: function (_ctx, { xaxis }) {
                    if (xaxis.min && xaxis.max) {
                        updateHeaderStats(xaxis.min, xaxis.max);
                        if (!_isProgrammaticZoom) {
                            document.querySelectorAll('#portfolio-range-group .range-btn').forEach(b => b.classList.remove('active'));
                            // Stash zoom bounds and rebuild the chart so
                            // performance mode rebases to 0% on the new
                            // first visible day, matching the behaviour
                            // of preset-range pill clicks. rAF defers
                            // the rebuild so we don't destroy the chart
                            // in the middle of ApexCharts' own zoom
                            // event handler.
                            _zoomBounds = { minX: xaxis.min, maxX: xaxis.max };
                            requestAnimationFrame(rebuildChart);
                        }
                        _isProgrammaticZoom = false;
                    }
                },
            },
        },
        colors: [ROSE, EMERALD],
        fill: {
            type: 'gradient',
            gradient: { shadeIntensity: 1, opacityFrom: 0.3, opacityTo: 0.05, stops: [0, 90, 100], colorStops: [] },
        },
        // dashArray: 0 on BOTH series (not [0, 0]) and explicit
        // `show` on stroke — ApexCharts occasionally emits a dashed
        // path on leading-null series otherwise.
        stroke: { show: true, curve: 'smooth', width: 2.5, lineCap: 'round', dashArray: 0 },
        forecastDataPoints: { count: 0 },
        // showNullDataPoints:false — the two overlaid series carry
        // null in the slots the other owns, and ApexCharts draws a
        // marker at each null by default (stroked white), which
        // shows up as a row of white dashes along the chart's top
        // edge. Disabling null-point markers removes them.
        markers: { size: 0, showNullDataPoints: false, hover: { size: 6, sizeOffset: 3, strokeWidth: 2, strokeColor: '#fff' } },
        dataLabels: { enabled: false },
        tooltip: buildPerformanceTooltip(isDark),
        theme: { mode: isDark ? 'dark' : 'light' },
        legend: { show: false }, // two internal series aren't user-facing
        grid: {
            show: false,
            padding: { left: 10, right: 10 },
        },
        xaxis: {
            type: 'datetime',
            axisBorder: { show: false },
            axisTicks: { show: false },
            tooltip: { enabled: false },
        },
        yaxis: buildYAxis('performance'),
        annotations: buildAnnotations('performance'),
    };
}

function buildYAxis(mode) {
    const isDark = document.documentElement.className === 'dark';
    if (mode === 'performance') {
        return {
            labels: {
                formatter: v => `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`,
                style: { colors: isDark ? '#475569' : '#334155', fontSize: '10px' },
            },
            title: {
                text: 'Return on investment %',
                style: { color: isDark ? '#64748b' : '#475569', fontSize: '10px', fontWeight: 600 },
            },
        };
    }
    return {
        labels: {
            formatter: v => Number(v).toLocaleString('en-GH', { maximumFractionDigits: 0 }),
            style: { colors: isDark ? '#475569' : '#334155', fontSize: '10px' },
        },
        title: {
            text: '¢',
            style: { color: isDark ? '#64748b' : '#475569', fontSize: '10px', fontWeight: 600 },
        },
    };
}

function buildAnnotations() {
    // No annotations — the 0% baseline + "FLAT · 0%" label have been
    // removed at the user's request. Kept as a function so the
    // options builders can call `annotations: buildAnnotations()`
    // uniformly without branching on mode.
    return { yaxis: [] };
}

// ── Tooltips ─────────────────────────────────────────────────────────

function buildValueTooltip(isDark) {
    return {
        theme: isDark ? 'dark' : 'light',
        x: { format: 'dd MMM yyyy' },
        style: { fontSize: '12px', fontFamily: 'Outfit' },
        marker: { show: false },
        custom: function ({ series, seriesIndex, dataPointIndex, w }) {
            const val = series[seriesIndex][dataPointIndex];
            const ts  = w.globals.seriesX[seriesIndex][dataPointIndex];
            const dateLabel = new Date(ts).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
            const color = w.globals.colors?.[0] || EMERALD;
            // Growth badge tracks the header: value change from the
            // window's first visible day, (val − first.y) / first.y.
            // _rangeBase is set to first.y by updateHeaderStats on
            // every range click / initial render.
            let growthHtml = '';
            if (_rangeBase && _rangeBase > 0) {
                const pct = ((val / _rangeBase) - 1) * 100;
                const sign = pct >= 0 ? '+' : '';
                const cls = pct >= 0 ? 'text-emerald-400' : 'text-rose-400';
                growthHtml = `<span class="text-xs font-bold ${cls}">${sign}${pct.toFixed(2)}%</span>`;
            }
            return `
                <div class="p-3 bg-slate-950/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl">
                    <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">${dateLabel}</p>
                    <div class="grid items-center gap-x-4 gap-y-1 mt-1" style="grid-template-columns: auto auto auto;">
                        <span class="flex items-center gap-2">
                            <span class="inline-block w-2 h-2 rounded-full" style="background:${color}"></span>
                            <span class="text-xs font-bold text-white/80">Value:</span>
                        </span>
                        <span class="text-xs font-bold text-white tabular-nums">${fmtGHS(val)}</span>
                        ${growthHtml || '<span></span>'}
                    </div>
                </div>`;
        },
    };
}

function buildPerformanceTooltip(isDark) {
    return {
        theme: isDark ? 'dark' : 'light',
        x: { format: 'dd MMM yyyy' },
        style: { fontSize: '12px', fontFamily: 'Outfit' },
        marker: { show: false },
        // Two-series performance chart. Whichever series is non-null
        // at the hovered index owns the point; fall back to the
        // sibling for interpolated zero-crossing hits so a tooltip
        // still appears.
        custom: function ({ series, seriesIndex, dataPointIndex, w }) {
            let val = series[seriesIndex]?.[dataPointIndex];
            let ts  = w.globals.seriesX[seriesIndex]?.[dataPointIndex];
            if (val === null || val === undefined) {
                const other = seriesIndex === 0 ? 1 : 0;
                val = series[other]?.[dataPointIndex];
                ts  = w.globals.seriesX[other]?.[dataPointIndex] ?? ts;
            }
            if (val === null || val === undefined) return '';
            const rawPoint = _series.find(p => p.x === ts);
            const rawVal = rawPoint ? rawPoint.y : 0;
            const dateLabel = fmtDate(ts);
            const isUp = val >= 0;
            const cls = isUp ? 'text-emerald-400' : 'text-rose-400';
            const dot = isUp ? EMERALD : ROSE;
            return `
                <div class="p-3 bg-slate-950/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl">
                    <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">${dateLabel}</p>
                    <div class="grid items-center gap-x-4 gap-y-1 mt-1" style="grid-template-columns: auto auto;">
                        <span class="flex items-center gap-2">
                            <span class="inline-block w-2 h-2 rounded-full" style="background:${dot}"></span>
                            <span class="text-xs font-bold text-white/80">Return:</span>
                        </span>
                        <span class="text-sm font-bold tabular-nums ${cls}">${fmtPct(val)}</span>
                    </div>
                    ${rawPoint ? `<p class="text-[10px] text-slate-500 mt-1">${fmtGHS(rawVal)}</p>` : ''}
                </div>`;
        },
    };
}
