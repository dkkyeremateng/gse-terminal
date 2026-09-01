package server

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// ─── API Keys (per-user CRUD) ────────────────────────────────────────────────

// HandleListAPIKeys returns the calling user's API keys (excluding the raw
// secret, which only exists at creation time).
func (s *Server) HandleListAPIKeys(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	keys, err := s.pgRepo.ListAPIKeys(r.Context(), user.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list API keys")
		return
	}
	respondJSON(w, keys)
}

// HandleCreateAPIKey provisions a new API key for the calling user. The raw
// key is returned ONCE in the response — clients must persist it themselves.
func (s *Server) HandleCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "Untitled key"
	}
	if len(name) > 200 {
		respondError(w, http.StatusBadRequest, "Key name must be 200 characters or fewer")
		return
	}

	raw, prefix, hash, err := auth.GenerateAPIKey()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Key generation failed")
		return
	}
	keyID, err := s.pgRepo.CreateAPIKey(r.Context(), user.ID, name, hash, prefix)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to persist key")
		return
	}

	s.auditLog.Log(r.Context(), audit.ActionAPIKeyCreate, "api_key", strconv.Itoa(keyID), map[string]interface{}{
		"name": name,
	})

	respondJSON(w, map[string]interface{}{
		"id":     keyID,
		"name":   name,
		"prefix": prefix,
		"key":    raw, // shown once
	})
}

// HandleRevokeAPIKey marks the supplied key as revoked. Only the owner of
// the key can revoke it.
func (s *Server) HandleRevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	idStr := chi.URLParam(r, "id")
	keyID, err := strconv.Atoi(idStr)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid key id")
		return
	}
	if err := s.pgRepo.RevokeAPIKey(r.Context(), user.ID, keyID); err != nil {
		LoggerFromCtx(r.Context()).Warn("revoke api key failed", "error", err, "key_id", keyID)
		respondError(w, http.StatusNotFound, "API key not found")
		return
	}
	s.auditLog.Log(r.Context(), audit.ActionAPIKeyRevoke, "api_key", strconv.Itoa(keyID), nil)
	respondJSON(w, map[string]string{"status": "revoked"})
}

// ─── Admin Audit Log ─────────────────────────────────────────────────────────

// HandleAdminAuditPage redirects to the admin shell with the audit tab
// pre-selected, so /admin/audit (and any bookmarks) keep working while the
// actual UI lives inside the existing admin layout.
func (s *Server) HandleAdminAuditPage(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/admin?tab=audit", http.StatusFound)
}

// auditCategory groups an action into a colour bucket used by the UI badge.
func auditCategory(action string) string {
	switch {
	case strings.HasPrefix(action, "user."):
		if action == "user.delete" {
			return "cat-fail"
		}
		return "cat-user"
	case strings.HasPrefix(action, "data."):
		return "cat-data"
	case strings.HasPrefix(action, "auth."):
		if strings.HasSuffix(action, "failure") {
			return "cat-fail"
		}
		return "cat-auth"
	case strings.HasPrefix(action, "api_key."):
		return "cat-key"
	case strings.HasPrefix(action, "alert."):
		return "cat-data"
	}
	return "cat-data"
}

