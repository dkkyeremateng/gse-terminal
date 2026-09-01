// Connection state overlay — debounces offline transitions, updates
// the nav status dot/text, and shows toasts on state changes.

window.isTerminalOffline = false;
window.appStartTime = Date.now();
let offlineTransitionTimeout = null;

function applyConnectionChange(isOffline) {
    if (window.isTerminalOffline === isOffline) return;
    window.isTerminalOffline = isOffline;

    const body = document.body;
    const dot = document.getElementById('nav-status-dot');
    const text = document.getElementById('nav-status-text');

    if (isOffline) {
        body.classList.add('terminal-offline');
        if (dot) dot.classList.add('offline');
        if (text) {
            text.innerText = 'Offline Node';
            text.classList.add('offline');
        }
        // Toasts removed — the PWA service worker serves cached reads
        // offline, so a WS blip no longer means "the app stopped
        // working". The nav status pill on its own is a less disruptive
        // indicator for a non-blocking failure mode.
    } else {
        body.classList.remove('terminal-offline');
        if (dot) dot.classList.remove('offline');
        if (text) text.classList.remove('offline');
        if (typeof window.updateMarketStatus === 'function') {
            window.updateMarketStatus();
        }
    }
}

export function setConnectionState(isOffline) {
    const gracePeriod = 4000;
    const timeSinceStart = Date.now() - window.appStartTime;

    if (isOffline) {
        if (timeSinceStart < gracePeriod) return;
        if (offlineTransitionTimeout || window.isTerminalOffline) return;

        offlineTransitionTimeout = setTimeout(() => {
            applyConnectionChange(true);
            offlineTransitionTimeout = null;
        }, 1000);
    } else {
        if (offlineTransitionTimeout) {
            clearTimeout(offlineTransitionTimeout);
            offlineTransitionTimeout = null;
        }
        applyConnectionChange(false);
    }
}

if (typeof window !== 'undefined') {
    window.setConnectionState = setConnectionState;
}
