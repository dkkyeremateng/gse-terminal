// Sector views — heatmap, cards, rotation chart, drill-down modal.
// Extracted from app.js; all window.* shims preserved.

import { escapeHTML as escapeHtml } from '../util/escape.js';
import { twColor } from '../util/tw-colors.js';


// ─── Sector views ───────────────────────────────────────────────────────────
// Backed by /v1/market-sectors (turnover-weighted) with three sub-views:
// heatmap (treemap), cards, and rotation (indexed line chart). All user-
// supplied strings are escaped via escapeHtml since sector names can now come
// from an admin-editable DB table.

window.fetchMarketSectors = async function(force = false) {
    if (window.userRole !== 'admin' && window.userRole !== 'pro') {
        // Show promotional content instead of sector data
        window._renderSectorPromo();
        return;
    }
    try {
        if (!force && window.MARKET_SECTORS_DATA) {
            window.renderActiveSectorView();
            return;
        }
        const res = await fetch('/v1/market-sectors');
        if (!res.ok) return;
        const data = await res.json();
        window.MARKET_SECTORS_DATA = data;
        window.renderActiveSectorView();

        const pulseTitle = document.getElementById('pulse-title');
        if (pulseTitle && pulseTitle.innerText === "Sectors") {
            window.renderSectorPulse(data);
        }
    } catch (e) {
        console.warn("Sector fetch failed", e);
    }
};

window.renderActiveSectorView = function() {
    const data = window.MARKET_SECTORS_DATA;
    if (!data) return;
    const view = window._sectorView || 'heatmap';
    if (view === 'heatmap') window.renderSectorHeatmap(data);
    else if (view === 'cards') window.renderSectorsView(data);
    // rotation is loaded on demand via loadSectorRotation
};

window.switchSectorView = function(view, btn) {
    window._sectorView = view;
    document.querySelectorAll('.sector-view-btn').forEach(b => b.classList.remove('active', 'bg-white/5', 'text-white'));
    if (btn) btn.classList.add('active', 'bg-white/5', 'text-white');

    const heat = document.getElementById('sector-heatmap-container');
    const grid = document.getElementById('sector-grid');
    const rot = document.getElementById('sector-rotation-container');
    if (heat) heat.classList.toggle('hidden', view !== 'heatmap');
    if (grid) grid.classList.toggle('hidden', view !== 'cards');
    if (rot) rot.classList.toggle('hidden', view !== 'rotation');

    if (view === 'heatmap' || view === 'cards') {
        window.renderActiveSectorView();
    } else if (view === 'rotation') {
        const activeBtn = document.querySelector('.rotation-range-btn.active') ||
                          document.querySelector('.rotation-range-btn');
        const range = activeBtn ? activeBtn.innerText.trim() : '1M';
        window.loadSectorRotation(range, activeBtn);
    }
};