// HandleAdminAuditLog returns the audit entries as a stream of .audit-row
// divs styled to match admin.html's audit view.
func (s *Server) HandleAdminAuditLog(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 1000 {
		limit = 1000
	}
	entries, err := s.pgRepo.GetAuditLog(r.Context(), limit)
	if err != nil {
		if wantsJSON(r) {
			respondError(w, http.StatusInternalServerError, "Failed to fetch audit log")
			return
		}
		http.Error(w, "Failed to fetch audit log", http.StatusInternalServerError)
		return
	}

	if wantsJSON(r) {
		if entries == nil {
			entries = []repository.AuditEntry{}
		}
		respondJSON(w, entries)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	var b strings.Builder

	if len(entries) == 0 {
		b.WriteString(`<div class="px-6 py-12 text-center text-slate-500 italic text-xs">No audit entries yet. Administrative actions will appear here.</div>`)
		w.Write([]byte(b.String()))
		return
	}

	for _, e := range entries {
		// Actor cell — small avatar with first letter, fallback to "system".
		var actorHTML string
		if e.ActorUsername == "" {
			actorHTML = `<span class="text-slate-600 italic font-medium text-xs">system</span>`
		} else {
			initial := strings.ToUpper(e.ActorUsername[:1])
			actorHTML = fmt.Sprintf(
				`<div class="audit-actor-avatar">%s</div><span>%s</span>`,
				html.EscapeString(initial), html.EscapeString(e.ActorUsername),
			)
		}

		// Target cell — uppercase type label + monospaced id.
		targetHTML := `<span class="text-slate-600 italic">—</span>`
		if e.TargetType != "" || e.TargetID != "" {
			targetHTML = fmt.Sprintf(
				`<span class="audit-target-type">%s</span><span class="audit-target">%s</span>`,
				html.EscapeString(e.TargetType), html.EscapeString(e.TargetID),
			)
		}

		// Metadata cell — JSON in a monospaced pill, or empty placeholder.
		metaHTML := `<span class="audit-meta empty">no metadata</span>`
		if e.Metadata != "" {
			metaHTML = fmt.Sprintf(`<span class="audit-meta" title="%s">%s</span>`,
				html.EscapeString(e.Metadata), html.EscapeString(e.Metadata))
		}

		fmt.Fprintf(&b, `<div class="audit-row">
			<div class="audit-time">%s</div>
			<div class="audit-actor">%s</div>
			<div><span class="audit-action %s">%s</span></div>
			<div class="flex items-center gap-3 min-w-0">%s%s</div>
		</div>`,
			e.CreatedAt.Format("2006-01-02 15:04:05"),
			actorHTML,
			auditCategory(e.Action),
			html.EscapeString(e.Action),
			targetHTML,
			metaHTML,
		)
	}

	w.Write([]byte(b.String()))
}

// ─── Data Quality Alerts ────────────────────────────────────────────────

// HandleAdminAlerts returns recent data quality alerts as JSON.
func (s *Server) HandleAdminAlerts(w http.ResponseWriter, r *http.Request) {
	alerts, err := s.pgRepo.GetRecentAlerts(r.Context(), 100)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch alerts")
		return
	}
	if alerts == nil {
		alerts = []repository.DataAlert{}
	}
	respondJSON(w, alerts)
}

// ─── Client Error Telemetry ─────────────────────────────────────────────

// clientErrorReport mirrors the payload posted by ui/src/ui/error-boundary.js
// via navigator.sendBeacon. Fields are optional and bounded in the browser —
// we re-truncate server-side as a belt-and-braces guard against abuse.
type clientErrorReport struct {
	Msg   string `json:"msg"`
	Stack string `json:"stack,omitempty"`
	URL   string `json:"url,omitempty"`
	UA    string `json:"ua,omitempty"`
	When  string `json:"when,omitempty"`
}

// HandleClientError ingests uncaught-error + unhandled-rejection reports from
// the browser error boundary and records them to the structured log stream.
// Fire-and-forget from the client (sendBeacon), so we always return 204 — the
// browser can't surface a response anyway. Rate-limiting is inherited from the
// global per-IP limiter applied at the router level.
func (s *Server) HandleClientError(w http.ResponseWriter, r *http.Request) {
	// Bounded read — the client-side cap is 500 (msg) + 4000 (stack) + a few
	// hundred bytes of url/ua metadata. 8 KiB is a generous ceiling; a larger
	// body is almost certainly abuse.
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	defer r.Body.Close()

	var rep clientErrorReport
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rep); err != nil {
		// Malformed payload — still return 204 so the client never retries.
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Defensive truncation — never trust client-reported lengths.
	trunc := func(s string, max int) string {
		if len(s) > max {
			return s[:max]
		}
		return s
	}

	LoggerFromCtx(r.Context()).Warn("client error",
		"client_error", true,
		"msg", trunc(rep.Msg, 500),
		"stack", trunc(rep.Stack, 4000),
		"url", trunc(rep.URL, 500),
		"ua", trunc(rep.UA, 300),
		"when", trunc(rep.When, 40),
		"remote", r.RemoteAddr,
	)

	w.WriteHeader(http.StatusNoContent)
}

// HandleAdminAckAlert marks a single alert as acknowledged.
func (s *Server) HandleAdminAckAlert(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid alert ID")
		return
	}
	if err := s.pgRepo.AcknowledgeAlert(r.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to acknowledge alert")
		return
	}
	respondJSON(w, map[string]interface{}{"acknowledged": true, "id": id})
}
