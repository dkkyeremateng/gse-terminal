// Package web holds the React client mounted at /v2, alongside the Vite
// project that produces it. Only dist/ is embedded — the binary carries the
// compiled bundle, never the source tree or node_modules.
//
// dist/ must exist for this package to compile, so `npm run build` in web/ is
// a prerequisite of `go build`. The Makefile's `web` target and the
// Dockerfile's web-build stage both take care of it.
package web

import (
	"embed"
)

//go:embed all:dist
var Files embed.FS
