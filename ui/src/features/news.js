// News — stock-specific (fetchNews) and market-wide (fetchMarketNews)
// feeds. Both render the same insight-card layout:
//   [ source + classification badge ] → [ time-ago meta ] → [ headline ]
//
// Extracted from charts/index.js (fetchNews) and panels/index.js
// (fetchMarketNews) so the two near-identical renderers share a file and
// a row template. The parseNewsTitle util is colocated in ./util/news.js
// — this module pulls it in so window.parseNewsTitle is guaranteed to be
// registered before the first call.
//
// Uses window globals — escapeHTML, timeAgo, parseNewsTitle,
// setConnectionState — so no new import wiring is needed at call sites.
// Window-registered so the action dispatcher + setInterval callbacks
// keep working unchanged.

import '../util/news.js'; // side-effect: registers window.parseNewsTitle

// Classification → badge palette. Centralised so the stock and market
// renderers stay in lockstep when a new classification (e.g. "MIXED")
// gets added server-side.
function classificationClass(c) {
    return c === 'POSITIVE' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
           c === 'NEGATIVE' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                              'bg-slate-500/10 text-slate-400 border-white/5';
}

// Render one news item as an insight-card row.
// `staggerBase` offsets where the stagger animation starts for this
// feed — stock news picks up after the price block (base 4) while market
// news picks up after the dashboard topbar (base 1). `maxOffset` caps
// the stagger-i var so very long feeds don't spiral into huge delays.
function renderNewsItem(item, index, staggerBase, maxOffset) {
    const c = item.classification || 'NEUTRAL';
    const parsed = window.parseNewsTitle(item.title);
    return `
    <a href="${window.escapeHTML(item.link)}" target="_blank" rel="noopener noreferrer" class="news-item block glass-card rounded-xl p-4 transition-all hover:bg-white/[0.04] border border-white/5 hover:border-white/10 group light:bg-white light:border-slate-200 light:hover:shadow-md stagger-enter" style="--stagger-i: ${staggerBase + Math.min(index, maxOffset)}">
        <div class="flex items-center justify-between mb-2">
            <span class="news-source text-sm font-bold font-display text-slate-200 group-hover:text-blue-400 transition-colors line-clamp-1 min-w-0 light:text-slate-800">${window.escapeHTML(parsed.source)}</span>
            <span class="px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest border shrink-0 ${classificationClass(c)}">${window.escapeHTML(c)}</span>
        </div>
        <div class="flex items-center gap-4 text-[10px] text-slate-500 mb-3 light:text-slate-500">
            <span>${window.timeAgo(item.pubDate)}</span>
        </div>
        <p class="news-headline text-[11px] text-slate-400 leading-relaxed line-clamp-3 light:text-slate-600">${window.escapeHTML(parsed.headline)}</p>
    </a>`;
}

// Stock-specific news — renders into #news-feed on the stock detail view.
window.fetchNews = async function(symbol) {
    const feed = document.getElementById('news-feed');
    const pulseTitle = document.getElementById('investor-pulse-title');
    if (pulseTitle) pulseTitle.innerText = `${symbol} News`;
    if (!feed) return;
    feed.innerHTML = `
        <div class="space-y-4">
            <div class="glow-surface glass-card rounded-2xl p-4 shimmer h-24 stagger-enter stagger-4"></div>
            <div class="glow-surface glass-card rounded-2xl p-4 shimmer h-24 stagger-enter stagger-5"></div>
            <div class="glow-surface glass-card rounded-2xl p-4 shimmer h-24 stagger-enter stagger-6"></div>
        </div>
    `;

    try {
        const signal = window.abortableSignal ? window.abortableSignal('news-stock') : undefined;
        const res = await fetch(`/v1/news?symbol=${encodeURIComponent(symbol)}`, { signal });
        if (!res.ok) {
            feed.innerHTML = `<p class="text-xs text-slate-500 leading-relaxed italic opacity-80">News engine temporarily throttled</p>`;
            return;
        }
        const news = await res.json();
        window.setConnectionState(false);

        if (!news || news.length === 0) {
            feed.innerHTML = `<p class="text-xs text-slate-500 leading-relaxed font-light italic opacity-80">No public press releases currently circulating for ${window.escapeHTML(symbol)} via primary nodes.</p>`;
            return;
        }
        feed.innerHTML = news.map((item, i) => renderNewsItem(item, i, 4, 4)).join('');
    } catch (e) {
        if (window.isAbortError && window.isAbortError(e)) return;
        feed.innerHTML = `<p class="text-xs text-rose-500/70 border border-rose-500/10 p-3 rounded-lg bg-rose-500/5">GSE Intelligence Link Failure: Connection dropped.</p>`;
    }
};

// Market-wide news — renders into #market-news-feed on the home view.
window.fetchMarketNews = async function() {
    const feed = document.getElementById('market-news-feed');
    if (!feed) return;
    try {
        const signal = window.abortableSignal ? window.abortableSignal('news-market') : undefined;
        const res = await fetch('/v1/market-news', { signal });
        if (!res.ok) throw new Error(`market-news ${res.status}`);
        const news = await res.json();
        window.setConnectionState(false);

        if (!news || news.length === 0) {
            feed.innerHTML = `<p class="text-[11px] text-slate-500 leading-relaxed font-light italic opacity-80">GSE primary nodes report no new public disclosures for the current session cycle.</p>`;
            return;
        }
        feed.innerHTML = news.map((item, i) => renderNewsItem(item, i, 1, 6)).join('');
    } catch (e) {
        if (window.isAbortError && window.isAbortError(e)) return;
        feed.innerHTML = `<p class="text-xs text-slate-500 italic">Unable to load market news.</p>`;
        window.setConnectionState(true);
    }
};
