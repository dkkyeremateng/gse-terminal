// Tear-sheet PDF export — single-page A4 report with chart snapshot.
// Extracted from app.js; all window.* shims preserved.

import { escapeHTML as escapeHtml } from '../util/escape.js';

// Builds a purpose-built single-page A4 tear sheet (not a dashboard screenshot)
// using data already in window state plus an inline chart snapshot from
// ApexCharts.dataURI(). Pro/admin gated.

// escapeHtml is an alias for window.escapeHTML, kept so the sector and tear
// sheet code reads naturally without `window.` everywhere. Both names refer
// escapeHtml is the same as escapeHTML; imported from ./util/escape.js.

function computeTearSheetStats(data) {
    if (!data || data.length === 0) return null;
    const prices = data.map(d => d.y).filter(p => p > 0);
    if (prices.length === 0) return null;
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const totalReturn = first > 0 ? ((last / first) - 1) * 100 : 0;

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

    const startDate = new Date(data[0].x);
    const endDate = new Date(data[data.length - 1].x);
    return { high, low, first, last, totalReturn, vol, startDate, endDate, points: data.length };
}

window.generateTearSheet = async function(symbol) {
    if (window.userRole !== 'admin' && window.userRole !== 'pro') {
        window.showToast && window.showToast("Premium Feature Locked", "error");
        return;
    }
    if (!symbol || typeof window.html2pdf === 'undefined') {
        window.showToast && window.showToast("PDF engine not ready", "error");
        return;
    }

    const btn = document.getElementById('export-pdf-btn');
    if (btn) btn.classList.add('animate-pulse', 'text-blue-500');

    const sym = symbol.toUpperCase();

    // Honor the chart's currently visible range (set by range buttons or zoom)
    // so the tear sheet reflects exactly what the user is looking at.
    let rangeData = window.currentChartData || [];
    let rangeLabel = '';
    try {
        const g = window.chart && window.chart.w && window.chart.w.globals;
        if (g && g.minX && g.maxX) {
            rangeData = rangeData.filter(d => d.x >= g.minX && d.x <= g.maxX);
        }
    } catch (e) { console.debug('[tearsheet] chart range read:', e); }
    // Scope to the stock chart's pill row — the portfolio equity
    // chart on the home dashboard reuses the .range-btn class, so
    // an unscoped lookup can pick that pill instead and print the
    // wrong range label on the tear-sheet PDF.
    const activeBtn = document.querySelector('#chart-controls .range-btn.active');
    if (activeBtn) rangeLabel = activeBtn.innerText.trim();

    const stats = computeTearSheetStats(rangeData);
    if (!stats) {
        window.showToast && window.showToast("No price data loaded for tear sheet", "error");
        if (btn) btn.classList.remove('animate-pulse', 'text-blue-500');
        return;
    }

    // Snapshot the existing ApexChart as an inline image so the tear sheet
    // doesn't depend on rendering ApexCharts a second time inside html2canvas.
    let chartImg = '';
    try {
        if (window.chart && typeof window.chart.dataURI === 'function') {
            const { imgURI } = await window.chart.dataURI({ scale: 2 });
            chartImg = imgURI;
        }
    } catch (e) {
        console.warn('chart dataURI failed, tear sheet will omit chart', e);
    }

    const fmtDate = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const fmtMoney = v => '¢' + v.toFixed(2);
    const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    const returnColor = stats.totalReturn >= 0 ? '#059669' : '#dc2626';
    const about = window.GSE_WIKI && window.GSE_WIKI[sym]
        ? window.GSE_WIKI[sym]
        : `${sym} is a listed security on the Ghana Stock Exchange.`;
    const generated = new Date().toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    // Build the PDF directly with jsPDF (bundled inside html2pdf) instead of
    // rasterizing DOM via html2canvas — html2canvas is unreliable for offscreen
    // wrappers and depends on browser layout state. Direct drawing gives a
    // deterministic, vector-text PDF every time.
    const jsPDFCtor =
        (window.jspdf && window.jspdf.jsPDF) ||
        (window.html2pdf && window.html2pdf.jsPDF) ||
        window.jsPDF;
    if (!jsPDFCtor) {
        window.showToast && window.showToast("PDF engine not ready", "error");
        if (btn) btn.classList.remove('animate-pulse', 'text-blue-500');
        return;
    }

    try {
        const doc = new jsPDFCtor({ unit: 'pt', format: 'a4', orientation: 'portrait' });
        const pageW = doc.internal.pageSize.getWidth();   // 595.28
        const pageH = doc.internal.pageSize.getHeight();  // 841.89
        const M = 44;
        const SLATE = [15, 23, 42];
        const MUTED = [100, 116, 139];
        const FAINT = [148, 163, 184];
        const BORDER = [226, 232, 240];
        const TILE_BG = [248, 250, 252];

        const setColor = c => doc.setTextColor(c[0], c[1], c[2]);
        const label = (text, x, y, opts = {}) => {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7.5);
            setColor(MUTED);
            doc.text(text, x, y, opts);
        };

        let y = M + 8;

        // ── Header band ──
        label('GSE TERMINAL  ·  EQUITY TEAR SHEET', M, y);
        label('GENERATED', pageW - M, y, { align: 'right' });

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(26);
        setColor(SLATE);
        doc.text(sym, M, y + 30);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        setColor(SLATE);
        doc.text(generated, pageW - M, y + 16, { align: 'right' });
        doc.setFontSize(9);
        setColor(MUTED);
        const rangeStr = (rangeLabel ? rangeLabel + '  ·  ' : '') + `${fmtDate(stats.startDate)}  –  ${fmtDate(stats.endDate)}`;
        doc.text(rangeStr, pageW - M, y + 30, { align: 'right' });

        y += 44;
        doc.setDrawColor(SLATE[0], SLATE[1], SLATE[2]);
        doc.setLineWidth(1.2);
        doc.line(M, y, pageW - M, y);
        y += 26;

        // ── Price block ──
        const colGap = 220;
        label('LAST CLOSE', M, y);
        label('PERIOD RETURN', M + colGap, y);
        y += 26;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(30);
        setColor(SLATE);
        doc.text(fmtMoney(stats.last), M, y);

        const rc = stats.totalReturn >= 0 ? [5, 150, 105] : [220, 38, 38];
        doc.setFontSize(22);
        setColor(rc);
        doc.text(fmtPct(stats.totalReturn), M + colGap, y);

        y += 28;

        // ── Stats grid (4 tiles) ──
        const tiles = [
            ['PERIOD HIGH', fmtMoney(stats.high)],
            ['PERIOD LOW', fmtMoney(stats.low)],
            ['VOLATILITY (ANN.)', stats.vol.toFixed(2) + '%'],
            ['OBSERVATIONS', String(stats.points)]
        ];
        const gap = 12;
        const tileW = (pageW - 2 * M - 3 * gap) / 4;
        const tileH = 60;
        tiles.forEach((t, i) => {
            const x = M + i * (tileW + gap);
            doc.setFillColor(TILE_BG[0], TILE_BG[1], TILE_BG[2]);
            doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]);
            doc.setLineWidth(0.5);
            doc.roundedRect(x, y, tileW, tileH, 5, 5, 'FD');
            label(t[0], x + 12, y + 18);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(13);
            setColor(SLATE);
            doc.text(t[1], x + 12, y + 42);
        });
        y += tileH + 26;

        // ── Chart snapshot ──
        if (chartImg) {
            label('PRICE HISTORY', M, y);
            y += 12;
            const chartW = pageW - 2 * M;
            const chartH = 230;
            try {
                doc.addImage(chartImg, 'PNG', M, y, chartW, chartH, undefined, 'FAST');
            } catch (e) {
                console.warn('addImage failed', e);
            }
            doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]);
            doc.setLineWidth(0.5);
            doc.roundedRect(M, y, chartW, chartH, 5, 5, 'S');
            y += chartH + 26;
        }

        // ── AI Insight (structured fields, no prose summary) ──
        const footerTop = pageH - M - 18;
        const insight = (window._lastInsight && window._lastInsight.symbol === sym)
            ? window._lastInsight.data
            : null;
        if (insight) {
            label('AI INSIGHT', M, y);
            y += 14;

            const sig = (insight.signal || 'NEUTRAL').toUpperCase();
            const sigColor = sig === 'BULLISH' ? [5, 150, 105]
                           : sig === 'BEARISH' ? [220, 38, 38]
                           : [100, 116, 139];
            const sentVal = typeof insight.sentiment === 'number' ? insight.sentiment : 0;
            const sentLabel = sentVal > 0.3 ? 'Bullish' : sentVal < -0.3 ? 'Bearish' : 'Neutral';
            const conf = typeof insight.confidence === 'number' ? insight.confidence.toFixed(0) + '%' : '—';
            const fair = typeof insight.sma50 === 'number' ? fmtMoney(insight.sma50) : '—';
            const target = typeof insight.priceRangeLow === 'number' ? fmtMoney(insight.priceRangeLow) : '—';

            // 5 tiles matching the stats grid above
            const sentColor = sentVal > 0.3 ? [5, 150, 105]
                            : sentVal < -0.3 ? [220, 38, 38]
                            : SLATE;
            const insightTiles = [
                { label: 'SIGNAL', value: sig, fill: sigColor, valueColor: [255, 255, 255], labelColor: [255, 255, 255] },
                { label: 'CONFIDENCE', value: conf },
                { label: 'FAIR VALUE', value: fair },
                { label: 'PRICE TARGET', value: target },
                { label: 'SENTIMENT', value: sentLabel, valueColor: sentColor }
            ];
            const iGap = 12;
            const iTileW = (pageW - 2 * M - (insightTiles.length - 1) * iGap) / insightTiles.length;
            const iTileH = 60;
            insightTiles.forEach((t, i) => {
                const x = M + i * (iTileW + iGap);
                if (t.fill) {
                    doc.setFillColor(t.fill[0], t.fill[1], t.fill[2]);
                    doc.setDrawColor(t.fill[0], t.fill[1], t.fill[2]);
                } else {
                    doc.setFillColor(TILE_BG[0], TILE_BG[1], TILE_BG[2]);
                    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]);
                }
                doc.setLineWidth(0.5);
                doc.roundedRect(x, y, iTileW, iTileH, 5, 5, 'FD');

                doc.setFont('helvetica', 'bold');
                doc.setFontSize(7.5);
                setColor(t.labelColor || MUTED);
                doc.text(t.label, x + 12, y + 18);

                doc.setFont('helvetica', 'bold');
                doc.setFontSize(13);
                setColor(t.valueColor || SLATE);
                doc.text(t.value, x + 12, y + 42);
            });
            y += iTileH + 26;
        }

        // ── About (clipped to remaining space above footer) ──
        label('ABOUT', M, y);
        y += 14;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setLineHeightFactor(1.45);
        setColor([51, 65, 85]);
        const aboutLines = doc.splitTextToSize(about, pageW - 2 * M);
        const maxAboutLines = Math.max(0, Math.floor((footerTop - y - 8) / 13));
        doc.text(aboutLines.slice(0, maxAboutLines), M, y);
        doc.setLineHeightFactor(1.15);

        // ── Footer ──
        doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]);
        doc.setLineWidth(0.5);
        doc.line(M, footerTop, pageW - M, footerTop);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        setColor(FAINT);
        doc.text('Source: GSE Terminal  ·  End-of-day prices reported to the Ghana Stock Exchange.', M, footerTop + 12);
        doc.text('Not investment advice.', pageW - M, footerTop + 12, { align: 'right' });

        doc.save(`${sym}_GSE_TearSheet_${new Date().toISOString().split('T')[0]}.pdf`);
        window.showToast && window.showToast("Tear sheet exported", "success");
    } catch (e) {
        console.error("PDF Export failed", e);
        window.showToast && window.showToast("Failed to export tear sheet", "error");
    } finally {
        if (btn) btn.classList.remove('animate-pulse', 'text-blue-500');
    }
}