window.renderSectorHeatmap = function(data) {
    const target = document.getElementById('sector-heatmap');
    if (!target || typeof ApexCharts === 'undefined') return;

    // Skip empty/no-turnover sectors so they don't bloat the layout. Sort
    // by turnover desc so the largest blocks anchor the top-left and the
    // visual hierarchy is predictable across renders.
    const filtered = data
        .filter(s => (s.totalTurnover || 0) > 0)
        .slice()
        .sort((a, b) => (b.totalTurnover || 0) - (a.totalTurnover || 0));

    if (filtered.length === 0) {
        target.innerHTML = '<div class="flex items-center justify-center h-[400px] text-xs text-slate-500">No turnover today</div>';
        renderSectorHeatmapLegend(null);
        return;
    }

    // Compress the dynamic range so a single mega-cap (e.g. MTNGH) doesn't
    // squash every other sector to an unreadable sliver. sqrt() is a good
    // middle ground between linear (too dominated by big sectors) and log
    // (which over-flattens). Then enforce a hard minimum of ~6% of the
    // largest tile so the smallest sector is always at least labelable.
    const rawSizes = filtered.map(s => Math.sqrt(Math.max(s.totalTurnover || 0, 1)));
    const maxSize = Math.max(...rawSizes);
    const minSize = maxSize * 0.18; // floor → smallest tile ≈ 18% of largest

    const points = filtered.map((s, i) => ({
        x: s.sector,
        y: Math.max(rawSizes[i], minSize),
        fillColor: pctToColor(s.avgPctChange),
        meta: s
    }));

    const options = {
        series: [{ data: points }],
        chart: {
            type: 'treemap',
            height: 440,
            background: 'transparent',
            toolbar: { show: false },
            fontFamily: 'Outfit, sans-serif',
            animations: {
                enabled: true, easing: 'easeinout', speed: 250,
                animateGradually: { enabled: false },
                dynamicAnimation: { enabled: false },
            },
            events: {
                dataPointSelection: (_, __, cfg) => {
                    const sec = filtered[cfg.dataPointIndex];
                    if (sec) window.openSectorDrill(sec.sector);
                }
            }
        },
        legend: { show: false },
        stroke: { show: true, width: 2, colors: ['#0f172a'] },
        dataLabels: {
            enabled: true,
            style: { fontSize: '12px', fontFamily: 'Outfit', fontWeight: 700, colors: ['#ffffff'] },
            formatter: function(text, op) {
                const s = filtered[op.dataPointIndex];
                if (!s) return text;
                // Estimate the rendered tile area (px²) so we can drop optional
                // lines on small tiles instead of letting ApexCharts rotate text.
                const rect = op.config && op.config.series && op.w && op.w.globals
                    ? (op.w.globals.dom && op.w.globals.dom.elGraphical
                        ? op.w.globals.dom.elGraphical.querySelectorAll('rect.apexcharts-treemap-rect')[op.dataPointIndex]
                        : null)
                    : null;
                let tileW = 9999, tileH = 9999;
                if (rect) {
                    tileW = parseFloat(rect.getAttribute('width')) || 0;
                    tileH = parseFloat(rect.getAttribute('height')) || 0;
                }
                const sign = s.avgPctChange >= 0 ? '▲' : '▼';
                const pctLine = `${sign} ${Math.abs(s.avgPctChange).toFixed(2)}%`;
                const top = (s.topGainer && s.topGainer.symbol) || '';
                // ApexCharts rotates labels when the widest line doesn't fit
                // horizontally, which produces the unreadable vertical text on
                // tall-thin tiles. Tier label content by *width* (not area):
                //   width < 90px  → name only (fits even when truncated)
                //   width < 140px → name + %
                //   else          → name + % + top symbol
                if (tileW < 90 || tileH < 50) return [text.toUpperCase()];
                if (tileW < 140) return [text.toUpperCase(), pctLine];
                return [text.toUpperCase(), pctLine, top ? `Top: ${top}` : ''].filter(Boolean);
            },
            offsetY: -2
        },
        tooltip: {
            theme: 'dark',
            custom: ({ dataPointIndex }) => {
                const s = filtered[dataPointIndex];
                if (!s) return '';
                const sign = s.avgPctChange >= 0 ? '+' : '';
                const turnover = (s.totalTurnover / 1000).toFixed(1);
                const breadthTotal = s.advanceCount + s.declineCount + s.neutralCount;
                const breadthPct = breadthTotal > 0 ? Math.round((s.advanceCount / breadthTotal) * 100) : 0;
                const top = s.topGainer && s.topGainer.symbol
                    ? `<span class="text-emerald-400">▲ ${escapeHtml(s.topGainer.symbol)} ${s.topGainer.percentChange >= 0 ? '+' : ''}${s.topGainer.percentChange.toFixed(2)}%</span>`
                    : '';
                const worst = s.worstLoser && s.worstLoser.symbol && s.worstLoser.symbol !== (s.topGainer && s.topGainer.symbol)
                    ? `<span class="text-rose-400">▼ ${escapeHtml(s.worstLoser.symbol)} ${s.worstLoser.percentChange.toFixed(2)}%</span>`
                    : '';
                return `
                    <div class="p-3 bg-slate-950/95 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl min-w-[200px]">
                        <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">${escapeHtml(s.sector)}</p>
                        <p class="text-2xl font-bold font-display ${s.avgPctChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${sign}${s.avgPctChange.toFixed(2)}%</p>
                        <div class="mt-2 space-y-0.5 text-[11px]">
                            <div class="flex justify-between gap-4 text-slate-400"><span>Turnover</span><span class="text-slate-200 tabular-nums">¢${turnover}k</span></div>
                            <div class="flex justify-between gap-4 text-slate-400"><span>Breadth</span><span class="text-slate-200 tabular-nums">${breadthPct}% adv (${s.advanceCount}/${s.declineCount + s.neutralCount})</span></div>
                            <div class="flex justify-between gap-4 text-slate-400"><span>Constituents</span><span class="text-slate-200 tabular-nums">${(s.constituents && s.constituents.length) || 0}</span></div>
                        </div>
                        <div class="mt-2 pt-2 border-t border-white/10 space-y-0.5 text-[11px] font-bold">
                            ${top}${top && worst ? '<br>' : ''}${worst}
                        </div>
                        <p class="text-[9px] text-slate-500 mt-2 uppercase tracking-widest">Click to drill in</p>
                    </div>
                `;
            }
        },
        plotOptions: {
            treemap: {
                enableShades: false,
                distributed: true,
                useFillColorAsStroke: false,
                borderRadius: 6
            }
        }
    };

    if (window._sectorHeatmap) {
        try { window._sectorHeatmap.destroy(); } catch (e) { console.debug("[chart] heatmap cleanup:", e); }
    }
    target.innerHTML = '';
    window._sectorHeatmap = new ApexCharts(target, options);
    window._sectorHeatmap.render();
    renderSectorHeatmapLegend(filtered);
};

