// Minimal accessible-dialog helper. Keeps focus inside an open modal,
// auto-focuses the first tabbable element, restores focus to the trigger
// on close, and closes on Escape.
//
// Usage:
//   openModal('merge-account-modal');
//   closeModal('merge-account-modal');
//
// Existing show/close helpers (in app.js) already toggle the `hidden`
// class — they now delegate focus-trap wiring to this module.

const TABBABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),' +
                 'input:not([disabled]):not([type="hidden"]),' +
                 'select:not([disabled]),[tabindex]:not([tabindex="-1"])';

const state = new Map(); // modalId -> { keyHandler, prevFocus }

function tabbableIn(root) {
    return [...root.querySelectorAll(TABBABLE)].filter(el => {
        // Skip elements that are visually hidden (display:none / aria-hidden).
        if (el.closest('[hidden],[aria-hidden="true"]')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    });
}

export function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const prevFocus = document.activeElement;

    modal.classList.remove('hidden');

    const focusable = tabbableIn(modal);
    if (focusable.length) focusable[0].focus();

    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal(modalId);
            return;
        }
        if (e.key !== 'Tab') return;
        const nodes = tabbableIn(modal);
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', keyHandler);
    state.set(modalId, { keyHandler, prevFocus });
}

export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('hidden');
    const s = state.get(modalId);
    if (s) {
        document.removeEventListener('keydown', s.keyHandler);
        // Restore focus to whatever had it before the modal opened.
        if (s.prevFocus && typeof s.prevFocus.focus === 'function') {
            s.prevFocus.focus();
        }
        state.delete(modalId);
    }
}

if (typeof window !== 'undefined') {
    window.openModal = openModal;
    window.closeModal = closeModal;
}
