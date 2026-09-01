package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// Pro-role-request endpoints.
//
// Lifecycle:
//   1. A 'user'-tier account POSTs /v1/me/pro-request with an optional
//      reason. The repo layer enforces "one open request per user" via a
//      partial unique index; a duplicate POST returns 409.
//   2. The handler audit-logs the creation and pushes a WS frame to every
//      currently-connected admin so the admin tab badge updates live. The
//      /v1/admin/pro-requests/count endpoint covers the cold-load case for
//      admins who weren't connected when the request landed.
//   3. From the admin portal, an admin POSTs /v1/admin/pro-requests/{id}/decide
//      with form-encoded `decision=approve|deny` (and optional `note`). The
//      repo runs the decision + (on approval) the role bump in one tx, so
//      a partial outcome is impossible.
//   4. Approved or denied requests are terminal — the user can submit a
//      fresh request after a denial (no cooldown).
//
// All endpoints return JSON, not HTML, because the consumers (account.js,
// admin.js) render the UI client-side. This is a small departure from the
// htmx-fragment pattern used by older admin handlers — chosen here because
// the data needs to feed both the table and a live-updating badge, which
// is awkward to do with a single HTML response.

// proRequestReason caps the user-supplied justification so a malicious
// account can't blow up the audit_log or admin UI with a multi-MB blob.
// 1 KiB is plenty for a sentence or two of context.
const proRequestReasonMaxBytes = 1024

// proRequestNoteMaxBytes caps the admin-supplied decision note. Same
// reasoning as the user reason cap, slightly larger because admins
// occasionally paste short policy excerpts.
const proRequestNoteMaxBytes = 2048

// ── User-facing endpoints ─────────────────────────────────────────────

// HandleGetProRequest returns the caller's most recent pro-role request,
// or `{request: null}` if they've never submitted one. Powers the
// account-page Pro Access section.
func (s *Server) HandleGetProRequest(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	req, err := s.pgRepo.GetActiveProRoleRequest(r.Context(), user.ID)
	if err != nil {
		// pgx returns ErrNoRows wrapped — any error short-circuits to
		// "no request" since we don't distinguish between "row absent"
		// and "transient lookup failure" for the read path. The user
		// will see the "Request Pro" button either way.
		respondJSON(w, map[string]interface{}{"request": nil, "role": user.Role})
		return
	}
	respondJSON(w, map[string]interface{}{"request": req, "role": user.Role})
}

// proRequestCreateBody is the JSON body of POST /v1/me/pro-request. Both
// fields are optional — the user can submit a bare {} and we'll record
// the request with no justification. The reason length is capped at the
// repo layer via proRequestReasonMaxBytes.
type proRequestCreateBody struct {
	Reason string `json:"reason"`
}

// HandleCreateProRequest creates a new pending pro-role request for the
// caller. Refuses when the caller is already 'pro' or 'admin' (the role
// would be a no-op promotion or a downgrade), and when the caller already
// has an open pending request.
func (s *Server) HandleCreateProRequest(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	// Already-elevated accounts have nothing to gain. We reject server-side
	// even though the UI hides the button — defence in depth against a
	// stale tab or a hand-crafted curl.
	if user.Role != "user" {
		respondError(w, http.StatusConflict,
			"your account is already elevated; only standard users can request Pro")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, int64(proRequestReasonMaxBytes)+256)
	defer r.Body.Close()
	var body proRequestCreateBody
	if r.ContentLength > 0 {
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			respondError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
	}
	reason := strings.TrimSpace(body.Reason)
	if len(reason) > proRequestReasonMaxBytes {
		reason = reason[:proRequestReasonMaxBytes]
	}

	id, err := s.pgRepo.CreateProRoleRequest(r.Context(), user.ID, reason)
	if err != nil {
		if errors.Is(err, repository.ErrProRequestExists) {
			respondError(w, http.StatusConflict, "you already have a pending request")
			return
		}
		LoggerFromCtx(r.Context()).Error("create pro role request failed", "user_id", user.ID, "error", err)
		respondError(w, http.StatusInternalServerError, "failed to submit request")
		return
	}

	s.auditLog.Log(r.Context(), audit.ActionProRequestNew, "pro_role_request", strconv.Itoa(id),
		map[string]interface{}{"user_id": user.ID})

	// Notify connected admins. We send to all connected admin clients
	// (real-time badge bump) and ignore delivery — the count endpoint
	// covers admins who weren't online. Fan-out to *every* admin row in
	// the DB would mean queueing offline notifications, which we
	// deliberately don't do here; the queue is the request itself.
	// Log the delivery count so we can tell in server logs whether the
	// "no notification" case is "no admin connected" vs a wiring bug.
	frame := proRequestNotifyFrame(id, user.Username, reason)
	if frame != nil && s.Hub != nil {
		delivered := s.Hub.PushToRole("admin", frame)
		LoggerFromCtx(r.Context()).Info("pro role request created",
			"request_id", id, "user_id", user.ID, "username", user.Username,
			"admin_clients_notified", delivered)
	}

	// Fetch the freshly-created row so the client can render the
	// "awaiting review" state without a follow-up GET.
	req, _ := s.pgRepo.GetActiveProRoleRequest(r.Context(), user.ID)
	respondJSON(w, map[string]interface{}{"request": req})
}