function renderSectorHeatmapLegend(filtered) {
    const container = document.getElementById('sector-heatmap-container');
    if (!container) return;
    let legend = container.querySelector('.sector-heatmap-legend');
    if (!legend) {
        legend = document.createElement('div');
        legend.className = 'sector-heatmap-legend flex items-center justify-between text-[10px] text-slate-500';
        container.insertBefore(legend, container.firstChild);
    }
    if (!filtered) { legend.innerHTML = ''; return; }

    const totalTurnover = filtered.reduce((a, s) => a + (s.totalTurnover || 0), 0);
    const advancing = filtered.filter(s => s.avgPctChange > 0).length;
    const declining = filtered.filter(s => s.avgPctChange < 0).length;

    // Build a 9-stop color ramp from -5% → +5%
    const stops = [-5, -3.75, -2.5, -1.25, 0, 1.25, 2.5, 3.75, 5];
    const swatches = stops.map(p => `<span class="inline-block w-5 h-2" style="background:${pctToColor(p)}"></span>`).join('');

    legend.innerHTML = `
        <div class="flex items-center gap-3">
            <span class="font-bold uppercase tracking-widest text-slate-400">${filtered.length} sectors</span>
            <span class="text-emerald-500 font-bold">▲ ${advancing}</span>
            <span class="text-rose-500 font-bold">▼ ${declining}</span>
            <span class="text-slate-400">· Σ turnover ¢${(totalTurnover / 1000).toFixed(1)}k</span>
        </div>
        <div class="flex items-center gap-2">
            <span>−5%</span>
            <span class="flex rounded overflow-hidden border border-white/10">${swatches}</span>
            <span>+5%</span>
        </div>
    `;
}

