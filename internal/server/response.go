package server

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

const contentTypeJSON = "application/json"

// wantsJSON returns true when a handler with both HTML and JSON outputs
// should pick the JSON branch. The only HTML consumer is the legacy
// /ui/admin via HTMX, which always sets `HX-Request: true`; every other
// caller (the React SPA, curl, automation) wants JSON. Accept-header
// negotiation was tried first but proved fragile — some browsers/proxies
// rewrite it, and the SPA-vs-HTMX split is what actually matters here.
func wantsJSON(r *http.Request) bool {
	if r.Header.Get("HX-Request") != "" {
		// HTMX consumers may still opt into JSON by setting Accept
		// explicitly (e.g. for a fetch() call from /ui that wants the
		// JSON shape). The default HTMX request stays on HTML.
		return strings.HasPrefix(r.Header.Get("Accept"), contentTypeJSON)
	}
	return true
}

// respondError emits a structured JSON error so all API endpoints share a
// consistent error contract. HTML/HTMX endpoints should NOT use this helper —
// they have their own templating responses.
func respondError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(map[string]string{"error": message}); err != nil {
		slog.Error("failed to encode error response", "error", err)
	}
}

// respondJSON marshals the value as JSON and writes it with a 200 status.
//
// Encoding goes through a bytes.Buffer first so a marshal failure can
// surface as a clean 500 instead of a half-written body with HTTP 200.
// Without the buffer, json.NewEncoder writes incrementally — a marshal
// error mid-stream leaves the client with a truncated payload under a
// success status, which then misleads any client-side error handling
// keyed on response.ok. Almost all callers pass marshalable types, so
// the failure is rare; the buffer makes the rare case clean.
func respondJSON(w http.ResponseWriter, value interface{}) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(value); err != nil {
		slog.Error("failed to encode JSON response", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to encode response")
		return
	}
	w.Header().Set("Content-Type", contentTypeJSON)
	if _, err := w.Write(buf.Bytes()); err != nil {
		slog.Error("failed to write JSON response", "error", err)
	}
}
