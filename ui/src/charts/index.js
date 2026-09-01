// Chart subsystem — single-symbol, compare mode, and fair-value annotation.
// Extracted from app.js; all window.* shims preserved for the dispatcher.

import { twColor } from '../util/tw-colors.js';
import { escapeHTML } from '../util/escape.js';
import { countUp } from '../util/count-up.js';

window.chart = null;
window.currentChartData = [];

window.updateChartRange = function(rangeStr, btnContext) {
    if (btnContext) {
        // Scope to #chart-controls — the stock chart's own pill row.
        // The portfolio equity chart on the home dashboard reuses the
        // .range-btn class for its own pills, so an unscoped selector
        // would wipe its active state too. (Long-standing bug, masked
        // historically by clearSelectedStock refetching the dashboard;
        // exposed once we removed that refetch.)
        document.querySelectorAll('#chart-controls .range-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-checked', 'false');
        });
        btnContext.classList.add('active');
        btnContext.setAttribute('aria-checked', 'true');
    }

    if (!window.chart) return;

    // In compare mode, derive the time axis from the longer of the two
    // series and zoom both at once. The price-stats panel is replaced by the
    // comparison header so we skip updatePriceStats.
    if (window.compareState) {
        // Re-render the comparison so each series is rebased to the start of
        // the newly selected range. zoomX alone wouldn't recompute the % return.
        window.compareState.range = rangeStr;
        renderCompareChart();
        return;
    }

    if (!window.currentChartData || window.currentChartData.length === 0) return;

    const maxDate = window.currentChartData[window.currentChartData.length - 1].x;
    const maxD = new Date(maxDate);
    let minDate;

    switch(rangeStr) {
        case '1M': minDate = new Date(maxD).setMonth(maxD.getMonth() - 1); break;
        case '6M': minDate = new Date(maxD).setMonth(maxD.getMonth() - 6); break;
        case 'YTD': minDate = new Date(maxD.getFullYear(), 0, 1).getTime(); break;
        case '1Y': minDate = new Date(maxD).setFullYear(maxD.getFullYear() - 1); break;
        case '5Y': minDate = new Date(maxD).setFullYear(maxD.getFullYear() - 5); break;
        case 'MAX': minDate = window.currentChartData[0].x; break;
        default: 
            const d = new Date(maxD);
            d.setDate(d.getDate() - (rangeStr === '5D' ? 5 : 1));
            minDate = d.getTime();
    }

    window.isProgrammaticZoom = true;
    updatePriceStats(minDate, maxDate, rangeStr);
    ApexCharts.exec('chart-id', 'zoomX', minDate, maxDate);
}