function pctToColor(pct) {
    // Diverging green↔red ramp clamped at ±5%.
    const clamped = Math.max(-5, Math.min(5, pct));
    if (clamped >= 0) {
        const t = clamped / 5;
        const r = Math.round(30 + (16 - 30) * t);
        const g = Math.round(41 + (185 - 41) * t);
        const b = Math.round(59 + (129 - 59) * t);
        return `rgb(${r},${g},${b})`;
    } else {
        const t = -clamped / 5;
        const r = Math.round(30 + (244 - 30) * t);
        const g = Math.round(41 + (63 - 41) * t);
        const b = Math.round(59 + (94 - 59) * t);
        return `rgb(${r},${g},${b})`;
    }
}

window.renderSectorsView = function(data) {
    const grid = document.getElementById('sector-grid');
    if (!grid) return;

    grid.innerHTML = data.map((s, idx) => {
        const isUp = s.avgPctChange >= 0;
        // Hardcoded class variants so Tailwind JIT picks them up.
        const accentBg = isUp ? 'bg-emerald-500/10' : 'bg-rose-500/10';
        const accentFg = isUp ? 'text-emerald-500' : 'text-rose-500';
        const arrow = isUp
            ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>'
            : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0v-8m0 8l-8-8-4 4-6-6"></path>';
        const sign = isUp ? '+' : '';
        const breadthTotal = s.advanceCount + s.declineCount + s.neutralCount;
        const advPct = breadthTotal > 0 ? (s.advanceCount / breadthTotal) * 100 : 0;
        const decPct = breadthTotal > 0 ? (s.declineCount / breadthTotal) * 100 : 0;
        const vol = ((s.totalVolume || 0) / 1000).toFixed(1);
        const sector = escapeHtml(s.sector);
        const topSym = escapeHtml((s.topGainer && s.topGainer.symbol) || '—');

        return `
            <div class="glass-card rounded-2xl p-5 border-white/5 hover:bg-white/[0.04] transition-all group stagger-enter cursor-pointer" style="animation-delay: ${idx * 50}ms" data-action="open-sector-drill" data-sector="${sector}">
                <div class="flex items-start justify-between mb-4">
                    <div>
                        <h4 class="text-[11px] font-bold text-slate-500 uppercase tracking-widest mb-1">${sector}</h4>
                        <p class="text-lg font-bold font-display text-white">${sign}${s.avgPctChange.toFixed(2)}%</p>
                    </div>
                    <div class="p-2 rounded-xl ${accentBg} ${accentFg}">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${arrow}</svg>
                    </div>
                </div>
                <div class="flex items-center gap-4 mb-5">
                    <div class="flex-1">
                        <div class="flex justify-between text-[9px] font-black uppercase tracking-wider text-slate-500 mb-1.5">
                            <span>Sentiment</span>
                            <span>${s.advanceCount}A / ${s.declineCount}D</span>
                        </div>
                        <div class="h-1 w-full bg-white/10 rounded-full overflow-hidden flex">
                            <div class="h-full bg-emerald-500" style="width: ${advPct}%"></div>
                            <div class="h-full bg-rose-500" style="width: ${decPct}%"></div>
                        </div>
                    </div>
                </div>
                <div class="flex items-center justify-between pt-4 border-t border-white/5">
                    <div class="flex items-center gap-2">
                        <div class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></div>
                        <span class="text-[10px] text-slate-400 font-bold">${topSym}</span>
                    </div>
                    <span class="text-[10px] text-slate-500 font-black uppercase tracking-widest">${vol}k Units</span>
                </div>
            </div>
        `;
    }).join('');
};

