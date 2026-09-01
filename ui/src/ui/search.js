// Symbol autocomplete dropdown — backed by the shared /v1/symbols session
// cache so the list is fetched once per session (or until an upload-driven
// cache bust). Keyboard navigation via ArrowUp/Down/Enter/Escape handled
// here. Legacy `window.*` names preserved for inline handlers.

import { getSymbols } from '../util/symbols-cache.js';

let _allSymbols = [];
let _dropdownActiveIdx = -1;

async function loadSymbols() {
    if (_allSymbols.length > 0) return;
    try {
        const list = await getSymbols();
        if (Array.isArray(list)) _allSymbols = list;
    } catch (err) {
        console.debug('[search] /v1/symbols failed:', err);
    }
}

// Exported so a cache-bust listener (see app.js) can force a refresh of
// the autocomplete list when an admin upload adds new tickers.
export function resetSymbolsList() {
    _allSymbols = [];
}

function renderDropdown(items) {
    const dd = document.getElementById('symbols-dropdown');
    if (!dd) return;

    if (!items || items.length === 0) {
        dd.innerHTML = '<div class="symbol-dropdown-empty">No matching securities</div>';
        dd.classList.remove('hidden');
        return;
    }

    _dropdownActiveIdx = -1;
    const header = '<div class="symbol-dropdown-header">Securities</div>';
    const rows = items.map((sym, i) =>
        `<div class="symbol-option" data-idx="${i}" data-symbol="${sym.replace(/"/g, '&quot;')}">
            <span class="symbol-ticker">${sym.replace(/</g, '&lt;')}</span>
            <span class="symbol-option-icon"></span>
        </div>`
    ).join('');
    dd.innerHTML = header + rows;
    dd.classList.remove('hidden');
}

export function selectSymbol(sym) {
    const inp = document.getElementById('symbol-search');
    if (inp) inp.value = sym;
    closeSymbolDropdown();
    if (typeof window.fetchHistory === 'function') window.fetchHistory();
}

export async function openSymbolDropdown(inp) {
    await loadSymbols();
    filterSymbolDropdown(inp.value);
}

export function closeSymbolDropdown() {
    const dd = document.getElementById('symbols-dropdown');
    if (dd) dd.classList.add('hidden');
    _dropdownActiveIdx = -1;
}

export function filterSymbolDropdown(query) {
    if (!query || query.trim() === '') {
        renderDropdown(_allSymbols.slice(0, 40));
        return;
    }
    const q = query.toUpperCase();
    const exact = _allSymbols.filter(s => s.startsWith(q));
    const fuzzy = _allSymbols.filter(s => !s.startsWith(q) && s.includes(q));
    renderDropdown([...exact, ...fuzzy].slice(0, 40));
}

export function symbolDropdownKeyNav(e) {
    const dd = document.getElementById('symbols-dropdown');
    const inp = document.getElementById('symbol-search');
    if (!dd || dd.classList.contains('hidden')) {
        if (e.key === 'Enter' && typeof window.fetchHistory === 'function') window.fetchHistory();
        return;
    }

    const items = dd.querySelectorAll('.symbol-option');
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _dropdownActiveIdx = Math.min(_dropdownActiveIdx + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _dropdownActiveIdx = Math.max(_dropdownActiveIdx - 1, -1);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_dropdownActiveIdx >= 0 && items[_dropdownActiveIdx]) {
            selectSymbol(items[_dropdownActiveIdx].dataset.symbol);
        } else {
            closeSymbolDropdown();
            if (typeof window.fetchHistory === 'function') window.fetchHistory();
        }
        return;
    } else if (e.key === 'Escape') {
        closeSymbolDropdown();
        if (inp) inp.blur();
        return;
    } else {
        return;
    }

    items.forEach((el, i) => el.classList.toggle('active', i === _dropdownActiveIdx));
    if (_dropdownActiveIdx >= 0 && items[_dropdownActiveIdx]) {
        items[_dropdownActiveIdx].scrollIntoView({ block: 'nearest' });
        const activeSym = items[_dropdownActiveIdx].dataset.symbol;
        if (inp) inp.value = activeSym;
        // Warm the cache for the keyboard-highlighted symbol so Enter
        // lands on an already-loaded chart.
        if (activeSym && typeof window.prefetchHistory === 'function') {
            window.prefetchHistory(activeSym, '1d');
        }
    }
}

/** Preload the symbol list — called from the composition root at boot. */
export function preloadSymbols() {
    loadSymbols();
}

/**
 * Wire the search input event listeners programmatically — replaces
 * the inline onfocus/onblur/oninput/onkeydown that used to live on
 * the #symbol-search element in terminal.html. Called once from the
 * DOMContentLoaded block.
 */
export function initSearchInput() {
    const inp = document.getElementById('symbol-search');
    if (!inp) return;

    inp.addEventListener('focus', () => {
        inp.select();
        openSymbolDropdown(inp);
    });
    inp.addEventListener('blur', () => {
        setTimeout(() => closeSymbolDropdown(), 150);
    });
    inp.addEventListener('input', () => {
        filterSymbolDropdown(inp.value);
    });
    inp.addEventListener('keydown', (e) => {
        symbolDropdownKeyNav(e);
    });
}

// Legacy globals for the data-action dispatcher
if (typeof window !== 'undefined') {
    window._selectSymbol = selectSymbol;
    window.openSymbolDropdown = openSymbolDropdown;
    window.closeSymbolDropdown = closeSymbolDropdown;
    window.filterSymbolDropdown = filterSymbolDropdown;
    window.symbolDropdownKeyNav = symbolDropdownKeyNav;
}
