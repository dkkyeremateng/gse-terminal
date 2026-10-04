package server

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/config"
	"github.com/teckdroids/ges-data-engine/web"
)

// mountSPA wires the handler the way main.go does, so the tests exercise the
// real routing (both the bare "/v2" and the "/v2/*" subtree) rather than
// calling the handler with a path chi would never have matched.
func mountSPA(t *testing.T, env string) http.Handler {
	t.Helper()
	h, err := NewSPAHandler(&config.Config{AppEnv: env})
	if err != nil {
		t.Fatalf("NewSPAHandler: %v", err)
	}
	r := chi.NewRouter()
	r.Handle(SPABasePath, h)
	r.Handle(SPABasePath+"/*", h)
	return r
}

func getSPA(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// The mount point has to answer with the app shell at both /v2 and /v2/ —
// a bare /v2 that 404s means the entry point itself is unreachable.
func TestSPAHandler_ServesIndexAtMountPoint(t *testing.T) {
	h := mountSPA(t, "production")

	for _, path := range []string{SPABasePath, SPABasePath + "/"} {
		rec := getSPA(t, h, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `<div id="root">`) {
			t.Errorf("GET %s did not return the SPA shell", path)
		}
	}
}

// Client-side routes have no file behind them. An extensionless miss must
// return the shell so the router can resolve it; returning 404 would break
// every deep link and page refresh in the app.
func TestSPAHandler_FallsBackToIndexForClientRoutes(t *testing.T) {
	h := mountSPA(t, "production")

	for _, path := range []string{"/v2/dashboard", "/v2/markets/MTNGH", "/v2/settings/api-keys"} {
		rec := getSPA(t, h, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200 (history-API fallback)", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `<div id="root">`) {
			t.Errorf("GET %s did not return the SPA shell", path)
		}
	}
}

// A missing asset must NOT fall back to index.html. Answering an absent
// bundle with HTML under a 200 turns a deploy mistake into an opaque
// MIME-type error in the browser console, and lets a stale client silently
// render the shell instead of reporting the missing chunk.
func TestSPAHandler_MissingAssetIs404(t *testing.T) {
	h := mountSPA(t, "production")

	for _, path := range []string{"/v2/assets/index-deadbeef.js", "/v2/nope.css", "/v2/missing.png"} {
		rec := getSPA(t, h, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404; body starts %.40q", path, rec.Code, rec.Body.String())
		}
	}
}

// index.html names the content-hashed bundles, so caching it strands a
// returning browser on chunk URLs a redeploy has already removed. The
// hashed assets themselves are immutable and should be cached hard.
func TestSPAHandler_CacheHeaders(t *testing.T) {
	prod := mountSPA(t, "production")

	if got := getSPA(t, prod, SPABasePath).Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Errorf("index Cache-Control = %q, want no-store", got)
	}

	asset := firstBuiltAsset(t)
	if got := getSPA(t, prod, asset).Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("%s Cache-Control = %q, want immutable in production", asset, got)
	}

	// Development must not pin assets, or a rebuild is invisible until a
	// hard refresh.
	dev := mountSPA(t, "development")
	if got := getSPA(t, dev, asset).Header().Get("Cache-Control"); strings.Contains(got, "immutable") {
		t.Errorf("%s Cache-Control = %q in development, want a revalidating value", asset, got)
	}
}

// The request line reaches handlers uncleaned, so a traversal attempt is
// something this handler sees verbatim. It must never escape dist/.
func TestSPAHandler_RejectsTraversal(t *testing.T) {
	h := mountSPA(t, "production")

	for _, path := range []string{
		"/v2/../go.mod",
		"/v2/../../etc/passwd",
		"/v2/assets/../../go.sum",
	} {
		rec := getSPA(t, h, path)
		body := rec.Body.String()
		if strings.Contains(body, "module github.com/teckdroids") || strings.Contains(body, "root:") {
			t.Fatalf("GET %s escaped the asset root: %.80q", path, body)
		}
	}
}

// firstBuiltAsset returns a real hashed asset path from the embedded build,
// so the cache-header assertions run against something that actually exists
// instead of a name pinned to one build's hash.
func firstBuiltAsset(t *testing.T) string {
	t.Helper()
	entries, err := fs.ReadDir(web.Files, "dist/assets")
	if err != nil || len(entries) == 0 {
		t.Skipf("no built assets under web/dist/assets (run `make web`): %v", err)
	}
	return SPABasePath + "/assets/" + entries[0].Name()
}
