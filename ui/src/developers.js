// Developer docs — stateful three-column reference with a live playground.
//
// The page is driven entirely off the ENDPOINTS registry below. For each
// endpoint the module:
//   1. Renders a sidebar entry (method chip + path)
//   2. Renders a content-stream section (description, params table)
//   3. Syncs a right-rail playground whose request builder + code samples
//      track whichever endpoint is visible in the viewport
//   4. Regenerates the code samples (cURL / JavaScript / Python) from
//      live param inputs — typing a ticker updates the curl string
//   5. Fakes a Send request: animates the status pill + reveals the mock
//      JSON line-by-line like a ticker tape
//
// Mock response shapes mirror the real handlers in internal/server/*.go —
// keep them in lockstep when the real endpoints change.

// Pull the compiled Tailwind bundle so the HTML's utility classes
// (max-w-[1400px], grid-cols-12, bg-[var(--ink)], etc.) have
// definitions. The page's own inline :root + `html, body { background:
// var(--ink); }` rules override the app's shared dark-slate theme so
// the landing-page palette wins cleanly.
import './styles.css';
// WS connection + persistent admin-notifications widget — needed so an
// admin browsing the developers page still sees the floating bell when
// a Pro request lands. Both modules self-gate (socket.js no-ops without
// a session; admin-notifications no-ops for non-admins).
import './live/socket.js';
import './features/admin-notifications.js';

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://your-host';
const SAMPLE_KEY = 'ges_live_…';  // Shown in code samples; never a real key.

// ─── Registry ─────────────────────────────────────────────────────────────
//
// `params` describes both path / query / body params. `in: 'body'` entries
// are serialised as a single JSON body; `in: 'query'` entries concatenate
// onto the URL. The playground renders inputs for whichever are present.

const CATEGORIES = [
    {
        id: 'market',
        folio: '§ I · 03.14',
        title: ['Market data,', 'the live wire.'],
        desc: 'Public-keyless endpoints for quotes, history, batch compare, news and the daily briefing.',
        endpoints: ['history', 'compare', 'symbols', 'summary', 'briefing', 'news'],
    },
    {
        id: 'analytics',
        folio: '§ II · 03.15',
        title: ['Analytics &', 'the Oracle.'],
        desc: 'RSI, sentiment and fair-value anchors for a single ticker; sector rollups; natural-language screening against a whitelisted SQL surface.',
        endpoints: ['insight', 'sectors', 'query'],
    },
    {
        id: 'user',
        folio: '§ III · 03.16',
        title: ['User &', 'watchlist.'],
        desc: 'Caller identity, watchlist CRUD, and watchlist alert rules with email + in-app delivery.',
        endpoints: ['me', 'watchlist', 'alerts-list', 'alerts-create'],
    },
    {
        id: 'keys',
        folio: '§ IV · 03.17',
        title: ['API keys.'],
        desc: 'Provision and revoke bearer keys scoped to your account. The raw key is returned only at creation time — store it at the callsite.',
        endpoints: ['keys-list', 'keys-create'],
    },
];

