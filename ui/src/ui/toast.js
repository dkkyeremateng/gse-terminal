// Toast system — queued, accessible, auto-dismissing notifications.
// Max 3 visible at once. Severity: 'info' (default) | 'success' | 'error' | 'warn'.
// Mount point is created lazily so it works on any page that loads app.js.

const _toastState = { mount: null, queue: [], visible: 0, MAX: 3 };

function ensureMount() {
    if (_toastState.mount) return _toastState.mount;
    const el = document.createElement('div');
    el.id = 'toast-mount';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'false');
    el.style.cssText = [
        'position:fixed',
        'top:12px',
        'right:12px',
        'z-index:2000',
        'display:flex',
        'flex-direction:column',
        'gap:8px',
        'pointer-events:none',
        'max-width:calc(100vw - 24px)',
    ].join(';');
    document.body.appendChild(el);
    _toastState.mount = el;
    return el;
}

const COLORS = {
    info:    { border: 'rgba(244,236,216,0.22)', accent: '#ffb12b' },
    success: { border: 'rgba(74,107,42,0.6)',    accent: '#4a6b2a' },
    error:   { border: 'rgba(178,58,23,0.6)',    accent: '#b23a17' },
    warn:    { border: 'rgba(201,122,6,0.6)',    accent: '#c97a06' },
};

function render({ message, severity, durationMs }) {
    const mount = ensureMount();
    const colors = COLORS[severity] || COLORS.info;

    const node = document.createElement('div');
    node.style.cssText = [
        'pointer-events:auto',
        'min-width:220px',
        'max-width:360px',
        'padding:10px 14px',
        'background:rgba(11,10,8,0.95)',
        'backdrop-filter:blur(8px)',
        `border:1px solid ${colors.border}`,
        `border-left:3px solid ${colors.accent}`,
        'color:#f4ecd8',
        'font:500 12px/1.4 "Inter",system-ui,sans-serif',
        'letter-spacing:0.01em',
        'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
        'opacity:0',
        'transform:translateX(12px)',
        'transition:opacity .25s ease, transform .25s ease',
        'cursor:pointer',
    ].join(';');

    // Text-only content — NEVER use innerHTML with the message.
    node.textContent = String(message);

    const remove = () => {
        node.style.opacity = '0';
        node.style.transform = 'translateX(12px)';
        setTimeout(() => {
            if (node.parentNode) node.parentNode.removeChild(node);
            _toastState.visible -= 1;
            flushQueue();
        }, 250);
    };
    node.addEventListener('click', remove);

    mount.appendChild(node);
    _toastState.visible += 1;

    requestAnimationFrame(() => {
        node.style.opacity = '1';
        node.style.transform = 'translateX(0)';
    });

    if (durationMs > 0) setTimeout(remove, durationMs);
}

function flushQueue() {
    while (_toastState.visible < _toastState.MAX && _toastState.queue.length > 0) {
        render(_toastState.queue.shift());
    }
}

/**
 * Queue a toast notification.
 * @param {string} message — plain text, always escaped
 * @param {'info'|'success'|'error'|'warn'} [severity]
 * @param {number} [durationMs] — 0 for persistent, default 4000
 */
export function showToast(message, severity = 'info', durationMs = 4000) {
    if (!message) return;
    _toastState.queue.push({ message, severity, durationMs });
    flushQueue();
}

// Legacy global for call sites still on window.showToast
if (typeof window !== 'undefined') {
    window.showToast = showToast;
}
