// Mobile tab state — drives the body[data-tab="..."] attribute from
// the URL hash and highlights the matching chip. Replaces the chain
// of body:has(#x:target) CSS rules that required Safari ≥16.
//
// Valid values: 'home' | 'quote' | 'news' | 'movers' | 'watchlist'

const TAB_HASHES = {
    '#home': 'home',
    '#news': 'news',
    '#movers': 'movers',
    '#market-pulse-panel': 'movers',
    '#watchlist': 'watchlist',
    '#watchlist-panel-container': 'watchlist',
    '#portfolio': 'portfolio',
};

export function syncTabState() {
    const hash = window.location.hash;
    const tab = TAB_HASHES[hash] || '';
    if (tab) {
        document.body.dataset.tab = tab;
    } else {
        delete document.body.dataset.tab;
    }

    // Highlight the matching chip. Default active = first chip when no
    // stock is loaded ('home'), or second chip when a stock is loaded
    // ('quote'), mirroring the original :has()+:target CSS.
    const chips = document.querySelectorAll('.mobile-section-nav .mobile-tab');
    if (chips.length === 0) return;
    chips.forEach(c => {
        c.removeAttribute('data-tab-active');
        c.setAttribute('aria-selected', 'false');
    });

    const matchingChips = tab
        ? Array.from(chips).filter(c => (c.getAttribute('href') || '').slice(1) &&
            (TAB_HASHES[c.getAttribute('href')] === tab))
        : [];

    if (matchingChips.length > 0) {
        matchingChips.forEach(c => {
            c.setAttribute('data-tab-active', 'true');
            c.setAttribute('aria-selected', 'true');
        });
    } else {
        const selected = chips[document.body.dataset.view === 'stock' ? 1 : 0];
        if (selected) {
            selected.setAttribute('data-tab-active', 'true');
            selected.setAttribute('aria-selected', 'true');
        }
    }
}

// ── Mobile panel relocation ──────────────────────────────────────────
// On mobile (<1024px) the left-stock-panels block (Market Indicators +
// AI Oracle) moves out of the left aside into #chart-main, AND the
// Company Intelligence section moves out of the right #news aside into
// that same left-stock-panels block — so the three sections that the
// Overview / Intel tabs filter across all live in a single container
// on mobile. On desktop the relocations unwind and each section lives
// back in its original aside.

const MQ_MOBILE = window.matchMedia('(max-width: 1023px)');

function relocateIndicators() {
    const panels = document.getElementById('left-stock-panels');
    if (!panels) return;

    const chartMain = document.getElementById('chart-main');
    const leftAside = document.querySelector('aside.mobile-left-aside');
    if (!chartMain || !leftAside) return;

    if (MQ_MOBILE.matches) {
        // Move into chart-main (after the last child — below chart + comparables)
        if (panels.parentElement !== chartMain) {
            chartMain.appendChild(panels);
        }
    } else {
        // Return to left aside (before the first child so it appears at top)
        if (panels.parentElement !== leftAside) {
            leftAside.appendChild(panels);
        }
    }
}

function relocateCompanyIntel() {
    const about = document.querySelector('section[data-stock-section="about"]');
    if (!about) return;

    const leftPanels = document.getElementById('left-stock-panels');
    const sidebarContent = document.getElementById('sidebar-content');
    if (!leftPanels || !sidebarContent) return;

    if (MQ_MOBILE.matches) {
        // Insert after Market Indicators but before the AI Oracle section
        // (and its anchor span) so the Overview tab reads:
        //   Market Indicators → Company Intelligence → (Oracle, hidden).
        if (about.parentElement !== leftPanels) {
            const intelAnchor = leftPanels.querySelector('#intel');
            const oracle = leftPanels.querySelector('[data-stock-section="oracle"]');
            const before = intelAnchor || oracle;
            if (before) {
                leftPanels.insertBefore(about, before);
            } else {
                leftPanels.appendChild(about);
            }
        }
    } else {
        // Return to the right-aside sidebar-content. The section's
        // `order-2 lg:order-1` Tailwind class restores its desktop
        // position (About above News in the flex container).
        if (about.parentElement !== sidebarContent) {
            sidebarContent.appendChild(about);
        }
    }
}

function relocateStockNews() {
    const news = document.querySelector('section[data-stock-section="news"]');
    if (!news) return;

    const leftPanels = document.getElementById('left-stock-panels');
    const sidebarContent = document.getElementById('sidebar-content');
    if (!leftPanels || !sidebarContent) return;

    if (MQ_MOBILE.matches) {
        // Append after every existing panel — the News tab's filter
        // reveals only this section, and Overview/Intel hide it.
        if (news.parentElement !== leftPanels) {
            leftPanels.appendChild(news);
        }
    } else {
        // Return to sidebar-content. Tailwind `order-1 lg:order-2`
        // restores the desktop position (News below About).
        if (news.parentElement !== sidebarContent) {
            sidebarContent.appendChild(news);
        }
    }
}

function syncPanelLayout() {
    relocateIndicators();
    relocateCompanyIntel();
    relocateStockNews();
}

MQ_MOBILE.addEventListener('change', syncPanelLayout);
document.addEventListener('DOMContentLoaded', syncPanelLayout);

// ── Stock-detail section tab nav (mobile) ───────────────────────────
// Tapping a tab filters the visible [data-stock-section] blocks via
// a body-level data attribute that CSS keys off. Mapping:
//   overview → indicators + about
//   intel    → oracle
//   news     → news
// After filtering, scroll the first visible section into view so the
// new tab's content lands at the top (sticky section nav stays visible).
const STOCK_TAB_FIRST_SECTION = {
    overview: 'indicators',
    intel:    'oracle',
    news:     'news',
};

window.activateStockTab = function(key) {
    if (!STOCK_TAB_FIRST_SECTION[key]) return;
    document.querySelectorAll('.stock-section-tab').forEach(t => {
        const selected = t.dataset.section === key;
        t.classList.toggle('active', selected);
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    document.body.dataset.stockTab = key;
};

document.addEventListener('click', (e) => {
    const tab = e.target.closest('.stock-section-tab');
    if (!tab) return;
    const key = tab.dataset.section;
    if (!STOCK_TAB_FIRST_SECTION[key]) return;
    e.preventDefault();
    window.activateStockTab(key);
    // Scroll the first visible section to the top — sticky nav handles
    // the offset via CSS scroll-margin-top.
    const target = document.querySelector(`[data-stock-section="${STOCK_TAB_FIRST_SECTION[key]}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Legacy alias used by fetchHistory / clearSelectedStock
if (typeof window !== 'undefined') {
    window._syncTabState = syncTabState;
}
