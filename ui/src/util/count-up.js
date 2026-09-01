// Count-up number animation — ~300ms lerp from 0 to a target value,
// written into each matching element's innerText on every rAF frame.
//
// Accepts a string target name or a direct element. When given a string,
// resolves to every element with a matching `data-count-target` (the
// multi-instance contract — the desktop + mobile price headers both
// carry `data-count-target="main-price-display"`), falling back to
// `getElementById` for single-instance targets (stat-high, stat-low,
// stat-vol). Duplicate IDs are invalid DOM; the data-attribute path is
// the preferred one for anything rendered more than once per page.
//
// Concurrent-call protection: live WS ticks can fire faster than the
// 300ms lerp completes. Without cancellation, multiple rAF loops stack
// and fight for `.innerText` on the same element. We track the active
// rAF handle per target name (or per element identity for direct-node
// callers) and `cancelAnimationFrame` the previous one before starting
// a new one.

const activeFrames = new WeakMap(); // element → rAF handle (direct-node calls)
const activeFramesByKey = new Map(); // string target → rAF handle

export function countUp(target, targetValue, duration = 300, prefix = "", suffix = "") {
    let elements;
    let key;
    if (typeof target === 'string') {
        key = target;
        const byAttr = document.querySelectorAll(`[data-count-target="${target}"]`);
        elements = byAttr.length
            ? [...byAttr]
            : [document.getElementById(target)].filter(Boolean);
    } else {
        elements = [target].filter(Boolean);
    }
    if (!elements.length) return;

    // Cancel any in-flight animation for this target so we don't stack
    // overlapping rAF loops writing to the same element each frame.
    if (key !== undefined) {
        const prev = activeFramesByKey.get(key);
        if (prev !== undefined) cancelAnimationFrame(prev);
    } else {
        for (const el of elements) {
            const prev = activeFrames.get(el);
            if (prev !== undefined) cancelAnimationFrame(prev);
        }
    }

    const start = 0;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const current = progress * (targetValue - start) + start;
        const text = `${prefix}${current.toFixed(2)}${suffix}`;
        for (const el of elements) el.innerText = text;

        if (progress < 1) {
            const handle = requestAnimationFrame(update);
            if (key !== undefined) activeFramesByKey.set(key, handle);
            else for (const el of elements) activeFrames.set(el, handle);
        } else {
            // Animation finished — clear the slot so the next call starts clean.
            if (key !== undefined) activeFramesByKey.delete(key);
            else for (const el of elements) activeFrames.delete(el);
        }
    }
    const handle = requestAnimationFrame(update);
    if (key !== undefined) activeFramesByKey.set(key, handle);
    else for (const el of elements) activeFrames.set(el, handle);
}

if (typeof window !== 'undefined') {
    window.countUp = countUp;
}