window.renderSectorPulse = function(data) {
    const itemsCont = document.getElementById('market-pulse-items');
    if (!itemsCont) return;
    itemsCont.innerHTML = data.slice(0, 5).map(s => {
        const sign = s.avgPctChange >= 0 ? '+' : '';
        const cls = s.avgPctChange >= 0 ? 'text-emerald-500' : 'text-rose-500';
        const count = (s.constituents && s.constituents.length) || 0;
        return `
            <div class="glass-card rounded-xl p-3 flex items-center justify-between transition-all hover:bg-white/[0.06] group stagger-enter cursor-pointer" data-action="open-sector-drill" data-sector="${escapeHtml(s.sector)}">
                <div>
                    <p class="text-xs font-bold text-slate-300 group-hover:text-amber-400 transition-colors uppercase tracking-wider">${escapeHtml(s.sector)}</p>
                    <div class="flex items-center gap-2 mt-0.5">
                        <span class="text-[9px] text-slate-500 font-black uppercase tracking-widest">${count} Assets</span>
                    </div>
                </div>
                <div class="text-right">
                    <p class="text-[10px] font-black ${cls}">${sign}${s.avgPctChange.toFixed(2)}%</p>
                </div>
            </div>
        `;
    }).join('');
};

// ─── Sector drill-down modal ───
window.openSectorDrill = async function(sectorName) {
    const modal = document.getElementById('sector-drill-modal');
    const title = document.getElementById('sector-drill-title');
    const stats = document.getElementById('sector-drill-stats');
    const body = document.getElementById('sector-drill-body');
    if (!modal || !window.MARKET_SECTORS_DATA) return;

    // The default cache may have been fetched with ?detail=summary stripped of
    // constituents in future iterations — refetch the full payload here so the
    // drill view always has the row-level data it needs.
    let sec = window.MARKET_SECTORS_DATA.find(s => s.sector === sectorName);
    if (!sec || !sec.constituents || sec.constituents.length === 0) {
        try {
            const res = await fetch('/v1/market-sectors');
            if (res.ok) {
                const fresh = await res.json();
                window.MARKET_SECTORS_DATA = fresh;
                sec = fresh.find(s => s.sector === sectorName);
            }
        } catch (e) { console.warn('[sectors] drill refetch:', e); }
    }
    if (!sec) return;

    title.textContent = sec.sector;
    const sign = sec.avgPctChange >= 0 ? '+' : '';
    stats.innerHTML = `<span class="${sec.avgPctChange >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold">${sign}${sec.avgPctChange.toFixed(2)}%</span> · ${sec.advanceCount}A / ${sec.declineCount}D · Turnover ¢${(sec.totalTurnover / 1000).toFixed(1)}k`;

    const sorted = (sec.constituents || []).slice().sort((a, b) => b.percentChange - a.percentChange);
    body.innerHTML = `
        <table class="w-full text-xs">
            <thead>
                <tr class="text-[9px] font-bold uppercase tracking-widest text-slate-500 border-b border-white/5">
                    <th class="text-left py-2">Symbol</th>
                    <th class="text-right py-2">Last</th>
                    <th class="text-right py-2">Change</th>
                    <th class="text-right py-2">% Chg</th>
                    <th class="text-right py-2">Volume</th>
                </tr>
            </thead>
            <tbody>
                ${sorted.map(c => {
                    const cls = c.percentChange >= 0 ? 'text-emerald-400' : 'text-rose-400';
                    const sg = c.percentChange >= 0 ? '+' : '';
                    return `
                        <tr class="border-b border-white/5 hover:bg-white/[0.02] cursor-pointer" data-action="load-symbol-from-drill" data-symbol="${escapeHtml(c.symbol)}">
                            <td class="py-2 font-bold text-white">${escapeHtml(c.symbol)}</td>
                            <td class="py-2 text-right text-slate-300">¢${c.lastPrice.toFixed(2)}</td>
                            <td class="py-2 text-right ${cls}">${sg}${c.priceChange.toFixed(2)}</td>
                            <td class="py-2 text-right ${cls} font-bold">${sg}${c.percentChange.toFixed(2)}%</td>
                            <td class="py-2 text-right text-slate-400">${c.volume.toLocaleString()}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
    modal.classList.remove('hidden');
};

window.closeSectorDrill = function() {
    const modal = document.getElementById('sector-drill-modal');
    if (modal) modal.classList.add('hidden');
};

