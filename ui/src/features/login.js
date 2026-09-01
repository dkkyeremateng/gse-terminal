// Login / Signup toggle logic — extracted from inline <script> in login.html.

let isLogin = true;

window.toggleAuthMode = function () {
    const form = document.getElementById('auth-form');
    if (!form) return;
    isLogin = !isLogin;
    const title = document.getElementById('form-title');
    const subtitle = document.getElementById('form-subtitle');
    const submitBtn = document.getElementById('submit-btn').querySelector('.submit-text');
    const toggleBtn = document.getElementById('toggle-auth');
    const errorMsg = document.getElementById('error-msg');
    if (errorMsg) errorMsg.innerText = '';

    if (isLogin) {
        form.setAttribute('hx-post', '/login');
        if (title) title.innerText = 'Access Protocol';
        if (subtitle) subtitle.innerText = 'Initialize terminal link';
        if (submitBtn) submitBtn.innerText = 'Initialize Uplink';
        if (toggleBtn)
            toggleBtn.innerHTML =
                'Need an account? <span class="text-[var(--amber)] underline decoration-1 underline-offset-4">Join the Network</span>';
    } else {
        form.setAttribute('hx-post', '/signup');
        if (title) title.innerText = 'Network Enrolment';
        if (subtitle) subtitle.innerText = 'Create new terminal identity';
        if (submitBtn) submitBtn.innerText = 'Register Node';
        if (toggleBtn)
            toggleBtn.innerHTML =
                'Already registered? <span class="text-[var(--amber)] underline decoration-1 underline-offset-4">Uplink Here</span>';
    }
    if (window.htmx) htmx.process(form);
};

// Delegated click dispatch — keeps login.html free of inline onclick
// handlers so a strict CSP could ship. `toggle-theme` is handled by
// app.js's dispatcher (loaded on the same page); `toggle-auth-mode` is
// login-specific and lives here.
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.getAttribute('data-action') === 'toggle-auth-mode') {
        window.toggleAuthMode();
    }
});
