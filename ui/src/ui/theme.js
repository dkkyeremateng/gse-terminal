// Theme toggle — dark/light with a circular clip-path view transition
// on supported browsers, plus a fallback instant swap. On theme change,
// the Apex chart (if any) is re-themed in place.
//
// TODO (perf, low-priority): the .light theme is ~67 rule blocks
// (~3-5KB gzip) shipped in the base bundle but used by <1% of users.
// A future patch could move those rules to ./styles/light.css and
// dynamic-`import('./styles/light.css')` here when toggling to light /
// when initTheme() detects a saved 'light' state. Two gotchas:
//   1) FOUC on initial load if saved=light — must await the dynamic
//      import before adding the .light class, or pre-fetch with
//      `<link rel="prefetch">` on the HTML.
//   2) The CSS modifies CSS custom properties at :root, so the import
//      must complete before the toggle to avoid a flash of dark-themed
//      cards on a light background.

// Safari in private mode throws on localStorage access, and some
// enterprise browser policies disable storage entirely. Wrap reads/writes
// so theme toggling still works (just without cross-session persistence)
// instead of crashing the whole init path.
function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* no-op */ }
}

function updateThemeIcon(theme) {
    const isDark = theme === 'dark';
    const moon = document.querySelector('.moon-path');
    const sun = document.querySelector('.sun-path');
    if (moon) moon.classList.toggle('hidden', !isDark);
    if (sun) sun.classList.toggle('hidden', isDark);
}

function applyThemeToggle() {
    const html = document.documentElement;
    const current = html.className === 'light' ? 'dark' : 'light';
    html.className = current;
    safeStorageSet('theme', current);
    updateThemeIcon(current);

    // Sync chart (if one exists)
    if (window.chart) {
        const isDark = current === 'dark';
        window.chart.updateOptions({
            theme: { mode: isDark ? 'dark' : 'light' },
            chart: { foreColor: isDark ? '#64748b' : '#312e81' },
            grid: { borderColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(99, 102, 241, 0.06)' },
            colors: [isDark ? '#10b981' : '#4f46e5']
        });
    }
}

export function toggleTheme(e) {
    if (!document.startViewTransition || !e) {
        applyThemeToggle();
        return;
    }

    const x = e.clientX ?? innerWidth / 2;
    const y = e.clientY ?? innerHeight / 2;

    const transition = document.startViewTransition(() => {
        applyThemeToggle();
    });

    transition.ready.then(() => {
        const radius = Math.hypot(
            Math.max(x, innerWidth - x),
            Math.max(y, innerHeight - y)
        );
        document.documentElement.animate(
            {
                clipPath: [
                    `circle(0px at ${x}px ${y}px)`,
                    `circle(${radius}px at ${x}px ${y}px)`
                ]
            },
            {
                // Signature moment — kept but halved from 800ms to 400ms
                // so the rest of the app feels snappier in comparison.
                duration: 400,
                easing: "cubic-bezier(0.16, 1, 0.3, 1)",
                pseudoElement: "::view-transition-new(root)"
            }
        );
    });
}

/** Initialize the theme on first load from localStorage or the OS preference. */
export function initTheme() {
    const saved = safeStorageGet('theme') || 'dark';
    if (saved === 'light') {
        document.documentElement.classList.add('light');
    }
    updateThemeIcon(saved);
}

if (typeof window !== 'undefined') {
    window.toggleTheme = toggleTheme;
}