// ─── Sector rotation chart ───
window.loadSectorRotation = async function(range, btn) {
    document.querySelectorAll('.rotation-range-btn').forEach(b => b.classList.remove('active', 'bg-white/5', 'text-white'));
    if (btn) btn.classList.add('active', 'bg-white/5', 'text-white');

    const target = document.getElementById('sector-rotation-chart');
    if (!target || typeof ApexCharts === 'undefined') return;
    target.innerHTML = '<div class="flex items-center justify-center h-[360px] text-xs text-slate-500">Loading rotation…</div>';
    try {
        const res = await fetch(`/v1/market-sectors/history?range=${encodeURIComponent(range)}`);
        if (!res.ok) throw new Error();
        const data = await res.json();

        const series = data.map(s => ({
            name: s.sector,
            data: s.series.map(p => ({ x: new Date(p.date).getTime(), y: Number(p.value.toFixed(2)) }))
        }));

        const options = {
            series,
            chart: {
                type: 'line',
                height: 400,
                background: 'transparent',
                foreColor: '#64748b',
                toolbar: { show: false },
                animations: {
                    enabled: true, easing: 'easeinout', speed: 250,
                    animateGradually: { enabled: false },
                    dynamicAnimation: { enabled: false },
                }
            },
            stroke: { curve: 'smooth', width: 2 },
            xaxis: { type: 'datetime', axisBorder: { show: false }, axisTicks: { show: false } },
            yaxis: {
                labels: { formatter: v => v.toFixed(0), style: { fontSize: '10px' } },
                title: { text: 'Index (start = 100)', style: { fontSize: '10px', color: '#475569' } }
            },
            grid: { borderColor: 'rgba(255,255,255,0.04)', strokeDashArray: 5 },
            legend: { position: 'top', fontSize: '10px', labels: { colors: '#94a3b8' } },
            markers: { size: 0, hover: { size: 5 } },
            tooltip: {
                theme: 'dark',
                shared: true,
                intersect: false,
                x: { format: 'dd MMM yyyy' },
                custom: function({ series, dataPointIndex, w }) {
                    // Each sector series has its own (potentially sparse) x-axis,
                    // so we resolve each series' value at the hovered timestamp
                    // independently instead of trusting a single shared index.
                    const hoverX = w.globals.seriesX[0] && w.globals.seriesX[0][dataPointIndex];
                    const dateLabel = hoverX ? new Date(hoverX).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
                    const rows = w.globals.seriesNames.map((name, i) => {
                        const xs = w.globals.seriesX[i] || [];
                        // Find the closest x ≤ hoverX for this series
                        let idx = -1;
                        for (let k = 0; k < xs.length; k++) {
                            if (xs[k] <= hoverX) idx = k; else break;
                        }
                        const val = idx >= 0 ? series[i][idx] : null;
                        const color = w.globals.colors[i];
                        return `
                            <div class="flex items-center justify-between gap-4 text-xs">
                                <span class="flex items-center gap-2">
                                    <span class="inline-block w-2 h-2 rounded-full" style="background:${color}"></span>
                                    <span class="text-white/80 font-bold">${name}</span>
                                </span>
                                <span class="text-white tabular-nums font-bold">${val == null ? '—' : val.toFixed(2)}</span>
                            </div>
                        `;
                    }).join('');
                    return `
                        <div class="p-3 bg-slate-950/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl space-y-1 min-w-[200px]">
                            <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-2">${dateLabel}</p>
                            ${rows}
                        </div>
                    `;
                }
            },
            theme: { mode: 'dark' }
        };

        target.innerHTML = '';
        if (window._sectorRotationChart) {
            try { window._sectorRotationChart.destroy(); } catch (e) { console.debug("[chart] rotation cleanup:", e); }
        }
        window._sectorRotationChart = new ApexCharts(target, options);
        window._sectorRotationChart.render();
    } catch (e) {
        target.innerHTML = '<div class="flex items-center justify-center h-[360px] text-xs text-rose-400">Failed to load sector rotation</div>';
    }
};

