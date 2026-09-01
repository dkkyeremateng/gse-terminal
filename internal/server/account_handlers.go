package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// ─── Account management ────────────────────────────────────────────────────
//
// Self-service account-hygiene endpoints under /v1/me/*: unlink email,
// change password. Each is auth-required and operates only on the caller's
// own row — no admin override paths live here (those are at /v1/admin/*).
//
// Lifecycle relations:
//   - Linking a manual email          → POST /v1/me/email/request-verify
//   - Verifying a manual email        → GET  /auth/verify-email?token=…
//   - Unlinking a manual email        → POST /v1/me/email/unlink   (this file)
//   - Linking an OAuth provider       → GET  /auth/link/{provider}
//   - Unlinking an OAuth provider     → POST /v1/me/unlink-provider (existing)
//   - Setting a password (OAuth-only) → POST /v1/me/set-password   (existing)
//   - Changing a password             → POST /v1/me/password       (this file)

// HandleUnlinkEmail clears the caller's email + verified flag. Returns 409
// when the email is OAuth-managed (the user must unlink the provider
// first; doing so already clears email via UnlinkProvider).
func (s *Server) HandleUnlinkEmail(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	if err := s.pgRepo.UnlinkUserEmail(r.Context(), user.ID); err != nil {
		if errors.Is(err, repository.ErrEmailManagedByOAuth) {
			respondError(w, http.StatusConflict,
				"your email is managed by your linked provider — unlink the provider to remove the email")
			return
		}
		LoggerFromCtx(r.Context()).Error("unlink email failed", "user_id", user.ID, "error", err)
		respondError(w, http.StatusInternalServerError, "failed to unlink email")
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionUserStatus, "email_unlink", strconv.Itoa(user.ID),
			map[string]interface{}{"user_id": user.ID})
	}
	w.WriteHeader(http.StatusNoContent)
}

// changePasswordReq is the body of POST /v1/me/password. Both fields are
// required; the current password is verified against the stored bcrypt
// hash before the new one is written.
type changePasswordReq struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// HandleChangePassword verifies the caller's current password and stores
// a fresh bcrypt hash for the new one. Distinct from HandleSetPassword,
// which targets OAuth-only users that don't yet have a password to verify.
func (s *Server) HandleChangePassword(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 2<<10)
	defer r.Body.Close()
	var req changePasswordReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.CurrentPassword == "" {
		respondError(w, http.StatusBadRequest, "current password required")
		return
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := s.pgRepo.VerifyAndUpdatePassword(r.Context(), user.ID, req.CurrentPassword, req.NewPassword); err != nil {
		switch {
		case errors.Is(err, repository.ErrCurrentPasswordWrong):
			respondError(w, http.StatusUnauthorized, "current password is incorrect")
		case errors.Is(err, repository.ErrNoPasswordSet):
			respondError(w, http.StatusConflict,
				"this account has no password yet — use Set Password instead")
		default:
			LoggerFromCtx(r.Context()).Error("change password failed", "user_id", user.ID, "error", err)
			respondError(w, http.StatusInternalServerError, "failed to update password")
		}
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionUserStatus, "password_change", strconv.Itoa(user.ID),
			map[string]interface{}{"user_id": user.ID})
	}
	w.WriteHeader(http.StatusNoContent)
}
