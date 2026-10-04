package server

import (
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/teckdroids/ges-data-engine/internal/config"
	"github.com/teckdroids/ges-data-engine/web"
)

// SPABasePath is where the React client (web/) is mounted. It has to agree
// with three other places or the app 404s on its own assets: Vite's `base` in
// web/vite.config.ts, the router `basename` in web/src/app/router.tsx, and the
// path exclusion in the legacy service worker (ui/public/sw.js).
const SPABasePath = "/v2"

// NewSPAHandler serves the built React client under SPABasePath.
//
// Two behaviours the plain http.FileServer doesn't give us:
//
//   - History-API fallback. /v2/markets/MTNGH is a client-side route with no
//     file behind it, so an extensionless miss returns index.html and lets the
//     router resolve it. A miss that does look like a file (anything with an
//     extension) still 404s — answering an absent /v2/assets/index-abc.js with
//     HTML would surface as an opaque MIME-type error in the console instead
//     of the missing-asset problem it actually is.
//   - Split caching. Vite content-hashes everything under assets/, so those
//     are immutable for a year; index.html is the manifest that points at them
//     and must never be cached, or a redeploy leaves browsers asking for
//     bundles that no longer exist.
func NewSPAHandler(cfg *config.Config) (http.Handler, error) {
	distFS, err := fs.Sub(web.Files, "dist")
	if err != nil {
		return nil, fmt.Errorf("sub-fs for %s assets: %w", SPABasePath, err)
	}

	// Development prefers the on-disk build so `npm run build` in web/ shows
	// up on the next request without a Go restart. Same fallback as the ui/
	// tree: a container inherits APP_ENV=development from the shared .env but
	// ships with no source tree to read.
	var assets http.FileSystem = http.FS(distFS)
	if cfg.AppEnv == "development" {
		if _, statErr := os.Stat("web/dist"); statErr == nil {
			assets = http.Dir("web/dist")
		} else {
			slog.Warn("web/dist not found on disk, serving embedded assets", "error", statErr)
		}
	}

	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		f, err := assets.Open("/index.html")
		if err != nil {
			slog.Error("SPA index.html missing", "error", err)
			http.Error(w, "UI unavailable", http.StatusInternalServerError)
			return
		}
		defer f.Close()
		stat, err := f.Stat()
		if err != nil {
			http.Error(w, "UI unavailable", http.StatusInternalServerError)
			return
		}
		// The document naming the hashed bundles. Caching it is how a
		// deploy becomes invisible to a returning browser.
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		http.ServeContent(w, r, "index.html", stat.ModTime(), f)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Clean before resolving: the request line reaches handlers
		// verbatim, so "/v2/../../etc/passwd" arrives intact. http.Dir and
		// http.FS both reject traversal on their own, but normalising here
		// means the extension and prefix checks below reason about the same
		// path the filesystem will.
		rel := path.Clean("/" + strings.TrimPrefix(r.URL.Path, SPABasePath))

		if rel == "/" {
			serveIndex(w, r)
			return
		}

		f, err := assets.Open(rel)
		if err != nil {
			if path.Ext(rel) != "" {
				http.NotFound(w, r)
				return
			}
			serveIndex(w, r)
			return
		}
		defer f.Close()

		stat, err := f.Stat()
		if err != nil || stat.IsDir() {
			serveIndex(w, r)
			return
		}

		if cfg.IsProduction() && strings.HasPrefix(rel, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), f)
	}), nil
}
