// Symbol sanitiser. The server validates `?symbol=` against
// ^[A-Z0-9]{1,10}$ and returns 400 for anything else, so any value we
// pass to /v1/history / /v1/ai-insight / etc. must already match.
//
// We sanitise on the client too because upstream payloads (LLM-generated
// briefings, legacy DB rows) have been seen carrying markdown emphasis
// around tickers — e.g. `**ALW**`. Without this guard, a click on an
// affected briefing card fires a request the server immediately rejects
// with "Invalid symbol", wasting a round trip and showing an error card.
//
// Returns '' for inputs that can't be salvaged to a valid symbol — the
// caller should short-circuit on empty.
export function sanitizeSymbol(raw) {
    if (raw == null) return '';
    const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Truncate at 10 to match the server's upper bound.
    return cleaned.slice(0, 10);
}

if (typeof window !== 'undefined') {
    window.sanitizeSymbol = sanitizeSymbol;
}
