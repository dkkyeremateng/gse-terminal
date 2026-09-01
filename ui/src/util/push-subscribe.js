// Web Push subscription flow.
//
// 1. Fetch the server's VAPID public key from /v1/push/vapid-key.
// 2. Ask the browser for notification permission.
// 3. Call PushManager.subscribe() with the VAPID key.
// 4. POST the resulting subscription object to /v1/push/subscribe.
//
// The whole flow is best-effort and non-blocking — if any step fails
// (user declines, browser doesn't support, server not configured) it
// bails silently. The app works fine without push; alerts still land
// in the drawer + email.

// Base64url → Uint8Array (needed by PushManager.subscribe).
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

let _subscribed = false;

// subscribeToPush runs the full subscribe flow. Idempotent — safe to
// call on every page load; if the user already has an active
// subscription it re-POSTs it (the server upserts).
export async function subscribeToPush() {
    if (_subscribed) return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (typeof Notification === 'undefined') return;
    if (!window.isUserAuthenticated) return;

    try {
        // 1. Fetch VAPID public key.
        const keyRes = await fetch('/v1/push/vapid-key');
        if (!keyRes.ok) return; // push not configured on this server
        const { publicKey } = await keyRes.json();
        if (!publicKey) return;

        // 2. Wait for the SW to be ready.
        const registration = await navigator.serviceWorker.ready;

        // 3. Check existing subscription — re-POST to keep it fresh.
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            // 4. Request permission + subscribe.
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
        }

        // 5. POST to server.
        const subJSON = subscription.toJSON();
        await fetch('/v1/push/subscribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                endpoint: subJSON.endpoint,
                keys: {
                    p256dh: subJSON.keys.p256dh,
                    auth: subJSON.keys.auth,
                },
            }),
        });
        _subscribed = true;
    } catch (e) {
        console.debug('[push] subscribe failed', e);
    }
}

// unsubscribeFromPush removes the subscription on both the browser and
// the server. Called from the settings page when the user toggles off.
export async function unsubscribeFromPush() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription) return;
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await fetch('/v1/push/unsubscribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint }),
        });
        _subscribed = false;
    } catch (e) {
        console.debug('[push] unsubscribe failed', e);
    }
}

// isPushSupported returns true when the browser, SW, and server all
// support push. Used to gate the toggle UI on the settings page.
export async function isPushSupported() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    if (typeof Notification === 'undefined') return false;
    if (typeof PushManager === 'undefined') return false;
    try {
        const res = await fetch('/v1/push/vapid-key');
        return res.ok;
    } catch {
        return false;
    }
}

// isPushSubscribed checks whether the current browser already has an
// active push subscription registered.
export async function isPushSubscribed() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        return !!sub;
    } catch {
        return false;
    }
}
