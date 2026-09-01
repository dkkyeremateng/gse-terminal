// Single-flight abort helper. Each fetch path that should supersede
// itself (e.g. symbol-switch races: A → B → C) registers under a key;
// calling `abortableSignal(key)` cancels whatever is in flight under
// that key and hands back a fresh AbortSignal for the new request.
//
// Usage:
//   const signal = abortableSignal('history');
//   const res = await fetch(url, { signal });
//   // If another caller fires abortableSignal('history') before we
//   // finish, our fetch throws AbortError — callers should swallow it.
//
// `isAbortError(err)` is the canonical check so callers don't need to
// know that AbortController surfaces as a DOMException named 'AbortError'.

const controllers = new Map();

export function abortableSignal(key) {
    const prev = controllers.get(key);
    if (prev) prev.abort();
    const next = new AbortController();
    controllers.set(key, next);
    return next.signal;
}

export function isAbortError(err) {
    return err && (err.name === 'AbortError' || err.code === 20);
}

if (typeof window !== 'undefined') {
    window.abortableSignal = abortableSignal;
    window.isAbortError = isAbortError;
}
