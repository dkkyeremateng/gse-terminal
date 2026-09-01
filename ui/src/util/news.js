// Split a feed title into headline + source. Most GSE-adjacent news
// feeds use "Headline - Publisher" / "Headline — Publisher" / "... | ..."
// in the title field. Peel the trailing publisher segment off so the
// news card can render source and headline separately (matching the
// stock-insight card layout).
export function parseNewsTitle(title) {
    if (!title) return { headline: '', source: 'GSE News' };
    // Greedy first group walks to the LAST separator, not the first,
    // so titles with internal dashes still split cleanly.
    const m = title.match(/^(.+)\s+[\-–—|]\s+([^\-–—|]+)$/);
    if (m) return { headline: m[1].trim(), source: m[2].trim() };
    return { headline: title.trim(), source: 'GSE News' };
}

if (typeof window !== 'undefined') {
    window.parseNewsTitle = parseNewsTitle;
}