// Promotional content shown to non-pro/non-admin users when they tap
// the Sector Performance tab. Renders into both the main dashboard
// area and the sidebar movers panel.
window._renderSectorPromo = function() {
    const dashboard = document.getElementById('market-sectors-dashboard');
    if (dashboard) {
        dashboard.classList.remove('hidden');
        dashboard.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 px-6 text-center stagger-enter">
                <div class="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-6 border border-amber-500/20">
                    <svg class="w-8 h-8 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path>
                    </svg>
                </div>
                <h3 class="text-xl font-display font-bold text-white/90 mb-3">Sector Performance</h3>
                <p class="text-sm text-slate-400 leading-relaxed max-w-md mb-6">
                    Unlock real-time sector heatmaps, rotation charts, and drill-down analysis.
                    See which industries are leading the GSE and where capital is flowing.
                </p>
                <div class="flex flex-col gap-3 w-full max-w-xs">
                    <div class="flex items-center gap-3 text-left p-3 rounded-lg bg-white/[0.02] border border-white/5">
                        <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                            <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
                        </div>
                        <div>
                            <p class="text-xs font-bold text-white/80">Treemap Heatmap</p>
                            <p class="text-[10px] text-slate-500">Turnover-weighted sector view</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-3 text-left p-3 rounded-lg bg-white/[0.02] border border-white/5">
                        <div class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                            <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                        </div>
                        <div>
                            <p class="text-xs font-bold text-white/80">Rotation Charts</p>
                            <p class="text-[10px] text-slate-500">Track capital flow across sectors</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-3 text-left p-3 rounded-lg bg-white/[0.02] border border-white/5">
                        <div class="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                            <svg class="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </div>
                        <div>
                            <p class="text-xs font-bold text-white/80">Drill-down Analysis</p>
                            <p class="text-[10px] text-slate-500">Constituent-level breakdowns</p>
                        </div>
                    </div>
                </div>
                ${window.isUserAuthenticated
                    ? '<p class="mt-6 text-[10px] text-slate-500 uppercase tracking-widest">Contact admin to upgrade your account to Pro</p>'
                    : '<a href="/login" class="mt-6 px-6 py-2.5 bg-amber-500 hover:bg-amber-400 text-[var(--ink)] text-[10px] font-black uppercase tracking-widest rounded transition-all active:scale-95">Establish Uplink</a>'
                }
            </div>
        `;
    }

    // Also render promo in the sidebar pulse panel — same layout as
    // the "Watchlist Locked" card in terminal.html.
    const itemsCont = document.getElementById('market-pulse-items');
    if (itemsCont) {
        itemsCont.innerHTML = `
            <div class="glass-card rounded-2xl p-6 border-amber-500/20 relative overflow-hidden flex flex-col items-center text-center animate-in fade-in slide-in-from-left-4 duration-500 group">
                <div class="absolute inset-0 bg-gradient-to-br from-amber-600/5 to-orange-600/5 pointer-events-none"></div>
                <div class="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center text-amber-500 mb-3 group-hover:scale-110 transition-transform duration-500">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                    </svg>
                </div>
                <h4 class="text-[11px] font-bold text-white/90 mb-1.5 uppercase tracking-wider">Sectors Locked</h4>
                <p class="text-[9px] text-slate-500 leading-relaxed mb-4">Unlock real-time sector heatmaps, rotation charts, and drill-down analysis across the GSE.</p>
                ${window.isUserAuthenticated
                    ? '<p class="w-full py-2 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-lg text-[9px] font-black uppercase tracking-widest">Upgrade to Pro</p>'
                    : '<a href="/login" class="w-full py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/20 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all">Establish Uplink</a>'
                }
            </div>
        `;
    }
};
