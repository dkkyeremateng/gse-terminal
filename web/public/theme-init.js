// Applies the stored theme before first paint, so a light-mode user doesn't
// get a flash of the dark shell while the React bundle loads.
//
// This lives in its own file rather than inline in index.html because the
// server sends `script-src 'self'` with no 'unsafe-inline' (see the CSP
// middleware in cmd/server/main.go) — an inline block here would simply be
// refused, and the flash would come back.
(function () {
  try {
    var t = localStorage.getItem('ges-pro-theme') || 'dark';
    var resolved =
      t === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : t;
    if (resolved === 'light') document.documentElement.classList.add('light');
  } catch (_) {}
})();