window.updatePriceStats = function(minDate, maxDate) {
    if (!window.currentChartData || window.currentChartData.length === 0) return;

    const filteredData = window.currentChartData.filter(d => d.x >= minDate && d.x <= maxDate);
    if(filteredData.length > 0) {
        const startPrice = filteredData[0].y;
        // Stash the range's first price so the chart tooltip can compute
        // growth relative to the currently selected range.
        window._chartBasePrice = startPrice;
        const endPrice = filteredData[filteredData.length - 1].y;
        const diff = endPrice - startPrice;
        const pct = startPrice !== 0 ? (diff / startPrice) * 100 : 0;
        
        const isUp = diff >= 0;
        const colorHex = isUp ? '#10b981' : '#ef4444';
        const sign = isUp ? '+' : '';

        ApexCharts.exec('chart-id', 'updateOptions', { colors: [colorHex] }, false, false);

        const sym = window.currentSymbol ? window.currentSymbol.toUpperCase() : '';
        const dateStart = new Date(filteredData[0].x).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const dateEnd = new Date(filteredData[filteredData.length - 1].x).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        const priceSummaryEl = document.getElementById('price-summary');
        if(priceSummaryEl) {
            const watchlistBtn = window.isUserAuthenticated ? `
                <button data-watchlist-star data-action="toggle-watchlist" data-symbol="${window.escapeHTML(sym)}" aria-label="Toggle watchlist" class="focus-visible:outline-none transition-all hover:scale-110 active:scale-95 ${window.userWatchlist && window.userWatchlist.has(sym) ? 'text-amber-400' : 'text-slate-500 hover:text-amber-200'}" title="Toggle Watchlist">
                    <svg class="w-5 h-5" fill="${window.userWatchlist && window.userWatchlist.has(sym) ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"></path></svg>
                </button>` : '';

            // Alerts entry point — sits next to the watchlist star on the
            // stock detail header so users can create a price/RSI alert
            // for the current symbol in one tap, without walking through
            // bell → drawer → Rules. Shares the rule-modal + data-symbol
            // contract with the watchlist bell button. Pro/Admin only:
            // mirrors the RequireProOrAdmin gate on /v1/me/alerts* so
            // basic-tier users don't see a button that 403s.
            const alertBtn = (window.isUserAuthenticated && (window.userRole === 'admin' || window.userRole === 'pro')) ? `
                <button data-action="open-alert-rules-modal" data-symbol="${window.escapeHTML(sym)}" aria-label="Set an alert for ${window.escapeHTML(sym)}" class="focus-visible:outline-none transition-all text-slate-500 hover:text-amber-400 hover:scale-110 active:scale-95" title="Set alert">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
                </button>` : '';

            const csvBtn = (window.userRole === 'admin' || window.userRole === 'pro') ? `
                <button data-action="download-stock-data" class="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold text-slate-500 hover:text-blue-400 hover:bg-white/[0.04] border border-white/5 transition-all uppercase tracking-widest" title="Download CSV">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                    CSV
                </button>` : '';

            const exportBtn = (window.userRole === 'admin' || window.userRole === 'pro') ? `
                <button id="export-pdf-btn" data-action="export-tearsheet" data-symbol="${window.escapeHTML(sym)}" class="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold text-slate-500 hover:text-blue-400 hover:bg-white/[0.04] border border-white/5 transition-all uppercase tracking-widest" title="Export Tear Sheet">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                    PDF
                </button>` : '';

            // Price summary is rendered twice — classic 3-row flat layout
            // for desktop (hidden < lg), and the Accra Trader layout for
            // mobile (lg:hidden). Both price h1s share
            // `data-count-target="main-price-display"` and both watchlist
            // stars share `data-watchlist-star`; countUp + updateWatchlistUI
            // iterate via those attribute selectors. No duplicate IDs.
            const symInitial = sym ? sym.charAt(0).toUpperCase() : '·';
            priceSummaryEl.innerHTML = `
                <div class="stagger-enter stagger-1">
                    <!-- ── Desktop: classic 3-row flat layout ─────────────── -->
                    <div class="hidden lg:block">
                        <!-- Line 1: Back + Symbol + Actions -->
                        <div class="flex items-center gap-2.5 mb-3">
                            <button data-action="clear-selected-stock" class="flex items-center gap-1 text-slate-500 hover:text-amber-400 transition-colors" title="Back to Dashboard">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                            </button>
                            <h2 class="text-lg font-display font-bold text-white/90 tracking-tight">${sym}</h2>
                            ${watchlistBtn}
                            ${alertBtn}
                            ${csvBtn}
                            ${exportBtn}
                        </div>

                        <!-- Line 2: Price + Change (single baseline) -->
                        <div class="flex items-baseline gap-3 flex-wrap">
                            <h1 data-count-target="main-price-display" class="text-4xl lg:text-5xl font-bold font-display tracking-tight text-white/95">¢0.00</h1>
                            <span class="text-base lg:text-lg font-bold ${isUp ? 'text-emerald-400' : 'text-rose-400'}">${sign}${pct.toFixed(2)}%</span>
                            <span class="text-xs font-medium ${isUp ? 'text-emerald-400/60' : 'text-rose-400/60'}">${sign}${diff.toFixed(2)}</span>
                        </div>

                        <!-- Line 3: Data as of -->
                        <div class="flex items-center gap-1.5 mt-1.5 text-[10px] text-slate-500">
                            <svg class="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            <span>Data as of <span class="font-bold text-slate-400">${dateEnd}</span></span>
                        </div>
                    </div>

                    <!-- ── Mobile: Accra Trader topbar + identity grid ────── -->
                    <div class="lg:hidden stock-header">
                        <div class="stock-header__topbar">
                            <button data-action="clear-selected-stock" class="stock-header__iconbtn" aria-label="Back to Dashboard" title="Back">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                            </button>
                            <span class="stock-header__topbar-title">Stock Details</span>
                            <div class="stock-header__actions">
                                ${watchlistBtn}
                                ${alertBtn}
                                <button data-action="share-stock" class="stock-header__iconbtn stock-header__iconbtn--share" data-symbol="${window.escapeHTML(sym)}" aria-label="Share" title="Copy link">
                                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v14"/></svg>
                                </button>
                            </div>
                        </div>

                        <div class="stock-header__identity">
                            <div class="stock-header__logo" aria-hidden="true">${symInitial}</div>
                            <div class="stock-header__ticker">
                                <h2 class="stock-header__ticker-name">${sym}</h2>
                                <span class="stock-header__ticker-sub">As of ${dateEnd}</span>
                            </div>
                            <div class="stock-header__price-block">
                                <h1 data-count-target="main-price-display" class="stock-header__price">¢0.00</h1>
                                <div class="stock-header__delta stock-header__delta--${isUp ? 'up' : 'down'}">
                                    <span class="stock-header__delta__arrow">${isUp ? '▲' : '▼'}</span>
                                    <span>${Math.abs(pct).toFixed(2)}%</span>
                                    <span class="stock-header__delta__abs">${isUp ? '+' : '−'}${Math.abs(diff).toFixed(2)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            priceSummaryEl.classList.remove('hidden');
        }
        setTimeout(() => countUp('main-price-display', endPrice, 300, "¢"), 30);

        // Update the chart controls date-range label
        const chartStartEl = document.getElementById('chart-date-start');
        const chartEndEl = document.getElementById('last-updated-date');
        const chartLabelEl = document.getElementById('last-updated-label');
        if (chartStartEl) chartStartEl.textContent = dateStart;
        if (chartEndEl) chartEndEl.textContent = dateEnd;
        if (chartLabelEl) chartLabelEl.classList.remove('hidden');

        const placeholder = document.getElementById('sidebar-placeholder');
        const sidebarContent = document.getElementById('sidebar-content');
        if(placeholder) placeholder.classList.add('hidden');
        if(sidebarContent) sidebarContent.classList.remove('hidden');
        
        const aboutInfo = document.getElementById('about-info');
        if(aboutInfo) {
            // GSE_WIKI is a static client-side dictionary keyed by symbol —
            // safe to render as-is — but the dynamic fallback contains the
            // server-supplied symbol so it must be escaped.
            const wikiText = GSE_WIKI[sym];
            if (wikiText) {
                aboutInfo.innerHTML = `<p>${wikiText}</p>`;
            } else {
                aboutInfo.textContent = `No primary documentation found for ${sym}. This entity is a listed security on the Ghana Stock Exchange. Trade data reflects institutional and retail market activity reported to the GSE portal.`;
            }
        }

        // exitCompareMode sets _skipStatsRebuild so the market-indicators
        // grid (tech-stats) isn't re-rendered when we swap from compare
        // back to single view — the compare overlay never touched those
        // cells, so the values are already correct. The price header
        // above IS rebuilt since compare mode replaced it with the peer
        // chips. Flag is cleared on a timer in exitCompareMode.
        const techStats = window._skipStatsRebuild
            ? null
            : document.getElementById('tech-stats');
        if(techStats) {
            const prices = filteredData.map(d => d.y);
            const high = Math.max(...prices);
            const low = Math.min(...prices);
            const mStatus = updateMarketStatus();
            
            // techStats.style.borderColor = 'rgba(255, 255, 255, 0.08)';

            // techStats.style.borderColor =  mStatus.text.split(' ')[0] === 'Opened' ? 'rgba(16, 185, 129, 0.2)' : mStatus.text.split(' ')[0] === 'Closed' ? 'rgba(244, 63, 94, 0.2)' : 'rgba(255, 255, 255, 0.08)';
            
            techStats.innerHTML = `
                <div class="stat-cell glow-surface glass-card rounded-2xl p-4 stagger-enter stagger-3">
                    <div class="glow-content">
                        <p class="stat-label text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">High</p>
                        <p id="stat-high" class="stat-value text-sm font-bold" style="color:#f4ecd8c7">¢0.00</p>
                    </div>
                </div>
                <div class="stat-cell glow-surface glass-card rounded-2xl p-4 stagger-enter stagger-4">
                    <div class="glow-content">
                        <p class="stat-label text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Low</p>
                        <p id="stat-low" class="stat-value text-sm font-bold" style="color:#f4ecd8c7">¢0.00</p>
                    </div>
                </div>
                <div class="stat-cell glow-surface glass-card rounded-2xl p-4 stagger-enter stagger-5">
                    <div class="glow-content">
                        <p class="stat-label text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80 has-tooltip">Volatility<span class="tooltip">Annualised standard deviation of daily log returns over the selected range (×√252). The industry-standard measure of price risk — higher means wilder price swings.</span></p>
                        <p id="stat-vol" class="stat-value text-sm font-bold text-blue-400">0.00%</p>
                    </div>
                </div>
                <div class="stat-cell glow-surface glass-card rounded-2xl p-4 ${twColor(mStatus.color).cardBorder} stagger-enter stagger-6">
                    <div class="glow-content">
                        <p class="stat-label text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1.5 opacity-80">Status</p>
                        <p class="stat-value stat-value--status text-sm font-bold ${twColor(mStatus.color).text500} leading-tight">${mStatus.text.split(' ')[0]}</p>
                    </div>
                </div>
            `;
            
            setTimeout(() => {
                countUp('stat-high', high, 300, "¢");
                countUp('stat-low', low, 300, "¢");
                // Annualised volatility = stddev of daily log returns × √252
                // (252 trading days/year). Computed over the currently selected
                // chart range so the value tracks the user's zoom.
                let vol = 0;
                if (prices.length >= 2) {
                    const returns = [];
                    for (let i = 1; i < prices.length; i++) {
                        if (prices[i - 1] > 0 && prices[i] > 0) {
                            returns.push(Math.log(prices[i] / prices[i - 1]));
                        }
                    }
                    if (returns.length >= 2) {
                        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
                        const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
                        vol = Math.sqrt(variance) * Math.sqrt(252) * 100;
                    }
                }
                countUp('stat-vol', vol, 300, "", "%");
            }, 100);
        }
    }
}

window.renderChart = function(data) {
    document.getElementById('market-overview-dashboard')?.classList.add('hidden');
    document.getElementById('market-sectors-dashboard')?.classList.add('hidden');
    // Drop the "Sectors" pulse tab highlight so the sidebar doesn't claim a
    // view that's no longer on screen.
    document.querySelectorAll('.pulse-tab-btn').forEach(b => {
        if (b.getAttribute('title') === 'Sector Performance') b.classList.remove('active');
    });
    document.getElementById('chart-main').classList.remove('hidden');

    // Input is already sorted ascending by trading_date (QuestDB returns
    // ORDER BY, and fetchHistory no longer re-sorts). A belt-and-braces
    // check would be O(n) which defeats the point; skip it.
    const seriesData = data.map(d => ({ x: new Date(d.timestamp).getTime(), y: d.close }));
    window.currentChartData = seriesData;

    // If a chart already exists AND it's the same `area` type single-stock
    // chart, fast-path with updateSeries. Otherwise (we're coming from compare
    // mode, which uses a `line` chart with different config) destroy and
    // recreate so the type, tooltip, and series shape are clean.
    const existingType = window.chart?.opts?.chart?.type;
    if (window.chart && existingType === 'area') {
        window.chart.updateSeries([{ name: 'Close', data: seriesData }]).then(() => {
            // Scope to the stock chart's pill row; an unscoped lookup
            // can accidentally pick the portfolio equity chart's active
            // pill on the home dashboard.
            const activeBtn = document.querySelector('#chart-controls .range-btn.active');
            updateChartRange(activeBtn ? activeBtn.innerText : 'YTD', activeBtn);
        });
        return;
    }
    if (window.chart) {
        try { window.chart.destroy(); } catch (e) { console.debug("[chart] cleanup:", e); }
        window.chart = null;
    }

    const options = {
        series: [{ name: 'Close', data: seriesData }],
        chart: {
            id: 'chart-id',
            type: 'area',
            height: 380,
            background: 'transparent',
            foreColor: '#64748b',
            toolbar: { show: false },
            // Keep the initial-render curve draw (feels like the chart is
            // "materialising") but disable the longer animateGradually /
            // dynamicAnimation paths so updateSeries on live ticks + symbol
            // switches doesn't re-animate the whole series.
            animations: {
                enabled: true, easing: 'easeinout', speed: 250,
                animateGradually: { enabled: false },
                dynamicAnimation: { enabled: false },
            },
            zoom: {
                enabled: window.matchMedia('(min-width: 1024px)').matches,
                type: 'x',
                autoScaleYaxis: true,
                allowMouseWheelZoom: false
            },
            events: {
                zoomed: function(_, { xaxis }) {
                    if (xaxis.min && xaxis.max) {
                        updatePriceStats(xaxis.min, xaxis.max);
                        if (!window.isProgrammaticZoom) {
                            // Scope to the stock chart's pill row —
                            // unscoped wipes the portfolio equity
                            // chart's active state on the home
                            // dashboard.
                            document.querySelectorAll('#chart-controls .range-btn').forEach(b => b.classList.remove('active'));
                        }
                        window.isProgrammaticZoom = false;
                    }
                }
            }
        },
        colors: ['#3b82f6'],
        fill: {
            type: 'gradient',
            gradient: { shadeIntensity: 1, opacityFrom: 0.3, opacityTo: 0.05, stops: [0, 90, 100], colorStops: [] }
        },
        stroke: { curve: 'smooth', width: 2.5, lineCap: 'round' },
        markers: { size: 0, hover: { size: 6, sizeOffset: 3, strokeWidth: 2, strokeColor: '#fff' } },
        dataLabels: { enabled: false },
        tooltip: {
            theme: document.documentElement.className === 'dark' ? 'dark' : 'light',
            x: { format: 'dd MMM yyyy' },
            style: { fontSize: '12px', fontFamily: 'Outfit' },
            marker: { show: false },
            y: {
                formatter: v => '¢' + v.toFixed(2),
                title: { formatter: () => 'Price:' }
            },
            // Mirrors the compare-mode tooltip for visual consistency: same
            // dark card, dotted-marker row with symbol, price, and growth %.
            custom: function({series, seriesIndex, dataPointIndex, w}) {
                const val = series[seriesIndex][dataPointIndex];
                const dateLabel = new Date(w.globals.seriesX[seriesIndex][dataPointIndex]).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
                const base = window._chartBasePrice;
                let growthHtml = '';
                if (base && base > 0) {
                    const pct = ((val / base) - 1) * 100;
                    const sign = pct >= 0 ? '+' : '';
                    const cls = pct >= 0 ? 'text-emerald-400' : 'text-rose-400';
                    growthHtml = `<span class="text-xs font-bold ${cls}">${sign}${pct.toFixed(2)}%</span>`;
                }
                const symbol = (window.currentSymbol || '').toUpperCase();
                const color = w.globals.colors?.[0] || '#3b82f6';
                return `
                    <div class="p-3 bg-slate-950/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl">
                        <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">${dateLabel}</p>
                        <div class="grid items-center gap-x-4 gap-y-1 mt-1" style="grid-template-columns: auto auto auto;">
                            <span class="flex items-center gap-2">
                                <span class="inline-block w-2 h-2 rounded-full" style="background:${color}"></span>
                                <span class="text-xs font-bold text-white/80">${symbol}:</span>
                            </span>
                            <span class="text-xs font-bold text-white tabular-nums">¢${val.toFixed(2)}</span>
                            ${growthHtml || '<span></span>'}
                        </div>
                    </div>
                `;
            }
        },
        theme: { mode: document.documentElement.className === 'dark' ? 'dark' : 'light' },
        grid: { 
            borderColor: document.documentElement.className === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)',
            strokeDashArray: 5, 
            padding: { left: 10, right: 10 } 
        },
        xaxis: {
            type: 'datetime',
            axisBorder: { show: false },
            axisTicks: { show: false },
            tooltip: { enabled: false },
        },
        yaxis: { 
            labels: { 
                formatter: v => Math.round(v).toString(),
                style: { colors: document.documentElement.className === 'dark' ? '#475569' : '#334155', fontSize: '10px' }
            }
        }
    };

    window.chart = new ApexCharts(document.querySelector("#chart-container"), options);
    window.chart.render().then(() => {
        // Target YTD on the stock-chart control strip explicitly. The old
        // index-based lookup `.range-btn[4]` walks every pill in document
        // order — including the portfolio chart's pills when it's mounted
        // (hidden) in the dashboard column — so [4] lands on portfolio's
        // YTD instead of the stock chart's YTD and the stock pill never
        // gets the `.active` class.
        updateChartRange('YTD', document.querySelector('#chart-controls [data-range="YTD"]'));
        // Apply any fair value annotation that arrived before the chart was ready
        if (window._pendingFairValue != null) {
            window.applyFairValueAnnotation(window._pendingFairValue);
        }
    });
}

// ─── Comparison Mode ────────────────────────────────────────────────────────
// Multi-symbol comparison driven by the "Compare To" peer cards. Click a peer
// to add it to the overlay; click again to remove. Up to MAX_COMPARE peers can
// be active at once (4 total series including the base symbol — matches the
// backend /v1/compare cap).
//
// State shape:
//   { series: [{ symbol, data }, ...] }   index 0 = base (active) symbol
window.compareState = null;
// Symbol currently being fetched for comparison (one at a time). Used by
// renderComparables to render a per-card loading state.
window._loadingPeer = null;
const MAX_COMPARE_PEERS = 3;

// Color palette: index 0 = base, then peers in order added.
const COMPARE_COLORS = ['#3b82f6', '#f59e0b', '#ec4899', '#14b8a6'];

window.togglePeerCompare = async function(peerSymbol) {
    peerSymbol = (peerSymbol || '').toUpperCase();
    if (!peerSymbol || !window.currentSymbol) return;

    // Already comparing this peer → remove it.
    if (window.compareState) {
        const idx = window.compareState.series.findIndex(s => s.symbol === peerSymbol);
        if (idx > 0) {
            window.compareState.series.splice(idx, 1);
            // If only the base is left, exit compare mode entirely.
            if (window.compareState.series.length <= 1) {
                window.exitCompareMode();
                return;
            }
            renderCompareChart();
            window.renderComparables(window.currentSymbol);
            return;
        }
        // Adding another peer — guard against the cap.
        if (window.compareState.series.length >= MAX_COMPARE_PEERS + 1) {
            window.showToast(`Limit reached: max ${MAX_COMPARE_PEERS} peers`, 'error');
            return;
        }
        await addPeerToCompare(peerSymbol);
        return;
    }

    // First peer — bootstrap compare mode with base + this peer.
    await window.enterCompareMode(peerSymbol);
};

const sortByTs = (arr) => arr
    .map(d => ({ x: new Date(d.timestamp).getTime(), y: d.close }))
    .sort((a, b) => a.x - b.x);

window.enterCompareMode = async function(otherSymbol) {
    const baseSymbol = (window.currentSymbol || '').toUpperCase();
    otherSymbol = (otherSymbol || '').toUpperCase();
    if (!baseSymbol || !otherSymbol) return;

    window._loadingPeer = otherSymbol;
    window.renderComparables(baseSymbol);

    try {
        const res = await fetch(`/v1/compare?symbols=${encodeURIComponent(baseSymbol)},${encodeURIComponent(otherSymbol)}&interval=1d`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const dataBase = payload[baseSymbol];
        const dataPeer = payload[otherSymbol];
        if (!dataBase || !dataPeer || dataBase.length === 0 || dataPeer.length === 0) {
            window.showToast(`Insufficient data to compare ${baseSymbol} vs ${otherSymbol}`, 'error');
            return;
        }

        const activeBtn = document.querySelector('#chart-controls .range-btn.active');
        window.compareState = {
            range: activeBtn ? activeBtn.innerText : 'YTD',
            series: [
                { symbol: baseSymbol, data: sortByTs(dataBase) },
                { symbol: otherSymbol, data: sortByTs(dataPeer) },
            ],
        };

        renderCompareChart();
    } catch (e) {
        window.showToast(`Comparison failed: ${e.message}`, 'error');
    } finally {
        window._loadingPeer = null;
        window.renderComparables(baseSymbol);
    }
};

// addPeerToCompare fetches just the new peer's series and appends it to the
// existing comparison without re-fetching the base or any earlier peers.
async function addPeerToCompare(peerSymbol) {
    peerSymbol = (peerSymbol || '').toUpperCase();
    window._loadingPeer = peerSymbol;
    window.renderComparables(window.currentSymbol);
    try {
        const res = await fetch(`/v1/compare?symbols=${encodeURIComponent(peerSymbol)}&interval=1d`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const data = payload[peerSymbol];
        if (!data || data.length === 0) {
            window.showToast(`No data for ${peerSymbol}`, 'error');
            return;
        }
        window.compareState.series.push({ symbol: peerSymbol, data: sortByTs(data) });
        renderCompareChart();
    } catch (e) {
        window.showToast(`Failed to add ${peerSymbol}: ${e.message}`, 'error');
    } finally {
        window._loadingPeer = null;
        window.renderComparables(window.currentSymbol);
    }
}

// promoteToMain swaps a comparison peer into the main-stock slot. The chart
// exits comparison mode and reloads the full single-symbol view for the
// promoted symbol — same effect as searching for it from the search bar.
window.promoteToMain = function(symbol) {
    if (!symbol) return;
    window.compareState = null;
    const input = document.getElementById('symbol-search');
    if (input) input.value = symbol;
    window.fetchHistory();
};

window.exitCompareMode = function() {
    const sym = window.currentSymbol;
    // Capture the base series BEFORE nulling compareState so we can
    // redraw the single-stock area chart from memory — no fetchHistory,
    // no tech-stats rebuild, no price-header flash. The overlay never
    // touched either DOM node, so they already show the right values.
    const baseSeries = window.compareState?.series?.[0]?.data;
    window.compareState = null;
    if (!sym) return;
    window.renderComparables(sym);

    if (baseSeries && baseSeries.length > 0) {
        // renderChart's render() → updateChartRange → updatePriceStats
        // chain fires TWICE: once directly, once again via the chart's
        // `zoomed` event after the programmatic zoomX. Both must skip,
        // so hold the flag for ~500ms (ample for render + zoomed event)
        // then clear so the next genuine interaction rebuilds normally.
        window._skipStatsRebuild = true;
        const reshaped = baseSeries.map(d => ({
            timestamp: new Date(d.x).toISOString(),
            close: d.y,
        }));
        window.renderChart(reshaped);
        setTimeout(() => { window._skipStatsRebuild = false; }, 500);
        return;
    }
    // Fallback — base series was lost. Reload via the full path.
    window.fetchHistory(true);
};

// Normalises a price series to percent return from its first valid bar within
// [minDate, maxDate]. Skips leading non-positive prices so a single bad bar
// can't blank out the whole series.
function normalizeSeries(series, minDate, maxDate) {
    const filtered = series.filter(d => d.x >= minDate && d.x <= maxDate);
    if (filtered.length === 0) return [];
    let baseIdx = filtered.findIndex(d => d.y > 0);
    if (baseIdx === -1) return [];
    const base = filtered[baseIdx].y;
    return filtered.slice(baseIdx).map(d => ({ x: d.x, y: ((d.y / base) - 1) * 100 }));
}

window.renderCompareChart = function() {
    if (!window.compareState || window.compareState.series.length < 2) return;
    const all = window.compareState.series;

    // Earliest available data and most recent bar across all series. Used to
    // anchor range calculations.
    const seriesMin = Math.min(...all.map(s => s.data[0]?.x ?? Infinity));
    const seriesMax = Math.max(...all.map(s => s.data[s.data.length - 1]?.x ?? -Infinity));
    if (!isFinite(seriesMin) || !isFinite(seriesMax)) return;

    // Honour the user's range selection so the % return is rebased from the
    // start of that range, not from the earliest available bar.
    const rangeStr = window.compareState.range || 'YTD';
    const maxD = new Date(seriesMax);
    let lo;
    switch (rangeStr) {
        case '1D': lo = new Date(maxD).setDate(maxD.getDate() - 1); break;
        case '5D': lo = new Date(maxD).setDate(maxD.getDate() - 5); break;
        case '1M': lo = new Date(maxD).setMonth(maxD.getMonth() - 1); break;
        case '6M': lo = new Date(maxD).setMonth(maxD.getMonth() - 6); break;
        case 'YTD': lo = new Date(maxD.getFullYear(), 0, 1).getTime(); break;
        case '1Y': lo = new Date(maxD).setFullYear(maxD.getFullYear() - 1); break;
        case '5Y': lo = new Date(maxD).setFullYear(maxD.getFullYear() - 5); break;
        case 'MAX':
        default:    lo = seriesMin;
    }
    lo = Math.max(lo, seriesMin);
    const hi = seriesMax;

    const normalized = all.map(s => ({
        symbol: s.symbol,
        norm: normalizeSeries(s.data, lo, hi),
    }));

    // Header summary: each symbol with its colour swatch and current return.
    const priceSummaryEl = document.getElementById('price-summary');
    if (priceSummaryEl) {
        const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
        const chips = normalized.map((s, i) => {
            const last = s.norm.length ? s.norm[s.norm.length - 1].y : 0;
            const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
            const trendCls = last >= 0 ? 'text-emerald-400' : 'text-rose-400';
            const isBase = i === 0;
            // Clicking a chip promotes that symbol to the main stock and
            // reloads the full single-symbol view, mirroring Google Finance.
            const clickAttr = isBase
                ? ''
                : `data-action="promote-to-main" data-symbol="${window.escapeHTML(s.symbol)}" title="Set ${window.escapeHTML(s.symbol)} as main stock"`;
            const cursorCls = isBase ? '' : 'cursor-pointer hover:opacity-80 transition-opacity';
            return `
                <div class="flex flex-col ${cursorCls}" ${clickAttr}>
                    <div class="flex items-center gap-2">
                        <span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${color}"></span>
                        <h2 class="text-xl font-bold font-display tracking-tight" style="color:${color}">${window.escapeHTML(s.symbol)}</h2>
                    </div>
                    <span class="text-sm font-bold ${trendCls} ml-4">${fmtPct(last)}</span>
                </div>
            `;
        }).join('');
        const dateFmt = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const dateStart = dateFmt(lo);
        const dateEnd = dateFmt(hi);
        priceSummaryEl.innerHTML = `
            <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-6 stagger-enter stagger-1 w-full">
                <div class="space-y-2">
                    <div class="flex items-center gap-3 flex-wrap">
                        <button data-action="exit-compare-mode" class="flex items-center gap-1 text-slate-500 hover:text-amber-400 transition-colors" title="Back to ${window.escapeHTML(window.currentSymbol || '')}">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                        </button>
                        <span class="px-2.5 py-1 bg-blue-500/10 text-blue-400 text-[10px] font-bold rounded-lg border border-blue-500/20 uppercase tracking-widest">Compare</span>
                        <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Normalised Returns · ${normalized.length} stocks</span>
                    </div>
                    <div class="flex items-baseline gap-8 mt-2 flex-wrap">${chips}</div>
                </div>

                <div class="flex flex-col items-start lg:items-end gap-2">
                     <div class="flex items-center gap-2 text-[11px] font-medium text-slate-400/80 bg-white/[0.02] border border-white/5 px-3 py-1.5 rounded-full">
                        <svg class="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                        <span>${dateStart} - ${dateEnd}</span>
                     </div>
                </div>
            </div>
        `;
        priceSummaryEl.classList.remove('hidden');
    }

    document.getElementById('market-overview-dashboard')?.classList.add('hidden');
    document.getElementById('market-sectors-dashboard')?.classList.add('hidden');
    document.getElementById('chart-main').classList.remove('hidden');

    const series = normalized.map(s => ({ name: s.symbol, data: s.norm }));
    const colors = normalized.map((_, i) => COMPARE_COLORS[i % COMPARE_COLORS.length]);

    if (window.chart) {
        try { window.chart.destroy(); } catch (e) { console.debug("[chart] cleanup:", e); }
        window.chart = null;
    }

    const isDark = document.documentElement.className === 'dark';
    const options = {
        series,
        chart: {
            id: 'chart-id',
            type: 'line',
            height: 380,
            background: 'transparent',
            foreColor: '#64748b',
            toolbar: { show: false },
            animations: {
                enabled: true, easing: 'easeinout', speed: 250,
                animateGradually: { enabled: false },
                dynamicAnimation: { enabled: false },
            },
            zoom: { enabled: window.matchMedia('(min-width: 1024px)').matches, type: 'x', autoScaleYaxis: true, allowMouseWheelZoom: false },
        },
        colors,
        stroke: { curve: 'smooth', width: 2.5, lineCap: 'round' },
        markers: { size: 0, hover: { size: 5 } },
        dataLabels: { enabled: false },
        legend: { show: true, position: 'top', horizontalAlign: 'left', labels: { colors: isDark ? '#cbd5e1' : '#334155' } },
        tooltip: {
            theme: isDark ? 'dark' : 'light',
            shared: true,
            intersect: false,
            // Custom tooltip — the default shared tooltip indexes by position,
            // which breaks when each series has a different start date. We do
            // our own date-based lookup so every row reflects the value of
            // *that* series at the hovered date. Names are resolved from the
            // local symbol list (most reliable) instead of trusting ApexCharts'
            // possibly-stale seriesNames.
            custom: (function (symbolList, rawSeries) {
                // rawSeries[i] is the unnormalised price data for series i —
                // used to look up the actual price at the hovered date so the
                // tooltip can display ¢X.XX alongside the % growth.
                return function ({ seriesIndex, dataPointIndex, w }) {
                    const hoveredX = w.globals.seriesX[seriesIndex]?.[dataPointIndex];
                    if (hoveredX == null) return '';
                    const dateLabel = new Date(hoveredX).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

                    // Works for both flat-number x arrays (ApexCharts seriesX)
                    // and arrays of {x, y} objects (our raw price series).
                    const findAtOrBefore = (arr, x) => {
                        let best = -1;
                        for (let j = 0; j < arr.length; j++) {
                            const xv = typeof arr[j] === 'number' ? arr[j] : arr[j].x;
                            if (xv <= x) best = j;
                            else break;
                        }
                        return best;
                    };

                    const cells = [];
                    w.globals.series.forEach((seriesData, i) => {
                        const xs = w.globals.seriesX[i] || [];
                        if (xs.length === 0 || seriesData.length === 0) return;
                        const bestIdx = findAtOrBefore(xs, hoveredX);
                        if (bestIdx === -1) return;
                        const pct = seriesData[bestIdx];
                        if (pct == null || Number.isNaN(pct)) return;

                        let priceLabel = '';
                        const raw = rawSeries[i];
                        if (raw && raw.length) {
                            const rawIdx = findAtOrBefore(raw, hoveredX);
                            if (rawIdx !== -1 && raw[rawIdx]?.y != null) {
                                priceLabel = `¢${raw[rawIdx].y.toFixed(2)}`;
                            }
                        }

                        const name = symbolList[i] || w.globals.seriesNames[i] || `Series ${i + 1}`;
                        const color = w.globals.colors[i] || '#94a3b8';
                        const sign = pct >= 0 ? '+' : '';
                        const trendCls = pct >= 0 ? 'text-emerald-400' : 'text-rose-400';
                        cells.push(`
                            <span class="flex items-center gap-2">
                                <span class="inline-block w-2 h-2 rounded-full" style="background:${color}"></span>
                                <span class="text-xs font-bold text-white/80">${name}:</span>
                            </span>
                            <span class="text-xs font-bold text-white tabular-nums">${priceLabel}</span>
                            <span class="text-xs font-bold ${trendCls} tabular-nums">${sign}${pct.toFixed(2)}%</span>
                        `);
                    });

                    // Single grid wraps every row → columns share widths so
                    // prices and growth values align vertically across stocks.
                    return `
                        <div class="p-3 bg-slate-950/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl">
                            <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">${dateLabel}</p>
                            <div class="grid items-center gap-x-4 gap-y-1 mt-1" style="grid-template-columns: auto auto auto;">
                                ${cells.join('')}
                            </div>
                        </div>
                    `;
                };
            })(normalized.map(s => s.symbol), all.map(s => s.data)),
        },
        theme: { mode: isDark ? 'dark' : 'light' },
        grid: { borderColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)', strokeDashArray: 5, padding: { left: 10, right: 10 } },
        xaxis: {
            type: 'datetime',
            axisBorder: { show: false },
            axisTicks: { show: false },
            tooltip: { enabled: false },
        },
        yaxis: {
            labels: {
                formatter: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`,
                style: { colors: isDark ? '#475569' : '#334155', fontSize: '10px' },
            },
        },
    };

    window.chart = new ApexCharts(document.querySelector('#chart-container'), options);
    window.chart.render();
};

