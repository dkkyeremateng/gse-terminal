// HTML escape for values interpolated into innerHTML template strings.
// Accepts any input (null/undefined/number/object) and coerces to string.
// Replaces the inline `window.escapeHTML` that used to live at the top
// of app.js. Still exposed on window.* for legacy template literals
// that haven't been migrated to modules yet.

export function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// Legacy alias used in a couple of sector-rendering spots
export const escapeHtml = escapeHTML;

// Maintain the window.* shim during the migration
if (typeof window !== 'undefined') {
    window.escapeHTML = escapeHTML;
}