// proRequestNotifyFrame builds the WS frame admins receive when a new
// request lands. Returns nil on JSON marshal failure; the caller treats a
// nil frame as "skip the push" — the admin will still see the request on
// next /v1/admin/pro-requests refresh.
func proRequestNotifyFrame(id int, username, reason string) []byte {
	payload := map[string]interface{}{
		"type":      "admin:pro_request",
		"requestId": id,
		"username":  username,
		"reason":    reason,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	return b
}

// ── Admin-facing endpoints ────────────────────────────────────────────

// HandleAdminListProRequests returns every pending pro-role request as
// JSON. The admin portal renders the table client-side from this payload.
func (s *Server) HandleAdminListProRequests(w http.ResponseWriter, r *http.Request) {
	requests, err := s.pgRepo.ListPendingProRoleRequests(r.Context())
	if err != nil {
		LoggerFromCtx(r.Context()).Error("list pro role requests failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to load requests")
		return
	}
	respondJSON(w, requests)
}

// HandleAdminProRequestCount returns the pending count. Drives the badge
// on the Pro Requests admin tab when the page first loads (or when the
// admin reconnects after missing a WS frame).
func (s *Server) HandleAdminProRequestCount(w http.ResponseWriter, r *http.Request) {
	n, err := s.pgRepo.CountPendingProRoleRequests(r.Context())
	if err != nil {
		LoggerFromCtx(r.Context()).Error("count pro role requests failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to load count")
		return
	}
	respondJSON(w, map[string]int{"count": n})
}

// HandleAdminDecideProRequest approves or denies a pending request. The
// form body has `decision=approve|deny` and optional `note`. On approval
// the underlying user's role is bumped to 'pro' atomically with the
// status flip (see DecideProRoleRequest tx). The user receives a WS
// frame announcing the decision so their account page updates live.
func (s *Server) HandleAdminDecideProRequest(w http.ResponseWriter, r *http.Request) {
	approver := auth.FromContext(r.Context())
	if approver.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid request id")
		return
	}

	if err := r.ParseForm(); err != nil {
		respondError(w, http.StatusBadRequest, "invalid form")
		return
	}
	decision := r.FormValue("decision")
	note := strings.TrimSpace(r.FormValue("note"))
	if len(note) > proRequestNoteMaxBytes {
		note = note[:proRequestNoteMaxBytes]
	}
	var approve bool
	switch decision {
	case "approve":
		approve = true
	case "deny":
		approve = false
	default:
		respondError(w, http.StatusBadRequest, "decision must be 'approve' or 'deny'")
		return
	}

	userID, username, err := s.pgRepo.DecideProRoleRequest(r.Context(), id, approver.ID, approve, note)
	if err != nil {
		// Surface the repo's own error message — these are user-facing
		// reasons (already decided, self-decision, not found) we want
		// the admin to see literally.
		respondError(w, http.StatusConflict, err.Error())
		return
	}

	action := audit.ActionProRequestNo
	if approve {
		action = audit.ActionProRequestOK
	}
	s.auditLog.Log(r.Context(), action, "pro_role_request", strconv.Itoa(id), map[string]interface{}{
		"user_id":  userID,
		"username": username,
		"note":     note,
	})

	// Tell the requester their fate. Best-effort — if they're offline
	// the next account-page load will re-probe /v1/me/pro-request and
	// surface the new status.
	if userID > 0 && s.Hub != nil {
		frame := proRequestDecisionFrame(id, approve, note)
		if frame != nil {
			s.Hub.PushToUser(userID, frame)
		}
		// If they were just promoted to 'pro' their JWT still claims
		// 'user' until it refreshes. Push a hint frame so the client
		// can encourage a re-login or trigger a silent refresh path.
		if approve {
			s.Hub.PushToUser(userID, []byte(`{"type":"role:changed","role":"pro"}`))
		}
	}

	respondJSON(w, map[string]interface{}{
		"id":       id,
		"status":   decisionStatus(approve),
		"userId":   userID,
		"username": username,
	})
}

func decisionStatus(approve bool) string {
	if approve {
		return "approved"
	}
	return "denied"
}

// proRequestDecisionFrame builds the WS frame the requester receives
// when their pending request is decided.
func proRequestDecisionFrame(id int, approved bool, note string) []byte {
	payload := map[string]interface{}{
		"type":      "pro_request:decided",
		"requestId": id,
		"status":    decisionStatus(approved),
		"note":      note,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	return b
}