// escapeHTML moved to ./util/escape.js
// fetchNews moved to ../features/news.js (colocated with fetchMarketNews).

window.applyFairValueAnnotation = function(sma50) {
    if (!window.chart || sma50 == null) return;
    window.chart.removeAnnotation('fair-value-line');
    window.chart.addYaxisAnnotation({
        id: 'fair-value-line',
        y: sma50,
        borderColor: '#3b82f6',
        strokeDashArray: 5,
        label: {
            borderColor: '#3b82f6',
            style: { color: '#fff', background: '#3b82f6', fontSize: '9px', fontWeight: 800, padding: { left: 8, right: 8, top: 4, bottom: 4 } },
            text: `SMA50 · ¢${sma50.toFixed(2)}`,
            offsetY: -4,
            offsetX: 40,
            position: 'left',
            textAnchor: 'start'
        }
    });
};

// Re-export window shims that other modules reference
if (typeof window !== 'undefined') {
    window.updateChartRange = window.updateChartRange;
    window.updatePriceStats = window.updatePriceStats;
    window.renderChart = window.renderChart;
    window.togglePeerCompare = window.togglePeerCompare;
    window.enterCompareMode = window.enterCompareMode;
    window.promoteToMain = window.promoteToMain;
    window.exitCompareMode = window.exitCompareMode;
    window.renderCompareChart = window.renderCompareChart;
    window.applyFairValueAnnotation = window.applyFairValueAnnotation;
}