const ENDPOINTS = {
    history: {
        method: 'GET', path: '/v1/history', auth: 'public',
        title: 'Fetch OHLC history',
        desc: 'OHLC bars for a single symbol. Intervals sample the underlying tick stream into candles server-side.',
        params: [
            { name: 'symbol',   in: 'query', type: 'string', required: true, default: 'MTNGH', desc: 'Ticker (e.g. MTNGH)' },
            { name: 'interval', in: 'query', type: 'string', required: true, default: '1d',    desc: 'Sampling window: 1d · 1w · 1M' },
        ],
        response: {
            status: 200,
            body: [
                { timestamp: '2026-04-07T15:30:00Z', open: 1.42, high: 1.48, low: 1.41, close: 1.46, volume: 128400 },
                { timestamp: '2026-04-08T15:30:00Z', open: 1.46, high: 1.49, low: 1.44, close: 1.48, volume: 156200 },
                { timestamp: '2026-04-09T15:30:00Z', open: 1.48, high: 1.52, low: 1.47, close: 1.51, volume: 198700 },
                { timestamp: '2026-04-10T15:30:00Z', open: 1.51, high: 1.53, low: 1.49, close: 1.50, volume: 143900 },
                { timestamp: '2026-04-14T15:30:00Z', open: 1.50, high: 1.55, low: 1.50, close: 1.54, volume: 211800 },
            ],
        },
    },

    compare: {
        method: 'GET', path: '/v1/compare', auth: 'public',
        title: 'Batch OHLC for up to four symbols',
        desc: 'Four-way compare in a single round-trip. Drives the Terminal\u2019s normalised overlay chart.',
        params: [
            { name: 'symbols',  in: 'query', type: 'string', required: true,  default: 'MTNGH,GCB,FML', desc: 'Comma-separated tickers, max 4' },
            { name: 'interval', in: 'query', type: 'string', required: false, default: '1d',           desc: 'Defaults to 1d' },
        ],
        response: {
            status: 200,
            body: {
                MTNGH: [{ timestamp: '2026-04-10T15:30:00Z', close: 1.50 }, { timestamp: '2026-04-14T15:30:00Z', close: 1.54 }],
                GCB:   [{ timestamp: '2026-04-10T15:30:00Z', close: 6.85 }, { timestamp: '2026-04-14T15:30:00Z', close: 6.92 }],
                FML:   [{ timestamp: '2026-04-10T15:30:00Z', close: 3.20 }, { timestamp: '2026-04-14T15:30:00Z', close: 3.27 }],
            },
        },
    },

    symbols: {
        method: 'GET', path: '/v1/symbols', auth: 'public',
        title: 'All listed symbols',
        desc: 'Every ticker listed on the exchange. Updated as the collector ingests the daily feed.',
        params: [],
        response: {
            status: 200,
            body: ['ACCESS','ALW','ASG','CAL','CLYD','EGH','EGL','ETI','FML','GCB','GOIL','MTNGH','RBGH','SCB','SIC','SOGEGH','TBL','TOTAL','UNIL'],
        },
    },

    summary: {
        method: 'GET', path: '/v1/market-summary', auth: 'public',
        title: 'Latest market snapshot',
        desc: 'One row per listed symbol with last price, % change, and session volume.',
        params: [],
        response: {
            status: 200,
            body: [
                { symbol: 'MTNGH', openPrice: 1.50, lastPrice: 1.54, priceChange: 0.04, percentChange: 2.67, volume: 211800 },
                { symbol: 'GCB',   openPrice: 6.85, lastPrice: 6.92, priceChange: 0.07, percentChange: 1.02, volume: 84300 },
                { symbol: 'FML',   openPrice: 3.20, lastPrice: 3.27, priceChange: 0.07, percentChange: 2.19, volume: 46700 },
                { symbol: 'SCB',   openPrice: 21.40, lastPrice: 21.25, priceChange: -0.15, percentChange: -0.70, volume: 12400 },
            ],
        },
    },

    briefing: {
        method: 'GET', path: '/v1/briefing', auth: 'public',
        title: 'Daily AI briefing',
        desc: 'The most recent AI-written market roll-up plus per-symbol verdicts for the session\u2019s most active tickers.',
        params: [],
        response: {
            status: 200,
            body: {
                tradingDate: '2026-04-14',
                summary: 'Financials extended a three-session advance as MTNGH tagged a fresh YTD high on thin volume; consumer staples trailed on profit-taking in FML. Breadth 12 up / 7 down.',
                averageSentiment: 0.31,
                insights: [
                    { symbol: 'MTNGH', verdict: 'Constructive', rsi: 62.4, sentiment: 0.71 },
                    { symbol: 'GCB',   verdict: 'Neutral',      rsi: 54.1, sentiment: 0.12 },
                    { symbol: 'FML',   verdict: 'Cautious',     rsi: 71.8, sentiment: -0.22 },
                ],
            },
        },
    },

    news: {
        method: 'GET', path: '/v1/news', auth: 'public',
        title: 'Ticker news feed',
        desc: 'Recent headlines for a ticker, each scored with a recency-weighted sentiment value in [\u22121, +1].',
        params: [
            { name: 'symbol', in: 'query', type: 'string', required: true, default: 'MTNGH', desc: 'Ticker to fetch headlines for' },
        ],
        response: {
            status: 200,
            body: [
                { title: 'MTN Ghana posts Q1 subscriber gains, lifts data revenue 18%', source: 'Business Day GH', publishedAt: '2026-04-14T08:12:00Z', sentiment: 0.62 },
                { title: 'Bank of Ghana holds policy rate; hints at cut in June',      source: 'Graphic Business', publishedAt: '2026-04-13T17:45:00Z', sentiment: 0.28 },
                { title: 'Consumer-staples pullback tempers index momentum',            source: 'JoyBusiness',      publishedAt: '2026-04-12T09:30:00Z', sentiment: -0.15 },
            ],
        },
    },

    insight: {
        method: 'GET', path: '/v1/ai-insight', auth: 'pro',
        title: 'AI Market Oracle verdict',
        desc: 'RSI, ATR, sentiment, fair-value anchor and a short LLM-written consensus for a single ticker. Budgeted at 10 rpm/user.',
        params: [
            { name: 'symbol', in: 'query', type: 'string', required: true, default: 'MTNGH', desc: 'Ticker' },
        ],
        response: {
            status: 200,
            body: {
                symbol: 'MTNGH', signal: 'BULLISH', confidence: 78,
                suggestedPrice: 1.48, fairValue: 1.43,
                sentiment: 0.71, sentimentLabel: 'Positive',
                rsi: 62.4, atr: 0.084,
                aboveSMA50: true, aboveSMA20: true, sampleSize: 62,
                analysis: 'Constructive setup: price holds above both moving averages, RSI in the upper-neutral band (62.4) suggests momentum without overbought stretch, and sentiment is firmly positive on strong subscriber-growth headlines.',
            },
        },
    },

    sectors: {
        method: 'GET', path: '/v1/market-sectors', auth: 'pro',
        title: 'Turnover-weighted sector rollup',
        desc: 'Average % change, total volume, breadth counts, and top-gainer / worst-loser per sector.',
        params: [
            { name: 'detail', in: 'query', type: 'string', required: false, default: 'summary', desc: 'Pass "summary" to drop the constituents array (~70% smaller payload).' },
        ],
        response: {
            status: 200,
            body: [
                { sector: 'Financials',       avgPctChange:  1.14, totalVolume: 412600, advanceCount: 6, declineCount: 2, topGainer: { symbol: 'GCB',   percentChange: 2.18 }, worstLoser: { symbol: 'SCB', percentChange: -0.70 } },
                { sector: 'Telecom',          avgPctChange:  2.67, totalVolume: 211800, advanceCount: 1, declineCount: 0, topGainer: { symbol: 'MTNGH', percentChange: 2.67 }, worstLoser: { symbol: 'MTNGH', percentChange: 2.67 } },
                { sector: 'Consumer Staples', avgPctChange: -0.42, totalVolume:  46700, advanceCount: 2, declineCount: 3, topGainer: { symbol: 'FML',   percentChange: 2.19 }, worstLoser: { symbol: 'UNIL', percentChange: -2.10 } },
            ],
        },
    },

    query: {
        method: 'POST', path: '/v1/query', auth: 'pro',
        title: 'Natural-language screen',
        desc: 'Plain-text questions resolved against a whitelisted SQL surface. Budgeted at 10 rpm/user.',
        params: [
            { name: 'question', in: 'body', type: 'string', required: true, default: 'Banks with RSI below 35 and positive YTD return', desc: 'Plain-English query' },
        ],
        response: {
            status: 200,
            body: {
                question: 'Banks with RSI below 35 and positive YTD return',
                rows: [
                    { symbol: 'GCB', rsi: 31.2, ytd_return: 4.7, last_price: 6.92 },
                    { symbol: 'SCB', rsi: 28.9, ytd_return: 1.3, last_price: 21.25 },
                    { symbol: 'CAL', rsi: 33.5, ytd_return: 2.8, last_price: 0.92 },
                ],
                generatedSQL: "SELECT symbol, rsi, ytd_return, last_price FROM screener WHERE sector = 'Financials' AND rsi < 35 AND ytd_return > 0",
            },
        },
    },

    me: {
        method: 'GET', path: '/v1/me', auth: 'auth',
        title: 'Caller identity',
        desc: 'Username, role, email + verification state, linked OAuth provider, password state.',
        params: [],
        response: {
            status: 200,
            body: {
                isAuthenticated: true, username: 'accra_trader', role: 'pro', isAdmin: false,
                email: 'trader@example.com', emailVerified: true, hasPassword: true,
                provider: 'google', providerEmail: 'trader@example.com',
                availableProviders: [{ name: 'google', displayName: 'Google' }],
            },
        },
    },

    watchlist: {
        method: 'GET', path: '/v1/watchlist', auth: 'auth',
        title: 'Caller\u2019s watchlist',
        desc: 'Starred symbols with the latest market snapshot joined on.',
        params: [],
        response: {
            status: 200,
            body: {
                symbols: ['MTNGH', 'GCB', 'FML'],
                details: [
                    { symbol: 'MTNGH', lastPrice: 1.54, percentChange: 2.67, volume: 211800 },
                    { symbol: 'GCB',   lastPrice: 6.92, percentChange: 1.02, volume: 84300 },
                    { symbol: 'FML',   lastPrice: 3.27, percentChange: 2.19, volume: 46700 },
                ],
            },
        },
    },

    'alerts-list': {
        method: 'GET', path: '/v1/me/alerts', auth: 'pro',
        title: 'List watchlist alerts',
        desc: 'All rules belonging to the caller \u2014 armed and paused. A rule fires at most once before going to paused.',
        params: [],
        response: {
            status: 200,
            body: [
                { id: 142, userId: 9, symbol: 'MTNGH', metric: 'price', op: '>',  threshold: 1.50,  enabled: false, lastFiredAt: '2026-04-14T15:31:02Z', fireCount: 1 },
                { id: 141, userId: 9, symbol: 'ALW',   metric: 'price', op: '<',  threshold: 12.00, enabled: true,  lastFiredAt: null, fireCount: 0 },
                { id: 138, userId: 9, symbol: 'GCB',   metric: 'rsi',   op: '<',  threshold: 30,    enabled: true,  lastFiredAt: null, fireCount: 0 },
            ],
        },
    },

    'alerts-create': {
        method: 'POST', path: '/v1/me/alerts', auth: 'pro',
        title: 'Create watchlist alert',
        desc: 'New alert rule. Requires a verified email on the caller\u2019s account.',
        params: [
            { name: 'symbol',    in: 'body', type: 'string',  required: true, default: 'MTNGH', desc: 'Ticker' },
            { name: 'metric',    in: 'body', type: 'enum',    required: true, default: 'price', desc: 'price · rsi · pct_change' },
            { name: 'op',        in: 'body', type: 'enum',    required: true, default: '>',     desc: '> · < · >= · <=' },
            { name: 'threshold', in: 'body', type: 'number',  required: true, default: 1.50,    desc: 'Value the metric is compared against' },
        ],
        response: { status: 201, body: { id: 143 } },
    },

    'keys-list': {
        method: 'GET', path: '/v1/me/api-keys', auth: 'auth',
        title: 'List your API keys',
        desc: 'Only the prefix is stored server-side. The raw key is returned only at creation time.',
        params: [],
        response: {
            status: 200,
            body: [
                { id: 3, prefix: 'ges_live_aZ8k', name: 'my-laptop',   createdAt: '2026-03-22T10:12:00Z', lastUsedAt: '2026-04-14T09:40:00Z' },
                { id: 2, prefix: 'ges_live_jF2m', name: 'ci-pipeline', createdAt: '2026-03-05T17:08:00Z', lastUsedAt: '2026-04-14T00:00:00Z' },
            ],
        },
    },

    'keys-create': {
        method: 'POST', path: '/v1/me/api-keys', auth: 'auth',
        title: 'Provision a new API key',
        desc: 'The raw `key` is returned once. Store it at the callsite.',
        params: [
            { name: 'name', in: 'body', type: 'string', required: false, default: 'screener-bot', desc: 'Display label, max 200 chars' },
        ],
        response: { status: 200, body: { id: 4, prefix: 'ges_live_qR4v', name: 'screener-bot', key: 'ges_live_qR4v9n8xK2pLm1dC5wY3zH7vE6tB0sJ4uA8iO' } },
    },
};

