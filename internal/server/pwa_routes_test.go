package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/config"
)

// chi does not panic on a duplicate method+pattern — it silently overwrites,
// and the LAST registration wins. That is how six root PWA routes ended up
// registered twice with the dedicated handlers unreachable. Pinning the
// behaviour here so the hazard is documented rather than rediscovered.
func TestChiSilentlyOverwritesDuplicateRoutes(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/x", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("first")) })
	r.Get("/x", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("second")) })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if got := rec.Body.String(); got != "second" {
		t.Fatalf("body = %q; chi's duplicate-route behaviour has changed, revisit the PWA route comments", got)
	}
}

func newPWATestServer(env string) *Server {
	return &Server{cfg: &config.Config{AppEnv: env}}
}

// The manifest went out as text/plain in production because HandleManifest
// — which sets application/manifest+json — was shadowed and never ran.
func TestPWAHandlers_SetIntendedHeaders(t *testing.T) {
	s := newPWATestServer("production")

	cases := []struct {
		name        string
		handler     func(http.ResponseWriter, *http.Request)
		path        string
		wantType    string
		wantCache   string
		wantSWScope bool
	}{
		{
			name: "manifest", handler: s.HandleManifest, path: "/manifest.webmanifest",
			wantType: "application/manifest+json; charset=utf-8",
		},
		{
			name: "service worker", handler: s.HandleServiceWorker, path: "/sw.js",
			wantType: "application/javascript; charset=utf-8", wantCache: "no-cache", wantSWScope: true,
		},
		{
			name: "offline shell", handler: s.HandleOfflinePage, path: "/offline.html",
			wantType: "text/html; charset=utf-8", wantCache: "no-cache",
		},
		{
			name: "icon", handler: s.HandlePWAIcon192, path: "/icon-192.png",
			wantCache: "public, max-age=86400",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.handler(rec, httptest.NewRequest("GET", tc.path, nil))

			if tc.wantType != "" && rec.Header().Get("Content-Type") != tc.wantType {
				t.Errorf("Content-Type = %q, want %q", rec.Header().Get("Content-Type"), tc.wantType)
			}
			if tc.wantCache != "" && rec.Header().Get("Cache-Control") != tc.wantCache {
				t.Errorf("Cache-Control = %q, want %q", rec.Header().Get("Cache-Control"), tc.wantCache)
			}
			if tc.wantSWScope && rec.Header().Get("Service-Worker-Allowed") != "/" {
				t.Errorf("Service-Worker-Allowed = %q, want /", rec.Header().Get("Service-Worker-Allowed"))
			}
		})
	}
}

// The static group applies `immutable`, which would pin a stale offline
// shell and stale icons across a redeploy. Neither may carry it.
func TestPWAAssets_AreNotImmutable(t *testing.T) {
	s := newPWATestServer("production")
	for name, h := range map[string]func(http.ResponseWriter, *http.Request){
		"offline.html": s.HandleOfflinePage,
		"icon-192.png": s.HandlePWAIcon192,
		"sw.js":        s.HandleServiceWorker,
	} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("GET", "/"+name, nil))
		if cc := rec.Header().Get("Cache-Control"); cc == "" {
			t.Errorf("%s: no Cache-Control set; it no longer inherits the static group's", name)
		} else if strings.Contains(cc, "immutable") {
			t.Errorf("%s: Cache-Control = %q, must not be immutable", name, cc)
		}
	}
}