// ─── State ─────────────────────────────────────────────────────────────────

const state = {
    activeEndpoint: CATEGORIES[0].endpoints[0],   // id key in ENDPOINTS
    language: 'curl',                             // curl | js | python
    paramValues: {},                              // { endpointId: { paramName: value } }
    lastResponse: null,                           // rendered in the pg response block
};

// Seed default param values from the registry.
for (const id of Object.keys(ENDPOINTS)) {
    state.paramValues[id] = {};
    for (const p of ENDPOINTS[id].params || []) {
        state.paramValues[id][p.name] = p.default ?? '';
    }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const slug = (s) => String(s).replace(/[^a-z0-9-]/gi, '-').toLowerCase();

// Syntax-highlight a JSON string (stringified, pretty-printed).
// Differentiates keys, strings, numbers, booleans, null.
function hlJSON(json) {
    const safe = esc(json);
    return safe.replace(
        /("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
        (m) => {
            if (/^"/.test(m)) {
                if (/:$/.test(m)) return `<span class="c-k">${m}</span>`;
                return `<span class="c-s">${m}</span>`;
            }
            if (m === 'true' || m === 'false') return `<span class="c-b">${m}</span>`;
            if (m === 'null') return `<span class="c-nul">${m}</span>`;
            return `<span class="c-n">${m}</span>`;
        },
    );
}

// Lightweight cURL highlighter — options + URLs + strings.
function hlCurl(src) {
    const safe = esc(src);
    return safe
        .replace(/(^|\s)(curl)\b/g, '$1<span class="c-fn">$2</span>')
        .replace(/(\s)(-[A-Za-z]|--[a-zA-Z-]+)/g, '$1<span class="c-k">$2</span>')
        .replace(/('[^']*')/g, '<span class="c-s">$1</span>')
        .replace(/(https?:\/\/[^\s'"\\]+)/g, '<span class="c-pn">$1</span>');
}

// Lightweight JS highlighter — keywords, strings, numbers.
function hlJS(src) {
    let s = esc(src);
    s = s.replace(/(&#39;[^&#;]*&#39;|&quot;[^&quot;]*&quot;|`[^`]*`)/g, '<span class="c-s">$1</span>');
    s = s.replace(/\b(const|let|await|return|async|function|new|if|else|await|of|in)\b/g, '<span class="c-k">$1</span>');
    s = s.replace(/\b(fetch|JSON|json|headers)\b/g, '<span class="c-fn">$1</span>');
    s = s.replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="c-n">$1</span>');
    s = s.replace(/(\/\/.*$)/gm, '<span class="c-cm">$1</span>');
    return s;
}

// Lightweight Python highlighter.
function hlPy(src) {
    let s = esc(src);
    s = s.replace(/(&#39;[^&#;]*&#39;|&quot;[^&quot;]*&quot;)/g, '<span class="c-s">$1</span>');
    s = s.replace(/\b(import|from|as|def|return|if|else|for|in|True|False|None)\b/g, '<span class="c-k">$1</span>');
    s = s.replace(/\b(requests|json|print)\b/g, '<span class="c-fn">$1</span>');
    s = s.replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="c-n">$1</span>');
    s = s.replace(/(#.*$)/gm, '<span class="c-cm">$1</span>');
    return s;
}

// Build the final URL + body for an endpoint using its current param values.
function buildRequest(id) {
    const ep = ENDPOINTS[id];
    const vals = state.paramValues[id] || {};
    const qs = (ep.params || []).filter(p => p.in === 'query' && vals[p.name] !== '' && vals[p.name] != null);
    const body = (ep.params || []).filter(p => p.in === 'body');
    let url = BASE_URL + ep.path;
    if (qs.length) {
        url += '?' + qs.map(p => `${encodeURIComponent(p.name)}=${encodeURIComponent(vals[p.name])}`).join('&');
    }
    let bodyObj = null;
    if (body.length) {
        bodyObj = {};
        for (const p of body) {
            let v = vals[p.name];
            if (p.type === 'number' && v !== '' && v != null) v = Number(v);
            bodyObj[p.name] = v;
        }
    }
    return { ep, url, bodyObj };
}

// ─── Code sample generators ────────────────────────────────────────────────

function sampleCurl(id) {
    const { ep, url, bodyObj } = buildRequest(id);
    const parts = [`curl`];
    if (ep.method !== 'GET') parts.push(`-X ${ep.method}`);
    if (ep.auth !== 'public') parts.push(`-H 'Authorization: Bearer ${SAMPLE_KEY}'`);
    if (bodyObj) {
        parts.push(`-H 'Content-Type: application/json'`);
        parts.push(`-d '${JSON.stringify(bodyObj)}'`);
    }
    parts.push(`'${url}'`);
    return parts.join(' \\\n     ');
}

function sampleJS(id) {
    const { ep, url, bodyObj } = buildRequest(id);
    const headers = {};
    if (ep.auth !== 'public') headers['Authorization'] = `Bearer ${SAMPLE_KEY}`;
    if (bodyObj) headers['Content-Type'] = 'application/json';
    const hdrLines = Object.entries(headers).map(([k, v]) => `    '${k}': '${v}'`).join(',\n');
    const lines = [];
    lines.push(`const res = await fetch('${url}', {`);
    if (ep.method !== 'GET') lines.push(`  method: '${ep.method}',`);
    if (hdrLines) lines.push(`  headers: {\n${hdrLines}\n  },`);
    if (bodyObj) lines.push(`  body: JSON.stringify(${JSON.stringify(bodyObj, null, 2).replace(/\n/g, '\n  ')}),`);
    lines.push(`});`);
    lines.push(`const data = await res.json();`);
    return lines.join('\n');
}

function samplePy(id) {
    const { ep, url, bodyObj } = buildRequest(id);
    const headers = {};
    if (ep.auth !== 'public') headers['Authorization'] = `Bearer ${SAMPLE_KEY}`;
    const fn = ep.method === 'GET' ? 'requests.get' : 'requests.post';
    // Rebuild URL without the query string so requests handles it from params=
    const plainURL = BASE_URL + ep.path;
    const queryParams = (ep.params || []).filter(p => p.in === 'query');
    const pyQueryVals = {};
    for (const p of queryParams) pyQueryVals[p.name] = state.paramValues[id][p.name];

    const lines = [`import requests`, ``];
    lines.push(`r = ${fn}(`);
    lines.push(`    '${plainURL}',`);
    if (Object.keys(headers).length) {
        lines.push(`    headers=${JSON.stringify(headers).replace(/"/g, "'")},`);
    }
    if (Object.keys(pyQueryVals).length && ep.method === 'GET') {
        lines.push(`    params=${JSON.stringify(pyQueryVals, null, 4).replace(/"/g, "'").replace(/\n/g, '\n    ')},`);
    }
    if (bodyObj) {
        lines.push(`    json=${JSON.stringify(bodyObj, null, 4).replace(/"/g, "'").replace(/\n/g, '\n    ')},`);
    }
    lines.push(`)`);
    lines.push(`data = r.json()`);
    return lines.join('\n');
}

// ─── Sidebar ───────────────────────────────────────────────────────────────

function renderSidebar() {
    const el = document.getElementById('sidebar-list');
    if (!el) return;
    const frags = [];
    for (const cat of CATEGORIES) {
        frags.push(`<div class="sidebar-cat">${esc(cat.id)}</div>`);
        for (const id of cat.endpoints) {
            const ep = ENDPOINTS[id];
            frags.push(`
                <a class="sidebar-link" href="#ep-${esc(id)}" data-sb-link="${esc(id)}">
                    <span class="v ${ep.method.toLowerCase()}">${esc(ep.method)}</span>
                    <span class="pth">${esc(ep.path)}</span>
                </a>`);
        }
    }
    frags.push(`<div class="sidebar-cat" style="margin-top:26px">reference</div>`);
    frags.push(`<a class="sidebar-link" href="#cat-errors" style="padding-left:22px"><span class="v" style="color:rgba(244,236,216,.4)">§ V</span><span class="pth">Errors</span></a>`);
    el.innerHTML = frags.join('');
}

function setActiveSidebar(id) {
    document.querySelectorAll('[data-sb-link]').forEach(l => {
        l.classList.toggle('active', l.getAttribute('data-sb-link') === id);
    });
}

// ─── Content stream ────────────────────────────────────────────────────────

function renderContentStream() {
    const el = document.getElementById('ep-stream');
    if (!el) return;
    const frags = [];
    for (const cat of CATEGORIES) {
        frags.push(`<hr class="ep-section-divider">`);
        frags.push(`<section class="ep-section" id="cat-${esc(cat.id)}">`);
        frags.push(`  <div class="ep-cat-head">`);
        frags.push(`    <span class="ep-cat-folio">${esc(cat.folio)}</span>`);
        frags.push(`    <h2 class="ep-cat-title">${esc(cat.title[0])} <em>${esc(cat.title[1] || '')}</em></h2>`);
        frags.push(`  </div>`);
        frags.push(`  <p class="ep-cat-desc">${esc(cat.desc)}</p>`);
        for (const id of cat.endpoints) {
            frags.push(renderEndpointCard(id));
        }
        frags.push(`</section>`);
    }
    el.innerHTML = frags.join('');
}

function renderEndpointCard(id) {
    const ep = ENDPOINTS[id];
    const authLabel = ep.auth === 'public' ? 'public' : (ep.auth === 'pro' ? 'Pro · Admin' : 'Authenticated');
    const authCls = ep.auth === 'pro' ? 'ep-auth pro' : 'ep-auth';
    const hasParams = (ep.params || []).length > 0;
    const paramsTable = hasParams ? `
        <div class="param-head">${esc(ep.method === 'POST' || ep.method === 'PATCH' ? 'Body' : 'Parameters')}</div>
        <table class="param-table">
            <thead><tr><th>Field</th><th>Type</th><th>Req.</th><th>Description</th></tr></thead>
            <tbody>
                ${ep.params.map(p => `
                    <tr>
                        <td class="pname">${esc(p.name)}</td>
                        <td class="ptype">${esc(p.type)}</td>
                        <td class="preq ${p.required ? 'r' : 'o'}">${p.required ? 'required' : 'optional'}</td>
                        <td>${esc(p.desc)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : '';

    return `
        <article class="ep-card" id="ep-${esc(id)}" data-ep="${esc(id)}">
            <div class="ep-head">
                <span class="verb verb-${ep.method.toLowerCase()}">${esc(ep.method)}</span>
                <code class="ep-path">${esc(ep.path)}</code>
                <span class="${authCls}">${esc(authLabel)}</span>
            </div>
            <h3 class="ep-title">${esc(ep.title)}</h3>
            <p class="ep-desc">${esc(ep.desc)}</p>
            ${paramsTable}
        </article>`;
}

// ─── Playground ────────────────────────────────────────────────────────────

function renderPlayground() {
    const el = document.getElementById('pg-root');
    if (!el) return;
    const id = state.activeEndpoint;
    const ep = ENDPOINTS[id];

    // Build param input rows
    const inputs = (ep.params || []).map(p => {
        const val = state.paramValues[id][p.name] ?? '';
        const lbl = `${esc(p.name)}${p.required ? '<span class="req">*</span>' : ''}`;
        const input = (p.type === 'enum')
            ? (() => {
                // Naive enum derivation from the default or the desc
                const opts = (p.desc.match(/[A-Za-z_>=<]+/g) || [p.default]).filter(Boolean).slice(0, 6);
                return `<select data-pg-param="${esc(p.name)}">${opts.map(o => `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
            })()
            : `<input type="${p.type === 'number' ? 'number' : 'text'}" data-pg-param="${esc(p.name)}" value="${esc(val)}" placeholder="${esc(p.default ?? '')}" autocomplete="off" spellcheck="false">`;
        return `
            <div class="pg-param">
                <label>${lbl}</label>
                ${input}
                <div class="desc">${esc(p.desc)}</div>
            </div>`;
    }).join('');

    const inputsBlock = (ep.params && ep.params.length) ? `
        <div class="pg-block">
            <div class="pg-block-head">${ep.method === 'GET' ? 'Parameters' : (ep.params.some(p => p.in === 'body') ? 'Body' : 'Parameters')}</div>
            <div class="pg-block-body">${inputs}</div>
        </div>` : `
        <div class="pg-block">
            <div class="pg-block-head">No parameters</div>
            <div class="pg-block-body" style="padding:14px;color:rgba(244,236,216,0.45);font-family:'IBM Plex Mono',monospace;font-size:11px;">This endpoint takes no inputs.</div>
        </div>`;

    el.innerHTML = `
        <div class="pg-head">
            <span class="verb verb-${ep.method.toLowerCase()}">${esc(ep.method)}</span>
            <code class="pg-path">${esc(ep.path)}</code>
        </div>

        ${inputsBlock}

        <button class="pg-send" data-pg-send aria-label="Send request">Send request →</button>

        <div class="pg-block" style="margin-top:20px">
            <div class="pg-response-head">
                ${state.lastResponse && state.lastResponse.endpointId === id
                    ? `<span class="pg-status s-${state.lastResponse.status}">${state.lastResponse.status} ${state.lastResponse.statusText}</span>
                       <span class="pg-timing">${state.lastResponse.timing} ms</span>`
                    : `<span style="color:rgba(244,236,216,0.4)">Response · dummy</span>
                       <span style="color:rgba(244,236,216,0.25)">Awaiting send</span>`}
            </div>
            <div class="pg-response-body" data-pg-response>
                ${state.lastResponse && state.lastResponse.endpointId === id
                    ? `<pre class="code">${hlJSON(state.lastResponse.rendered)}</pre>`
                    : `<div class="pg-response-empty">Tap <strong style="color:var(--amber);">Send request</strong><br>to see a dummy payload.</div>`}
            </div>
        </div>

        <div class="pg-block" style="margin-top:20px">
            <div class="pg-lang">
                <button data-pg-lang="curl"   class="${state.language==='curl'?'active':''}">cURL</button>
                <button data-pg-lang="js"     class="${state.language==='js'?'active':''}">JavaScript</button>
                <button data-pg-lang="python" class="${state.language==='python'?'active':''}">Python</button>
                <div style="flex:1"></div>
                <button class="pg-copy" data-pg-copy="code" style="margin:6px 8px">Copy</button>
            </div>
            <pre class="code" id="pg-code"></pre>
        </div>
    `;

    renderCode();
}

function renderCode() {
    const el = document.getElementById('pg-code');
    if (!el) return;
    const id = state.activeEndpoint;
    let src = '';
    let highlighter = hlCurl;
    if (state.language === 'curl')   { src = sampleCurl(id);   highlighter = hlCurl; }
    else if (state.language === 'js')     { src = sampleJS(id); highlighter = hlJS;   }
    else if (state.language === 'python') { src = samplePy(id); highlighter = hlPy;   }
    el.innerHTML = highlighter(src);
    el.setAttribute('data-raw', src);
}

// ─── Send (animated mock) ──────────────────────────────────────────────────

function fakeSend() {
    const id = state.activeEndpoint;
    const ep = ENDPOINTS[id];
    const body = document.querySelector('[data-pg-response]');
    const btn = document.querySelector('[data-pg-send]');
    const headEl = document.querySelector('.pg-response-head');
    if (!body || !btn || !headEl) return;

    btn.disabled = true;
    btn.textContent = 'Sending…';

    // Loading state
    body.classList.add('loading');
    headEl.innerHTML = `<span style="color:var(--amber)">Dispatching…</span><span class="pg-timing">—</span>`;

    // Simulate network: 260–480ms randomised
    const timing = Math.round(260 + Math.random() * 220);
    setTimeout(() => {
        body.classList.remove('loading');
        const status = ep.response?.status ?? 200;
        const statusText = statusPhrase(status);
        const rendered = JSON.stringify(ep.response?.body ?? {}, null, 2);

        state.lastResponse = { endpointId: id, status, statusText, timing, rendered };

        // Update the header pill
        headEl.innerHTML = `
            <span class="pg-status s-${status}">${status} ${statusText}</span>
            <span class="pg-timing">${timing} ms</span>
        `;

        // Ticker-tape reveal of the JSON body — each line fades in with a
        // short cascading delay. Sells the "live wire" feel without
        // sacrificing readability.
        const lines = rendered.split('\n');
        const html = `<pre class="code">${lines.map((line, i) =>
            `<span class="rev-line" style="animation-delay:${Math.min(i * 18, 420)}ms">${hlJSON(line) || '&nbsp;'}</span>`
        ).join('\n')}</pre>`;
        body.innerHTML = html;
        body.classList.add('revealing');

        btn.disabled = false;
        btn.textContent = 'Send again →';

        // Remove the revealing class once animations have completed so the
        // next render doesn't inherit stale opacity transitions.
        const totalDelay = Math.min(lines.length * 18, 420) + 300;
        setTimeout(() => body.classList.remove('revealing'), totalDelay);
    }, timing);
}

function statusPhrase(s) {
    return { 200:'OK', 201:'Created', 204:'No Content', 400:'Bad Request', 401:'Unauthorized',
             403:'Forbidden', 404:'Not Found', 409:'Conflict', 429:'Rate Limited', 500:'Internal' }[s] || '';
}

// ─── Event wiring ──────────────────────────────────────────────────────────

function copyText(str, feedbackEl) {
    try {
        navigator.clipboard.writeText(str).then(() => {
            if (feedbackEl) {
                feedbackEl.classList.add('copied');
                const prev = feedbackEl.textContent;
                feedbackEl.textContent = 'Copied';
                setTimeout(() => { feedbackEl.classList.remove('copied'); feedbackEl.textContent = prev; }, 1200);
            }
        });
    } catch (_) { /* clipboard unavailable */ }
}

function wireEvents() {
    // Sidebar click — smooth scroll and set active.
    document.addEventListener('click', (e) => {
        const link = e.target.closest('[data-sb-link]');
        if (link) {
            const id = link.getAttribute('data-sb-link');
            state.activeEndpoint = id;
            setActiveSidebar(id);
            renderPlayground();
            return;
        }

        const langBtn = e.target.closest('[data-pg-lang]');
        if (langBtn) {
            state.language = langBtn.getAttribute('data-pg-lang');
            // Refresh tab actives without a full re-render
            document.querySelectorAll('[data-pg-lang]').forEach(b =>
                b.classList.toggle('active', b.getAttribute('data-pg-lang') === state.language));
            renderCode();
            return;
        }

        const sendBtn = e.target.closest('[data-pg-send]');
        if (sendBtn) {
            fakeSend();
            return;
        }

        const copyBtn = e.target.closest('[data-pg-copy]');
        if (copyBtn) {
            const codeEl = document.getElementById('pg-code');
            const raw = codeEl ? codeEl.getAttribute('data-raw') : '';
            if (raw) copyText(raw, copyBtn);
            return;
        }
    });

    // Param input — regenerate code samples live.
    document.addEventListener('input', (e) => {
        const t = e.target.closest('[data-pg-param]');
        if (!t) {
            if (e.target.id === 'ep-search') filterSidebar(e.target.value);
            return;
        }
        const name = t.getAttribute('data-pg-param');
        state.paramValues[state.activeEndpoint][name] = t.value;
        renderCode();
    });
    document.addEventListener('change', (e) => {
        const t = e.target.closest('[data-pg-param]');
        if (!t) return;
        const name = t.getAttribute('data-pg-param');
        state.paramValues[state.activeEndpoint][name] = t.value;
        renderCode();
    });

    // Scroll-spy — highlight the sidebar link for the endpoint card the
    // user is currently reading, and sync the playground without reopening
    // it. Uses IntersectionObserver with a rootMargin that biases detection
    // toward the top third of the viewport so the "active" feel matches
    // where the eye is.
    const cards = Array.from(document.querySelectorAll('[data-ep]'));
    if (cards.length && 'IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            // Pick the entry closest to the viewport top that's intersecting.
            const visible = entries.filter(x => x.isIntersecting);
            if (!visible.length) return;
            visible.sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
            const id = visible[0].target.getAttribute('data-ep');
            if (id && id !== state.activeEndpoint) {
                state.activeEndpoint = id;
                setActiveSidebar(id);
                renderPlayground();
            }
        }, { rootMargin: '-20% 0px -60% 0px', threshold: [0, 0.25, 0.5, 1] });
        cards.forEach(c => io.observe(c));
    }
}

// ─── Sidebar search filter ────────────────────────────────────────────────

function filterSidebar(q) {
    const query = q.trim().toLowerCase();
    document.querySelectorAll('[data-sb-link]').forEach(l => {
        const id = l.getAttribute('data-sb-link');
        const ep = ENDPOINTS[id];
        if (!ep) return;
        const hay = (ep.method + ' ' + ep.path + ' ' + (ep.title || '')).toLowerCase();
        l.style.display = (!query || hay.includes(query)) ? '' : 'none';
    });
    // Hide category labels that have no visible children
    document.querySelectorAll('.sidebar-cat').forEach((cat) => {
        let next = cat.nextElementSibling;
        let any = false;
        while (next && !next.classList.contains('sidebar-cat')) {
            if (next.matches('[data-sb-link]') && next.style.display !== 'none') { any = true; break; }
            next = next.nextElementSibling;
        }
        cat.style.display = any ? '' : 'none';
    });
}

// ─── Boot ─────────────────────────────────────────────────────────────────

function boot() {
    renderSidebar();
    renderContentStream();
    renderPlayground();
    wireEvents();

    // Honour a deep-link like /developers#ep-history
    const hash = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (hash.startsWith('ep-')) {
        const id = hash.slice(3);
        if (ENDPOINTS[id]) {
            state.activeEndpoint = id;
            setActiveSidebar(id);
            renderPlayground();
            // Defer scroll to next frame so the content is laid out.
            requestAnimationFrame(() => {
                const target = document.getElementById(hash);
                if (target) target.scrollIntoView({ block: 'start' });
            });
        }
    } else {
        setActiveSidebar(state.activeEndpoint);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
